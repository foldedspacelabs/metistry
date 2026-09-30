// The egress door: one loopback HTTP CONNECT proxy, a hostname allowlist,
// and a bearer per confined child.
//
// WHY it exists. `ops/sandbox/assistant.sb` said the honest thing for a
// year: *"sandbox-exec filters outbound by PORT, not by name, so this list
// is documentation, not an enforced rule"*. SBPL cannot express
// `openrouter.ai`. It CAN express one loopback port — and a process
// listening there can name hosts all day. So the profiles now deny every
// outbound destination except the console, Postgres and THIS port, and the
// thing on this port is the only way out of the sandbox
// (docs/research/2026-09-19-agent-virtual-filesystems.md §1.A, the shape
// Anthropic's `sandbox-runtime` uses on macOS; the pattern, not the
// package — no dependency was added).
//
// Core owns the contract because three components have to agree on it:
// `metistry up` computes the allowlist, the supervisor serves it, and
// `metistry doctor` reports it. The arrow stays apps → packages.
//
// Deliberately small:
//
//   * **CONNECT only.** No TLS interception, no certificate authority, no
//     body inspection. The proxy learns a host name and a port and nothing
//     else — which is exactly the guarantee the profile could not make.
//   * **Exact host match.** No wildcards, no suffix rules, no regex. A
//     provider that moves to a new host name is a `compute.yaml` change and
//     an `up`, not a pattern that quietly admits a look-alike.
//   * **A bearer per child**, because loopback is not a trust boundary
//     (invariant 8) and because the audit row for a refusal has to be able
//     to say WHO asked. Basic proxy authentication is what both clients in
//     this product already speak: undici honours the userinfo in
//     `HTTPS_PROXY`, and git/curl answers a `407` challenge.

import { z } from "zod";
import { credentialEnvNames, credentialFromEnv, providerCredential, type Provider } from "./compute.js";
import { SecretRedactor } from "./redact.js";
import type { RunExecutor } from "./runs.js";
import { SECRET_GRANTEE_FORMS, SECRET_USE_META_KEY, fillSecretRefs, parseSecretGrantee, providerGrantee, secretGrant, secretRefsIn, type SecretSource, type SecretsFile, type SecretsPolicyRead } from "./secrets.js";

/** `metistry up` allocates the proxy this port when the instance has no namespace — after llamaserver's 7813, continuing the loopback block. */
export const EGRESS_PROXY_DEFAULT_PORT = 7814;

/** The proxy binds loopback and nothing else; a rule, not a default, so a config that says otherwise is refused. */
export const EGRESS_PROXY_HOST = "127.0.0.1";

/** What a confined child finds in its environment. `ALL_PROXY` is there for clients that read only that one. */
export const EGRESS_PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"] as const;

/**
 * Loopback destinations never go through the proxy: the console, Postgres,
 * the bridges and an on-machine model server are profile rules, not egress.
 * Both spellings plus the IPv6 literal, because undici's env agent compares
 * the URL's host textually.
 */
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";

/** `Proxy-Authenticate` realm and the `407` body — a fixed string, so it tells a caller nothing about the token. */
export const EGRESS_REALM = "metistry-egress";

/** The `runs.kind` every refusal lands under. Denials are a security event, so they are rows, not log lines. */
export const EGRESS_RUN_KIND = "egress";
/** `runs.component` for the proxy itself. */
export const EGRESS_COMPONENT = "egress-proxy";

/**
 * One allowlist entry: a host name, or `host:port` when the destination is
 * not 443.
 *
 * A bare entry means port 443 ONLY. That is the whole of this product's
 * off-machine traffic — an OpenAI-compatible provider over TLS and a git
 * remote over HTTPS — and admitting every port on an allowed host would
 * give a confined child a tunnel to whatever else that host runs.
 */
export const EGRESS_DEFAULT_PORT = 443;

export const egressEntrySchema = z
  .string()
  .min(1)
  .refine((s) => parseEgressEntry(s) !== undefined, { message: "must be a host name, or host:port" });

export const egressSchema = z
  .object({
    /** the loopback port the proxy binds; every confined child's profile allows exactly this one */
    port: z.number().int().positive(),
    /** host names (or `host:port`) a confined child may CONNECT to. Empty = the proxy refuses everything, which is a valid install with no off-machine provider and no remote */
    allow: z.array(egressEntrySchema).default([]),
    /** child name → bearer. The key is the identity that lands on the audit row; the value is minted once per install, like the control token */
    tokens: z.record(z.string().min(1), z.string().min(16)).default({}),
  })
  .strict();

export type Egress = z.infer<typeof egressSchema>;
export type EgressInput = z.input<typeof egressSchema>;

export interface EgressTarget {
  host: string;
  port: number;
}

/** `openrouter.ai` → `{host, 443}`; `example.test:8443` → `{host, 8443}`; anything else → undefined. */
export function parseEgressEntry(entry: string): EgressTarget | undefined {
  const s = entry.trim();
  if (s === "") return undefined;
  const colon = s.lastIndexOf(":");
  if (colon === -1) return isHostish(s) ? { host: s.toLowerCase(), port: EGRESS_DEFAULT_PORT } : undefined;
  const host = s.slice(0, colon);
  const port = Number(s.slice(colon + 1));
  if (!isHostish(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: host.toLowerCase(), port };
}

/**
 * A host name, an IPv4 literal, or a bracketed IPv6 literal — no scheme, no
 * path, no `*`. The wildcard is refused on purpose: `*.example.com` is the
 * rule that quietly admits `evil.example.com` the day a provider's DNS is
 * someone else's.
 */
function isHostish(s: string): boolean {
  if (s.startsWith("[") && s.endsWith("]")) return /^[0-9a-fA-F:]+$/.test(s.slice(1, -1));
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes("..") && !s.startsWith(".") && !s.endsWith(".");
}

/** The allowlist entry a URL contributes: its host, plus its port when that is not 443. `undefined` for loopback and for anything that is not a URL. */
export function egressEntryFor(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return undefined;
  const port = u.port === "" ? (u.protocol === "http:" ? 80 : EGRESS_DEFAULT_PORT) : Number(u.port);
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return port === EGRESS_DEFAULT_PORT ? bracketed.toLowerCase() : `${bracketed.toLowerCase()}:${port}`;
}

/** Loopback is the profile's business, never the proxy's — a confined child reaches the console and Postgres directly or not at all. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Is this CONNECT target allowed? Exact host match, case-insensitive, and
 * the port must match too.
 *
 * The child cannot widen this: the list is read from `supervisor.json`
 * BEFORE any child is spawned, lives in the supervisor's memory, and the
 * proxy takes nothing from the request but the target and the bearer.
 */
export function egressAllows(allow: readonly string[], target: EgressTarget): boolean {
  for (const entry of allow) {
    const t = parseEgressEntry(entry);
    if (t && t.host === target.host.toLowerCase() && t.port === target.port) return true;
  }
  return false;
}

/** `example.com:443` from a CONNECT request line. Undefined when it is not one — a proxy that guesses is a proxy that can be talked past. */
export function parseConnectTarget(requestUrl: string | undefined): EgressTarget | undefined {
  if (!requestUrl) return undefined;
  return parseEgressEntry(requestUrl.trim());
}

/**
 * `http://<child>:<token>@127.0.0.1:<port>` — the value both clients read.
 *
 * The bearer is in the URL because that is where undici's `EnvHttpProxyAgent`
 * and libcurl both look for it, and because it keeps the whole thing one
 * environment variable per child rather than a second file for a second
 * secret.
 */
export function egressProxyUrl(child: string, token: string, port: number, host: string = EGRESS_PROXY_HOST): string {
  return `http://${encodeURIComponent(child)}:${encodeURIComponent(token)}@${host}:${port}`;
}

/**
 * The environment a confined child needs to USE the door.
 *
 * `NODE_USE_ENV_PROXY=1` is the load-bearing one and is easy to miss: Node's
 * global `fetch` ignores `HTTPS_PROXY` unless it is asked to honour it
 * (undici's `EnvHttpProxyAgent`, behind `--use-env-proxy` since Node 22.15).
 * Verified on this install's Node 22.23.1: without it a `fetch` goes direct
 * and the profile — not the allowlist — is what refuses it, which is a worse
 * error message and a worse guarantee.
 */
export function egressProxyEnv(child: string, egress: { port: number; tokens: Record<string, string> }, host: string = EGRESS_PROXY_HOST): Record<string, string> {
  const token = egress.tokens[child];
  if (!token) return {};
  const url = egressProxyUrl(child, token, egress.port, host);
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: EGRESS_NO_PROXY,
    NODE_USE_ENV_PROXY: "1",
  };
}

/** What a refusal records. `at` is the proxy's clock; `runs.ts` stamps the row's own `ts`. */
export interface EgressDenial {
  child: string | null;
  host: string;
  port: number;
  reason: "unauthenticated" | "not-allowlisted" | "not-loopback" | "malformed";
  at: string;
}

/** One line for the supervisor's log, and the `meta` for the `runs` row — the same words in both places. */
export function describeDenial(d: EgressDenial): string {
  return `[egress] refused ${d.child ?? "an unauthenticated client"} → ${d.host}:${d.port} (${d.reason})`;
}

// =====================================================================================
// The secret fill (§2.14, T4-2): `{{ secret.name }}` is filled HERE, at egress, and
// only for a destination on that secret's *Sent only to* list.
// =====================================================================================
//
// WHY IT IS NOT THE PROXY. The proxy above is CONNECT-only on purpose: it
// learns a host and a port and never a byte of the tunnel, so it cannot see —
// let alone fill — a header. The fill therefore happens in the process that
// makes the call, just before TLS, and the proxy remains the second wall
// (the host must ALSO be on the install's allowlist to be dialled at all).
//
// WHERE IT SITS. `guardedFetch` is a `fetch` — the one shape every outbound
// caller in this product already takes as a seam: the engine's chat client
// (`fetchFn`), the MCP SDK's HTTP transport (`fetch`), a connection's client.
// A caller hands its request over with the references still in it and gets
// back a Response whose body and headers are already redacted. The filled
// request never exists outside this function, so there is nothing to log by
// mistake.
//
// What it makes impossible rather than discouraged — each a refusal with a
// code (`EgressRefused`), before a byte is sent:
//
//   * **A value to an unlisted host.** Every secret the request references
//     — or already carries literally, because a value the redactor knows is
//     the same secret however it got there — must list the exact destination
//     (host, and port when not 443) in `hosts:`. A secret that
//     `secrets.yaml` does not describe lists nothing. `host_not_listed`.
//   * **A value in a URL.** URLs land in logs, proxies and histories. A
//     reference, a known value (in any encoding), or userinfo in the URL is
//     flagged and the call refused. `secret_in_url`.
//   * **A value in a model's request body.** For `purpose: "model"` a
//     reference or a known value anywhere in the body is refused: the body
//     IS the model's context. A provider key still goes in a header.
//     `secret_in_model_body`.
//   * **A value over cleartext** to anything but loopback. `cleartext`.
//   * **A grantee the owner did not grant.** Off refuses (`not_granted`); Ask
//     refuses (`needs_approval`) unless the caller holds the owner's approval
//     for that name on this call.
//   * **A redirect carrying the value somewhere else.** A request that
//     carries a secret is sent with `redirect: "manual"`: a 3xx comes back to
//     the caller as a response, and following it is a new call through this
//     door, checked against the new host.
//
// And on the way back: the response body (streamed, with a carry so a value
// split across chunks is still caught), every response header, and any error
// are passed through the `SecretRedactor`, which learned each value the moment
// it was filled. A transcript shows `***REDACTED secret.<name>***`.
//
// Each call that sends a secret reports the NAMES it used (`onUse`) — which
// is what `recordSecretUse` stamps on the caller's `runs` row as
// `meta.secrets`, and what the `secret_last_used` query reads back as *last
// used* (T4-1).

/** What the call is for. `model`: a request to a compute provider — its body is the model's context, so no secret may be in it. `service`: anything else (a connection, a bridge). */
export const SECRET_EGRESS_PURPOSES = ["model", "service"] as const;
export type SecretEgressPurpose = (typeof SECRET_EGRESS_PURPOSES)[number];

/** Why the door refused. A closed set: each is a code path with a test (U3). */
export const EGRESS_REFUSAL_CODES = [
  "bad_url",
  "secret_in_url",
  "secret_in_model_body",
  "host_not_listed",
  "cleartext",
  "not_granted",
  "needs_approval",
  "missing_secret",
  "malformed_reference",
  "uninspectable_body",
  "not_provider_host",
] as const;
export type EgressRefusalCode = (typeof EGRESS_REFUSAL_CODES)[number];

/**
 * A refusal at the door. Names secrets and the destination — never a value;
 * the message is built from names only, so it is safe to show, log and
 * record as it is.
 */
export class EgressRefused extends Error {
  override readonly name = "EgressRefused";
  constructor(
    readonly code: EgressRefusalCode,
    readonly names: readonly string[],
    readonly destination: string | null,
    message: string,
  ) {
    super(`egress refused (${code}): ${message}`);
  }
}

/** The request as the caller writes it: references in, values never. */
export interface EgressCall {
  url: string;
  method?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/** The owner's rules for one caller's calls. `planEgress` needs all but the store; `guardedFetch` needs the store too. */
export interface SecretEgressRules {
  /** `.metistry/secrets.yaml`, parsed */
  secrets: SecretsFile;
  /** who is calling: `connection:<name>`, `agent:<id>` or `provider:<name>` — the grantee `secrets.yaml` grants to */
  grantee: string;
  purpose: SecretEgressPurpose;
  /** learns every value filled; redacts the way back. One per process that fills, shared by all its calls. */
  redactor: SecretRedactor;
  /** names whose **Ask** grant the owner approved for this call (the approval path, T4-9). Never read from the request. */
  approved?: readonly string[] | undefined;
}

export interface SecretEgressPolicy extends SecretEgressRules {
  /** one instance's store (`InstanceSecrets`) */
  source: SecretSource;
  /** told the NAMES (never values) once a call carrying them is sent — stamp them with `recordSecretUse` */
  onUse?: ((use: { names: string[]; destination: string }) => void | Promise<void>) | undefined;
}

/** Where a URL goes, spelled as a *Sent only to* entry: `host`, or `host:port` when not 443. */
export interface EgressDestination {
  entry: string;
  host: string;
  port: number;
  /** plain http to something that is not loopback */
  cleartext: boolean;
}

/** `https://api.github.com/x` → `api.github.com`; `http://127.0.0.1:7812/` → `127.0.0.1:7812`. Undefined for anything that is not an http(s) URL. Unlike `egressEntryFor`, loopback is a destination here: a secret for a local bridge still lists its host. */
export function egressDestination(url: string): EgressDestination | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const host = u.hostname.toLowerCase();
  if (host === "") return undefined;
  const port = u.port === "" ? (u.protocol === "http:" ? 80 : EGRESS_DEFAULT_PORT) : Number(u.port);
  return { entry: port === EGRESS_DEFAULT_PORT ? host : `${host}:${port}`, host, port, cleartext: u.protocol === "http:" && !isLoopbackHost(host) };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replaceAll("+", " "));
  } catch {
    return s;
  }
}

function unionSorted(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())].sort();
}

/** What a call will send, once every check has passed. Names only. */
export interface EgressPlan {
  destination: EgressDestination;
  /** references to fill */
  refs: string[];
  /** every secret the call carries: the references and any known value already in it */
  names: string[];
}

/**
 * Every check, and no value read: the refusal a call would get, or the plan
 * of what it would send. `guardedFetch` runs exactly this before it fills;
 * an Ask preview (T4-8b) can run it to say "sends github_write to
 * api.github.com" without touching the Keychain.
 */
export function planEgress(call: EgressCall, rules: SecretEgressRules): EgressPlan {
  if (!parseSecretGrantee(rules.grantee)) throw new Error(`${JSON.stringify(rules.grantee)} is not a grantee — ${SECRET_GRANTEE_FORMS}`);
  const destination = egressDestination(call.url);
  if (!destination) throw new EgressRefused("bad_url", [], null, `${JSON.stringify(call.url.slice(0, 200))} is not an http(s) URL`);
  const dest = destination.entry;

  // ---- a secret in the URL: flagged, and refused
  const inUrl = [call.url, safeDecode(call.url)];
  const urlRefs = inUrl.map((u) => secretRefsIn(u));
  const urlNames = unionSorted(...urlRefs.map((r) => r.names), ...inUrl.map((u) => rules.redactor.find(u)));
  const u = new URL(call.url);
  if (urlNames.length > 0 || urlRefs.some((r) => r.malformed.length > 0) || u.username !== "" || u.password !== "") {
    const what = urlNames.length > 0 ? urlNames.join(", ") : u.username !== "" || u.password !== "" ? "credentials in the URL's userinfo" : "a secret reference";
    throw new EgressRefused("secret_in_url", urlNames, dest, `${what} in a URL — a URL lands in logs and histories, so a secret goes in a header or the body, never the URL`);
  }

  // ---- what the headers and the body carry
  const headers = Object.entries(call.headers ?? {});
  for (const [name] of headers) {
    const r = secretRefsIn(name);
    if (r.names.length > 0 || r.malformed.length > 0 || rules.redactor.find(name).length > 0) {
      throw new EgressRefused("malformed_reference", r.names, dest, "a header NAME cannot carry a secret — only its value");
    }
  }
  const headerText = headers.map(([, v]) => v);
  const body = call.body ?? "";
  const headerRefs = headerText.map((v) => secretRefsIn(v));
  const bodyRefs = secretRefsIn(body);
  const malformed = unionSorted(...headerRefs.map((r) => r.malformed), bodyRefs.malformed);
  if (malformed.length > 0) throw new EgressRefused("malformed_reference", [], dest, `not a secret reference: ${malformed.join(", ")} — the form is {{ secret.name }}`);
  const bodyLiteral = rules.redactor.find(body);
  const headerLiteral = unionSorted(...headerText.map((v) => rules.redactor.find(v)));

  if (rules.purpose === "model" && (bodyRefs.names.length > 0 || bodyLiteral.length > 0)) {
    const names = unionSorted(bodyRefs.names, bodyLiteral);
    throw new EgressRefused("secret_in_model_body", names, dest, `${names.join(", ")} in a model request body — a model never receives a secret value`);
  }

  const refs = unionSorted(...headerRefs.map((r) => r.names), bodyRefs.names);
  const names = unionSorted(refs, bodyLiteral, headerLiteral);
  if (names.length === 0) return { destination, refs, names };

  // ---- only to listed hosts
  const unlisted = names.filter((n) => {
    const policy = Object.hasOwn(rules.secrets.secrets, n) ? rules.secrets.secrets[n] : undefined;
    return !policy || !policy.hosts.includes(dest);
  });
  if (unlisted.length > 0) {
    throw new EgressRefused("host_not_listed", unlisted, dest, `${unlisted.join(", ")} may not be sent to ${dest} — it is not on the secret's *Sent only to* list (\`metistry secrets hosts <name>\`)`);
  }
  if (destination.cleartext) {
    throw new EgressRefused("cleartext", names, dest, `${names.join(", ")} would go to ${dest} over plain http — a secret goes off this machine over https only`);
  }

  // ---- who may use it
  const approved = new Set(rules.approved ?? []);
  const off = names.filter((n) => secretGrant(rules.secrets, n, rules.grantee) === "off");
  if (off.length > 0) throw new EgressRefused("not_granted", off, dest, `${rules.grantee} is not granted ${off.join(", ")} (\`metistry secrets grant <name> ${rules.grantee} on|ask\`)`);
  const ask = names.filter((n) => secretGrant(rules.secrets, n, rules.grantee) === "ask" && !approved.has(n));
  if (ask.length > 0) throw new EgressRefused("needs_approval", ask, dest, `${rules.grantee} may use ${ask.join(", ")} only with the owner's approval of this call`);

  return { destination, refs, names };
}

/** Text of a request body the door can inspect; undefined when it cannot. */
async function bodyText(body: unknown): Promise<string | undefined | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * A stream that redacts as it goes. It holds back the last (longest form − 1)
 * characters of each chunk, so a value split across two chunks is still one
 * match: any form that starts before the held tail ends inside what has
 * already arrived, and the regex sees it whole.
 */
function redactingStream(redactor: SecretRedactor): TransformStream<string, string> {
  let buf = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buf += chunk;
      const hold = Math.max(0, redactor.longestForm - 1);
      const safe = buf.length - hold;
      if (safe <= 0) return;
      const { text, consumed } = redactor.redactPrefix(buf, safe);
      if (text !== "") controller.enqueue(text);
      buf = buf.slice(consumed);
    },
    flush(controller) {
      if (buf !== "") controller.enqueue(redactor.redactText(buf));
      buf = "";
    },
  });
}

async function redactResponse(res: Response, redactor: SecretRedactor): Promise<Response> {
  const headers = new Headers();
  res.headers?.forEach((value, key) => {
    // the body changes length when a value is redacted
    if (key === "content-length" || key === "content-encoding") return;
    headers.append(key, redactor.redactText(value));
  });
  const init = { status: res.status, statusText: redactor.redactText(res.statusText ?? ""), headers };
  if (NULL_BODY_STATUS.has(res.status) || res.body === null) return new Response(null, init);
  // A fetch seam that answers with a Response-LIKE (a test's fake, a
  // caller's own client) has no stream to pipe: read it whole, then redact.
  if (res.body === undefined) return new Response(redactor.redactText(await res.text()), init);
  const body = res.body.pipeThrough(new TextDecoderStream()).pipeThrough(redactingStream(redactor)).pipeThrough(new TextEncoderStream());
  return new Response(body, init);
}

/**
 * **The egress door for a call that may carry a secret** — a `fetch`.
 *
 * Hand it to anything that takes a fetch seam. Each call is planned
 * (`planEgress` — every refusal above), then its `{{ secret.name }}`
 * references are filled from the instance's store all or nothing, then sent;
 * the response comes back with every known value redacted, and a failure
 * comes back as an error with none in it.
 *
 * A body the door cannot read (a stream, a Blob, FormData) is refused: a body
 * that cannot be inspected is a body that could carry anything.
 */
export function guardedFetch(policy: SecretEgressPolicy, fetchFn: typeof fetch = fetch): typeof fetch {
  const { redactor } = policy;
  return async (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : input instanceof URL ? input.href : String(input);
    const headerBag = new Headers(request ? request.headers : undefined);
    new Headers(init.headers).forEach((v, k) => headerBag.set(k, v));
    const headers: Record<string, string> = {};
    headerBag.forEach((v, k) => (headers[k] = v));
    const rawBody = init.body !== undefined ? await bodyText(init.body) : request ? (request.body === null ? null : await request.text()) : null;
    if (rawBody === undefined) throw new EgressRefused("uninspectable_body", [], egressDestination(url)?.entry ?? null, "a request body the egress guard cannot read (a stream, a Blob, FormData) is not sent");
    const method = init.method ?? request?.method ?? "GET";

    const plan = planEgress({ url, method, headers, ...(rawBody === null ? {} : { body: rawBody }) }, policy);
    const dest = plan.destination.entry;

    // ---- fill, all or nothing, learning each value as it is read
    const recording: SecretSource = {
      async value(name) {
        const v = await policy.source.value(name);
        if (v) redactor.learn(name, v);
        return v;
      },
    };
    const filledHeaders: Record<string, string> = {};
    const missing = new Set<string>();
    for (const [k, v] of Object.entries(headers)) {
      const r = await fillSecretRefs(v, recording);
      if (r.ok) filledHeaders[k] = r.text;
      else r.missing.forEach((n) => missing.add(n));
    }
    let filledBody: string | null = rawBody;
    if (rawBody !== null) {
      const r = await fillSecretRefs(rawBody, recording);
      if (r.ok) filledBody = r.text;
      else r.missing.forEach((n) => missing.add(n));
    }
    if (missing.size > 0) {
      const names = [...missing].sort();
      throw new EgressRefused("missing_secret", names, dest, `no item in this instance for ${names.join(", ")} — \`metistry secrets set <name>\` stores one; nothing was sent`);
    }

    const out: RequestInit = { ...init, method, headers: filledHeaders };
    if (filledBody === null) delete out.body;
    else out.body = filledBody;
    if (plan.names.length > 0) out.redirect = "manual";

    let res: Response;
    try {
      res = await fetchFn(url, out);
    } catch (err) {
      if (plan.names.length > 0) await policy.onUse?.({ names: plan.names, destination: dest });
      throw redactor.redactError(err);
    }
    if (plan.names.length > 0) await policy.onUse?.({ names: plan.names, destination: dest });
    return await redactResponse(res, redactor);
  };
}

/**
 * Stamp the NAMES a call sent on its `runs` row — `meta.secrets`, a sorted
 * set, merged with any already there (a run that makes several calls
 * accumulates, it does not overwrite). `secret_last_used` reads it back as
 * *last used*. Takes any executor with pg's query shape, like `startRun`.
 */
export async function recordSecretUse(db: RunExecutor, runId: number, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await db.query(
    `UPDATE runs SET meta = jsonb_set(
       coalesce(meta, '{}'::jsonb), ARRAY[$3::text],
       (SELECT coalesce(jsonb_agg(DISTINCT n ORDER BY n), '[]'::jsonb)
          FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(meta -> $3::text) = 'array' THEN meta -> $3::text ELSE '[]'::jsonb END || $2::jsonb
          ) AS s(n)))
     WHERE id = $1`,
    [runId, JSON.stringify([...names]), SECRET_USE_META_KEY],
  );
}

// =====================================================================================
// Compute through the door (ruling 2 of the W2 checkpoint, 2026-09-27; X-7).
// =====================================================================================
//
// A model call is an egress like any other, and its credential is a secret
// like any other. Before this, the engine, the collectors' `completeJson`,
// the router's `scoreChoice` and the embedder each built their own
// `Authorization: Bearer <key>` and dialled whatever URL they had — the
// provider's key was held by the caller, and nothing but the caller's own
// care kept it off another host.
//
// `computeFetch` is the one `fetch` every compute call now goes through. The
// caller never holds the key: it hands over its request with NO credential,
// and the door adds it. What the door makes impossible, each a refusal
// (`EgressRefused`) before a byte is sent:
//
//   * **A call to a host that is not the provider's.** Every request must go
//     to the destination `base_url` names — the same host AND port. The key
//     is only ever attached to a request that passed that check, so it
//     cannot reach anything else, whatever URL a caller builds.
//     `not_provider_host`.
//   * **A provider key without its grant.** A `{{ secret.x }}` credential is
//     filled only when `secrets.yaml` grants `x` to `provider:<name>` (On —
//     Ask has no one to ask on a model call, so it refuses as
//     `needs_approval`), and only when `x`'s *Sent only to* lists the
//     provider's host: exactly `guardedFetch`'s rules, with the provider as
//     the grantee and `purpose: "model"`. A `secrets.yaml` that cannot be
//     read is no grant. `not_granted`, `host_not_listed`.
//   * **The key in the model's body**, as for every model call
//     (`secret_in_model_body`).
//
// An `env:NAME` credential (an install variable — a bridge bearer this
// install minted) has no line in `secrets.yaml` to grant it, so it is bound
// by the host rule alone: attached only to a call to the provider's own
// destination. Every credential is learned by the redactor, and the
// response and any error come back with it redacted.

/** Where a compute call's credential and policy come from. */
export interface ComputeEgressOptions {
  /** the provider's name in `compute.yaml` — its grantee is `provider:<name>` */
  providerName: string;
  provider: Provider;
  /** where the credential was delivered: this process's environment (`credentialEnvNames`). Never the Keychain. */
  env: NodeJS.ProcessEnv;
  /**
   * The owner's `secrets.yaml`, read at EACH call so a revoked grant takes
   * effect on the next request without a restart. Needed only for a
   * `{{ secret.x }}` credential; absent, such a credential is refused.
   */
  policy?: (() => SecretsPolicyRead | Promise<SecretsPolicyRead>) | undefined;
  /** learns the credential; redacts the way back. Default: one per door. */
  redactor?: SecretRedactor | undefined;
}

/** The destination a provider's calls may go to: its `base_url`'s host, and port when not 443. */
export function providerDestination(provider: Pick<Provider, "base_url">): EgressDestination | undefined {
  return egressDestination(provider.base_url);
}

/**
 * The host rule on its own: `url` must go to `baseUrl`'s destination (host,
 * and port when not 443), or it is refused as `not_provider_host` before
 * anything is sent. `who` names the caller in the refusal.
 */
export function requireProviderHost(baseUrl: string, who: string, url: string): EgressDestination {
  const home = egressDestination(baseUrl);
  const dest = egressDestination(url);
  if (!dest) throw new EgressRefused("bad_url", [], null, `${JSON.stringify(url.slice(0, 200))} is not an http(s) URL`);
  if (!home || dest.entry !== home.entry) {
    throw new EgressRefused("not_provider_host", [], dest.entry, `${who} calls go to ${home?.entry ?? "(a base_url that is not an http(s) URL)"} only — ${dest.entry} is not its host, so nothing was sent`);
  }
  return dest;
}

/**
 * A fetch-shaped function that dials `baseUrl`'s destination and nothing
 * else — the door for a compute call that carries NO credential (the
 * embedder). A call with a credential goes through `computeFetch`, which
 * applies the same rule first.
 */
export function hostBoundFetch<F extends (input: string, init: never) => Promise<unknown>>(baseUrl: string, who: string, fetchFn: F): F {
  return ((input: string, init: never) => {
    requireProviderHost(baseUrl, who, input);
    return fetchFn(input, init);
  }) as F;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

/** A redactor name for an environment variable: `METISTRY_BRIDGE_TOKEN_APPLE_FM` → `metistry_bridge_token_apple_fm`. */
function envRedactName(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
  return /^[a-z][a-z0-9_]{0,63}$/.test(n) ? n : "provider_credential";
}

/**
 * **The door for a compute call** — a `fetch` bound to ONE provider.
 *
 * Every call is checked against the provider's own destination, then its
 * credential (if the provider has one) is attached by the door itself —
 * through `guardedFetch` with `provider:<name>` as the grantee for an
 * instance secret — and the response comes back redacted. The caller passes
 * no `authorization` header; one it passes is replaced, never trusted.
 */
export function computeFetch(opts: ComputeEgressOptions, fetchFn: typeof fetch = (u, i) => fetch(u, i)): typeof fetch {
  const grantee = providerGrantee(opts.providerName);
  const redactor = opts.redactor ?? new SecretRedactor();
  const cred = providerCredential(opts.provider);
  return async (input, init = {}) => {
    const url = requestUrl(input);
    const dest = requireProviderHost(opts.provider.base_url, grantee, url);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    headers.delete("authorization");
    const plain: Record<string, string> = {};
    headers.forEach((v, k) => (plain[k] = v));

    if (!cred) return fetchFn(url, { ...init, headers: plain });

    if (cred.kind === "env") {
      const value = credentialFromEnv(cred, opts.env);
      if (!value) throw new EgressRefused("missing_secret", [], dest.entry, `${cred.name} is unset in this process's environment — nothing was sent`);
      if (dest.cleartext) throw new EgressRefused("cleartext", [], dest.entry, `${cred.name} would go to ${dest.entry} over plain http — a credential goes off this machine over https only`);
      const name = envRedactName(cred.name);
      redactor.learn(name, value);
      const body = typeof init.body === "string" ? init.body : "";
      if (redactor.find(body).length > 0) throw new EgressRefused("secret_in_model_body", [name], dest.entry, `${cred.name} in a model request body — a model never receives a credential`);
      let res: Response;
      try {
        res = await fetchFn(url, { ...init, headers: { ...plain, authorization: `Bearer ${value}` }, redirect: "manual" });
      } catch (err) {
        throw redactor.redactError(err);
      }
      return await redactResponse(res, redactor);
    }

    // `{{ secret.x }}`: the owner's grant to THIS provider, or nothing is sent
    const read = opts.policy ? await opts.policy() : undefined;
    if (!read || !read.ok) {
      const why = !read ? "this process was handed no secrets.yaml to read the grant from — METISTRY_INSTANCE_DIR is unset or unreadable here" : read.why;
      throw new EgressRefused("not_granted", [cred.name], dest.entry, `${grantee} may not use ${cred.name}: its grant cannot be checked (${why}) — a provider key is sent only on a grant the owner wrote (\`metistry secrets grant ${cred.name} ${grantee} on\`)`);
    }
    const source: SecretSource = { value: async (n) => (n === cred.name ? credentialFromEnv(cred, opts.env) : undefined) };
    const door = guardedFetch({ secrets: read.file, grantee, purpose: "model", redactor, source }, async (u, i) => fetchFn(u, i));
    try {
      return await door(url, { ...init, headers: { ...plain, authorization: `Bearer {{ secret.${cred.name} }}` } });
    } catch (err) {
      if (err instanceof EgressRefused && err.code === "missing_secret") {
        throw new EgressRefused("missing_secret", [cred.name], dest.entry, `{{ secret.${cred.name} }} has not reached this process (${credentialEnvNames(cred).join(" or ")} is unset) — \`metistry secrets sync --to env\`; nothing was sent`);
      }
      throw err;
    }
  };
}
