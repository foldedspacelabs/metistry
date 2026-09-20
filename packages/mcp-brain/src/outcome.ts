// What a tool body returns; the server's wrapper turns it into a
// CallToolResult + runs row + nudge. Shared by every tool file.
import type { ErrorCode, Refusal } from "@foldedspacelabs/metistry-core";

export type Outcome =
  | { ok: true; result: unknown; meta?: Record<string, unknown> }
  | {
      ok: false;
      code: ErrorCode;
      message?: string | undefined;
      /** Audit-only: folded into the `runs` row, never the wire response (server.ts's `render`). */
      meta?: Record<string, unknown>;
      /**
       * The opposite of `meta`: fields merged straight into the CallToolResult
       * body, alongside `error` (server.ts's `render`). Reserved for a
       * refusal that has something structured and safe to say beyond the
       * uniform envelope — e.g. `scope_required`'s `reason`/`grantedScope`
       * (knowledge.ts) — so an ordinary `fail(code, message, meta)` call
       * elsewhere in this package is unaffected: nothing is exposed unless a
       * caller opts in here explicitly.
       */
      expose?: Record<string, unknown>;
    };

export const fail = (code: ErrorCode, message?: string, meta?: Record<string, unknown>, expose?: Record<string, unknown>): Outcome => ({
  ok: false,
  code,
  message,
  ...(meta ? { meta } : {}),
  ...(expose ? { expose } : {}),
});
export const done = (result: unknown, meta?: Record<string, unknown>): Outcome => ({ ok: true, result, ...(meta ? { meta } : {}) });

/**
 * A `may()` refusal as this package's outcome. The ONE translation, so a
 * decision's code, message and `expose` reach the wire exactly as `core`
 * wrote them and no tool body gets to edit a refusal on the way out.
 *
 * `message: ""` becomes an ABSENT message — that is how the doors that say
 * nothing have always answered (`fail("forbidden")`), and silence stays
 * silence rather than becoming an empty string on the wire. `meta` is the
 * caller's audit detail (tier, areas, path), which is not part of the
 * decision.
 */
export const refuse = (d: Refusal, meta?: Record<string, unknown>): Outcome => ({
  ok: false,
  code: d.code,
  message: d.message === "" ? undefined : d.message,
  ...(meta ? { meta } : {}),
  ...(d.expose ? { expose: d.expose } : {}),
});
