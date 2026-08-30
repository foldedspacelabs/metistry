// Web push (§4.9): the primary notification channel. Subscriptions bind to
// a device session (revocation clears both, §4.2); a 410 from the push
// service means the subscription silently died (Home-Screen reinstall) —
// treated as alertable, not a quiet degrade: logged to runs as a failure.

import webpush from "web-push";
import { finishRun, startRun, optionalEnv } from "@foldedspacelabs/metistry-core";
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

/** Send to one session's subscription. Clears + flags dead (410/404) subs. */
export async function sendToSession(
  db: Db,
  cfg: PushConfig,
  sessionId: number,
  payload: { title: string; body: string; url?: string },
): Promise<"sent" | "no_subscription" | "dead"> {
  const { rows } = await db.query(
    `SELECT push_subscription FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
  const sub = rows[0]?.push_subscription;
  if (!sub) return "no_subscription";

  const runId = await startRun(db, { component: "console", kind: "outbound", tool: "web_push", meta: { session: sessionId } });
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
    });
    await finishRun(db, runId, { ok: true });
    return "sent";
  } catch (err: any) {
    const dead = err?.statusCode === 410 || err?.statusCode === 404;
    if (dead) {
      await db.query(`UPDATE auth_sessions SET push_subscription = NULL WHERE id = $1`, [sessionId]);
    }
    // a dead subscription is an alertable failure (§4.9), not a quiet degrade
    await finishRun(db, runId, { ok: false, error: dead ? "subscription dead (410)" : String(err?.message ?? err) });
    return dead ? "dead" : "no_subscription";
  }
}
