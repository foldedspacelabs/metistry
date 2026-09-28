// A provider that REFUSED a turn — out of credits (402), or the key it was
// sent was not accepted (401/403) — is a state to report, not an outage to
// retry (C96: events become requests; a failed provider is a `report`).
//
// The 0.14.2 owner report: OpenRouter answered `402 This request requires
// more credits`, the drain tried the turn again, every attempt landed on
// `runs` with the same error, the thread got "that turn failed — it's
// logged; try again", and nothing said the one thing that would fix it. A
// retry of a 402 buys exactly the same 402.
//
// So, enforced here and not by any prompt:
//
//   1. NO RETRY. The engine already retries only 429/5xx; the drain's
//      stale-session fallback skips these too (drain.ts).
//   2. ONE REPORT per (provider, error class) while one is waiting — a mirror
//      keyed `provider-refused:<provider>#<class>` (core's `raiseMirror`), so
//      a storm of turns raises one row, and its title counts the turns
//      waiting behind it.
//   3. THE PROVIDER IS PAUSED while that report waits: a turn assigned to it
//      is HELD (`inbound_messages.status = 'held'`), never sent. Dismissing
//      the report, or any later turn on that provider succeeding, releases
//      every held turn back to `new`, oldest first. One held turn is let
//      through as a probe every `PROVIDER_PROBE_MS`, so topping up is enough
//      to get going again even if the report is never answered.
//
// Rules and budgets still decide first (invariant 4): a turn resolves its
// tier and passes the budget guard exactly as before — this only decides
// whether a provider that has already said no is asked again.

import { raiseMirror, resolveAtSource, type Provider, type RequestSource } from "@foldedspacelabs/metistry-core";
import { EngineHttpError } from "./engine-openai.js";

export interface RefusalDb {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The statuses that mean "this provider will not serve this account until the owner acts". */
export const PROVIDER_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
/** `inbound_messages.status` of a turn waiting on a paused provider. Not claimed by the drain until released. */
export const HELD_STATUS = "held";
/** The request's source system: the subject is this instance's own compute. */
export const PROVIDER_SOURCE_KIND = "metistry";
/** What raises the report — the drain, never an agent. */
export const PROVIDER_AGENT = "assistant";
/** `payload.event`, for a client drawing it. */
export const PROVIDER_REFUSED_EVENT = "provider_refused";
/** While paused, one held turn is tried this often — so a top-up is noticed without anyone answering the report. */
export const PROVIDER_PROBE_MS = 10 * 60_000; // limit: fixed — one refused call per provider per ten minutes costs nothing (a 402 bills nothing) and notices a top-up within the time it takes to read the report
/** How much of the provider's own message the report and the reply carry. */
const MESSAGE_EXCERPT = 500; // limit: fixed — an excerpt a phone shows without scrolling; `runs.error` has all of it

const REF = "provider-refused:";

export type RefusalClass = "credits" | "credential";

export interface ProviderRefusal {
  status: number;
  cls: RefusalClass;
  /** The provider's own words, from its error body — what the owner reads. */
  message: string;
}

/** Is this error a provider refusing the account (not the request)? */
export function providerRefusal(err: unknown): ProviderRefusal | undefined {
  if (!(err instanceof EngineHttpError) || !PROVIDER_REFUSED_STATUSES.has(err.status)) return undefined;
  return { status: err.status, cls: err.status === 402 ? "credits" : "credential", message: providerMessage(err.body) || `HTTP ${err.status}` };
}

/** `{error: {message}}` (OpenAI, OpenRouter), `{message}`, or the text itself — clipped. */
export function providerMessage(body: string): string {
  let text = body.trim();
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === "object" && j.error !== null ? j.error.message : typeof j.error === "string" ? j.error : j.message;
    if (typeof m === "string" && m.trim() !== "") text = m.trim();
  } catch {
    /* not JSON: the text is the message */
  }
  return text.length > MESSAGE_EXCERPT ? `${text.slice(0, MESSAGE_EXCERPT - 1)}…` : text;
}

/** One subject per (provider, class): credits and a bad key are two different things to fix. */
export function refusedSource(provider: string, cls: RefusalClass): RequestSource {
  return { kind: PROVIDER_SOURCE_KIND, external_ref: `${REF}${provider}#${cls}` };
}

/** Where the owner tops up: the provider's own credits page where it is known, else its site. */
export function topUpUrl(provider: Provider | undefined): string | undefined {
  if (!provider) return undefined;
  let url: URL;
  try {
    url = new URL(provider.base_url);
  } catch {
    return undefined;
  }
  if (url.hostname === "openrouter.ai" || url.hostname.endsWith(".openrouter.ai")) return "https://openrouter.ai/settings/credits";
  return url.origin;
}

const turns = (n: number): string => `${n} turn${n === 1 ? "" : "s"} waiting`;

/** The title the owner reads — rewritten as turns queue behind it. */
export function refusalTitle(provider: string, cls: RefusalClass, status: number, waiting: number, url?: string): string {
  return cls === "credits"
    ? `${provider}: out of credits — top up at ${url ?? "the provider's billing page"}; ${turns(waiting)}`
    : `${provider}: the key was refused (HTTP ${status}) — replace it in Settings › Secrets; ${turns(waiting)}`;
}

/** Is a report for this provider waiting — i.e. is the provider paused? */
export async function pausedFor(db: RefusalDb, provider: string): Promise<boolean> {
  const prefix = `${REF}${provider}#`;
  const { rows } = await db.query(
    `SELECT 1 FROM proposals WHERE decision = 'pending' AND source->>'kind' = $1 AND left(source->>'external_ref', $2) = $3 LIMIT 1`,
    [PROVIDER_SOURCE_KIND, prefix.length, prefix],
  );
  return rows.length > 0;
}

/** Has the provider been asked within the probe window? Postgres's clock on both sides. */
async function askedRecently(db: RefusalDb, provider: string, probeMs: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM runs WHERE component = 'assistant' AND kind = 'turn' AND provider = $1
                     AND started_at > now() - make_interval(secs => $2)) AS recent`,
    [provider, probeMs / 1000],
  );
  return rows[0]?.recent === true;
}

/** May a turn on a paused provider go out now, as the probe? */
export async function probeDue(db: RefusalDb, provider: string, probeMs = PROVIDER_PROBE_MS): Promise<boolean> {
  return !(await askedRecently(db, provider, probeMs));
}

/** Held turns for this provider. */
async function heldCount(db: RefusalDb, provider: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM inbound_messages WHERE status = $1 AND meta->'held'->>'provider' = $2`, [HELD_STATUS, provider]);
  return Number(rows[0]?.n ?? 0);
}

/** Keep every waiting report's count (and so its title) true. */
async function refreshWaiting(db: RefusalDb, provider: string): Promise<void> {
  const prefix = `${REF}${provider}#`;
  const { rows } = await db.query(
    `SELECT id, payload FROM proposals WHERE decision = 'pending' AND source->>'kind' = $1 AND left(source->>'external_ref', $2) = $3`,
    [PROVIDER_SOURCE_KIND, prefix.length, prefix],
  );
  if (rows.length === 0) return;
  const waiting = await heldCount(db, provider);
  for (const r of rows) {
    const p = r.payload ?? {};
    const cls: RefusalClass = p.error_class === "credential" ? "credential" : "credits";
    const title = refusalTitle(provider, cls, Number(p.status ?? 0), waiting, typeof p.top_up === "string" ? p.top_up : undefined);
    await db.query(`UPDATE proposals SET payload = payload || $2::jsonb WHERE id = $1 AND decision = 'pending'`, [r.id, JSON.stringify({ title, waiting })]);
  }
}

/** Park a turn behind a paused provider, and count it on the report. */
export async function holdTurn(db: RefusalDb, messageId: number, provider: string): Promise<void> {
  await db.query(`UPDATE inbound_messages SET status = $2, meta = meta || $3::jsonb WHERE id = $1`, [
    messageId,
    HELD_STATUS,
    JSON.stringify({ held: { provider } }),
  ]);
  await refreshWaiting(db, provider);
}

/**
 * Before each claim: every held turn whose provider is no longer paused
 * goes back to `new` (the report was dismissed, or a turn succeeded); and on
 * a provider still paused whose probe is due, the OLDEST held turn goes
 * back alone, to be the probe. Returns how many were released.
 */
export async function releaseHeld(db: RefusalDb, probeMs = PROVIDER_PROBE_MS): Promise<number> {
  const { rows } = await db.query(
    `SELECT DISTINCT meta->'held'->>'provider' AS provider FROM inbound_messages WHERE status = $1`,
    [HELD_STATUS],
  );
  let released = 0;
  for (const r of rows) {
    const provider = typeof r.provider === "string" ? r.provider : "";
    if (!(await pausedFor(db, provider))) {
      const out = await db.query(`UPDATE inbound_messages SET status = 'new' WHERE status = $1 AND meta->'held'->>'provider' IS NOT DISTINCT FROM $2 RETURNING id`, [HELD_STATUS, r.provider]);
      released += out.rows.length;
    } else if (await probeDue(db, provider, probeMs)) {
      const out = await db.query(
        `UPDATE inbound_messages SET status = 'new'
         WHERE id = (SELECT id FROM inbound_messages WHERE status = $1 AND meta->'held'->>'provider' = $2 ORDER BY ts LIMIT 1)
         RETURNING id`,
        [HELD_STATUS, provider],
      );
      released += out.rows.length;
      if (out.rows.length > 0) await refreshWaiting(db, provider);
    }
  }
  return released;
}

export interface RaiseRefusal {
  provider: string;
  config: Provider | undefined;
  refusal: ProviderRefusal;
  messageId: number;
  runId: number;
  thread: string;
}

/** Raise the one report for (provider, class). `raised: false` = one was already waiting — this turn is a probe or a latecomer. */
export async function raiseRefusal(db: RefusalDb, r: RaiseRefusal): Promise<{ raised: boolean; id: number }> {
  const url = r.refusal.cls === "credits" ? topUpUrl(r.config) : undefined;
  const waiting = await heldCount(db, r.provider);
  const fix =
    r.refusal.cls === "credits"
      ? `Top up ${r.provider}${url ? ` at ${url}` : ""}. Turns for ${r.provider} are held, not sent, until you dismiss this or a turn gets through — one is tried every ${PROVIDER_PROBE_MS / 60_000} minutes, so topping up is enough. A tier's max_output_tokens in compute.yaml is how much each turn reserves.`
      : `Replace the key compute.yaml names for ${r.provider} (providers.${r.provider}.auth) in Settings › Secrets, or \`metistry secrets set <name>\`. Turns for ${r.provider} are held until you dismiss this or a turn gets through (one is tried every ${PROVIDER_PROBE_MS / 60_000} minutes).`;
  const out = await raiseMirror(db as Parameters<typeof raiseMirror>[0], {
    kind: "report",
    source_agent: PROVIDER_AGENT,
    trust: "internal",
    source: refusedSource(r.provider, r.refusal.cls),
    payload: {
      title: refusalTitle(r.provider, r.refusal.cls, r.refusal.status, waiting, url),
      body: `${r.provider} answered HTTP ${r.refusal.status}: ${r.refusal.message}\n\n${fix}`,
      event: PROVIDER_REFUSED_EVENT,
      provider: r.provider,
      status: r.refusal.status,
      error_class: r.refusal.cls,
      ...(url ? { top_up: url } : {}),
      waiting,
      message_id: r.messageId,
      thread: r.thread,
      run_id: r.runId,
      failed_at: new Date().toISOString(),
    },
  });
  return out;
}

/** A turn on this provider got through: every waiting report for it is cleared at its source, and the held turns go on the next pass. */
export async function providerRecovered(db: RefusalDb, provider: string): Promise<number[]> {
  const prefix = `${REF}${provider}#`;
  const { rows } = await db.query(
    `SELECT DISTINCT source->>'external_ref' AS ref FROM proposals
     WHERE decision = 'pending' AND source->>'kind' = $1 AND left(source->>'external_ref', $2) = $3`,
    [PROVIDER_SOURCE_KIND, prefix.length, prefix],
  );
  const cleared: number[] = [];
  for (const r of rows) cleared.push(...(await resolveAtSource(db as Parameters<typeof resolveAtSource>[0], { kind: PROVIDER_SOURCE_KIND, external_ref: String(r.ref) })));
  return cleared;
}
