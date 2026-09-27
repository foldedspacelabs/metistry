// `metistry console whoami` / `console call` — ask the console who it
// thinks you are, or make one authenticated request against it, with the
// local owner token (docs/ops/auth.md).
//
// `whoami` is the verb the Mac app calls to render "signed in as owner"
// without a passkey ceremony, and the one an operator runs to prove the door
// works before blaming the app. `call` is the scripting seam behind it — the
// same door, any method and path, for the app and the second-instance guide.
// Both are deliberately the whole client: one request, an Authorization
// header always and (for `call`, on request) an Idempotency-Key, no state.
// The token is never printed and never reaches argv — it goes into an
// Authorization header and nowhere else, and every error message is
// redacted against it before it leaves this file.

import { Keychain, keychainAccount } from "./keychain.js";
import { realExec, type Exec } from "./exec.js";
import { applyPorts, loadNamespace } from "./namespace.js";
import { accountFor } from "./secrets.js";

/** Where the console is, from the host's vantage. The watchdog's variable, then the plugin's, then the default. */
export const CONSOLE_URL_VARS = ["METISTRY_CONSOLE_URL", "METISTRY_URL"] as const;
export const DEFAULT_CONSOLE_URL = "http://127.0.0.1:8080";

export interface ConsoleTargetOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** this instance's `instance_id`: the Keychain account METISTRY_LOCAL_OWNER_TOKEN is filed under */
  instanceId?: string | undefined;
  /**
   * this instance's directory. A namespaced one (`.metistry/state/ports.yaml`)
   * has its console on its own port, not 8080 — without this an `--instance`
   * pointed at a second instance would send ITS owner token to the default
   * install's console.
   */
  instanceDir?: string | undefined;
  exec?: Exec | undefined;
  platform?: NodeJS.Platform | undefined;
}

export interface ConsoleTarget {
  url: string;
  token: string;
  /** where the token came from, for the "not set" message and `--json` — never the value */
  tokenFrom: "env" | "keychain";
}

function normalizeUrl(v: string): string {
  return v.trim().replace(/\/+$/, "");
}

/**
 * The console's URL and this install's owner token.
 *
 * The URL: METISTRY_CONSOLE_URL, then METISTRY_URL, then the default. For a
 * namespaced instance (`opts.instanceDir` with a `state/ports.yaml`) the
 * namespace fills METISTRY_CONSOLE_URL when nothing set it — the same
 * `applyPorts` rule `doctor`, `connect` and `up` apply, so an explicit URL
 * in the environment or `state/.env` still wins and the default 8080 is
 * never reached for an instance that has its own port. The caller's
 * environment is copied, never mutated.
 *
 * The token: the environment (which is `<instance>/state/.env`, already loaded) comes first; the login
 * Keychain is the fallback, under the account the scope table files
 * METISTRY_LOCAL_OWNER_TOKEN under — the instance's, with the per-user account
 * behind it for an item that has not been migrated yet.
 */
export async function consoleTarget(opts: ConsoleTargetOptions = {}): Promise<ConsoleTarget> {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  const ns = await loadNamespace(opts.instanceDir);
  if (ns) applyPorts(env, ns);
  const platform = opts.platform ?? process.platform;
  const url = normalizeUrl(CONSOLE_URL_VARS.map((v) => env[v]).find((v) => (v ?? "").trim() !== "") ?? DEFAULT_CONSOLE_URL);
  let token = (env.METISTRY_LOCAL_OWNER_TOKEN ?? "").trim();
  let tokenFrom: ConsoleTarget["tokenFrom"] = "env";
  if (!token && platform === "darwin") {
    const exec = opts.exec ?? realExec;
    const user = keychainAccount(env);
    const account = accountFor("METISTRY_LOCAL_OWNER_TOKEN", { user, ...(opts.instanceId ? { instance: opts.instanceId } : {}) });
    token = (await new Keychain(exec, account).getSecret("METISTRY_LOCAL_OWNER_TOKEN"))?.trim() ?? "";
    if (!token && account !== user) token = (await new Keychain(exec, user).getSecret("METISTRY_LOCAL_OWNER_TOKEN"))?.trim() ?? "";
    tokenFrom = "keychain";
  }
  if (!token) {
    throw new Error(
      "METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain) — `metistry secrets sync --to env` mints one for an install that predates it, then restart the console",
    );
  }
  return { url, token, tokenFrom };
}

/** Redact before printing: the token must not reach stdout, a log, or an error message. */
function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

export interface Whoami {
  url: string;
  /** `user` (a passkey session or the local owner token) or `owner_token` (a capture token) */
  principal: string;
  /** how it was proved: `local_owner_token` | `passkey_session` | `owner_token` */
  via: string;
  /** may this credential reach the management surface (devices, agents, projects)? */
  management: boolean;
  /** the console's canonical origin, so a mismatch with the browser's is visible here */
  origin?: string;
  as_of?: string;
}

export interface WhoamiOptions extends ConsoleTargetOptions {
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * GET /api/whoami with the owner token. A 401 here is the interesting case
 * and gets the whole diagnosis: either the token in this environment is not
 * the one the console was started with, or the request did not arrive from
 * this machine (which, under compose, is a NAT question — see
 * METISTRY_TRUSTED_LOOPBACK_PROXY).
 */
export async function whoami(opts: WhoamiOptions = {}): Promise<Whoami> {
  const target = await consoleTarget(opts);
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${target.url}/api/whoami`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, target.token)}`);
  }
  if (res.status === 401) {
    throw new Error(
      `${target.url} refused the owner token (401). Either METISTRY_LOCAL_OWNER_TOKEN here is not the one the console was started with (\`metistry restart console\` makes it read .env's value), or the request did not reach it from this machine — under compose the console needs METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md).`,
    );
  }
  if (!res.ok) throw new Error(`${target.url}/api/whoami returned HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Whoami>;
  return {
    url: target.url,
    principal: String(body.principal ?? "unknown"),
    via: String(body.via ?? "unknown"),
    management: body.management === true,
    ...(body.origin ? { origin: body.origin } : {}),
    ...(body.as_of ? { as_of: body.as_of } : {}),
  };
}

export function renderWhoami(w: Whoami): string {
  return [
    `console    ${w.url}`,
    `principal  ${w.principal}`,
    `via        ${w.via}`,
    `management ${w.management ? "yes" : "no"}`,
    ...(w.origin ? [`origin     ${w.origin}`] : []),
  ].join("\n");
}

/**
 * True for the hostnames the local owner token is actually good for. It is
 * minted for THIS machine's loopback (docs/ops/auth.md) — a console reached
 * any other way is not the door this token opens, and `console call` refuses
 * before it ever puts the token in a header aimed at one.
 */
export function isLoopbackConsoleUrl(url: string): boolean {
  try {
    // Node's URL keeps an IPv6 host bracketed (`[::1]`); strip the brackets
    // before comparing rather than special-casing the bracketed spelling.
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}

export interface ConsoleCallOptions extends ConsoleTargetOptions {
  method: string;
  /** must start with `/` — this is a path on the console, not a whole URL */
  path: string;
  /** raw bytes, sent as-is (this verb does not parse or reshape a request body) */
  body?: string | undefined;
  /**
   * Sent as the `Idempotency-Key` header (docs/ops/console-api.md, currently
   * read only by `POST /capture`). Checked against the same shape the server
   * enforces — trimmed, non-empty, at most 200 characters — before the
   * request ever goes out, so a bad key is a local refusal, not a round trip.
   */
  idempotencyKey?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ConsoleCallResult {
  status: number;
  /** the response, parsed — the raw text when it does not parse as JSON, so a non-JSON answer is not swallowed */
  body: unknown;
  /** exactly what the console sent back, byte for byte — what `--json` prints */
  raw: string;
  /** the console's `idempotency-replayed` response header: this is the ORIGINAL response to the key, not a new write */
  replayed: boolean;
}

/**
 * `Idempotency-Key`'s shape, mirrored from the server's own check
 * (`apps/console/src/server.ts`, `POST /capture`): trimmed, non-empty, at
 * most 200 characters. Refusing here — before `consoleTarget` even resolves a
 * token — is the same "fail before the network" rule `isLoopbackConsoleUrl`
 * follows below.
 */
function normalizeIdempotencyKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 200) {
    throw new Error(`--idempotency-key must be non-empty and at most 200 characters once trimmed, not ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

/**
 * One authenticated request against the instance's console, as the `user`
 * principal — the same owner token `console whoami` presents, over the same
 * loopback door. It is the scripting seam: no shape of its own, no retries,
 * no interpretation of the response beyond "does it parse as JSON" — the
 * caller (a script, the app, a person at a terminal) decides what the answer
 * means. `opts.idempotencyKey`, when given, rides as `Idempotency-Key` and
 * `replayed` on the result reports back the console's own
 * `idempotency-replayed` header — the CLI's only way to say "this is the
 * original response, not a new write" since it prints no headers.
 */
export async function consoleCall(opts: ConsoleCallOptions): Promise<ConsoleCallResult> {
  const idempotencyKey = opts.idempotencyKey !== undefined ? normalizeIdempotencyKey(opts.idempotencyKey) : undefined;
  const target = await loopbackConsoleTarget(opts, "`console call`");
  let res: Response;
  try {
    res = await sendConsoleRequest(target, {
      method: opts.method,
      path: opts.path,
      body: opts.body,
      idempotencyKey,
      fetchFn: opts.fetchFn,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact((err as { cause?: { message?: string } })?.cause?.message ?? err, target.token)}`);
  }
  return readConsoleResponse(res);
}

/**
 * `consoleTarget`, refused unless it is loopback. The one gate both `console
 * call` and `console session` pass before the token goes into any header —
 * `verb` only names who is refusing, in the sentence.
 */
async function loopbackConsoleTarget(opts: ConsoleTargetOptions, verb: string): Promise<ConsoleTarget> {
  const target = await consoleTarget(opts);
  if (!isLoopbackConsoleUrl(target.url)) {
    throw new Error(
      `${target.url} is not loopback — the local owner token this verb presents is minted for THIS machine only (docs/ops/auth.md) and ${verb} refuses to send it anywhere else. Point METISTRY_CONSOLE_URL/METISTRY_URL at a loopback address, or use a passkey session for a remote console.`,
    );
  }
  return target;
}

interface ConsoleRequest {
  method: string;
  path: string;
  body?: string | undefined;
  idempotencyKey?: string | undefined;
  /** `Last-Event-ID`, for a stream resuming where it left off (design-build-plan §2.20) */
  lastEventId?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  signal: AbortSignal;
}

/** The one place a request to the console is built: the bearer, and the two optional headers. */
function sendConsoleRequest(target: ConsoleTarget, req: ConsoleRequest): Promise<Response> {
  const fetchFn = req.fetchFn ?? fetch;
  return fetchFn(`${target.url}${req.path}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(req.idempotencyKey !== undefined ? { "idempotency-key": req.idempotencyKey } : {}),
      ...(req.lastEventId !== undefined ? { "last-event-id": req.lastEventId } : {}),
      ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(req.body !== undefined ? { body: req.body } : {}),
    signal: req.signal,
  });
}

async function readConsoleResponse(res: Response): Promise<ConsoleCallResult> {
  const raw = await res.text();
  let body: unknown = raw;
  if (raw !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      /* not JSON: raw text stands */
    }
  } else {
    body = null;
  }
  return { status: res.status, body, raw, replayed: res.headers.get("idempotency-replayed") === "true" };
}

/** The error envelope's `code`/`message` (and `field`, when the response carries one), for a non-2xx `console call`. */
export function renderConsoleCallError(r: ConsoleCallResult): string {
  const envelope = r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>).error : undefined;
  const e = envelope && typeof envelope === "object" ? (envelope as { code?: unknown; message?: unknown; field?: unknown }) : undefined;
  const field = e?.field ?? (r.body && typeof r.body === "object" ? (r.body as Record<string, unknown>).field : undefined);
  return [`HTTP ${r.status}`, e?.code ? String(e.code) : undefined, e?.message ? String(e.message) : undefined, field ? `(field: ${String(field)})` : undefined]
    .filter((s): s is string => s !== undefined)
    .join(" — ");
}

// ---------------------------------------------------------------------------
// `metistry console session --stdio` — the same door, held open.
//
// `console call` costs a whole process per request (node's start, the env
// load, the token lookup — ~140 ms on the scratch instance, measured for
// F-12), which is fine for a script and wrong for an app that repaints a
// board. The session is that verb as ONE long-lived child: the token is
// resolved once, at start, and every request after that is a line of JSON on
// stdin answered by a line of JSON on stdout.
//
//   in   {id, method, path, body?, idempotency_key?, stream?, last_event_id?}
//        {id, cancel: true}                         — ends a stream
//   out  {id, status, body, replayed?}              — the console answered
//        {id, event: {id, type, data}}              — one frame of an open stream
//        {id, event: {id}}                          — the stream's position with
//                                                     nothing to dispatch (the
//                                                     console's cursor for a
//                                                     fresh subscriber)
//        {id, ended: "cancelled" | "closed"}        — a stream's last line (or
//                                                     a request cancelled before
//                                                     its answer)
//        {id, error: {code, message}}               — nothing was asked, or no
//                                                     answer came
//
// Every request gets exactly ONE terminal line (`status` or `error`), so a
// client can hold a table of what is in flight and know when an entry is
// done. Requests run concurrently; responses match by `id`, never by order.
//
// What it will not do: send the token anywhere but a loopback console (it
// refuses at start, before reading a line), stream anything but `GET
// /api/events` (§2.20 — one subscription, ids never bodies), or print the
// token — every line it writes is redacted against it, on the same rule as
// every error message above.

/** The one route a request may mark `stream: true` (design-build-plan §2.20). */
export const SESSION_STREAM_PATH = "/api/events";
const SESSION_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type SessionId = string | number;

export interface ConsoleSessionOptions extends ConsoleTargetOptions {
  /** the request lines, one JSON object per line — the process's stdin */
  input: AsyncIterable<string>;
  /** one output line, written whole — the process's stdout. Resolves once written. */
  write: (line: string) => Promise<void> | void;
  fetchFn?: typeof fetch | undefined;
  /** per-request timeout for a non-stream request; a stream has none */
  timeoutMs?: number | undefined;
}

class SessionRefusal extends Error {
  constructor(
    readonly code: "invalid_request" | "duplicate_id",
    message: string,
  ) {
    super(message);
  }
}

interface SessionRequest {
  id: SessionId;
  method: string;
  path: string;
  body?: string;
  idempotencyKey?: string;
  lastEventId?: string;
  stream: boolean;
}

function sessionId(v: unknown): SessionId | undefined {
  if (typeof v === "string" && v !== "" && v.length <= 200) return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  return undefined;
}

/** One request line, checked — every refusal is a sentence the client gets back on the same id. */
function parseSessionRequest(o: Record<string, unknown>, id: SessionId, target: ConsoleTarget): SessionRequest {
  const method = typeof o.method === "string" ? o.method.toUpperCase() : "";
  if (!SESSION_METHODS.has(method)) throw new SessionRefusal("invalid_request", `method must be one of ${[...SESSION_METHODS].join(", ")}`);
  const path = typeof o.path === "string" ? o.path : "";
  // A path on THIS console: absolute, and the URL it makes keeps the
  // console's own origin — the token never rides to a host a path smuggled in.
  if (!path.startsWith("/") || path.startsWith("//") || new URL(`${target.url}${path}`).origin !== new URL(target.url).origin) {
    throw new SessionRefusal("invalid_request", "path must be an absolute path on the console, e.g. /api/whoami");
  }
  const stream = o.stream === true;
  if (stream && (method !== "GET" || path.split("?")[0] !== SESSION_STREAM_PATH)) {
    throw new SessionRefusal("invalid_request", `only GET ${SESSION_STREAM_PATH} may be a stream`);
  }
  if (o.stream !== undefined && typeof o.stream !== "boolean") throw new SessionRefusal("invalid_request", "stream must be true or false");
  const req: SessionRequest = { id, method, path, stream };
  if (o.body !== undefined) {
    if (method === "GET") throw new SessionRefusal("invalid_request", "a GET carries no body");
    req.body = JSON.stringify(o.body);
  }
  if (o.idempotency_key !== undefined) {
    if (typeof o.idempotency_key !== "string") throw new SessionRefusal("invalid_request", "idempotency_key must be a string");
    try {
      req.idempotencyKey = normalizeIdempotencyKey(o.idempotency_key);
    } catch (e) {
      throw new SessionRefusal("invalid_request", (e as Error).message.replace("--idempotency-key", "idempotency_key"));
    }
  }
  if (o.last_event_id !== undefined) {
    if (!stream || typeof o.last_event_id !== "string" || o.last_event_id === "" || o.last_event_id.length > 200) {
      throw new SessionRefusal("invalid_request", "last_event_id is a non-empty string, on a stream request only");
    }
    req.lastEventId = o.last_event_id;
  }
  return req;
}

/**
 * Server-Sent Events, framed: `id:`, `event:` and `data:` fields, a blank
 * line dispatching (the WHATWG rule), `:` lines being comments — the
 * console's heartbeat. `data` is parsed as JSON and left as text when it is
 * not; an unknown `type` passes through (the client ignores types it does
 * not know, so an additive type on a newer console breaks nothing).
 *
 * A block with an `id:` and no `data:` dispatches nothing, but it still moves
 * the stream's position (WHATWG: the last event ID is set before the empty
 * data buffer returns). The console sends exactly that to a fresh subscriber
 * — its cursor, so a client that hears nothing before a reconnect resumes
 * from there rather than from nothing — and it is passed on as `{id}` alone:
 * no `type`, no `data`, nothing to refetch, only an id to hand back as
 * `last_event_id`. Dropping it left a session client with no cursor at all
 * until the first real event.
 */
type SseFrame = { id?: string; type: string; data: unknown } | { id: string };

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let type = "";
  let data: string[] = [];
  let sawId = false; // this block carried an `id:` line
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (data.length > 0) {
            const text = data.join("\n");
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* not JSON: the text stands */
            }
            yield { ...(id !== undefined ? { id } : {}), type: type || "message", data: parsed };
          } else if (sawId && id !== undefined && id !== "") {
            yield { id }; // the cursor: a position with nothing to dispatch
          }
          type = "";
          data = [];
          sawId = false;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") {
          id = value;
          sawId = true;
        }
        else if (field === "event") type = value;
        else if (field === "data") data.push(value);
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Start consuming `input` NOW, before the caller's first await, and hold
 * every line until it is asked for. A readline interface emits a line the
 * moment stdin has one, and its async iterator only receives the lines that
 * arrive after the iterator exists — so a session that awaited anything
 * (the target, the Keychain) before starting its `for await` silently lost
 * whatever the parent wrote at spawn, and that call hung until its own
 * timeout. `close()` stops reading and discards what is held.
 */
function bufferedLines(input: AsyncIterable<string>): AsyncIterable<string> & { close: () => void } {
  const it = input[Symbol.asyncIterator]();
  const queue: string[] = [];
  let done = false;
  let closed = false;
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  const poke = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  void (async () => {
    try {
      for (;;) {
        const r = await it.next();
        if (r.done || closed) break;
        queue.push(r.value);
        poke();
      }
    } catch (error) {
      failure = { error };
    } finally {
      done = true;
      poke();
    }
  })();
  return {
    close: () => {
      closed = true;
      queue.length = 0;
      void Promise.resolve(it.return?.()).catch(() => undefined);
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (failure) throw failure.error;
        if (done || closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/**
 * Run one session to the end of its input. Stdin is attached before
 * anything is awaited, so a line the parent writes at spawn is held, not
 * lost. Then the target and the token are resolved ONCE — a refusal there
 * (no token, a non-loopback console) throws before any held line is sent
 * anywhere, every held line is discarded unanswered, and the caller prints
 * the reason and exits non-zero. After that nothing throws: every failure
 * is an `{id, error}` line.
 */
export async function runConsoleSession(opts: ConsoleSessionOptions): Promise<void> {
  const input = bufferedLines(opts.input);
  let target: ConsoleTarget;
  try {
    target = await loopbackConsoleTarget(opts, "`console session`");
  } catch (e) {
    input.close();
    throw e;
  }
  const clean = (s: string) => redact(s, target.token);
  const emit = (o: Record<string, unknown>) => opts.write(clean(JSON.stringify(o)));
  const inFlight = new Map<SessionId, { abort: AbortController; stream: boolean; cancelled: boolean }>();
  const running = new Set<Promise<void>>();

  const refuse = (id: SessionId | null, code: string, message: string) => emit({ id, error: { code, message: clean(message) } });

  const handle = async (req: SessionRequest, entry: { abort: AbortController; stream: boolean; cancelled: boolean }) => {
    // The id is free again BEFORE its terminal line goes out: a client that
    // reuses an id the moment it has its answer must not be told it is busy.
    const finish = (o: Record<string, unknown>) => {
      if (inFlight.get(req.id) === entry) inFlight.delete(req.id);
      return emit({ id: req.id, ...o });
    };
    let res: Response;
    try {
      res = await sendConsoleRequest(target, {
        method: req.method,
        path: req.path,
        body: req.body,
        idempotencyKey: req.idempotencyKey,
        lastEventId: req.lastEventId,
        fetchFn: opts.fetchFn,
        signal: req.stream ? entry.abort.signal : AbortSignal.any([entry.abort.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]),
      });
    } catch (err) {
      if (entry.cancelled) return void (await finish({ ended: "cancelled" }));
      const why = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error)?.message ?? String(err);
      return void (await finish({ error: { code: "unreachable", message: clean(`console unreachable at ${target.url}: ${why}`) } }));
    }
    const eventStream = req.stream && res.ok && (res.headers.get("content-type") ?? "").startsWith("text/event-stream") && res.body !== null;
    if (!eventStream) {
      // Not a stream after all — a 401, a 404 on a console that does not
      // serve the route yet, anything — so it is an ordinary answer.
      const r = await readConsoleResponse(res);
      return void (await finish({ status: r.status, body: r.body, ...(r.replayed ? { replayed: true } : {}) }));
    }
    try {
      for await (const frame of sseFrames(res.body as ReadableStream<Uint8Array>)) {
        await emit({ id: req.id, event: frame });
      }
      await finish({ ended: entry.cancelled ? "cancelled" : "closed" });
    } catch (err) {
      if (entry.cancelled) return void (await finish({ ended: "cancelled" }));
      await finish({ error: { code: "unreachable", message: clean(`the stream from ${target.url} broke: ${(err as Error)?.message ?? String(err)}`) } });
    }
  };

  for await (const raw of input) {
    const line = raw.trim();
    if (line === "") continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      o = parsed as Record<string, unknown>;
    } catch {
      await refuse(null, "invalid_request", "each line is one JSON object");
      continue;
    }
    const id = sessionId(o.id);
    if (id === undefined) {
      await refuse(null, "invalid_request", "id must be a non-empty string (at most 200 characters) or an integer");
      continue;
    }
    if (o.cancel === true) {
      const entry = inFlight.get(id);
      // Cancelling what already finished is not an error: the terminal line
      // for it is already on its way, and that line is the answer.
      if (entry) {
        entry.cancelled = true;
        entry.abort.abort();
      }
      continue;
    }
    if (inFlight.has(id)) {
      await refuse(id, "duplicate_id", `id ${JSON.stringify(id)} is still in flight — responses match by id, so it cannot be reused until its answer is out`);
      continue;
    }
    let req: SessionRequest;
    try {
      req = parseSessionRequest(o, id, target);
    } catch (e) {
      await refuse(id, e instanceof SessionRefusal ? e.code : "invalid_request", (e as Error).message);
      continue;
    }
    const entry = { abort: new AbortController(), stream: req.stream, cancelled: false };
    inFlight.set(id, entry);
    const p = handle(req, entry)
      .catch((e) => {
        if (inFlight.get(id) === entry) inFlight.delete(id);
        return refuse(id, "unreachable", (e as Error)?.message ?? String(e));
      })
      // stdout itself is gone (the parent died): there is no one to tell
      .catch(() => undefined)
      .finally(() => running.delete(p));
    running.add(p);
  }
  // Input closed: nobody is left to read a stream, so every stream ends; a
  // plain request still gets its answer written before the process goes.
  for (const entry of inFlight.values()) {
    if (entry.stream) {
      entry.cancelled = true;
      entry.abort.abort();
    }
  }
  await Promise.all([...running]);
}
