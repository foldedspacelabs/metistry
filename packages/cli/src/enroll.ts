// `metistry enroll` — add a phone (plan §2.22, M19). Mints a one-time passkey
// enrolment code on THIS Mac and prints the URL the phone opens; `--cancel
// <code_id>` kills an unused one at once.
//
// The root of trust does not move (plan §4.2): shell access to the host is what
// mints a first credential, so no HTTP route does this — not an unauthenticated
// one and not a `local` one. The Mac app drives this verb (`--json`) exactly as
// it drives every other management verb (X-77).
//
// The mint is core's `mintEnrollmentCode` — the function the console spends a
// code with, so the two can never disagree on the hash or the lifetime. That
// makes this the CLI's second direct Postgres path after the migration runner
// (and doctor's liveness probe): the same invariant-3 exception, ruled in
// §2.22, because a code is a credential and the console must have no door
// that mints one.
//
// REFUSES BEFORE MINTING when the phone cannot possibly complete the ceremony
// against the first `METISTRY_ORIGIN` entry — loopback, `http:`, an IP literal,
// or an origin this Mac itself cannot reach (or that names another instance).
// Each refusal is a code path with a test (U3); a refusal mints nothing. The
// checks are necessary, not sufficient: a name that resolves only on this Mac
// still passes, which is why the output says "Your phone must be able to open
// <host>".

import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { parse as parseYaml } from "yaml";
import { cancelEnrollmentCode, finishRun, instanceFile, mintEnrollmentCode, startRun, type CancelEnrollmentOutcome } from "@foldedspacelabs/metistry-core";
import { openDbFromEnv, type Db } from "./doctor.js";
import { readInstanceId } from "./instance.js";
import type { Ui } from "./ui.js";

/** How long `GET <origin>/health` has to answer from this Mac. */
export const ENROLL_HEALTH_TIMEOUT_MS = 5000; // limit: fixed — §2.22's own number ("within 5 s"); a refusal rule, not a tunable

export type EnrollRefusalCase = "origin_unset" | "origin_invalid" | "loopback" | "http" | "ip_literal" | "unreachable" | "other_instance";

export interface EnrollRefusal {
  case: EnrollRefusalCase;
  /** the refusal's own words — §2.22's table, verbatim where it has a row */
  message: string;
  /** the first METISTRY_ORIGIN entry as read, or null when there was none */
  origin: string | null;
  /** the pointer every refusal ends with */
  fix: string;
  /** what was observed, when a message alone would hide it (the failing probe) */
  detail?: string;
}

/** Every refusal ends here (§2.22): Settings ▸ Remote Access on the Mac, `metistry remote` in a terminal, and the guide. */
export const ENROLL_FIX =
  "Choose how your phone reaches this Mac in Settings ▸ Remote Access (`metistry remote` in a terminal); docs/ops/auth.md (\"Passkeys: origins\") says what METISTRY_ORIGIN has to be.";

/** The first `METISTRY_ORIGIN` entry — the canonical one passkeys bind to (docs/ops/auth.md) — trimmed, without a trailing slash; undefined when unset or blank. */
export function firstOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const first = (env.METISTRY_ORIGIN ?? "").split(",")[0]?.trim().replace(/\/+$/, "") ?? "";
  return first === "" ? undefined : first;
}

/** `[::1]` → `::1`; a URL's hostname keeps the brackets, `net.isIP` does not want them. */
function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** `127.0.0.0/8`, `::1`, its IPv4-mapped form, and `localhost` — every install's default (`init` writes `http://127.0.0.1:<port>`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

export type OriginShape = { ok: true; url: URL } | { ok: false; refusal: EnrollRefusal };

/**
 * The three refusals that need no network, in §2.22's order: loopback first —
 * so the default `http://127.0.0.1:8080` gets the refusal that names the
 * actual problem (nothing but this Mac can reach it), not the `http:` one.
 */
export function checkOriginShape(origin: string | undefined): OriginShape {
  const refuse = (c: EnrollRefusalCase, message: string): OriginShape => ({ ok: false, refusal: { case: c, message, origin: origin ?? null, fix: ENROLL_FIX } });
  if (origin === undefined) {
    return refuse("origin_unset", "METISTRY_ORIGIN is not set, so there is no address for your phone to open. Set it to the https:// hostname your phone will open, then run metistry enroll again.");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuse("origin_invalid", `METISTRY_ORIGIN is ${origin}, which is not a URL. Set it to the https:// address your phone will open.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse("origin_invalid", `METISTRY_ORIGIN is ${origin}, which is not a web address. Set it to the https:// address your phone will open.`);
  }
  const host = bareHost(url);
  if (isLoopbackHost(host)) {
    return refuse("loopback", "Your phone can't reach this Mac yet: Metistry only answers on this Mac. Choose how your phone reaches it in Settings ▸ Remote Access (`metistry remote set`).");
  }
  if (url.protocol === "http:") {
    return refuse("http", `A passkey needs HTTPS. METISTRY_ORIGIN is ${origin}; set it to the https:// address your phone will open.`);
  }
  if (isIP(host) !== 0) {
    return refuse("ip_literal", `A passkey needs a name, not an IP address. METISTRY_ORIGIN is ${origin}; set it to a hostname your phone can open.`);
  }
  return { ok: true, url };
}

export interface ReachabilityOptions {
  fetchFn?: typeof fetch | undefined;
  /** this instance's `instance_id`; absent = the identity comparison is skipped (there is nothing to compare against) */
  instanceId?: string | undefined;
  /** what `metistry remote` recorded (`deployment.yaml` `remote.provider`), for the refusal's wording */
  provider?: string | undefined;
  timeoutMs?: number | undefined;
}

/** The provider the refusal names: what `deployment.yaml` records (§2.23), or a generic phrase until one is chosen. */
export function providerPhrase(provider: string | undefined): string {
  return provider && provider !== "none" ? provider : "your remote-access provider";
}

/**
 * The fourth refusal (§2.22): `GET <origin>/health` does not answer from this
 * Mac within 5 s, or `GET <origin>/api/identity` names another instance's
 * `instance_id`. Any HTTP answer to /health counts as answering — a 503 is a
 * console that is unwell, not one the phone cannot reach.
 */
export async function checkOriginReachable(url: URL, opts: ReachabilityOptions = {}): Promise<EnrollRefusal | undefined> {
  const origin = url.origin;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? ENROLL_HEALTH_TIMEOUT_MS;
  const unreachable = (detail: string, c: EnrollRefusalCase = "unreachable"): EnrollRefusal => ({
    case: c,
    message: `${origin} doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what ${providerPhrase(opts.provider)} reports.`,
    origin,
    fix: ENROLL_FIX,
    detail,
  });
  try {
    await fetchFn(`${origin}/health`, { method: "GET", signal: AbortSignal.timeout(timeout), redirect: "manual" });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no answer within ${timeout / 1000} s` : e instanceof Error ? e.message : String(e);
    return unreachable(`GET ${origin}/health: ${why}`);
  }
  if (!opts.instanceId) return undefined;
  let body: unknown;
  try {
    const res = await fetchFn(`${origin}/api/identity`, { method: "GET", signal: AbortSignal.timeout(timeout), redirect: "manual" });
    if (!res.ok) return undefined; // 503 not_available: an instance `init` has not stamped is not another instance
    body = await res.json();
  } catch {
    return undefined; // /health answered; an identity that cannot be read proves nothing about whose it is
  }
  const theirs = body !== null && typeof body === "object" ? (body as { instance_id?: unknown }).instance_id : undefined;
  if (typeof theirs === "string" && theirs !== "" && theirs !== opts.instanceId) {
    return unreachable(`GET ${origin}/api/identity names instance ${theirs}, not this one (${opts.instanceId}) — that address reaches a different Metistry`, "other_instance");
  }
  return undefined;
}

/** `remote.provider` from the instance's `deployment.yaml` (§2.23), when the file has one; never throws. */
export async function readRemoteProvider(instanceDir: string | undefined): Promise<string | undefined> {
  if (!instanceDir) return undefined;
  try {
    const doc = parseYaml(await readFile(instanceFile(instanceDir, "deployment"), "utf8")) as unknown;
    const remote = doc !== null && typeof doc === "object" ? (doc as { remote?: unknown }).remote : undefined;
    const provider = remote !== null && typeof remote === "object" ? (remote as { provider?: unknown }).provider : undefined;
    return typeof provider === "string" && provider.trim() !== "" ? provider.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface EnrollOptions {
  /** the install's environment, already loaded (`METISTRY_ORIGIN`, `METISTRY_DB_*`) */
  env: NodeJS.ProcessEnv;
  instanceDir?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  /** test seam: the database to mint in; default opens one from `METISTRY_DB_*` and closes it */
  db?: Db | undefined;
  timeoutMs?: number | undefined;
}

/** `--json`'s one document: `{url, code_id, origin, expires_at}` (§2.22). `code_id` is the row's id, never the code. */
export interface EnrollMinted {
  url: string;
  code_id: number;
  origin: string;
  expires_at: string;
}

export type EnrollResult = { kind: "minted"; minted: EnrollMinted } | { kind: "refused"; refusal: EnrollRefusal };

export class NoDatabaseError extends Error {
  constructor() {
    super("no database configured (METISTRY_DB_PASSWORD is unset) — run from the install's environment: `--instance <dir>` picks up <instance>/.metistry/state/.env");
    this.name = "NoDatabaseError";
  }
}

async function withDb<T>(opts: { env: NodeJS.ProcessEnv; db?: Db | undefined }, fn: (db: Db) => Promise<T>): Promise<T> {
  if (opts.db) return fn(opts.db);
  const db = await openDbFromEnv(opts.env);
  if (!db) throw new NoDatabaseError();
  try {
    return await fn(db);
  } finally {
    await db.end?.().catch(() => {});
  }
}

/**
 * Mint, or refuse. Every check runs BEFORE a database connection is opened, so
 * a refusal writes no `auth_enrollment_codes` row and touches nothing. A mint
 * lands in `runs` (`auth` / `enroll`) like every add and remove (§2.22).
 */
export async function enroll(opts: EnrollOptions): Promise<EnrollResult> {
  const origin = firstOrigin(opts.env);
  const shape = checkOriginShape(origin);
  if (!shape.ok) return { kind: "refused", refusal: shape.refusal };
  const [instanceId, provider] = await Promise.all([opts.instanceDir ? readInstanceId(opts.instanceDir) : Promise.resolve(undefined), readRemoteProvider(opts.instanceDir)]);
  const unreachable = await checkOriginReachable(shape.url, { fetchFn: opts.fetchFn, instanceId, provider, timeoutMs: opts.timeoutMs });
  if (unreachable) return { kind: "refused", refusal: unreachable };
  return withDb(opts, async (db) => {
    const runId = await startRun(db, { component: "cli", kind: "auth", tool: "enroll", meta: { origin: shape.url.origin } });
    try {
      const minted = await mintEnrollmentCode(db);
      await finishRun(db, runId, { ok: true, meta: { code_id: minted.code_id, expires_at: minted.expires_at } });
      return { kind: "minted", minted: { url: `${shape.url.origin}/#enroll=${minted.code}`, code_id: minted.code_id, origin: shape.url.origin, expires_at: minted.expires_at } };
    } catch (e) {
      await finishRun(db, runId, { ok: false, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
      throw e;
    }
  });
}

/** `--cancel <code_id>` takes a positive integer id and nothing else — never a code. */
export function parseCodeId(raw: string | true | undefined): number | undefined {
  if (typeof raw !== "string" || !/^[1-9]\d{0,17}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

export interface EnrollCancelled {
  code_id: number;
  outcome: CancelEnrollmentOutcome;
  /** true only when this call killed a live code */
  cancelled: boolean;
}

/** Expire an unused code at once. Idempotent from the caller's side: a code already dead is reported, not an error; one that never existed is. */
export async function enrollCancel(opts: EnrollOptions & { codeId: number }): Promise<EnrollCancelled> {
  return withDb(opts, async (db) => {
    const runId = await startRun(db, { component: "cli", kind: "auth", tool: "enroll_cancel", meta: { code_id: opts.codeId } });
    try {
      const outcome = await cancelEnrollmentCode(db, opts.codeId);
      await finishRun(db, runId, { ok: outcome !== "not_found", meta: { outcome } });
      return { code_id: opts.codeId, outcome, cancelled: outcome === "cancelled" };
    } catch (e) {
      await finishRun(db, runId, { ok: false, error: e instanceof Error ? e.message : String(e) }).catch(() => {});
      throw e;
    }
  });
}

// ---- rendering --------------------------------------------------------------

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The URL, what it is good for, and how to kill it — stdout. The code is in the URL and nowhere else. */
export function renderEnrollMinted(m: EnrollMinted, ui: Ui): string {
  const host = new URL(m.origin).host;
  return [
    `Open this on the phone — it works once, for 10 minutes (until ${clock(m.expires_at)}):`,
    `  ${ui.strong(m.url)}`,
    `Your phone must be able to open ${host}.`,
    ui.dim(`Code ${m.code_id} — \`metistry enroll --cancel ${m.code_id}\` ends it early.`),
  ].join("\n");
}

/** The refusal's own words, METISTRY_ORIGIN named, the fix — stderr. */
export function renderEnrollRefusal(r: EnrollRefusal): string {
  const lines = [`metistry enroll: refused — ${r.message}`];
  if (!r.message.includes("METISTRY_ORIGIN")) lines.push(`  METISTRY_ORIGIN is ${r.origin ?? "not set"} (its first entry is the address the phone opens).`);
  if (r.detail) lines.push(`  ${r.detail}`);
  lines.push(`  ${r.fix}`);
  return lines.join("\n");
}

export function renderEnrollCancelled(c: EnrollCancelled): string {
  switch (c.outcome) {
    case "cancelled":
      return `code ${c.code_id} cancelled — its URL is dead.`;
    case "already_used":
      return `code ${c.code_id} was already used; nothing to cancel.`;
    case "already_expired":
      return `code ${c.code_id} had already expired (or was cancelled); nothing to cancel.`;
    case "not_found":
      return `no enrolment code has id ${c.code_id}.`;
  }
}
