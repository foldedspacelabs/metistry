// The turn correlation handle — `runs.meta.turn_id`, which the `activity_feed`
// query groups one reply's calls by.
//
// It is NOT a parameter, and since 0.10.0 it is no longer advertised as one.
// Merged into all 25 eager schemas it cost 3,750 chars ≈ 938 tokens — 18.8% of
// the ENTIRE eager definition surface — for a field no model should have to
// reason about and that is "never trusted for anything else"
// (docs/research/2026-09-19-code-mode-mcp.md §2.4; the owner ruled it a wire
// change worth making on 2026-09-19).
//
// So it travels where the MCP spec puts request metadata: `_meta` on
// `tools/call`, under a reverse-DNS key we own. The CLIENT sets it once per
// reply (apps/assistant/src/tools.ts), which is also the better control — the
// old shape asked the MODEL to invent an id per call and pass it faithfully,
// i.e. it was prompted rather than enforced.
//
// ONE RELEASE OF COMPATIBILITY, tolerated but not advertised: a client still
// sending `turn_id` inside `arguments` is lifted into `_meta` at the door by
// `liftTurnId`, beside the deprecated-name rewriter that already lives there,
// before any schema sees it. It is in no `inputSchema` and in no description,
// so nothing discovers it that way.

/**
 * The `_meta` key the handle rides under. Reverse-DNS, as the spec's `_meta`
 * naming rules ask, and the same identifier the launchd label uses; no prefix
 * reserved for MCP itself appears in it.
 *
 * `apps/assistant/src/brain.ts` carries the same literal (the assistant does
 * not import this package — it talks to it over HTTP) and a test locks the two
 * together.
 */
export const TURN_ID_META_KEY = "com.foldedspacelabs.metistry/turn_id";

/** Where a `tools/call` carries it; also what an older client put in `arguments`. */
const FIELD = "turn_id";

/**
 * Shape only — a correlation handle is not identity and not auth, so this
 * says "storable", nothing more.
 *
 * A malformed one is DROPPED rather than refused. Under the old schema a bad
 * value failed the whole call, which is the wrong trade for a join key: the
 * work the caller asked for has nothing to do with whether its bookkeeping
 * label parsed. The bound is inline on purpose — there is no knob here.
 */
export function validTurnId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/** The handle on one `tools/call`, read from its `_meta`. `undefined` when absent or malformed. */
export function turnIdFrom(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  return validTurnId((meta as Record<string, unknown>)[TURN_ID_META_KEY]);
}

/**
 * The compatibility shim, run on the way in (server.ts's `handle`): move a
 * legacy `arguments.turn_id` to `params._meta`, so there is exactly ONE place
 * the tool wrapper reads it from and the argument never reaches a schema that
 * would strip it. An explicit `_meta` value wins — a client that sends both is
 * telling us the new one.
 *
 * Mutates the message in place, like `resolveAliasCall` next door, and returns
 * what it lifted (for tests and for nothing else).
 */
export function liftTurnId(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const msg = message as { method?: unknown; params?: unknown };
  if (msg.method !== "tools/call" || msg.params === null || typeof msg.params !== "object") return undefined;
  const params = msg.params as { arguments?: unknown; _meta?: unknown };
  if (params.arguments === null || typeof params.arguments !== "object") return undefined;
  const args = params.arguments as Record<string, unknown>;
  if (!Object.hasOwn(args, FIELD)) return undefined;
  const lifted = validTurnId(args[FIELD]);
  delete args[FIELD];
  if (lifted === undefined) return undefined;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  if (meta[TURN_ID_META_KEY] !== undefined) return undefined; // the new carrier wins
  meta[TURN_ID_META_KEY] = lifted;
  params._meta = meta;
  return lifted;
}
