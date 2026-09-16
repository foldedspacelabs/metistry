// `metistry agents autonomy <id>` — read and change how much room one agent
// has with an `action` (docs/ops/actions.md).
//
// This is one of exactly two doors that may WIDEN an autonomy record; the
// other is the console's own `PUT /api/agents/:id/autonomy`, and this command
// is a client of it. It is deliberately not a second implementation: the
// merge happens here (so `--allow comment` does not erase the narrowing keys
// beside it), the POLICY happens server-side, and a refusal comes back as the
// console's own sentence rather than one written twice.
//
// The local owner token authenticates it and never reaches argv, stdout or an
// error message — same rule as `metistry console whoami` next door.

import {
  ACTION_KINDS,
  ACTION_MODES,
  AUTONOMY_LEVELS,
  effectiveActions,
  type ActionKind,
  type ActionMode,
  type AutonomyLevel,
} from "@foldedspacelabs/metistry-core";
import { consoleTarget, type ConsoleTargetOptions } from "./console-client.js";

/** The stored record, both halves: the §4.21 narrowing and the action table. Unknown keys are the console's to refuse. */
export interface AutonomyRecord {
  may_dispatch_to?: string[];
  accept_from?: string[];
  max_open_bundles?: number;
  level?: AutonomyLevel;
  actions?: Partial<Record<ActionKind, ActionMode>>;
}

export interface AutonomyChange {
  level?: AutonomyLevel | undefined;
  actions: Partial<Record<ActionKind, ActionMode>>;
}

const MODE_FLAG: Readonly<Record<string, ActionMode>> = { allow: "allow", propose: "propose", deny: "deny" };

/**
 * Read `--level <l>` and `--allow/--propose/--deny <kind>` off the RAW argv,
 * because each mode flag may be repeated and may carry a comma-separated
 * list — and the shared flag parser keeps only the last of a repeated flag.
 * An unknown level or kind throws with the closed list; there is no silent
 * fallback, here least of all.
 */
export function parseAutonomyFlags(argv: readonly string[]): AutonomyChange {
  const change: AutonomyChange = { actions: {} };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = splitFlag(argv[i]!);
    if (name === undefined) continue;
    if (name !== "level" && !Object.hasOwn(MODE_FLAG, name)) continue;
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (name === "level") {
      if (!AUTONOMY_LEVELS.includes(value as AutonomyLevel)) throw new Error(`--level must be one of ${AUTONOMY_LEVELS.join(" | ")}`);
      change.level = value as AutonomyLevel;
      continue;
    }
    for (const kind of value.split(",").map((k) => k.trim()).filter(Boolean)) {
      if (!ACTION_KINDS.includes(kind as ActionKind)) throw new Error(`--${name}: unknown action kind "${kind}" — one of ${ACTION_KINDS.join(" | ")} (docs/ops/actions.md)`);
      change.actions[kind as ActionKind] = MODE_FLAG[name]!;
    }
  }
  return change;
}

function splitFlag(arg: string): [string | undefined, string | undefined] {
  if (!arg.startsWith("--")) return [undefined, undefined];
  const eq = arg.indexOf("=");
  return eq === -1 ? [arg.slice(2), undefined] : [arg.slice(2, eq), arg.slice(eq + 1)];
}

/** True when nothing was asked for — the show-me case. */
export function isEmptyChange(c: AutonomyChange): boolean {
  return c.level === undefined && Object.keys(c.actions).length === 0;
}

/** `next` on top of `stored`, preserving every key this command does not own (the §4.21 narrowing). */
export function mergeAutonomy(stored: AutonomyRecord, change: AutonomyChange): AutonomyRecord {
  const actions = { ...(stored.actions ?? {}), ...change.actions };
  return {
    ...stored,
    ...(change.level !== undefined ? { level: change.level } : {}),
    ...(Object.keys(actions).length > 0 ? { actions } : {}),
  };
}

export interface AutonomyView {
  agent: string;
  display_name: string;
  level: AutonomyLevel;
  autonomy: AutonomyRecord;
  /** The resolved table — what the server will actually do, level ceiling applied. */
  actions: Record<ActionKind, ActionMode>;
  /** What this invocation raised, as the server named it. Empty on a read or a narrowing. */
  widened: string[];
}

export interface AgentAutonomyOptions extends ConsoleTargetOptions {
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Show, or change. A change is read-merge-PUT: the console holds the record
 * and refuses a concurrent overwrite with a `409`, which is surfaced as-is
 * rather than retried — a widening that raced is a widening nobody saw.
 */
export async function agentAutonomy(id: string, change: AutonomyChange, opts: AgentAutonomyOptions = {}): Promise<AutonomyView> {
  const target = await consoleTarget(opts);
  const fetchFn = opts.fetchFn ?? fetch;
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetchFn(`${target.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new Error(`console unreachable at ${target.url}: ${redact(err, target.token)}`);
    }
  };

  const list = await call("/api/agents");
  if (list.status === 401) throw new Error(`${target.url} refused the owner token (401) — see \`metistry console whoami\` (docs/ops/auth.md)`);
  if (!list.ok) throw new Error(`${target.url}/api/agents returned HTTP ${list.status}`);
  const { agents } = (await list.json()) as { agents: { id: string; display_name: string; autonomy?: AutonomyRecord; revoked?: boolean }[] };
  const row = agents.find((a) => a.id === id);
  if (!row) throw new Error(`no agent "${id}" is registered (metistry connect --list, or the console's Agents panel)`);
  if (row.revoked) throw new Error(`agent "${id}" is revoked — a revoked row takes no further change`);

  const stored = row.autonomy ?? {};
  if (isEmptyChange(change)) {
    return { agent: id, display_name: row.display_name, level: stored.level ?? "observe", autonomy: stored, actions: effectiveActions(stored), widened: [] };
  }

  const next = mergeAutonomy(stored, change);
  const put = await call(`/api/agents/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify(next) });
  const body = (await put.json().catch(() => ({}))) as { error?: { message?: string }; widened?: string[] };
  if (!put.ok) throw new Error(body.error?.message ?? `${target.url} refused the change (HTTP ${put.status})`);
  return { agent: id, display_name: row.display_name, level: next.level ?? "observe", autonomy: next, actions: effectiveActions(next), widened: body.widened ?? [] };
}

function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

export function renderAutonomy(v: AutonomyView): string {
  const lines = [`agent      ${v.agent} (${v.display_name})`, `level      ${v.level}`];
  for (const kind of ACTION_KINDS) lines.push(`  ${kind.padEnd(12)} ${v.actions[kind]}`);
  if (v.widened.length > 0) lines.push(`widened    ${v.widened.join("; ")} — recorded in runs, and you have an alert`);
  lines.push(`modes      ${ACTION_MODES.join(" | ")} · a level is a ceiling (docs/ops/actions.md)`);
  return lines.join("\n");
}
