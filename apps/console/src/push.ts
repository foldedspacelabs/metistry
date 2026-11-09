// Web push (§4.9): the primary notification channel, and Needs You's alone
// (screen 18 §6, X-32): only a request that needs the owner pushes, and the
// push carries its type and card link, never its text. Subscriptions bind to
// a device session (revocation clears both, §4.2); a 410 from the push
// service means the subscription silently died (Home-Screen reinstall) —
// treated as alertable, not a quiet degrade: logged to runs as a failure.

import webpush from "web-push";
import { finishRun, startRun, optionalEnv, requestWordOf } from "@foldedspacelabs/metistry-core";
import type { Db } from "./auth-store.js";

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: — Apple rejects placeholder contacts (PoC-6)
}

export function pushConfigFromEnv(): PushConfig | null {
  const publicKey = optionalEnv("METISTRY_VAPID_PUBLIC", "");
  const privateKey = optionalEnv("METISTRY_VAPID_PRIVATE", "");
  const subject = optionalEnv("METISTRY_VAPID_SUBJECT", "");
  if (!publicKey || !privateKey || !subject) return null; // degrades: absent
  return { publicKey, privateKey, subject };
}

export async function storeSubscription(db: Db, sessionId: number, subscription: unknown): Promise<void> {
  await db.query(`UPDATE auth_sessions SET push_subscription = $2 WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
    JSON.stringify(subscription),
  ]);
}

/**
 * What a push carries (screen 18 §6, X-32): the card's type, a title, and the
 * link that opens the card — nothing more. There is no `body`: the type says
 * what kind of request waits, never what it says. The shape is the whole
 * contract; `wirePayload` copies these three fields and no other, so a caller
 * that casts its way past the type still cannot put text on the wire.
 */
export interface PushPayload {
  readonly type?: string;
  readonly title: string;
  readonly url: string;
}

/** The JSON handed to the push service: `type`, `title` and `url`, whatever else the object held. */
export function wirePayload(p: PushPayload): string {
  const out: { type?: string; title: string; url: string } = { title: String(p.title), url: String(p.url) };
  if (typeof p.type === "string" && p.type !== "") out.type = p.type;
  return JSON.stringify(out);
}

/** Broadcast to every subscribed device session. */
export async function sendToAll(db: Db, cfg: PushConfig, payload: PushPayload): Promise<void> {
  const { rows } = await db.query(
    `SELECT id FROM auth_sessions WHERE push_subscription IS NOT NULL AND revoked_at IS NULL`,
    [],
  );
  for (const r of rows) await sendToSession(db, cfg, r.id, payload);
}

/**
 * The title every Needs You push carries. A request's own title is written by
 * whoever raised it — an agent, a mirrored pull request, an email's subject —
 * and so can hold anything: a key, a one-time code, a stranger's words. The
 * worker blanks what is key-shaped (T7-5), but a pattern is a hope, not a
 * control. So the request's title never leaves the console: the push names
 * the queue, and the card says the rest once it is open.
 */
export const NEEDS_YOU_TITLE = "Needs You";

/** A request's card: the PWA opens Needs You with that request open (app.js `openLink`). */
export const needsYouUrl = (id: string): string => `/#/needs-you/${id}`;

/** The queue's own page, for a burst too big to push card by card. */
export const NEEDS_YOU_URL = "/#/needs-you";

/** More new cards than this in one pass is one push for the queue, not one per card. */
export const NEEDS_YOU_BURST = 3;

/**
 * One request's push: its type in the table's words as the PWA heads it
 * (`requestWordOf` — a closed vocabulary; an unknown kind reads as a report,
 * never as itself), the fixed title, and its card's link. Null for an id that
 * is not a row id, which no link is made from.
 */
export function needsYouPayload(row: { id: unknown; kind: unknown }): PushPayload | null {
  const id = String(row.id);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) return null;
  const word = requestWordOf(typeof row.kind === "string" ? row.kind : "");
  return { type: word.replace(/\b\w/g, (ch) => ch.toUpperCase()), title: NEEDS_YOU_TITLE, url: needsYouUrl(id) };
}

/** The queue as Needs You shows it: pending, and not put down until later (events.ts `WAITING_SQL`). */
const SHOWING_SQL = `SELECT id, kind, group_id FROM proposals
  WHERE decision = 'pending' AND (snoozed_until IS NULL OR snoozed_until <= now())
  ORDER BY ts, id`;

/**
 * Needs You's notifier (screen 18 §6): only a request that has just come to
 * need the owner pushes — one raised, or one whose Later has run out. A
 * reply, an ack, a brief or an alert never does: those are activity, and
 * the feed and the thread are where activity is read.
 *
 * Each pass reads the queue as Needs You shows it and pushes the cards that
 * were not showing on the last pass. Reading the set rather than a high-water
 * id catches a row whose transaction committed late and a snooze ending (no
 * row is written when one does). A meeting's rows (`group_id`) push once. More
 * than `NEEDS_YOU_BURST` new cards at once — a sync's first pass — is one push
 * for the queue.
 *
 * The first pass only learns the queue: what was already waiting when the
 * console started has been seen, or pushed, before. A request raised while
 * the console was down therefore does not push when it comes back; the
 * badge and the Needs You count still show it.
 */
export function needsYouNotifier(db: Db, send: (payload: PushPayload) => Promise<void>): () => Promise<number> {
  let showing: Set<string> | null = null;
  return async function pass(): Promise<number> {
    const { rows } = await db.query(SHOWING_SQL, []);
    const now = new Set(rows.map((r: { id: unknown }) => String(r.id)));
    const before = showing;
    showing = now; // at most once: a send that throws is not retried into a second push
    if (before === null) return 0;
    const groups = new Set<string>();
    for (const r of rows) if (before.has(String(r.id)) && r.group_id) groups.add(String(r.group_id));
    const fresh: PushPayload[] = [];
    for (const r of rows) {
      if (before.has(String(r.id))) continue;
      if (r.group_id) {
        if (groups.has(String(r.group_id))) continue; // the meeting's card is already there
        groups.add(String(r.group_id));
      }
      const payload = needsYouPayload(r);
      if (payload) fresh.push(payload);
    }
    const out = fresh.length > NEEDS_YOU_BURST ? [{ title: NEEDS_YOU_TITLE, url: NEEDS_YOU_URL }] : fresh;
    for (const p of out) await send(p);
    return out.length;
  };
}

/** Run Needs You's notifier every `intervalMs`, one pass at a time. Runs in the console — the assistant only writes rows. */
export function startNotifier(db: Db, cfg: PushConfig, intervalMs = 2000): NodeJS.Timeout {
  const pass = needsYouNotifier(db, (payload) => sendToAll(db, cfg, payload));
  let running = false;
  return setInterval(async () => {
    if (running) return; // a slow pass is never overlapped by the next
    running = true;
    try {
      await pass();
    } catch (err) {
      console.error("notifier:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
}

/** Send to one session's subscription. Clears + flags dead (410/404) subs. */
export async function sendToSession(
  db: Db,
  cfg: PushConfig,
  sessionId: number,
  payload: PushPayload,
): Promise<"sent" | "no_subscription" | "dead"> {
  const { rows } = await db.query(
    `SELECT push_subscription FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  const sub = rows[0]?.push_subscription;
  if (!sub) return "no_subscription";

  const runId = await startRun(db, { component: "console", kind: "outbound", tool: "web_push", meta: { session: sessionId } });
  try {
    await webpush.sendNotification(sub, wirePayload(payload), {
      vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
    });
    await finishRun(db, runId, { ok: true });
    return "sent";
  } catch (err: any) {
    // dead = gone (410/404) OR structurally invalid (client-side validation
    // throws with no statusCode) — retrying those forever is failure spam
    const dead = err?.statusCode === 410 || err?.statusCode === 404 || err?.statusCode === 400 || err?.statusCode === undefined;
    if (dead) {
      await db.query(`UPDATE auth_sessions SET push_subscription = NULL WHERE id = $1`, [sessionId]);
    }
    // a dead subscription is an alertable failure (§4.9), not a quiet degrade
    await finishRun(db, runId, { ok: false, error: dead ? "subscription dead (410)" : String(err?.message ?? err) });
    return dead ? "dead" : "no_subscription";
  }
}
