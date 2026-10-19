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
import { parse as parseYaml } from "yaml";
import { cancelEnrollmentCode, finishRun, instanceFile, mintEnrollmentCode, startRun, type CancelEnrollmentOutcome } from "@foldedspacelabs/metistry-core";
import { openDbFromEnv, type Db } from "./doctor.js";
import { readInstanceId } from "./instance.js";
import { checkOriginReachable, checkOriginShape, firstOrigin, type EnrollRefusal } from "./origins.js";
import type { Ui } from "./ui.js";

// The origin checks themselves live in origins.ts (X-105), because the
// remote-access doctor rows and the environment renderer ask the same
// questions of METISTRY_ORIGIN; this verb keeps its names.
export {
  ENROLL_FIX,
  ENROLL_HEALTH_TIMEOUT_MS,
  checkOriginReachable,
  checkOriginShape,
  firstOrigin,
  isLoopbackHost,
  providerPhrase,
  type EnrollRefusal,
  type EnrollRefusalCase,
  type OriginShape,
  type ReachabilityOptions,
} from "./origins.js";

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
