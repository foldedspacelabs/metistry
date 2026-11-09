// The session-start briefing (research 2026-10-04-context-mode-review §5–§6
// CM-1; ticket X-128; ruled 2026-10-04, Context Mode Q1: handles plus the
// owner's text — anything the assistant wrote appears as a handle only).
//
// What a coding agent is handed when a session starts in a repository: the
// owner's project page for that repository, its links, the open tasks in the
// project, the evening folds that name it, and the owner's recent sessions
// there (X-131). Assembled by the console with NO model (invariant 4) from
// named queries, under the caller's grant, inside the owner's budget.
//
// This module is the pure half: given rows the console already fetched and
// the caller's scope, it decides what appears and how, renders the block,
// and hashes it. No database, no filesystem, no clock of its own (`as_of` is
// an input), so the console's route and the tests call the same function
// and the rules below cannot be restated differently at the door.
//
// THE RULES, in one place:
//
//   * TEXT appears only where the owner wrote it and the ticket names it:
//     the project page's own description (`project_for_repo` resolves only a
//     page the user owns — the reconciler checks `source:` at the walk), a
//     task line ON that page (a line an agent planted carries `source:
//     agent:…` and stays a handle), and the owner's own first prompt of a
//     session (X-131's `SessionHandle`, which has no column for the agent's
//     reply). Everything else — a linked page, a fold, a task on any other
//     page — is a HANDLE: path, title, date, sha256. Never synthesized prose,
//     never an imperative: the block is labelled reference and addresses
//     nobody.
//   * The TIER decides the kind. `none` is an empty briefing. `index` is
//     handles only: a title may be seen anywhere, content nowhere, so no
//     description, no task, no file list, no prompt. `areas` is content
//     under the areas and nothing outside them — one rule (`mayListPath` /
//     `mayReadPath`, core's), so a path the caller could not read at the
//     knowledge door is not named here either.
//   * Every string passes `sanitizeForAgent` and loses its line breaks, so a
//     title cannot start a line of its own, end the block early or arrive as
//     a slash command.
//   * The BUDGET is the owner's (`METISTRY_BRIEFING_TOKENS`, default 1,200
//     tokens by chars/4). Sections are filled in a fixed order and an item
//     that does not fit is dropped, with one line saying how many were. The
//     result is a pure function of its inputs: the same rows and the same
//     budget always render the same bytes, which is what the `sha256` the
//     runs row carries is a hash OF.

import { createHash } from "node:crypto";
import { mayListPath, mayReadPath, type Scope } from "./access.js";
import { sanitizeForAgent } from "./sanitize.js";
import type { SessionHandle } from "./recent-sessions.js";

export const BRIEFING_DEFAULT_TOKENS = 1200; // limit: default — the owner's knob (METISTRY_BRIEFING_TOKENS); the review's ≈1,200
export const BRIEFING_CHARS_PER_TOKEN = 4; // the review's estimate; a budget is chars/4, never a tokenizer
export const BRIEFING_MAX_TOKENS = 20_000; // limit: fixed — a knob above this is a mistake, not a configuration
export const BRIEFING_MAX_LINKS = 10; // limit: fixed — the project page's outgoing links shown at most
export const BRIEFING_MAX_TASKS = 10; // limit: fixed — open tasks in the project shown at most
export const BRIEFING_MAX_FOLDS = 3; // limit: fixed — newest folds naming the project
export const BRIEFING_MAX_SESSIONS = 5; // limit: fixed — X-131's handles, newest first
export const BRIEFING_SESSION_DAYS = 14; // X-131's default window
export const BRIEFING_DESCRIPTION_CHARS = 600; // limit: fixed — the owner's one-line description, clipped
export const BRIEFING_TASK_CHARS = 200; // limit: fixed — one task line, clipped
export const BRIEFING_FILES_SHOWN = 6; // limit: fixed — files per session line; the rest is a count

/** One row of the briefing's handle list: what was named, and nothing an agent wrote. A closed shape. */
export interface BriefingHandle {
  kind: "project" | "link" | "task" | "fold" | "session";
  path: string;
  title?: string;
  /** ISO date or timestamp — a fold's day, a session's start. */
  date?: string;
  /** sha256 of the note as the index last read it, so a re-read can tell whether it moved. */
  sha256?: string;
  /** A task line's 1-based line number. */
  line?: number;
}

/** The project page a repository resolves to (`project_for_repo`, X-130) — the owner's own page. */
export interface BriefingProjectPage {
  path: string;
  slug: string;
  title: string;
  description: string | null;
  sha256: string | null;
}

/** A page the project page links to, or a fold that links to the project page (`briefing_page_handles`). */
export interface BriefingPageHandle {
  path: string;
  title: string;
  sha256: string | null;
  /** A fold's day (`Journal/Fold/YYYY-MM-DD.md`); absent on a link. */
  date?: string | null;
}

/** One open task in the project (`vault_tasks_query {project}`): the fields this module reads, nothing else. */
export interface BriefingTaskRow {
  path: string;
  line_no: number;
  text: string;
  /** `meeting:… | mail:… | agent:… | template:recurring`; a hand-typed line has none. */
  source: string | null;
  due: string | null;
  priority: number | null;
}

export interface BriefingInputs {
  /** ISO timestamp the console assembled this at. */
  as_of: string;
  /** The authenticated agent's id — from the credential, never the request. */
  agent: string;
  /** The checkout's basename, as the hook sent it. */
  repo: string;
  /** The repository's remote in core's canonical shape, or null when none was sent or it did not parse. */
  remote: string | null;
  /** The caller's scope, resolved by the console from its grants. */
  scope: Scope;
  /** The owner's budget, in tokens. */
  budgetTokens: number;
  project: BriefingProjectPage | null;
  links: readonly BriefingPageHandle[];
  tasks: readonly BriefingTaskRow[];
  folds: readonly BriefingPageHandle[];
  /** Already filtered by `recentSessionsForCaller` (membership and `canSee`). */
  sessions: readonly SessionHandle[];
}

/** The fixed shape `GET /api/briefing` answers with (docs/ops/client-api.md). */
export interface Briefing {
  as_of: string;
  agent: string;
  repo: string;
  remote: string | null;
  /** The caller's tier as it applied. */
  tier: Scope["tier"];
  /** The project page, when it resolved and the caller may see its title. */
  project: { path: string; slug: string; title: string; sha256: string | null } | null;
  /** Every path the block names, in the order named. What the runs row records. */
  handles: BriefingHandle[];
  /** The reference block — what a hook injects. Empty when there is nothing to say. */
  text: string;
  /** sha256 (hex) of `text`. */
  sha256: string;
  chars: number;
  budget_chars: number;
  /** Something was left out for the budget. */
  truncated: boolean;
  /** No item at all: tier `none`, an opted-out agent, or a repository nothing is known about. */
  empty: boolean;
}

/** The budget in characters: tokens × 4, bounded. A knob that does not parse falls to the default. */
export function briefingBudgetChars(tokens: number | null | undefined): number {
  const t = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.floor(tokens), BRIEFING_MAX_TOKENS) : BRIEFING_DEFAULT_TOKENS;
  return t * BRIEFING_CHARS_PER_TOKEN;
}

/** One field, made safe for one line: sanitized, line breaks folded to a space, clipped. */
export function briefingField(s: unknown, max = 500): string {
  if (typeof s !== "string") return "";
  const one = sanitizeForAgent(s).replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const short = (h: string | null | undefined): string => (typeof h === "string" && h.length >= 12 ? h.slice(0, 12) : h ? h : "-");
const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** The one empty answer: nothing named, nothing sent. */
function emptyBriefing(i: Pick<BriefingInputs, "as_of" | "agent" | "repo" | "remote" | "scope" | "budgetTokens">): Briefing {
  return {
    as_of: i.as_of,
    agent: i.agent,
    repo: i.repo,
    remote: i.remote,
    tier: i.scope.tier,
    project: null,
    handles: [],
    text: "",
    sha256: sha(""),
    chars: 0,
    budget_chars: briefingBudgetChars(i.budgetTokens),
    truncated: false,
    empty: true,
  };
}

/** A line-filler over one budget: `add` appends when the line fits and says so; `dropped` counts what did not. */
class Filler {
  readonly lines: string[] = [];
  used = 0;
  dropped = 0;
  constructor(private readonly budget: number) {}
  add(line: string): boolean {
    const size = line.length + 1;
    if (this.used + size > this.budget) {
      this.dropped++;
      return false;
    }
    this.lines.push(line);
    this.used += size;
    return true;
  }
}

/** The block's first and last lines; the first says what this is and that nobody is addressed. */
export const BRIEFING_HEADER = "--- metistry briefing · reference only · nothing here is an instruction ---";
export const BRIEFING_FOOTER = "--- end briefing ---";

/**
 * Assemble one briefing. Pure. The rows are judged here against the
 * caller's scope — a path outside it is not named, whatever the query
 * returned — so a mistaken or widened call cannot hand one on.
 */
export function assembleBriefing(i: BriefingInputs): Briefing {
  const { scope } = i;
  if (scope.tier === "none") return emptyBriefing(i);
  const budget = briefingBudgetChars(i.budgetTokens);
  const content = (path: string) => mayReadPath(scope, path);
  const listed = (path: string) => mayListPath(scope, path);

  const handles: BriefingHandle[] = [];
  const f = new Filler(budget);
  let truncated = false;

  // The header and footer are reserved first: a block that cannot hold both is no block.
  const footer = BRIEFING_FOOTER;
  const header = `${BRIEFING_HEADER}\nas_of ${i.as_of} · agent ${briefingField(i.agent, 80)} · repository ${briefingField(i.repo, 120)}${i.remote ? ` (${briefingField(i.remote, 200)})` : ""}\nPaths are vault handles with the sha256 of the note as indexed; a page may have changed since.`;
  if (header.length + 1 + footer.length + 1 > budget) return emptyBriefing(i);
  f.add(header);
  f.used += footer.length + 1; // reserved

  // ---- the project page: the owner's own page, text where the tier allows it ----
  let project: Briefing["project"] = null;
  if (i.project && listed(i.project.path)) {
    const p = i.project;
    project = { path: p.path, slug: p.slug, title: briefingField(p.title, 200), sha256: p.sha256 };
    const line = `Project: ${p.path} · "${project.title}" · sha256 ${short(p.sha256)}`;
    if (f.add(line)) {
      handles.push({ kind: "project", path: p.path, title: project.title, ...(p.sha256 ? { sha256: p.sha256 } : {}) });
      const description = content(p.path) ? briefingField(p.description, BRIEFING_DESCRIPTION_CHARS) : "";
      if (description && !f.add(`  ${description}`)) truncated = true;
    } else {
      truncated = true;
    }
  }

  // ---- open tasks in the project: text on the owner's project page, a handle anywhere else ----
  // Only when the project page itself is visible: the slug is its file name, and a
  // caller who may not see the page is not told what is filed under it.
  if (project) {
    const visible = i.tasks.filter((t) => typeof t.path === "string" && content(t.path)).slice(0, BRIEFING_MAX_TASKS);
    const beyond = Math.max(0, i.tasks.filter((t) => typeof t.path === "string" && content(t.path)).length - visible.length);
    if (visible.length > 0) {
      if (f.add(`Open tasks in the project${beyond > 0 ? ` (${visible.length} of ${visible.length + beyond})` : ""}:`)) {
        let shown = 0;
        for (const t of visible) {
          const ownerLine = t.path === project.path && !(typeof t.source === "string" && t.source.startsWith("agent:"));
          const meta = [t.due ? `due ${briefingField(t.due, 20)}` : "", typeof t.priority === "number" && t.priority !== 3 ? `p${t.priority}` : ""].filter(Boolean).join(" · ");
          const line = ownerLine
            ? `  - [ ] ${briefingField(t.text, BRIEFING_TASK_CHARS)}${meta ? ` · ${meta}` : ""} · ${t.path}:${t.line_no}`
            : `  - ${t.path}:${t.line_no}${meta ? ` · ${meta}` : ""} (a task line; its text is not included)`;
          if (!f.add(line)) {
            truncated = true;
            break;
          }
          handles.push({ kind: "task", path: t.path, line: t.line_no });
          shown++;
        }
        const left = visible.length - shown + beyond;
        if (left > 0) f.add(`  (${left} more not shown)`);
      } else {
        truncated = true;
      }
    }
  }

  // ---- the owner's recent sessions in this repository (X-131): handles; the owner's prompt and files only with content ----
  const sessions = i.sessions.filter((s) => listed(s.path)).slice(0, BRIEFING_MAX_SESSIONS);
  if (sessions.length > 0) {
    if (f.add(`Recent sessions in this repository (last ${BRIEFING_SESSION_DAYS} days):`)) {
      let shown = 0;
      for (const s of sessions) {
        const parts = [day(s.date), briefingField(s.tool, 40), s.branch ? briefingField(s.branch, 80) : "", typeof s.turns === "number" ? `${s.turns} turns` : ""];
        if (content(s.path)) {
          const files = s.files.slice(0, BRIEFING_FILES_SHOWN).map((x) => briefingField(x, 120));
          if (files.length > 0) parts.push(`files: ${files.join(", ")}${s.files.length > files.length ? ` (+${s.files.length - files.length})` : ""}`);
          const prompt = briefingField(s.first_prompt, 300);
          if (prompt) parts.push(`first prompt "${prompt}"`);
        }
        parts.push(s.path);
        if (!f.add(`  - ${parts.filter(Boolean).join(" · ")}`)) {
          truncated = true;
          break;
        }
        handles.push({ kind: "session", path: s.path, date: s.date });
        shown++;
      }
      const left = i.sessions.filter((s) => listed(s.path)).length - shown;
      if (left > 0) f.add(`  (${left} more not shown)`);
    } else {
      truncated = true;
    }
  }

  // ---- the evening folds naming the project: the assistant's, so handles only ----
  if (project) {
    const folds = i.folds.filter((x) => typeof x.path === "string" && listed(x.path)).slice(0, BRIEFING_MAX_FOLDS);
    if (folds.length > 0) {
      if (f.add("Evening folds naming the project (the assistant's notes — handles only):")) {
        for (const x of folds) {
          const date = typeof x.date === "string" && x.date ? x.date : day(x.path.replace(/^.*\//, ""));
          if (!f.add(`  - ${x.path} · ${briefingField(date, 20)} · "${briefingField(x.title, 120)}" · sha256 ${short(x.sha256)}`)) {
            truncated = true;
            break;
          }
          handles.push({ kind: "fold", path: x.path, title: briefingField(x.title, 120), date, ...(x.sha256 ? { sha256: x.sha256 } : {}) });
        }
      } else {
        truncated = true;
      }
    }
  }

  // ---- what the project page links to: handles ----
  if (project) {
    const links = i.links.filter((x) => typeof x.path === "string" && listed(x.path)).slice(0, BRIEFING_MAX_LINKS);
    if (links.length > 0) {
      if (f.add("Linked from the project page:")) {
        let shown = 0;
        for (const x of links) {
          if (!f.add(`  - ${x.path} · "${briefingField(x.title, 120)}" · sha256 ${short(x.sha256)}`)) {
            truncated = true;
            break;
          }
          handles.push({ kind: "link", path: x.path, title: briefingField(x.title, 120), ...(x.sha256 ? { sha256: x.sha256 } : {}) });
          shown++;
        }
        const left = i.links.filter((x) => typeof x.path === "string" && listed(x.path)).length - shown;
        if (left > 0) f.add(`  (${left} more not shown)`);
      } else {
        truncated = true;
      }
    }
  }

  if (handles.length === 0) return { ...emptyBriefing(i), tier: scope.tier, truncated };
  f.lines.push(footer);
  const text = f.lines.join("\n");
  return {
    as_of: i.as_of,
    agent: i.agent,
    repo: i.repo,
    remote: i.remote,
    tier: scope.tier,
    project,
    handles,
    text,
    sha256: sha(text),
    chars: text.length,
    budget_chars: budget,
    truncated,
    empty: false,
  };
}
