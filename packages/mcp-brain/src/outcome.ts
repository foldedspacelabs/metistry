// What a tool body returns; the server's wrapper turns it into a
// CallToolResult + runs row + nudge. Shared by every tool file.
import type { ErrorCode } from "@foldedspacelabs/metistry-core";

export type Outcome =
  | { ok: true; result: unknown; meta?: Record<string, unknown> }
  | { ok: false; code: ErrorCode; message?: string | undefined; meta?: Record<string, unknown> };

export const fail = (code: ErrorCode, message?: string, meta?: Record<string, unknown>): Outcome => ({ ok: false, code, message, ...(meta ? { meta } : {}) });
export const done = (result: unknown, meta?: Record<string, unknown>): Outcome => ({ ok: true, result, ...(meta ? { meta } : {}) });
