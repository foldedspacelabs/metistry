// Schedule parsing — the ONE implementation (the console's runner uses it to
// decide when a collector is due; the watchdog uses it to decide when a
// collector has been silent too long). Deliberately narrow: */N minutes,
// 0 */N hours, @hourly, @daily, @weekly, @monthly — widen when a manifest
// actually needs more. Every shipped manifest must parse (console
// manifests.test.ts gates it: the console crash-looped once on an unparsed
// schedule).
//
// This is an INTERVAL scheduler, not a calendar one: @weekly is exactly
// 7 * 86400 seconds since the component last ran, not "every Monday". @monthly
// follows the same rule rather than inventing calendar semantics (a real
// "first of the month" would need the last-run timestamp, not just an
// interval) — 30 days, the same approximation every other named interval
// here already makes.

export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  if (schedule === "@daily") return 86400;
  if (schedule === "@weekly") return 604800;
  if (schedule === "@monthly") return 2592000; // 30 days — see module doc
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  if (m?.[1]) return Number(m[1]) * 60;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(schedule); // every N hours
  if (h?.[1]) return Number(h[1]) * 3600;
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, 0 */N hours, @hourly, @daily, @weekly, @monthly`);
}
