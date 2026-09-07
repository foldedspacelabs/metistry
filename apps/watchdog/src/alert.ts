// Alerting: failed probes become outbound_messages kind='alert' — the
// console's notifier loop pushes them (§4.9). Deduped: the same alert
// re-fires only after the quiet window, so a down service doesn't ping
// every cycle. Honest gap (accepted, §4.9): if db/console/push are ALL
// dead, this path is dead too — the bring-your-own dead-man's-switch
// covers that; stdout always gets the truth.

import type { CheckResult } from "@foldedspacelabs/metistry-core";
import type { Db } from "./probes.js";

/** Alertable = not ok and not absent (absent is "not configured", the documented graceful degrade — never a page). */
export function isFailure(c: CheckResult): boolean {
  return c.status !== "ok" && c.status !== "absent";
}

export async function alertFailures(db: Db, checks: CheckResult[], quietHours = 6): Promise<number> {
  let raised = 0;
  for (const c of checks) {
    if (!isFailure(c)) continue;
    const text = `watchdog: ${c.name} ${c.status} — ${c.remediation ?? c.probe}`;
    const { rows } = await db.query(
      `SELECT 1 FROM outbound_messages
       WHERE kind = 'alert' AND text = $1 AND ts > now() - make_interval(hours => $2)`,
      [text, quietHours],
    );
    if (rows.length > 0) continue; // already alerted inside the quiet window
    await db.query(`INSERT INTO outbound_messages (thread, text, kind) VALUES ('default', $1, 'alert')`, [text]);
    raised++;
  }
  return raised;
}
