// Schedule parsing — the ONE implementation (the console's runner uses it to
// decide when a collector is due; the watchdog uses it to decide when a
// collector has been silent too long). Deliberately narrow: */N minutes,
// 0 */N hours, @hourly, @daily, @weekly — widen when a manifest actually
// needs more. Every shipped manifest must parse (console manifests.test.ts
// gates it: the console crash-looped once on an unparsed schedule).

export function scheduleToSeconds(schedule: string): number {
  if (schedule === "@hourly") return 3600;
  if (schedule === "@daily") return 86400;
  if (schedule === "@weekly") return 604800;
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  if (m?.[1]) return Number(m[1]) * 60;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(schedule); // every N hours
  if (h?.[1]) return Number(h[1]) * 3600;
  throw new Error(`runner cannot schedule "${schedule}" yet — supported: */N minutes, 0 */N hours, @hourly, @daily, @weekly`);
}
