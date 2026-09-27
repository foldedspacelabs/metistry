// The assistant's tools (§4.11 one knowledge interface for ALL agents): the
// engine mounts exactly ONE MCP server — the console's mcp-brain at /mcp —
// and authenticates to it like any external agent, as the first INTERNAL
// agent in the registry. Invariant 9 is enforced here, not prompted: the
// allowlist below is the assistant's entire tool surface, and the engine has
// no other tool source to ignore — the loop calls what `tools.ts` hands it
// and nothing else (engine-openai.ts). Absent the env, the engine runs
// tool-less exactly as before (degrades: absent).

import { randomUUID } from "node:crypto";

/** The MCP server name the tool host presents under: tool names become `mcp__brain__<tool>`. */
export const BRAIN_SERVER = "brain";

/**
 * Where the turn correlation handle rides on a `tools/call`: the MCP spec's
 * own carrier for request metadata, under the bridge's reverse-DNS key
 * (`packages/mcp-brain/src/turn-id.ts` holds the same literal — the assistant
 * talks to the bridge over HTTP and does not import it, so test/brain.test.ts
 * locks the two together, the way BRAIN_TOOLS is locked to the manifest).
 *
 * It used to be an optional PARAMETER on all 25 tools. That cost ~940
 * definition tokens — 18.8% of the whole advertised surface — and asked the
 * MODEL to invent an id per reply and pass it faithfully on every call, i.e.
 * it was a convention in the system prompt rather than a control. The client
 * mints one per reply now and the model never sees it at all
 * (docs/research/2026-09-19-code-mode-mcp.md §2.4, ruled 2026-09-19).
 */
export const TURN_ID_META_KEY = "com.foldedspacelabs.metistry/turn_id";

/** One handle per reply. A UUID is already the shape the bridge stores: `[A-Za-z0-9_-]{1,64}`. */
export function newTurnId(): string {
  return randomUUID();
}

/**
 * The mcp-brain tools, in manifest order. Duplicated here on purpose — the
 * engine's allowlist must be readable in one place — and locked to
 * packages/mcp-brain/manifest.yaml by test/brain.test.ts. `knowledge_write`
 * is the assistant's `brain-commit` (§4.7): the bridge admits it for the
 * internal principal only, and the vault refuses protected paths behind it.
 * `agents_delegate` is likewise internal-only: the assistant hands briefs to
 * crews (crew.ts runs them); no crew ever holds either tool. `queries_list`
 * / `queries_run` (invariant 3's one read path) are open to every principal
 * in mcp-brain, but internal ones — the assistant included — always have
 * them regardless of a `queries` grant. `knowledge_list` / `knowledge_grep`
 * are filesystem semantics over the same `areas` grant knowledge_read uses
 * (docs/research/2026-09-stash-review.md item 3) — no separate scope.
 *
 * `request_access` (docs/ops/actions.md) is on the list for the same reason
 * `knowledge_write` is, pointing the other way: the bridge refuses it for an
 * INTERNAL principal, because the assistant's scope is configuration in the
 * user's hand (METISTRY_ASSISTANT_AREAS) and an approved ask would silently
 * revert at the next console start. The refusal says that, which is more use
 * to a model than a tool that is simply absent.
 *
 * `connections_list` / `connections_call` (plan §2.6, T4-8b) are the proxy's
 * lazy pair: the assistant reaches every connection the owner holds — a
 * connection not offered to agents is the assistant's and the syncs'
 * (C115) — and the tools each one runs are the owner's per-tool policy,
 * held by the proxy.
 *
 * `propose_action` (docs/ops/actions.md) is on the list because the list IS
 * the manifest — but the bridge registers it only for a credential whose
 * `autonomy` table admits an action, and the assistant's registry row carries
 * none until the owner sets a level. An allowlist that omitted it would turn
 * "the owner gave the assistant room" into a silent, unexplained refusal here
 * instead of a working tool; the gate stays where it is enforced.
 */
export const BRAIN_TOOLS = [
  "capture",
  "requests_create",
  "request_access",
  "tasks_list",
  "tasks_claim",
  "tasks_renew",
  "tasks_update",
  "tasks_release",
  "tasks_close",
  "tasks_create",
  "tasks_comment",
  "tasks_thread",
  "knowledge_search",
  "knowledge_read",
  "knowledge_list",
  "knowledge_grep",
  "knowledge_write",
  "artifacts_publish",
  "artifacts_get",
  "artifacts_list",
  "artifacts_comment",
  "artifacts_resolve",
  "artifacts_review",
  "agents_delegate",
  "queries_list",
  "queries_run",
  "connections_list",
  "connections_call",
  "propose_action",
] as const;

export interface BrainConfig {
  /** The console's /mcp, e.g. http://console:8080/mcp (METISTRY_BRAIN_URL). */
  url: string;
  /** The internal agent's bearer (METISTRY_ASSISTANT_TOKEN) — the same value the console registers. */
  token: string;
}

/** Fully-qualified tool names for the allowlist. */
export function brainToolNames(): string[] {
  return BRAIN_TOOLS.map((t) => `mcp__${BRAIN_SERVER}__${t}`);
}

/** Read the brain config from the environment; undefined unless BOTH values are present. */
export function brainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrainConfig | undefined {
  const url = env.METISTRY_BRAIN_URL?.trim();
  const token = env.METISTRY_ASSISTANT_TOKEN?.trim();
  if (!url || !token) return undefined;
  if (!/^https?:\/\//.test(url)) throw new Error("METISTRY_BRAIN_URL must be an http(s) URL");
  return { url, token };
}
