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

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import {
  ACTION_KINDS,
  ACTION_MODES,
  ASSISTANT_AGENT_ID,
  AUTONOMY_LEVELS,
  CREW_FRONTMATTER,
  EFFORTS,
  crewModelIssue,
  effectiveActions,
  effectiveActionsDetailed,
  parseCrewDefinition,
  permissionRowText,
  resolveInstanceLayout,
  type ActionKind,
  type ActionMode,
  type AutonomyLevel,
  type Effort,
  type EffectiveActionEntry,
  type PermissionRow,
  type ScopeView,
} from "@foldedspacelabs/metistry-core";
import { consoleTarget, type ConsoleTargetOptions } from "./console-client.js";
import { realExec, type Exec } from "./exec.js";
import { writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";
import { defaultUi, type Ui } from "./ui.js";

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
  /** The same table, with WHY (C46/C47): set by the owner, defaulted from the level, or clamped to its ceiling — a projection of `actions`, never a second computation of it. `renderAutonomy` is what reads this; `--json` gets it too, so a script sees the same reason a human does. */
  actionsDetailed: Record<ActionKind, EffectiveActionEntry>;
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
    return { agent: id, display_name: row.display_name, level: stored.level ?? "observe", autonomy: stored, actions: effectiveActions(stored), actionsDetailed: effectiveActionsDetailed(stored), widened: [] };
  }

  const next = mergeAutonomy(stored, change);
  const put = await call(`/api/agents/${encodeURIComponent(id)}/autonomy`, { method: "PUT", body: JSON.stringify(next) });
  const body = (await put.json().catch(() => ({}))) as { error?: { message?: string }; widened?: string[] };
  if (!put.ok) throw new Error(body.error?.message ?? `${target.url} refused the change (HTTP ${put.status})`);
  return { agent: id, display_name: row.display_name, level: next.level ?? "observe", autonomy: next, actions: effectiveActions(next), actionsDetailed: effectiveActionsDetailed(next), widened: body.widened ?? [] };
}

function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

/**
 * The wire enum (`allow | propose | deny`) never changes — this is only how it
 * is SAID (the designer's words, C46/C47): `deny` reads as something the
 * agent may never do on its own, not as a blanket refusal.
 */
export const MODE_LABEL: Readonly<Record<ActionMode, string>> = { allow: "Allow", propose: "Ask First", deny: "Never" };

/**
 * One kind's line, styled by WHY it is what it is (C46/C47's
 * `effectiveActionsDetailed`) — never by colour alone (docs/ops/cli-style.md
 * rule 1): `defaulted` and `clamped` say so in words, and the colour is
 * decoration on top of that.
 *
 *   - `set`       — the owner's own entry, honoured as asked: plain.
 *   - `defaulted` — no entry at all; the level's own default: dimmed.
 *   - `clamped`   — the ONE case where the owner's own setting is being
 *     overridden: what they asked for is named, so this is never mistaken for
 *     `set`.
 */
function renderActionLine(entry: EffectiveActionEntry, level: AutonomyLevel, ui: Ui): string {
  const word = MODE_LABEL[entry.mode];
  if (entry.source === "clamped") return ui.paint("degraded", `${word} (asked ${MODE_LABEL[entry.asked!]} — ${level}'s ceiling is ${word})`);
  if (entry.source === "defaulted") return ui.dim(`${word} (default for ${level})`);
  return word;
}

export function renderAutonomy(v: AutonomyView, ui: Ui = defaultUi()): string {
  const lines = [`agent      ${v.agent} (${v.display_name})`, `level      ${v.level}`];
  const width = Math.max(...ACTION_KINDS.map((k) => k.length));
  for (const kind of ACTION_KINDS) lines.push(`  ${kind.padEnd(width)} ${renderActionLine(v.actionsDetailed[kind], v.level, ui)}`);
  if (v.widened.length > 0) lines.push(`widened    ${v.widened.join("; ")} — recorded in runs, and you have an alert`);
  lines.push(`modes      ${ACTION_MODES.map((m) => MODE_LABEL[m]).join(" | ")} · a level is a ceiling (docs/ops/actions.md)`);
  return lines.join("\n");
}


// ---------------------------------------------------------------------------
// `metistry agents list` — the registry, in the one vocabulary
// ---------------------------------------------------------------------------
//
// P3 of docs/research/2026-09-19-grants-and-access-simplified.md §2.10: the
// brief asked for grants "rendered identically in the CLI, the console, Needs
// You, and the tool descriptions", and the CLI rendered them not at all —
// `metistry agents` had one subcommand, `autonomy`, and a grant was only
// settable (`metistry connect --areas`), never readable.
//
// It is deliberately NOT a second implementation of the vocabulary. The
// console sends each row's `scope` already rendered (core's `describeScope`),
// and this prints it. A second renderer here would be the fifth vocabulary
// for one record, which is the thing the phase exists to end.

export interface AgentListRow {
  id: string;
  display_name: string;
  kind: string;
  revoked: boolean;
  pending: boolean;
  last_seen_at: string | null;
  /** The server's rendering. Absent only against a console older than this CLI. */
  scope?: ScopeView | undefined;
  /** The actor's Resource × Read × Write rows (core's `describePermissions`, T4-6). Absent only against a console older than this CLI. */
  permissions?: PermissionRow[] | undefined;
  /** What this agent has asked for and the owner has not answered — the count, not a second door onto granting. */
  asked: { area: string; proposal_id: number }[];
}

/**
 * Every registered agent, with what it holds. Read-only: nothing here writes,
 * and the one door that widens a grant is still the console's (invariant 2).
 */
export async function agentsList(opts: AgentAutonomyOptions = {}): Promise<AgentListRow[]> {
  const target = await consoleTarget(opts);
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${target.url}/api/agents`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new Error(`console unreachable at ${target.url}: ${redact(err, target.token)}`);
  }
  if (res.status === 401) throw new Error(`${target.url} refused the owner token (401) — see \`metistry console whoami\` (docs/ops/auth.md)`);
  if (!res.ok) throw new Error(`${target.url}/api/agents returned HTTP ${res.status}`);
  const body = (await res.json()) as { agents?: AgentListRow[]; access_requests?: { agent: string; area: string; proposal_id: number }[] };
  const asked = new Map<string, { area: string; proposal_id: number }[]>();
  for (const r of body.access_requests ?? []) asked.set(r.agent, [...(asked.get(r.agent) ?? []), { area: r.area, proposal_id: r.proposal_id }]);
  return (body.agents ?? []).map((a) => ({ ...a, asked: asked.get(a.id) ?? [] }));
}

/**
 * One row per agent: who it is, then the triple — role · access · extras —
 * exactly as the console's panel and the Needs You card render it.
 *
 * A pending enrolment and a revoked row are STATUS words from the closed
 * vocabulary (docs/ops/cli-style.md rule 5), so the colour is the icon's and
 * the word is spelled out beside it.
 */
export function renderAgents(rows: readonly AgentListRow[], ui: Ui = defaultUi()): string {
  if (rows.length === 0) return ui.note("no agents are registered — `metistry connect` registers one (docs/ops/auth.md)");
  const out: string[] = [];
  for (const a of rows) {
    // The icon comes from the closed vocabulary; the word beside it is the
    // verb's own (style guide 5: "a verb keeps its own word in the text and
    // borrows the colour"), so `revoked` reads as `revoked` and is red.
    const status = a.revoked ? "failed" : a.pending ? "degraded" : "ok";
    const word = a.revoked ? "revoked" : a.pending ? "pending" : a.last_seen_at ? `seen ${a.last_seen_at.slice(0, 10)}` : "never seen";
    out.push(`${ui.statusIcon(status)} ${ui.strong(a.display_name)} ${ui.dim(a.id)}  ${ui.paint(status as "ok" | "degraded" | "failed", word)}`);
    out.push(ui.kv([["scope", a.scope?.line ?? "(this console is older than this CLI and sends no rendered scope)"]], { indent: 4 }));
    if (a.scope) out.push(ui.kv([["from", a.scope.from]], { indent: 4 }));
    if (a.permissions && !a.revoked) out.push(renderPermissions(a.permissions, ui, 4));
    for (const ask of a.asked) out.push(ui.kv([["asked", `${ask.area} — answer it in Needs You (request #${ask.proposal_id})`]], { indent: 4 }));
  }
  out.push(ui.note(`${rows.length} agent(s) · a grant is the owner's hand: the console's Agents panel, or answering the ask in Needs You (docs/ops/auth.md)`));
  return out.join("\n");
}

/**
 * **The permissions table** (T4-6, screen 7 §4.1): Resource × Read × Write,
 * each cell in core's words (`permissionRowText`) — the same strings the
 * console's panel and MetistryKit print, so the three surfaces draw one
 * table. An empty cell is `—` and an actor that holds nothing says so:
 * absence is the denial.
 */
export function renderPermissions(rows: readonly PermissionRow[], ui: Ui = defaultUi(), indent = 0): string {
  if (rows.length === 0) return `${" ".repeat(indent)}${ui.dim("holds nothing — anything not listed is not granted")}`;
  return ui.table(["", "Read", "Write"], rows.map((r) => [...permissionRowText(r)]), { indent, ragged: [2] });
}

// ---------------------------------------------------------------------------
// `metistry agents define <id>` — a crew's definition, in the owner's hand (M12)
// ---------------------------------------------------------------------------
//
// A crew's definition is one file, `.metistry/agents/<area>/<id>.md`: its
// frontmatter (how it runs, what it may reach) and its operating prompt. It
// says how an actor behaves, so it is a §4.7 protected path — the owner's
// hand and nobody else's (invariant 2; A4: the assistant never writes it) —
// and the console only READS it (`GET /api/agents/:id/definition`). This verb
// is the write, and the Mac app's definition editor is a client of it (§2.2).
//
// It edits what the owner edits in the editor — the prompt, the model and
// effort (one dropdown, C128), the description — and keeps every other line
// of the file as it was, comments included. The result is validated with the
// console's own reading of the file (core's `parseCrewDefinition`) BEFORE it
// is written, so an edit the console would refuse is refused here instead of
// landing and being dropped at the next sync. `--if-sha256` is the stale
// check: the hash the definition route answered with, and a file that moved
// since is refused rather than overwritten.

/** What `define` may change. Absent fields are left exactly as they are. */
export interface DefineChange {
  /** Only for a crew with no file yet: the directory it lives in. */
  area?: string | undefined;
  /** `<provider>/<model-id>` or `same_as_assistant` (a legacy alias is read, never written). */
  model?: string | undefined;
  effort?: Effort | undefined;
  description?: string | undefined;
  /** The operating prompt: the body below the frontmatter. */
  prompt?: string | undefined;
}

export interface AgentsDefineOptions {
  id: string;
  change: DefineChange;
  /** The sha256 the edit was made against — the definition route's `files[0].sha256`. A file that moved since is refused (stale). */
  ifSha256?: string | undefined;
  instanceDir: string;
  /** The product's `seed/`: a shipped crew (`seed/agents/<area>/<id>.md`) is the base an instance copy starts from. */
  seedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

export interface DefineResult {
  id: string;
  area: string;
  /** Instance-relative: where the owner's own copy is (or would be). */
  path: string;
  /** What the edit started from: the instance's own file, the shipped copy (the instance's then wins by name), or nothing. */
  from: "instance" | "product" | "new";
  sha256_before: string | null;
  sha256: string;
  model: string;
  effort: Effort;
  /** False when the result is byte-identical to the instance's file, or nothing was asked. */
  changed: boolean;
  delivery?: ProtectedWrite | undefined;
}

const CREW_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** `<dir>/<area>/<id>.md` files on disk, by area. */
async function findDefinition(dir: string, id: string): Promise<{ area: string; file: string }[]> {
  if (!existsSync(dir)) return [];
  const found: { area: string; file: string }[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = join(dir, e.name, `${id}.md`);
    if (existsSync(file)) found.push({ area: e.name, file });
  }
  return found;
}

/** True when nothing was asked: `define <id>` alone shows where the definition is. */
export function isEmptyDefine(c: DefineChange): boolean {
  return c.model === undefined && c.effort === undefined && c.description === undefined && c.prompt === undefined;
}

export async function agentsDefine(opts: AgentsDefineOptions): Promise<DefineResult> {
  const { id, change } = opts;
  if (!CREW_ID_RE.test(id)) throw new StepFailed(`"${id}" is not an agent id — lowercase kebab-case, at most 40 characters (the filename of .metistry/agents/<area>/<id>.md)`);
  if (id === ASSISTANT_AGENT_ID) {
    throw new StepFailed(
      "the assistant's definition is not a crew file: its identity is `metistry identity set`, and its instructions are the root CLAUDE.md and .metistry/assistant-prompt.md, edited by hand (docs/ops/actors.md)",
    );
  }
  if (change.model !== undefined) {
    const why = crewModelIssue(change.model);
    if (why) throw new StepFailed(`--model ${why}`);
  }
  if (change.effort !== undefined && !EFFORTS.includes(change.effort)) throw new StepFailed(`--effort must be one of ${EFFORTS.join(" | ")}`);

  const layout = resolveInstanceLayout(opts.instanceDir);
  const instanceHits = await findDefinition(layout.path("agentsDir"), id);
  if (instanceHits.length > 1) {
    throw new StepFailed(`${id} is defined twice (${instanceHits.map((h) => `${layout.layout.agentsDir}/${h.area}/${id}.md`).join(", ")}) — the name is the filename, so one has to go; refusing to guess which`);
  }
  const productHits = instanceHits.length === 0 ? await findDefinition(join(opts.seedDir, "agents"), id) : [];
  const base = instanceHits[0] ? { ...instanceHits[0], from: "instance" as const } : productHits[0] ? { ...productHits[0], from: "product" as const } : undefined;
  if (base && change.area !== undefined && change.area !== base.area) {
    throw new StepFailed(`${id} lives in ${base.area}/, not ${change.area}/ — the area IS the directory; moving a crew is renaming its file by hand`);
  }
  const area = base?.area ?? change.area;
  if (!area) throw new StepFailed(`${id} has no definition yet — a new crew needs --area <area>, --model <provider/model>|same_as_assistant and --prompt-file <file>|- (docs/ops/crews.md)`);
  if (!/^[a-z][a-z0-9-]*$/.test(area)) throw new StepFailed(`--area "${area}" is not an area name — lowercase kebab-case (casing rule: only the vault is TitleCase)`);
  const rel = `${layout.layout.agentsDir}/${area}/${id}.md`;

  const before = base ? await readFile(base.file, "utf8") : null;
  const shaBefore = before === null ? null : sha256(before);
  if (opts.ifSha256 !== undefined && opts.ifSha256 !== shaBefore) {
    throw new StepFailed(
      `stale: ${rel} is not the definition this edit was made against (it has ${shaBefore === null ? "no file" : `sha256 ${shaBefore.slice(0, 12)}…`}, the edit expected ${opts.ifSha256.slice(0, 12)}…) — re-read it (GET /api/agents/${id}/definition) and edit again; nothing was written`,
    );
  }

  // Nothing asked: a read — where the definition is, what it runs on, and the hash an edit is made against.
  if (isEmptyDefine(change)) {
    if (before === null) throw new StepFailed(`${id} has no definition — a new crew needs --area, --model and --prompt-file (docs/ops/crews.md)`);
    const current = parseCrewDefinition(before, rel, { name: id, area });
    return { id, area, path: rel, from: base!.from, sha256_before: shaBefore, sha256: shaBefore!, model: current.manifest.model, effort: current.manifest.effort, changed: false };
  }

  let next: string;
  if (before === null) {
    if (change.model === undefined || change.prompt === undefined) {
      throw new StepFailed(`${id} has no definition yet — a new crew needs --model <provider/model>|same_as_assistant and --prompt-file <file>|- (docs/ops/crews.md)`);
    }
    // The least a crew is: its name, where it lives, what it runs on. It
    // reaches nothing until the owner names its tools and scope by hand —
    // widening an actor is never a flag on this verb.
    const front = stringifyYaml({
      name: id,
      type: "agent",
      area,
      model: change.model,
      effort: change.effort ?? "low",
      ...(change.description !== undefined ? { description: change.description } : {}),
      uses: [],
      scope: [],
    });
    next = `---\n${front.trimEnd()}\n---\n\n${change.prompt.trim()}\n`;
  } else {
    const m = CREW_FRONTMATTER.exec(before);
    if (!m) throw new StepFailed(`${base!.file} has no frontmatter this command can edit — fix it by hand (docs/ops/crews.md)`);
    const doc = parseDocument(m[1]!);
    if (doc.errors.length > 0) throw new StepFailed(`${base!.file}'s frontmatter is not valid YAML (${doc.errors[0]?.message}) — fix it by hand; refusing to edit a file this command cannot read back`);
    if (change.model !== undefined) doc.set("model", change.model);
    if (change.effort !== undefined) doc.set("effort", change.effort);
    if (change.description !== undefined) doc.set("description", change.description);
    const body = change.prompt === undefined ? m[2]! : `\n${change.prompt.trim()}\n`;
    // flow collections as the owner wrote them (`[knowledge, requests]`), not re-padded
    next = `---\n${doc.toString({ flowCollectionPadding: false }).trimEnd()}\n---\n${body}`;
  }

  // the console's own reading of the file, before anything is written
  let parsed;
  try {
    parsed = parseCrewDefinition(next, rel, { name: id, area });
  } catch (e) {
    throw new StepFailed(`refusing to write ${rel}: the result would be refused by the console — ${e instanceof Error ? e.message : String(e)}`);
  }
  const result: DefineResult = {
    id,
    area,
    path: rel,
    from: base?.from ?? "new",
    sha256_before: shaBefore,
    sha256: sha256(next),
    model: parsed.manifest.model,
    effort: parsed.manifest.effort,
    changed: !(base?.from === "instance" && next === before),
  };
  if (!result.changed) return result;
  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  const message = `metistry agents define ${id}${base?.from === "product" ? " (the instance's own copy of the shipped definition)" : before === null ? " (new crew)" : ""}`;
  result.delivery = await writeProtected(r, rel, next, message, { env: opts.env, platform: opts.platform, uid: opts.uid, fetchFn: opts.fetchFn ?? fetch, instanceDir: opts.instanceDir });
  return result;
}

export function renderDefine(v: DefineResult, ui: Ui = defaultUi()): string {
  const lines = [ui.kv([
    ["agent", `${v.id} (${v.area})`],
    ["file", `${v.path}${v.from === "product" ? " — from the shipped copy; the instance's own now wins by name" : v.from === "new" ? " — new" : ""}`],
    ["model", `${v.model} · effort ${v.effort}`],
    ["sha256", v.sha256],
  ])];
  if (!v.changed) lines.push(ui.note("nothing changed — pass --model, --effort, --description or --prompt-file to edit it"));
  else if (v.delivery) lines.push(ui.note(`${v.delivery.detail} · the console re-reads crews every METISTRY_CREWS_SYNC_S (5 min) and at its next start`));
  return lines.join("\n");
}
