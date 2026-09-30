// The pooled MCP client (plan §2.6, C115; research 2026-09-22 §4.3–4.5,
// §4.11–4.12). One long-lived client per connection — a stdio child or a
// Streamable HTTP session — opened on first use, reused, closed when idle or
// when its file changes, with the upstream's `tools/list` cached until the
// server says it changed.
//
// It is the MECHANISM, and it is closed by default at every step. What it
// makes impossible rather than discouraged, each a refusal decided BEFORE
// anything is dialled (no child is spawned, no request is sent):
//
//   * **An unlisted tool.** The connection file's `tools:` is the allowlist.
//     A tool it does not name is refused `tool_not_listed`, a tool at Never
//     (`off`) `tool_off`, and one at Ask First (`ask`) `needs_approval`
//     unless the caller holds the owner's approval of this call (T4-9's
//     Approve is what sets it). The upstream is never asked about a tool
//     the owner did not list.
//   * **The caller's own bearer upstream.** The MCP authorization spec says
//     a server "MUST NOT pass through the token it received from the MCP
//     client" — the confused deputy. Here it is structural: the transport's
//     headers are built from the connection file and nothing else, a stdio
//     child's environment is built from the file and nothing else (never
//     this process's), and a call whose arguments carry the caller's bearer
//     is refused `caller_credential`.
//   * **A secret anywhere but its listed hosts.** Every HTTP request goes
//     through core's `guardedFetch` with the connection as the grantee
//     (`connection:<name>`): a `{{ secret.x }}` is filled only for a host on
//     that secret's *Sent only to* list and only when the owner granted it
//     to this connection, and everything that comes back is redacted.
//   * **Somewhere else.** An HTTP connection's requests go to its own origin
//     and nowhere else, and a redirect is not followed: a server that points
//     the client at another host is refused `other_host`.
//
// An IMAP mailbox (T4-15) is not MCP and is never pooled: `openImap` opens
// one signed-in session for the owner's hand (`check()`), through the IMAP
// provider's own host guard, with this pool's secrets and redactor, and the
// caller closes it.
//
// A stdio child is given a granted secret in its environment at spawn —
// §2.14's rule for a local process — and is NOT network-confined in this
// release: the supervisor's egress proxy has one allowlist for its confined
// children and no per-connection list, so a child's own traffic is its own.
// That is said wherever a command connection is shown (docs/ops/connections.md).
//
// Nothing here imports Postgres, the vault or project config. Where a call
// or a check lands in `runs` is the host's (`onEvent`).

import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  EgressRefused,
  SecretRedactor,
  fillSecretRefs,
  guardedFetch,
  secretGrant,
  secretRefsIn,
  type SecretSource,
  type SecretsFile,
  type ToolGroup,
  type ToolMode,
} from "@foldedspacelabs/metistry-core";
import type { ConnectionCatalog } from "./catalog.js";
import { ConnectionRefused } from "./errors.js";
import { IMAP_MODULE, openImap, type ImapDialer, type ImapSession } from "./imap.js";
import type { ConnectionEntry } from "./load.js";
import { planDial, planFingerprint, type CommandDial, type DialPlan, type HttpDial } from "./plan.js";

/** An idle connection is closed after this long — a stdio child is a process, and one nobody is using is a process for nothing. The host passes its own (`METISTRY_CONNECTION_IDLE_MS`). */
export const DEFAULT_CONNECTION_IDLE_MS = 10 * 60_000;
/** How long `initialize` may take. A cold `npx -y …` downloads its package first. The host passes its own (`METISTRY_CONNECTION_CONNECT_TIMEOUT_MS`). */
export const DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS = 30_000;
/** How long one call or `tools/list` may take — the SDK's own default. The host passes its own (`METISTRY_CONNECTION_CALL_TIMEOUT_MS`). */
export const DEFAULT_CONNECTION_CALL_TIMEOUT_MS = 60_000;
/** Lines of a stdio child's stderr kept to explain why it exited. */
const STDERR_TAIL_LINES = 20; // limit: fixed — a diagnostic tail for an error message, not a policy
/** The one `tools/list` page cap: a server that pages forever is not listing tools. */
const MAX_TOOL_PAGES = 20; // limit: fixed — guards a paging loop against a server that never stops, far above any real tool list

/** The grantee a connection's own secrets are granted to (`secrets.yaml`). */
export function connectionGrantee(name: string): string {
  return `connection:${name}`;
}

/** One tool as the upstream describes it, joined to the owner's policy for it. */
export interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: ToolGroup;
  mode: ToolMode;
}

/** One upstream tool, as `tools/list` said it. `readOnly` is the server's own hint — a hint, never a control (the MCP spec says so). */
export interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface CallRequest {
  connection: string;
  tool: string;
  args: Record<string, unknown>;
  /** who is asking. `bearer`: the credential they presented to this process — refused if it appears in the arguments, and structurally never sent upstream */
  caller?: { bearer?: string | undefined } | undefined;
  /** the owner approved THIS call (T4-9's Approve). Absent: an Ask First tool is refused `needs_approval` */
  approved?: boolean | undefined;
}

export interface CallOutcome {
  /** the upstream's content blocks, redacted */
  content: unknown[];
  structuredContent?: unknown;
  /** the upstream said the tool failed — the connection itself answered */
  isError: boolean;
  /** secret NAMES this call carried (never values) — for the caller's `runs` row (`recordSecretUse`) */
  secrets: string[];
}

/** What the pool tells its host after it dialled — a call or a check. The host writes the `runs` row (`connection_call` / `connection_check`). */
export interface PoolEvent {
  kind: "connection_call" | "connection_check";
  connection: string;
  tool?: string | undefined;
  /** the upstream answered (a tool error is still an answer) */
  ok: boolean;
  error?: string | undefined;
  ms: number;
  secrets: string[];
  meta?: Record<string, unknown> | undefined;
}

export interface ConnectionPoolOptions {
  /** read on every call, so an edit to a connection file, `variables.yaml` or `secrets.yaml` takes effect without a restart */
  catalog: () => Promise<ConnectionCatalog>;
  /** one instance's store (`InstanceSecrets`) — the only place a value comes from */
  secrets: SecretSource;
  /** learns every value filled; shared with the host so its transcripts redact the same values */
  redactor?: SecretRedactor | undefined;
  /** the base fetch under the egress guard (a test's fake; default global fetch) */
  fetch?: typeof fetch | undefined;
  /** how an IMAP connection's socket is opened (a test's fake; default Node's verified TLS) — only after its host guard passed */
  imapDial?: ImapDialer | undefined;
  /** where THIS process runs: a `runs_on` that names the other place is refused `runs_elsewhere`. Default host */
  runsOn?: "host" | "container" | undefined;
  idleMs?: number | undefined;
  connectTimeoutMs?: number | undefined;
  callTimeoutMs?: number | undefined;
  /** told after every dialled call and check; a throw here is ignored */
  onEvent?: ((e: PoolEvent) => void | Promise<void>) | undefined;
  /** client identity on the wire. The assistant's name never appears (CLAUDE.md) */
  clientInfo?: { name: string; version: string } | undefined;
}

interface Live {
  fingerprint: string;
  client: Client;
  /** secret names a stdio child was given in its environment */
  envSecrets: string[];
  /** the secrets policy an HTTP transport checks each request against — the latest the pool has read */
  secretsFile: SecretsFile;
  tools: UpstreamTool[] | undefined;
  idle: NodeJS.Timeout | undefined;
  stderr: string[];
  closed: boolean;
}

interface Prepared {
  entry: ConnectionEntry;
  plan: DialPlan;
  catalog: ConnectionCatalog;
  fingerprint: string;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

/** The pool. One per process that dials connections; `close()` it on the way down. */
export class ConnectionPool {
  readonly #opts: ConnectionPoolOptions;
  readonly #redactor: SecretRedactor;
  readonly #live = new Map<string, Promise<Live>>();
  /** the secret names the current call's requests carried — attributed per call on a shared transport */
  readonly #usage = new AsyncLocalStorage<Set<string>>();
  #closed = false;

  constructor(opts: ConnectionPoolOptions) {
    this.#opts = opts;
    this.#redactor = opts.redactor ?? new SecretRedactor();
  }

  /** The redactor every value this pool filled is known to. */
  get redactor(): SecretRedactor {
    return this.#redactor;
  }

  /** Connections open right now. */
  get size(): number {
    return this.#live.size;
  }

  /**
   * Call one tool. Every refusal in the module doc happens before the
   * upstream is dialled; the result comes back redacted, with the secret
   * NAMES the call carried.
   */
  async call(req: CallRequest): Promise<CallOutcome> {
    const prepared = await this.#prepare(req.connection);
    const { entry } = prepared;
    const c = entry.connection!;
    const policy = Object.hasOwn(c.tools, req.tool) ? c.tools[req.tool] : undefined;
    if (!policy) {
      throw new ConnectionRefused("tool_not_listed", c.name, `${req.tool} is not one of this connection's tools — the owner lists a tool before anything may call it (\`metistry connections policy ${c.name} ${req.tool} allow|ask|never\`)`, req.tool);
    }
    if (policy.mode === "off") throw new ConnectionRefused("tool_off", c.name, `${req.tool} is set to Never`, req.tool);
    if (policy.mode === "ask" && req.approved !== true) {
      throw new ConnectionRefused("needs_approval", c.name, `${req.tool} is set to Ask First — it runs only once the owner approves this call`, req.tool);
    }
    const bearer = req.caller?.bearer;
    if (bearer && bearer.length >= 8 && JSON.stringify(req.args ?? {}).includes(bearer)) {
      throw new ConnectionRefused("caller_credential", c.name, "the arguments carry the caller's own credential — it is never sent upstream", req.tool);
    }

    const started = Date.now();
    const used = new Set<string>();
    try {
      const live = await this.#ensure(req.connection, prepared);
      for (const n of live.envSecrets) used.add(n);
      const timeout = prepared.plan.kind === "http" ? (prepared.plan.timeoutMs ?? this.#callTimeout()) : this.#callTimeout();
      const result = (await this.#usage.run(used, () => live.client.callTool({ name: req.tool, arguments: req.args ?? {} }, undefined, { timeout }))) as {
        content?: unknown[];
        structuredContent?: unknown;
        isError?: boolean;
      };
      this.#touch(req.connection, live);
      const out: CallOutcome = {
        content: this.#redactor.redact(result.content ?? []),
        ...(result.structuredContent !== undefined ? { structuredContent: this.#redactor.redact(result.structuredContent) } : {}),
        isError: result.isError === true,
        secrets: [...used].sort(),
      };
      await this.#emit({ kind: "connection_call", connection: req.connection, tool: req.tool, ok: true, ms: Date.now() - started, secrets: out.secrets, meta: { is_error: out.isError } });
      return out;
    } catch (err) {
      const safe = this.#safe(err);
      if (!(err instanceof ConnectionRefused)) {
        await this.#emit({ kind: "connection_call", connection: req.connection, tool: req.tool, ok: false, error: safe.message, ms: Date.now() - started, secrets: [...used].sort() });
      }
      throw safe;
    }
  }

  /** The tools an agent may be offered: listed, not Never, and present upstream — with the upstream's description and schema. */
  async tools(name: string): Promise<ListedTool[]> {
    const prepared = await this.#prepare(name);
    const live = await this.#ensure(name, prepared);
    const upstream = await this.#listTools(live);
    this.#touch(name, live);
    const policies = prepared.entry.connection!.tools;
    const out: ListedTool[] = [];
    for (const t of upstream) {
      const p = Object.hasOwn(policies, t.name) ? policies[t.name] : undefined;
      if (!p || p.mode === "off") continue;
      out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, group: p.group, mode: p.mode });
    }
    return out;
  }

  /**
   * Dial (or reuse) and list what the upstream offers — every tool, listed or
   * not. For the owner's hand only: `metistry connections add` scaffolds a
   * file from it and `check()` compares it with the file. Never offered to an
   * agent (`tools()` is that).
   */
  async upstreamTools(name: string, opts: { fresh?: boolean } = {}): Promise<UpstreamTool[]> {
    const prepared = await this.#prepare(name);
    const live = await this.#ensure(name, prepared);
    if (opts.fresh) live.tools = undefined;
    const tools = await this.#listTools(live);
    this.#touch(name, live);
    return tools;
  }

  /**
   * Open and sign in to an IMAP connection (T4-15) — for the owner's hand
   * (`check()`, `metistry connections test`). Not pooled and never offered to
   * an agent: the caller closes the session. Refused before anything is
   * dialled for an unknown or not-ready connection and for one whose
   * provider is not the IMAP module; the host guard, the fill and the
   * sign-in are `openImap`'s.
   */
  async openImap(name: string, opts: { onUse?: ((use: { names: string[]; destination: string }) => void | Promise<void>) | undefined } = {}): Promise<ImapSession> {
    if (this.#closed) throw new Error("the connection pool is closed");
    const catalog = await this.#opts.catalog();
    const entry = catalog.entries.find((e) => e.name === name);
    if (!entry) throw new ConnectionRefused("unknown_connection", name, `no connection named ${name} (\`metistry connections list\`)`);
    if (entry.status !== "ok" || !entry.connection || !entry.provider) {
      throw new ConnectionRefused("not_ready", name, `${entry.status}: ${entry.issues.join("; ") || "the connection is not ready"}`);
    }
    const impl = entry.provider.manifest.implementation;
    const reach = entry.connection.reach.imap;
    if (impl.kind !== "builtin" || impl.module !== IMAP_MODULE || !reach) {
      throw new ConnectionRefused("not_built", name, `provider ${entry.provider.name} is not the IMAP module — it is not opened as a mailbox`);
    }
    if (!catalog.secrets.ok) {
      throw new ConnectionRefused("secret", name, `secrets.yaml does not load (${catalog.secrets.message}), so ${reach.secret} may not be used`);
    }
    return openImap({
      connection: name,
      reach,
      capabilities: [...entry.provider.manifest.capabilities],
      secretsFile: catalog.secrets.file,
      source: this.#opts.secrets,
      redactor: this.#redactor,
      ...(this.#opts.imapDial ? { dial: this.#opts.imapDial } : {}),
      timeoutMs: this.#opts.connectTimeoutMs ?? DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS,
      ...(opts.onUse ? { onUse: opts.onUse } : {}),
    });
  }

  /** Close one connection now (its file was removed, say) — or every one. */
  async close(name?: string): Promise<void> {
    if (name === undefined) {
      this.#closed = true;
      await Promise.all([...this.#live.keys()].map((n) => this.close(n)));
      return;
    }
    const p = this.#live.get(name);
    if (!p) return;
    this.#live.delete(name);
    const live = await p.catch(() => undefined);
    if (live) await this.#shut(live);
  }

  /** Report an event to the host, which writes the `runs` row. `check.ts` reports its own through here. */
  async emit(e: PoolEvent): Promise<void> {
    await this.#emit(e);
  }

  // ---- internals ------------------------------------------------------------------

  #callTimeout(): number {
    return this.#opts.callTimeoutMs ?? DEFAULT_CONNECTION_CALL_TIMEOUT_MS;
  }

  async #emit(e: PoolEvent): Promise<void> {
    try {
      await this.#opts.onEvent?.(e);
    } catch {
      /* the host's bookkeeping never fails a call */
    }
  }

  /** An error safe to throw on: a refusal as it is (it names, never values); anything else redacted. */
  #safe(err: unknown): Error {
    if (err instanceof ConnectionRefused || err instanceof EgressRefused) return err;
    const out = this.#redactor.redactError(err);
    // keep the errno (ENOENT: the command is not there) — a check reads it, and it is no value
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) (out as NodeJS.ErrnoException).code = code;
    return out;
  }

  /** Everything decidable without dialling: the file, its readiness, the plan. */
  async #prepare(name: string): Promise<Prepared> {
    if (this.#closed) throw new Error("the connection pool is closed");
    const catalog = await this.#opts.catalog();
    const entry = catalog.entries.find((e) => e.name === name);
    if (!entry) throw new ConnectionRefused("unknown_connection", name, `no connection named ${name} (\`metistry connections list\`)`);
    if (entry.status !== "ok" || !entry.connection) {
      throw new ConnectionRefused("not_ready", name, `${entry.status}: ${entry.issues.join("; ") || "the connection is not ready"}`);
    }
    const plan = planDial(entry, catalog.variables, catalog.baseDir);
    const where = this.#opts.runsOn ?? "host";
    if (plan.kind === "command" && plan.runsOn !== where) {
      throw new ConnectionRefused(
        "runs_elsewhere",
        name,
        plan.runsOn === "host" ? "runs_on: host — this process runs in a container and cannot start a command on the Mac" : "runs_on: container — this process runs on the Mac, not in a container",
      );
    }
    const secretsFile = catalog.secrets.ok ? catalog.secrets.file : undefined;
    if (!secretsFile && entry.connection.secrets.length > 0) {
      throw new ConnectionRefused("secret", name, `secrets.yaml does not load (${catalog.secrets.ok ? "" : catalog.secrets.message}), so none of ${entry.connection.secrets.join(", ")} may be used`);
    }
    // a command's environment is filled once, at spawn: a change to a grant must redial
    const grants = plan.kind === "command" ? envSecretNames(plan).map((n) => [n, secretsFile ? secretGrant(secretsFile, n, connectionGrantee(name)) : "off"]) : null;
    return { entry, plan, catalog, fingerprint: planFingerprint(plan, grants) };
  }

  /**
   * The live client for this plan: the pooled one when it is open and its
   * plan is this one, else a fresh dial (closing the old). A loop, because
   * another call may replace the entry while this one waits on it — the
   * check and the delete that follows it never have an await between them.
   */
  async #ensure(name: string, prepared: Prepared): Promise<Live> {
    for (;;) {
      const existing = this.#live.get(name);
      if (!existing) {
        const p = this.#connect(name, prepared);
        this.#live.set(name, p);
        try {
          return await p;
        } catch (err) {
          if (this.#live.get(name) === p) this.#live.delete(name);
          throw err;
        }
      }
      const live = await existing.catch(() => undefined);
      if (this.#live.get(name) !== existing) continue; // replaced meanwhile: look again
      if (live && !live.closed && live.fingerprint === prepared.fingerprint) {
        if (prepared.catalog.secrets.ok) live.secretsFile = prepared.catalog.secrets.file;
        return live;
      }
      this.#live.delete(name);
      if (live) await this.#shut(live);
    }
  }

  async #connect(name: string, prepared: Prepared): Promise<Live> {
    const { plan } = prepared;
    const secretsFile: SecretsFile = prepared.catalog.secrets.ok ? prepared.catalog.secrets.file : { secrets: {} };
    const live: Live = { fingerprint: prepared.fingerprint, client: undefined as unknown as Client, envSecrets: [], secretsFile, tools: undefined, idle: undefined, stderr: [], closed: false };
    const client = new Client(this.#opts.clientInfo ?? { name: "metistry-connections", version: "1" }, { capabilities: {} });
    live.client = client;
    let transport: Transport;
    if (plan.kind === "http") {
      transport = this.#httpTransport(name, plan, live);
    } else {
      const { env, names } = await this.#fillEnv(name, plan, secretsFile);
      live.envSecrets = names;
      const stdio = new StdioClientTransport({ command: plan.command, args: plan.args, ...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}), env, stderr: "pipe" });
      stdio.stderr?.on("data", (chunk: Buffer | string) => {
        for (const line of String(chunk).split("\n")) if (line.trim() !== "") live.stderr.push(line);
        if (live.stderr.length > STDERR_TAIL_LINES) live.stderr.splice(0, live.stderr.length - STDERR_TAIL_LINES);
      });
      transport = stdio as unknown as Transport;
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      live.tools = undefined;
    });
    client.onclose = () => {
      live.closed = true;
      if (live.idle) clearTimeout(live.idle);
    };
    try {
      // the cast: the SDK's `sessionId?: string` against this repo's
      // exactOptionalPropertyTypes (apps/assistant/src/tools.ts says the same)
      await client.connect(transport, { timeout: this.#opts.connectTimeoutMs ?? DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw this.#withStderr(err, live);
    }
    this.#touch(name, live);
    return live;
  }

  /** A stdio child's last words, redacted, appended to why it failed. */
  #withStderr(err: unknown, live: Live): unknown {
    if (err instanceof ConnectionRefused || err instanceof EgressRefused || live.stderr.length === 0) return err;
    const e = err instanceof Error ? err : new Error(String(err));
    const out = new Error(`${e.message} — the command said: ${this.#redactor.redactText(live.stderr.slice(-3).join(" | "))}`);
    const code = (e as NodeJS.ErrnoException).code;
    if (code) (out as NodeJS.ErrnoException).code = code;
    return out;
  }

  #httpTransport(name: string, plan: HttpDial, live: Live): Transport {
    const base = this.#opts.fetch ?? fetch;
    const redactor = this.#redactor;
    const source = this.#opts.secrets;
    const usage = this.#usage;
    const pinned: typeof fetch = async (input, init) => {
      const url = urlOf(input);
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new ConnectionRefused("other_host", name, "not a URL");
      }
      if (target.origin !== plan.origin) {
        throw new ConnectionRefused("other_host", name, `a request to ${target.origin} — this connection is ${plan.origin}, and it goes nowhere else`);
      }
      const door = guardedFetch(
        {
          secrets: live.secretsFile,
          grantee: connectionGrantee(name),
          purpose: "service",
          redactor,
          source,
          onUse: ({ names }) => {
            const set = usage.getStore();
            if (set) for (const n of names) set.add(n);
          },
        },
        base,
      );
      const res = await door(url, { ...(init ?? {}), redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get("location");
        let where = "somewhere else";
        try {
          if (loc) where = new URL(loc, url).origin;
        } catch {
          /* unparseable: say so generically */
        }
        throw new ConnectionRefused("other_host", name, `the server redirected to ${where} — a redirect is not followed; set the connection's URL to where the server lives`);
      }
      return res;
    };
    const t = new StreamableHTTPClientTransport(new URL(plan.url), { fetch: pinned, requestInit: { headers: plan.headers } });
    return t as unknown as Transport;
  }

  /**
   * A command's environment: its `env:` from the file, variables already
   * filled, secrets filled now — each only if the owner granted it to this
   * connection. Ask First cannot hold here: an environment is filled once,
   * when the command starts, so there is no per-call approval to wait for.
   */
  async #fillEnv(name: string, plan: CommandDial, file: SecretsFile): Promise<{ env: Record<string, string>; names: string[] }> {
    const grantee = connectionGrantee(name);
    const names = envSecretNames(plan);
    for (const n of names) {
      const mode = secretGrant(file, n, grantee);
      if (mode === "off") throw new ConnectionRefused("secret", name, `${grantee} is not granted ${n} (\`metistry secrets grant ${n} ${grantee} on\`)`);
      if (mode === "ask") {
        throw new ConnectionRefused("secret", name, `${n} is Ask First for ${grantee}, but a command's environment is filled once, when it starts — there is no call to approve. Grant it on, or reach the server over HTTP`);
      }
    }
    const redactor = this.#redactor;
    const source = this.#opts.secrets;
    const recording: SecretSource = {
      async value(n) {
        const v = await source.value(n);
        if (v) redactor.learn(n, v);
        return v;
      },
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(plan.env)) {
      const r = await fillSecretRefs(v, recording);
      if (!r.ok) throw new ConnectionRefused("secret", name, `reach.command.env.${k}: ${r.message}`);
      env[k] = r.text;
    }
    return { env, names };
  }

  async #listTools(live: Live): Promise<UpstreamTool[]> {
    if (live.tools) return live.tools;
    const out: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await live.client.listTools(cursor ? { cursor } : undefined, { timeout: this.#callTimeout() });
      for (const t of r.tools) {
        out.push({
          name: t.name,
          description: this.#redactor.redactText((t.description ?? "").slice(0, 2048)),
          inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          readOnly: t.annotations?.readOnlyHint === true,
        });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    live.tools = out;
    return out;
  }

  #touch(name: string, live: Live): void {
    if (live.idle) clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      void (async () => {
        const current = await this.#live.get(name)?.catch(() => undefined);
        if (current === live) this.#live.delete(name);
        await this.#shut(live);
      })();
    }, this.#opts.idleMs ?? DEFAULT_CONNECTION_IDLE_MS);
    live.idle.unref();
  }

  async #shut(live: Live): Promise<void> {
    if (live.idle) clearTimeout(live.idle);
    live.closed = true;
    await live.client.close().catch(() => undefined);
  }
}

/** The secret names a command's environment references. */
function envSecretNames(plan: CommandDial): string[] {
  const names = new Set<string>();
  for (const v of Object.values(plan.env)) for (const n of secretRefsIn(v).names) names.add(n);
  return [...names].sort();
}

export type { DialPlan };
