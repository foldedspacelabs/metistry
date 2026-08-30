// check() — the frozen return shape (review CRIT-2). Every bridge,
// collector, and service implements it; `metistry doctor` and the watchdog
// consume the same results. The probe field must describe a BEHAVIORAL
// assertion (Phase 0 hard requirement 3: permission APIs lie — attempt the
// real privileged operation and inspect the result).

import { z } from "zod";

export const checkResultSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "degraded", "failed", "absent"]),
  latency_ms: z.number().nonnegative(),
  /** What was actually attempted and observed, e.g. "read 1 calendar event from the default store". */
  probe: z.string(),
  /** Human-actionable fix when status != ok, e.g. the exact command or Settings pane. */
  remediation: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type CheckResult = z.infer<typeof checkResultSchema>;

export interface Checkable {
  check(): Promise<CheckResult>;
}

/** Run a probe with timing and uniform failure capture. */
export async function runCheck(
  name: string,
  probe: string,
  fn: () => Promise<Partial<Pick<CheckResult, "status" | "remediation" | "meta">> | void>,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const extra = (await fn()) ?? {};
    return checkResultSchema.parse({
      name,
      status: "ok",
      ...extra,
      latency_ms: Math.round(performance.now() - start),
      probe,
    });
  } catch (err) {
    return {
      name,
      status: "failed",
      latency_ms: Math.round(performance.now() - start),
      probe,
      remediation: err instanceof Error ? err.message : String(err),
    };
  }
}
