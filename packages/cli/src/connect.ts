// `metistry connect <tool>` — the one door an external dev tool comes in
// through (plan refresh 2026-09-13 §4b W3). One agent row per tool, one
// token per tool, independently revocable: adopting a second tool is
// minting a token and running one command, and a tool that stops being
// used gets its row revoked with nothing else to unpick.
//
// Three things this verb deliberately does NOT do:
//
//   * Decide what the tool may read. Grants live on the server
//     (`{tier, areas, queries}`, validated by `validateGrants`, and a new
//     row starts default-deny `{tier: "none", areas: []}`), and which
//     TOOLS a principal can call follows its principal KIND at the bridge —
//     an external agent cannot reach `knowledge_write` or
//     `agents_delegate` whatever this verb writes (packages/mcp-brain). So
//     there is no per-tool permission list here to get wrong.
//   * Print a secret it did not have to. The console returns an agent token
//     exactly once, at mint or rotate; a tool whose config can name an
//     environment variable gets the token put in the login Keychain and
//     reads it back by name. Devin is the honest exception — its MCP
//     servers are registered in a web form, so its bearer is printed for
//     pasting, once, on the run that minted it.
//   * Install anything. `connect claude-code` mints the token the plugin
//     docs have you mint by hand; the plugin itself is still
//     `/plugin install` (docs/ops/claude-code-plugin.md).

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { consoleTarget, type ConsoleTarget } from "./console-client.js";
import { realExec, type Exec } from "./exec.js";
import { Keychain, keychainAccount, serviceFor } from "./keychain.js";
import { applyPorts, loadNamespace } from "./namespace.js";
import { accountFor } from "./secrets.js";
import { defaultUi, statusName, type Ui } from "./ui.js";

export const CONNECT_TOOLS = ["claude-code", "cursor", "devin", "opencode"] as const;
export type ConnectTool = (typeof CONNECT_TOOLS)[number];

/** How a tool's end of the connection is configured. */
export type ConfigShape =
  /** a file this verb merges into (`~/.cursor/mcp.json`) */
  | "file"
  /** environment variables a session inherits (the Claude Code plugin) */
  | "env"
  /** a web form only the owner can fill in (Devin's Customize → MCPs) */
  | "paste";

export interface ToolSpec {
  id: ConnectTool;
  /** the tool's own name, spelled the way its vendor spells it — the agent row's display_name */
  displayName: string;
  config: ConfigShape;
  /** the page that covers it end to end */
  doc: string;
}

export const TOOL_SPECS: Record<ConnectTool, ToolSpec> = {
  "claude-code": { id: "claude-code", displayName: "Claude Code", config: "env", doc: "docs/ops/claude-code-plugin.md" },
  cursor: { id: "cursor", displayName: "Cursor", config: "file", doc: "docs/ops/cursor.md" },
  devin: { id: "devin", displayName: "Devin", config: "paste", doc: "docs/ops/devin.md" },
  opencode: { id: "opencode", displayName: "OpenCode", config: "file", doc: "docs/ops/opencode.md" },
};

/** A tool name, or undefined — never a guess, the way `parseChannel` is strict. */
export function parseTool(v: string | undefined): ConnectTool | undefined {
  return (CONNECT_TOOLS as readonly string[]).includes(v ?? "") ? (v as ConnectTool) : undefined;
}

/** The console's shape (apps/console/src/agents.ts `Grants`), repeated here because the CLI never imports the app. */
export interface Grants {
  tier: "none" | "index" | "areas";
  areas: string[];
  queries?: boolean;
}

/**
 * What a row starts with: the `agents.grants` column default
 * (`db/migrations/0007_agents.sql`) — default-deny. `--areas` is how it is
 * widened, and the console's `validateGrants` is the only authority on
 * what is legal (there is no `tier: "default"`, and `queries` is a boolean,
 * not a list).
 */
export const DEFAULT_GRANTS: Grants = { tier: "none", areas: [] };

/** The Keychain variable a tool's bearer is filed under. Namespaced instances get a suffix so two instances on one Mac cannot share one variable. */
export function agentTokenVar(tool: ConnectTool, suffix?: string | undefined): string {
  const base = `METISTRY_AGENT_TOKEN_${tool.replace(/-/g, "_").toUpperCase()}`;
  return suffix ? `${base}_${suffix.toUpperCase()}` : base;
}

/**
 * The name the tool's own config gives this server. `metistry` for a
 * single-instance install; `metistry-<label_suffix>` when the instance is
 * namespaced (`state/ports.yaml` exists), which is exactly the case where a
 * second instance shares the Mac and a single `metistry` key would be
 * silently overwritten. Same 8 hex the launchd labels and log files use.
 */
export function serverKey(suffix?: string | undefined): string {
  return suffix ? `metistry-${suffix}` : "metistry";
}

export interface ConnectOptions {
  tool: ConnectTool;
  /** the instance whose console this is: gives the namespace (ports) and the Keychain account */
  instanceDir?: string | undefined;
  instanceId?: string | undefined;
  /** mint a replacement token; the old one stops authenticating immediately */
  rotate?: boolean | undefined;
  /** `--areas`: widen the read grant to `{tier: "areas", areas}` (TitleCase vault prefixes, e.g. `Areas/Fsl`; the console validates) */
  areas?: string[] | undefined;
  /** `--project`: project membership (§4.21 — tasks and artifacts are scoped by it) */
  projects?: string[] | undefined;
  /**
   * `--remote`: this tool will present its bearer from off this machine, so
   * the row enrols PENDING and the owner has to let it in before the token
   * authenticates anything (S2). A loopback tool needs nothing of the sort
   * — it is already on the Mac whose Keychain holds the token — so the
   * default is immediate.
   */
  remote?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  /** where `~/.cursor/mcp.json` is, injected so the tests never touch a real home */
  home?: string | undefined;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ConnectResult {
  tool: ConnectTool;
  display_name: string;
  console_url: string;
  mcp_url: string;
  /** the console is only reachable from this Mac — Devin's cloud cannot get here (plan refresh §4b "Exposure") */
  loopback: boolean;
  agent_id: string;
  created: boolean;
  rotated: boolean;
  grants: Grants;
  projects: string[];
  /** S2: the row was enrolled `--remote` and the owner has not let it in yet — the token authenticates nothing. */
  pending: boolean;
  /** how the bearer reached the tool THIS run */
  token: "keychain" | "printed" | "unchanged";
  /** the environment variable the tool's config names (config shapes `file` and `env`) */
  token_var?: string;
  keychain_account?: string;
  keychain_service?: string;
  config_file?: string;
  config_key?: string;
  config_state?: "written" | "unchanged";
  /** the fields pasted into a web form, present only for a `paste` tool — `bearer` only on the run that minted it */
  paste?: { name: string; transport: string; url: string; header: string; bearer?: string };
}

/** The registry, minus everything secret. `GET /api/agents` already refuses to return a hash. */
interface AgentRow {
  id: string;
  display_name: string;
  kind: string;
  grants?: Partial<Grants>;
  projects?: string[];
  revoked?: boolean;
  last_seen_at?: string | null;
  /** S2: minted `--remote` and not yet let in. Absent on a console that predates the column. */
  pending?: boolean;
  /** S2: the row was enrolled as remote (approved or not). */
  remote?: boolean;
}

function normalizeGrants(raw: Partial<Grants> | undefined): Grants {
  const tier = raw?.tier === "index" || raw?.tier === "areas" ? raw.tier : "none";
  return { tier, areas: Array.isArray(raw?.areas) ? raw!.areas : [], ...(raw?.queries === true ? { queries: true } : {}) };
}

/** Never let the owner token into a message. Same rule (and same reason) as console-client's. */
function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

interface Api {
  target: ConsoleTarget;
  fetchFn: typeof fetch;
  timeoutMs: number;
}

/** One management call as the `user` principal, exactly as `console whoami` authenticates (docs/ops/auth.md). */
async function call(api: Api, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = `${api.target.url}${path}`;
  let res: Response;
  try {
    res = await api.fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${api.target.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(api.timeoutMs),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${api.target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, api.target.token)}`);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (res.status === 401) {
    throw new Error(
      `${api.target.url} refused the owner token (401) — \`metistry console whoami\` is the check for that door (docs/ops/auth.md); connect needs the management surface, which only the "user" principal reaches.`,
    );
  }
  if (res.status === 403) throw new Error(`${api.target.url} answered 403 for ${method} ${path}: the credential in use is capture-only (CRIT-7), not the local owner token`);
  if (!res.ok) {
    const e = (json.error ?? {}) as { code?: unknown; message?: unknown };
    throw new Error(`${method} ${path} answered HTTP ${res.status}${e.code ? ` (${String(e.code)}: ${String(e.message ?? "")})` : ""}`);
  }
  return { status: res.status, json };
}

export async function connect(opts: ConnectOptions): Promise<ConnectResult> {
  const spec = TOOL_SPECS[opts.tool];
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;

  // Refuse BEFORE minting anything: a token the console returns once and
  // this process cannot store is a token that has to be rotated to be
  // recovered. `secrets` draws the same line for the same reason.
  if (spec.config !== "paste" && platform !== "darwin") {
    throw new Error(
      `connect ${spec.id} keeps the agent token in the macOS login Keychain, which ${platform} does not have — nothing was minted. On this host use \`metistry connect devin\` (its bearer is pasted into a form, so nothing is stored) or register the agent yourself (POST /api/agents, docs/ops/console-api.md).`,
    );
  }

  // A namespaced instance's console is not on 8080 (state/ports.yaml), and
  // the namespace is also what keeps two instances' config entries apart.
  const ns = await loadNamespace(opts.instanceDir);
  if (ns) applyPorts(env, ns);
  const suffix = ns?.labelSuffix;
  const target = await consoleTarget({ env, platform, exec, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) });
  const api: Api = { target, fetchFn: opts.fetchFn ?? fetch, timeoutMs: opts.timeoutMs ?? 10_000 };

  // 1. the row. Idempotent by construction: the id IS the tool name, so a
  //    re-run finds what the last run made.
  const listed = ((await call(api, "GET", "/api/agents")).json.agents ?? []) as AgentRow[];
  const existing = listed.find((a) => a.id === spec.id);
  if (existing?.revoked === true) {
    throw new Error(
      `agent "${spec.id}" is revoked on ${target.url}. Revocation is permanent — the row stays so old proposals keep their provenance, and its id cannot be re-minted (apps/console/src/agents.ts). Register a differently-named agent by hand if this tool is coming back.`,
    );
  }
  // `--remote` is a property of the ENROLMENT, so it is settled when the row
  // is minted and never afterwards: promoting a row the owner already let in
  // would be a widening dressed as a flag, and demoting one would be an
  // approval this verb granted itself. Both are the owner's, in the console.
  if (opts.remote === true && existing && existing.remote !== true) {
    throw new Error(
      `agent "${spec.id}" is already registered on ${target.url} as a local (loopback) tool, and --remote is decided at enrolment, not after it. Revoke it in the console and connect again, or leave it as it is (docs/ops/console-api.md, "approve-before-enroll").`,
    );
  }

  let token: string | undefined;
  let created = false;
  let rotated = false;
  let pending = existing?.pending === true;
  if (!existing) {
    const r = await call(api, "POST", "/api/agents", { id: spec.id, display_name: spec.displayName, kind: "external", ...(opts.remote === true ? { remote: true } : {}) });
    token = String(r.json.token ?? "");
    created = true;
    pending = r.json.pending === true;
    if (!token) throw new Error(`POST /api/agents answered ${r.status} without a token — nothing to give ${spec.displayName}`);
  } else if (opts.rotate === true) {
    const r = await call(api, "POST", `/api/agents/${spec.id}/rotate`, {});
    token = String(r.json.token ?? "");
    rotated = true;
    if (!token) throw new Error(`POST /api/agents/${spec.id}/rotate answered ${r.status} without a token`);
  }

  // 2. grants and projects, only when asked for. An existing row's grants
  //    are otherwise left exactly as the owner set them — connect is not a
  //    verb that quietly narrows a tool you had widened.
  let grants = existing ? normalizeGrants(existing.grants) : { ...DEFAULT_GRANTS };
  const areas = (opts.areas ?? []).filter((a) => a !== "");
  if (areas.length > 0) {
    const r = await call(api, "PUT", `/api/agents/${spec.id}/grants`, { tier: "areas", areas });
    grants = normalizeGrants(r.json.grants as Partial<Grants>);
  }
  let projects = existing?.projects ?? [];
  const wanted = (opts.projects ?? []).filter((p) => p !== "");
  if (wanted.length > 0) {
    const r = await call(api, "PUT", `/api/agents/${spec.id}/projects`, { projects: wanted });
    projects = (r.json.projects as string[]) ?? wanted;
  }

  const mcpUrl = `${target.url}/mcp`;
  const result: ConnectResult = {
    tool: spec.id,
    display_name: spec.displayName,
    console_url: target.url,
    mcp_url: mcpUrl,
    loopback: /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/|$)/i.test(target.url),
    agent_id: spec.id,
    created,
    rotated,
    grants,
    projects,
    pending,
    token: token ? "keychain" : "unchanged",
  };

  // 3. the bearer. One delivery per tool, chosen by the config shape —
  //    never both (a token in a file AND in the Keychain is two things to
  //    revoke).
  if (spec.config === "paste") {
    result.token = token ? "printed" : "unchanged";
    result.paste = {
      name: serverKey(suffix),
      transport: "HTTP (Streamable HTTP)",
      url: mcpUrl,
      header: "Authorization",
      ...(token ? { bearer: `Bearer ${token}` } : {}),
    };
    return result;
  }

  const varName = agentTokenVar(spec.id, suffix);
  const account = accountFor(varName, { user: keychainAccount(env), ...(opts.instanceId ? { instance: opts.instanceId } : {}) });
  result.token_var = varName;
  result.keychain_account = account;
  result.keychain_service = serviceFor(varName);
  if (token) {
    try {
      await new Keychain(exec, account).setSecret(varName, token);
    } catch (err) {
      throw new Error(`the token was minted but could NOT be stored (${redact(err, token)}) — rerun with --rotate once the Keychain is writable; the value shown by the console is gone`);
    }
  }

  if (spec.config === "file") {
    // Two tools, two files, one rule: merge one entry, leave everything else
    // exactly as it was, and never write the bearer.
    const home = opts.home ?? env.HOME ?? "";
    const key = serverKey(suffix);
    const file = spec.id === "opencode" ? opencodeConfigFile(home, env) : cursorConfigFile(home);
    result.config_file = file;
    result.config_key = key;
    result.config_state = spec.id === "opencode" ? await writeOpencodeConfig(file, key, mcpUrl, varName) : await writeCursorConfig(file, key, mcpUrl, varName);
  }
  return result;
}

// ---- Cursor's config ---------------------------------------------------------
//
// `~/.cursor/mcp.json` takes remote servers as `url` + `headers`, and
// Cursor's config interpolation resolves `${env:NAME}` inside BOTH
// (docs/research/2026-09-15-devin-cursor-integration.md §2a) — so the
// bearer never reaches disk and the file is safe to read over someone's
// shoulder. Everything else in the file is another tool's business: merge,
// never rewrite.

export const CURSOR_CONFIG_REL = [".cursor", "mcp.json"] as const;
/** The schema URL OpenCode's own docs open every example with. */
export const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

export function cursorConfigFile(home: string): string {
  return join(home, ...CURSOR_CONFIG_REL);
}

/** The one entry this verb owns, so the shape lives in exactly one place (the tests assert on this, not on a string). */
export function cursorServerEntry(mcpUrl: string, varName: string): { url: string; headers: Record<string, string> } {
  return { url: mcpUrl, headers: { Authorization: `Bearer \${env:${varName}}` } };
}

/**
 * Merge one server into Cursor's global config and return whether anything
 * changed. 0600 because the file names a Metistry origin and another
 * server's entry may not be as careful with its own credentials as this one
 * is. A file that is not JSON is an error, never a clobber.
 */
export async function writeCursorConfig(file: string, key: string, mcpUrl: string, varName: string): Promise<"written" | "unchanged"> {
  let doc: Record<string, unknown> = {};
  let before = "";
  if (existsSync(file)) {
    before = await readFile(file, "utf8");
    if (before.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(before);
      } catch (err) {
        throw new Error(
          `${file} is not JSON this verb can merge into (${err instanceof Error ? err.message : String(err)}) — fix it, or add this entry by hand under "mcpServers": ${JSON.stringify({ [key]: cursorServerEntry(mcpUrl, varName) })}`,
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object, so there is no "mcpServers" to merge into`);
      doc = parsed as Record<string, unknown>;
    }
  }
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${file}'s "mcpServers" is not an object — refusing to replace it`);
  const next = { ...doc, mcpServers: { ...servers, [key]: cursorServerEntry(mcpUrl, varName) } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === before) return "unchanged";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return "written";
}

/** The entry this verb wrote, if it is there — how `--list` knows Cursor is configured. */
export async function readCursorServer(file: string, key: string): Promise<{ url: string } | undefined> {
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  const entry = (doc as { mcpServers?: Record<string, { url?: unknown }> })?.mcpServers?.[key];
  return entry && typeof entry.url === "string" ? { url: entry.url } : undefined;
}

// ---- OpenCode's config -------------------------------------------------------
//
// OpenCode takes remote MCP servers as `mcp.<name> = { type: "remote", url,
// headers }` and substitutes `{env:NAME}` anywhere in a config file
// (opencode.ai/docs/mcp-servers and /docs/config, both checked 2026-09-16) —
// so, exactly as with Cursor, the bearer never reaches disk. Everything else
// in the file is the owner's business: merge, never rewrite.
//
// Global, not per-project: `~/.config/opencode/opencode.json` (or
// `$XDG_CONFIG_HOME/opencode/…`, which `opencode debug paths` confirms wins
// when it is set). A project `opencode.json` is documented as "safe to be
// checked into Git", and an entry naming this instance's origin in a repo
// someone else clones is a footgun; a project override is one hand-copied
// block for anyone who wants it (docs/ops/opencode.md).

export const OPENCODE_CONFIG_DIR_REL = [".config", "opencode"] as const;

/** OpenCode's config directory: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export function opencodeConfigDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  return xdg ? join(xdg, "opencode") : join(home, ...OPENCODE_CONFIG_DIR_REL);
}

/**
 * The file to merge into. OpenCode loads `opencode.json` AND `opencode.jsonc`,
 * in that order, so when a `.jsonc` is already there it is the one that has the
 * last word — and therefore the one this verb writes. Otherwise `.json`, which
 * is what the docs tell people to create.
 */
export function opencodeConfigFile(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = opencodeConfigDir(home, env);
  const jsonc = join(dir, "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
}

/** The one entry this verb owns, so the shape lives in exactly one place (the tests assert on this, not on a string). */
export function opencodeServerEntry(mcpUrl: string, varName: string): { type: "remote"; url: string; enabled: true; headers: Record<string, string> } {
  return { type: "remote", url: mcpUrl, enabled: true, headers: { Authorization: `Bearer {env:${varName}}` } };
}

/**
 * Merge one server into OpenCode's global config and return whether anything
 * changed. 0600 for the same reason Cursor's file gets it: it names a Metistry
 * origin, and another server's entry may not be as careful with its own
 * credentials as this one is. A file that is not JSON is an error, never a
 * clobber — which is also what happens to a `.jsonc` that really does carry
 * comments, and the message says what to paste in by hand.
 */
export async function writeOpencodeConfig(file: string, key: string, mcpUrl: string, varName: string): Promise<"written" | "unchanged"> {
  let doc: Record<string, unknown> = {};
  let before = "";
  if (existsSync(file)) {
    before = await readFile(file, "utf8");
    if (before.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(before);
      } catch (err) {
        throw new Error(
          `${file} is not JSON this verb can merge into (${err instanceof Error ? err.message : String(err)}) — fix it, or add this entry by hand under "mcp": ${JSON.stringify({ [key]: opencodeServerEntry(mcpUrl, varName) })}`,
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object, so there is no "mcp" block to merge into`);
      doc = parsed as Record<string, unknown>;
    }
  }
  const servers = (doc.mcp ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error(`${file}'s "mcp" is not an object — refusing to replace it`);
  // `$schema` first if the file had none: OpenCode's own docs open every
  // example with it, and an editor with the schema is how a typo gets caught.
  const next = { ...(doc.$schema === undefined ? { $schema: OPENCODE_SCHEMA } : {}), ...doc, mcp: { ...servers, [key]: opencodeServerEntry(mcpUrl, varName) } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === before) return "unchanged";
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return "written";
}

/** The entry this verb wrote, if it is there — how `--list` knows OpenCode is configured. */
export async function readOpencodeServer(file: string, key: string): Promise<{ url: string } | undefined> {
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  const entry = (doc as { mcp?: Record<string, { url?: unknown }> })?.mcp?.[key];
  return entry && typeof entry.url === "string" ? { url: entry.url } : undefined;
}

// ---- output ------------------------------------------------------------------

/**
 * What the operator reads. Every instruction a tool needs is here and
 * nowhere else, so `--json` can stay a data shape; the only secret any of
 * it can print is a `paste` tool's bearer, which exists in the result
 * exactly on the run that minted it.
 */
export function renderConnect(r: ConnectResult): string {
  const spec = TOOL_SPECS[r.tool];
  const lines: string[] = [];
  lines.push(`${r.display_name} → ${r.mcp_url}`);
  lines.push(
    `agent     ${r.agent_id} (${r.created ? "registered now" : r.rotated ? "token rotated" : "already registered"}), kind external, grants ${describeGrants(r.grants)}${
      r.projects.length ? `, projects ${r.projects.join(", ")}` : ""
    }`,
  );
  if (r.token === "unchanged") {
    lines.push(`token     unchanged — the console returns an agent token only when it mints or rotates one. \`metistry connect ${r.tool} --rotate\` issues a new one (the old one stops working immediately).`);
  }
  if (r.pending) {
    lines.push(
      `pending   this row enrolled --remote, so the bearer below authenticates NOTHING until you let it in: answer the "${r.display_name}" item in Needs You, or POST /api/agents/${r.agent_id}/approve. Until then ${r.mcp_url} and /capture answer the same 401 an unknown token gets.`,
    );
  }
  lines.push("");

  if (r.tool === "cursor") {
    lines.push(`config    ${r.config_file} → mcpServers.${r.config_key} (${r.config_state}, 0600; every other server left alone)`);
    if (r.token === "keychain") lines.push(`token     stored in the login Keychain as ${r.keychain_service} under account ${r.keychain_account} — not printed, not written to ${r.config_file}`);
    lines.push("");
    lines.push(`Cursor resolves \${env:${r.token_var}} in the header, so the bearer never reaches disk — but a GUI app inherits no shell. Put this in your shell profile:`);
    lines.push("");
    lines.push(`  export ${r.token_var}="$(security find-generic-password -a ${r.keychain_account} -s ${r.keychain_service} -w)"`);
    lines.push("");
    lines.push(`then start Cursor from that shell (\`cursor .\`), not from the Dock — the CLI shim passes its environment to the app it launches. ${spec.doc} has the whole story, including how to widen the read grant.`);
  } else if (r.tool === "opencode") {
    lines.push(`config    ${r.config_file} → mcp.${r.config_key} (${r.config_state}, 0600; every other server left alone)`);
    if (r.token === "keychain") lines.push(`token     stored in the login Keychain as ${r.keychain_service} under account ${r.keychain_account} — not printed, not written to ${r.config_file}`);
    lines.push("");
    lines.push(`OpenCode substitutes {env:${r.token_var}} when it reads the config, so the bearer never reaches disk. Put this in the profile OpenCode inherits:`);
    lines.push("");
    lines.push(`  export ${r.token_var}="$(security find-generic-password -a ${r.keychain_account} -s ${r.keychain_service} -w)"`);
    lines.push("");
    lines.push(`then start OpenCode from that shell. \`opencode mcp list\` is the check that it worked. ${spec.doc} has the whole story, including how to widen the read grant and how to capture finished sessions (\`node plugins/opencode/install.mjs\`).`);
  } else if (r.tool === "claude-code") {
    if (r.token === "keychain") lines.push(`token     stored in the login Keychain as ${r.keychain_service} under account ${r.keychain_account} — not printed`);
    lines.push("");
    lines.push("The plugin reads its environment and nothing else. Put these in the profile Claude Code inherits (or `env` in ~/.claude/settings.json):");
    lines.push("");
    lines.push(`  export METISTRY_URL=${r.console_url}`);
    lines.push(`  export METISTRY_OWNER_TOKEN="$(security find-generic-password -a ${r.keychain_account} -s ${r.keychain_service} -w)"`);
    lines.push("  export METISTRY_CAPTURE_ON_STOP=1   # optional: the SessionEnd summary hook, default off");
    lines.push("");
    lines.push("This verb mints the token; it does not install the plugin — `/plugin marketplace add foldedspacelabs/metistry` then `/plugin install metistry@metistry` (docs/ops/claude-code-plugin.md).");
  } else {
    lines.push("Devin has no config file to write — register the server once, by hand, at Customize → MCPs (personal scope needs no admin):");
    lines.push("");
    lines.push(`  name         ${r.paste?.name}`);
    lines.push(`  transport    ${r.paste?.transport}`);
    lines.push(`  url          ${r.paste?.url}`);
    lines.push(`  auth method  Auth Header`);
    lines.push(`  header       ${r.paste?.header}: ${r.paste?.bearer ?? "(unchanged — rerun with --rotate to be shown a new one)"}`);
    lines.push("");
    if (r.paste?.bearer) lines.push("That bearer is shown ONCE. Paste it now; if it is lost, `--rotate` mints another and invalidates this one.");
    if (r.loopback) {
      lines.push(
        `${r.mcp_url} is loopback: a Devin CLI session on this Mac reaches it, Devin's cloud does not. An inbound path for cloud Devin (a tunnel with the console's own auth in front) is not chosen yet — plan refresh §4b "Exposure", ${spec.doc}.`,
      );
    }
    lines.push(`Devin's "Test listing tools" button is the check that the token works before you trust it.`);
  }
  return lines.join("\n");
}

export function describeGrants(g: Grants): string {
  const tier = g.tier === "areas" ? `areas (${g.areas.join(", ")})` : g.tier;
  return `tier ${tier}${g.queries ? " + queries" : ""}`;
}

// ---- `connect --list` --------------------------------------------------------

export interface ConnectListRow {
  tool: ConnectTool;
  display_name: string;
  /** `registered` | `pending` | `revoked` | `absent` — what the console's registry says */
  agent: "registered" | "pending" | "revoked" | "absent";
  grants?: Grants;
  projects?: string[];
  last_seen_at?: string | null;
  /** what this tool's own end looks like: the config file's entry, or the shape that has no file */
  config: string;
  /** is the bearer where this verb puts it? `n/a` for a `paste` tool, `unknown` off macOS */
  token: "keychain" | "absent" | "n/a" | "unknown";
}

export interface ConnectListOptions extends Omit<ConnectOptions, "tool" | "rotate" | "areas" | "projects"> {}

export async function connectList(opts: ConnectListOptions): Promise<{ console_url: string; tools: ConnectListRow[] }> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realExec;
  const ns = await loadNamespace(opts.instanceDir);
  if (ns) applyPorts(env, ns);
  const suffix = ns?.labelSuffix;
  const target = await consoleTarget({ env, platform, exec, ...(opts.instanceId ? { instanceId: opts.instanceId } : {}) });
  const api: Api = { target, fetchFn: opts.fetchFn ?? fetch, timeoutMs: opts.timeoutMs ?? 10_000 };
  const listed = ((await call(api, "GET", "/api/agents")).json.agents ?? []) as AgentRow[];
  const key = serverKey(suffix);
  const home = opts.home ?? env.HOME ?? "";
  const tools: ConnectListRow[] = [];
  for (const tool of CONNECT_TOOLS) {
    const spec = TOOL_SPECS[tool];
    const row = listed.find((a) => a.id === tool);
    const varName = agentTokenVar(tool, suffix);
    const account = accountFor(varName, { user: keychainAccount(env), ...(opts.instanceId ? { instance: opts.instanceId } : {}) });
    let token: ConnectListRow["token"] = "n/a";
    if (spec.config !== "paste") {
      token = platform !== "darwin" ? "unknown" : (await new Keychain(exec, account).hasSecret(varName)) ? "keychain" : "absent";
    }
    let config: string;
    if (spec.config === "file" && tool === "opencode") {
      const file = opencodeConfigFile(home, env);
      const entry = await readOpencodeServer(file, key);
      config = entry ? `${file} → mcp.${key}` : `${file}: no ${key} entry`;
    } else if (spec.config === "file") {
      const file = cursorConfigFile(home);
      const entry = await readCursorServer(file, key);
      config = entry ? `${file} → mcpServers.${key}` : `${file}: no ${key} entry`;
    } else if (spec.config === "env") {
      config = `environment (METISTRY_URL + METISTRY_OWNER_TOKEN)`;
    } else {
      config = "pasted into the tool's own UI (no file)";
    }
    tools.push({
      tool,
      display_name: spec.displayName,
      agent: row === undefined ? "absent" : row.revoked === true ? "revoked" : row.pending === true ? "pending" : "registered",
      ...(row ? { grants: normalizeGrants(row.grants), projects: row.projects ?? [], last_seen_at: row.last_seen_at ?? null } : {}),
      config,
      token,
    });
  }
  return { console_url: target.url, tools };
}

/** How a row's `agent`/`token` reads at a glance — the word is kept, the colour comes from the vocabulary (docs/ops/cli-style.md). */
const LIST_STATUS: Record<string, string> = { registered: "ok", keychain: "ok", pending: "degraded", revoked: "failed", absent: "n/a", "n/a": "n/a", unknown: "n/a" };

export function renderConnectList(r: { console_url: string; tools: ConnectListRow[] }, ui: Ui = defaultUi()): string {
  const word = (v: string): string => `${ui.statusIcon(LIST_STATUS[v] ?? "n/a")} ${ui.paint(statusName(LIST_STATUS[v] ?? "n/a"), v)}`;
  const rows = r.tools.map((t) => [t.tool, word(t.agent), word(t.token), ui.dim(t.config)]);
  return [
    ui.kv([["console", r.console_url]], { indent: 0 }),
    "",
    ui.table(["tool", "agent", "token", "config"], rows),
    "",
    ...ui
      .wrap(
        "agent: the row in this instance's registry (absent = `metistry connect <tool>` has not run; pending = enrolled --remote and awaiting your approval, so its token authenticates nothing; revoked is permanent).",
      )
      .split("\n")
      .map((l) => ui.dim(l)),
    ...ui
      .wrap("token: whether the bearer is in the login Keychain where this verb puts it — its value is never read here.")
      .split("\n")
      .map((l) => ui.dim(l)),
  ].join("\n");
}
