// Note parsing for the index (§4.13): content hash, frontmatter (title,
// description, draft), link extraction, and Obsidian/Syncthing conflict-file
// detection. Pure functions — the indexer feeds them bytes.

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { INSTANCE_LAYOUT, JOURNAL_DIR, isUserOwnedPath, parseTaskLine, validAreaPrefix, type ParsedTaskLine, type TaskDateOptions } from "@foldedspacelabs/metistry-core";

export interface NoteMeta {
  title: string | null;
  description: string | null;
  draft: boolean;
  /**
   * The frontmatter `source:` — **who owns this file** (#231's ownership
   * vocabulary, `packages/mcp-brain/src/knowledge-write.ts`). Null means no
   * `source:` at all, which is the user's and not an opening. The task pass
   * reads it to tell a note the user typed from a machine file that merely
   * renders one (daily-flow-spec §5.1, D10).
   */
  source: string | null;
  /** The frontmatter `area:`, wikilink brackets stripped — `area: "[[Drey]]"` is the schema's spelling (`metistry-build-plan.md`). */
  area: string | null;
  /**
   * The frontmatter `event_id:` — the calendar event a meeting note is FOR
   * (today-hub-requests A3, plan §2.9 `vault_meeting_refs`). Verbatim, never
   * truncated: an id that is not one whole id is not an id (`meetingEventId`).
   * The walk reads it only from a meeting note (`isMeetingNotePath`).
   */
  event_id: string | null;
  /**
   * The frontmatter `email:` — one address or a list, normalised and
   * validated by `personEmails`; anything that is not plainly an address is
   * dropped rather than repaired. The walk reads it only from a People page
   * the user owns (`isPersonPath` + `ownedByUser`).
   */
  emails: string[];
}

export interface NoteLink {
  target: string; // as written, minus alias/heading/block
  kind: "wikilink" | "embed" | "markdown";
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Basename without the .md extension — the fallback title. */
export function basenameTitle(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.md$/i, "");
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Frontmatter fields the index serves. Never throws — bad YAML is "no
 * frontmatter".
 *
 * `bodyLine` is the 1-based line number, IN THE FILE, of the first line of
 * `body`. The task pass reports `vault_tasks.line_no` as the line the user
 * would jump to in Obsidian, and a note with eight lines of frontmatter
 * would otherwise be reported eight lines short.
 */
export function parseFrontmatter(text: string): { meta: NoteMeta; body: string; bodyLine: number } {
  const m = FRONTMATTER_RE.exec(text);
  const none: NoteMeta = emptyNoteMeta();
  if (!m) return { meta: none, body: text, bodyLine: 1 };
  const bodyLine = 1 + (m[0].match(/\n/g)?.length ?? 0);
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return { meta: none, body: text.slice(m[0].length), bodyLine };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { meta: none, body: text.slice(m[0].length), bodyLine };
  const o = fm as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : typeof v === "number" ? String(v) : null);
  const status = typeof o.status === "string" ? o.status.trim().toLowerCase() : "";
  const area = str(o.area);
  return {
    meta: {
      title: str(o.title),
      description: str(o.description),
      draft: status === "draft" || o.draft === true,
      source: str(o.source),
      area: area === null ? null : unwikilink(area),
      event_id: meetingEventId(o.event_id),
      emails: personEmails(o.email),
    },
    body: text.slice(m[0].length),
    bodyLine,
  };
}

/** A note with no frontmatter the index reads. */
export function emptyNoteMeta(): NoteMeta {
  return { title: null, description: null, draft: false, source: null, area: null, event_id: null, emails: [] };
}

/** Longer than any calendar's event id (EventKit's, Google's, an iCalendar UID); a longer value is refused, never cut to fit. */
const EVENT_ID_MAX = 1024; // limit: fixed — a sanity bound on one frontmatter scalar, not a policy anyone tunes

/**
 * `event_id:` as the walk stores it: a string (or a number — YAML reads a
 * bare numeric id as one) with its ends trimmed and NOTHING else changed.
 * Event ids are case-sensitive and opaque, so this never lowercases,
 * truncates or "cleans" one: a value with a control character, or one over
 * `EVENT_ID_MAX`, is no id at all, and a meeting with no id links to no note.
 */
export function meetingEventId(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  if (raw === null || raw === "" || raw.length > EVENT_ID_MAX) return null;
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/** RFC 5321's path limit; nothing longer is a deliverable address. */
const EMAIL_MAX = 254; // limit: fixed — the protocol's own ceiling
/** Addresses read from one People page. A person has a few; a list of hundreds is not a person. */
const EMAILS_PER_PAGE_MAX = 16; // limit: fixed — a bound on one page's frontmatter, so one note cannot flood the table

/**
 * Deliberately plain: one `@`, no whitespace, no brackets, quotes or
 * separators anywhere, a dot in the domain. It is not RFC 5322 and does not
 * try to be — an attendee address from a calendar is always this shape, and
 * anything that is not (`Jim <jim@x.com>`, `jim at x dot com`) is dropped,
 * not parsed: a person is never guessed (A4).
 */
const EMAIL_RE = /^[^\s@<>()[\]{},;:"'\\]+@[^\s@<>()[\]{},;:"'\\.]+(?:\.[^\s@<>()[\]{},;:"'\\.]+)+$/;

/**
 * `email:` as the walk stores it — the key `people_by_email` looks an
 * attendee up by. One string or a YAML list of strings; each trimmed, a
 * `mailto:` prefix dropped (Obsidian users paste links), then LOWERCASED
 * whole: calendars do not agree on the case of an address, and a lookup that
 * missed `Jim@X.com` because the page said `jim@x.com` would be a person
 * silently lost. Invalid entries are dropped; duplicates collapse.
 */
export function personEmails(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out = new Set<string>();
  for (const item of items) {
    if (out.size >= EMAILS_PER_PAGE_MAX) break;
    if (typeof item !== "string") continue;
    const email = normaliseEmail(item);
    if (email !== null) out.add(email);
  }
  return [...out];
}

/** One address, normalised the way the table and `people_by_email` both read it, or null when it is not plainly an address. */
export function normaliseEmail(value: string): string | null {
  const email = value.trim().replace(/^mailto:/i, "").toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  return EMAIL_RE.test(email) ? email : null;
}

/** `[[Drey]]` → `Drey`, `[[Areas/Drey|Drey]]` → `Areas/Drey`. The frontmatter schema says an `area:` is always a wikilink; the index stores the target. */
function unwikilink(value: string): string {
  const m = /^!?\[\[([^\]]+)\]\]$/.exec(value.trim());
  return (m?.[1] ?? value).split("|")[0]!.trim();
}

const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_FENCE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/** Wiki-links, embeds, and relative markdown links (URLs with a scheme are skipped). */
export function extractLinks(body: string): NoteLink[] {
  const text = body.replace(CODE_FENCE_RE, ""); // links inside code are not links
  const out: NoteLink[] = [];
  const seen = new Set<string>();
  const push = (target: string, kind: NoteLink["kind"]) => {
    const key = `${kind}:${target}`;
    if (target && !seen.has(key)) {
      seen.add(key);
      out.push({ target, kind });
    }
  };
  for (const m of text.matchAll(WIKILINK_RE)) {
    const inner = m[2]!.split("|")[0]!.split("#")[0]!.split("^")[0]!.trim();
    push(inner, m[1] ? "embed" : "wikilink");
  }
  for (const m of text.matchAll(MDLINK_RE)) {
    let href = m[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) continue; // external / same-page
    href = href.split("#")[0]!;
    try {
      href = decodeURIComponent(href);
    } catch {}
    if (href) push(href, "markdown");
  }
  return out;
}

/**
 * Resolve a link target to a vault path the way Obsidian does: exact
 * vault-relative path (with or without .md), a path relative to the
 * linking note's directory, or a unique basename match anywhere in the
 * vault. Unresolved targets are kept as written so dangling links are
 * queryable.
 */
export function resolveLink(fromPath: string, target: string, paths: ReadonlySet<string>, byBasename: ReadonlyMap<string, string[]>): string {
  const t = target.replace(/^\.\//, "");
  const withMd = /\.[A-Za-z0-9]+$/.test(t) ? t : `${t}.md`;
  if (paths.has(t)) return t;
  if (paths.has(withMd)) return withMd;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const rel = normalize(dir ? `${dir}/${withMd}` : withMd);
  if (rel && paths.has(rel)) return rel;
  const base = withMd.replace(/^.*\//, "").toLowerCase();
  const cands = byBasename.get(base);
  if (cands && cands.length === 1) return cands[0]!;
  return t;
}

function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

// Obsidian Sync: "Note (conflict 2026-09-06 12-00-00).md"; Syncthing:
// "Note.sync-conflict-20260906-120000-ABCDEFG.md"; other tools:
// "Note (sync-conflict …)". PoC-12: flag, never index.
const CONFLICT_RE = /(\((sync-)?conflict\b[^)]*\)|\.sync-conflict-)/i;

export function isConflictFile(path: string): boolean {
  return CONFLICT_RE.test(path.replace(/^.*\//, ""));
}

/**
 * The note a conflict copy is a copy OF — the same folder, the name with the
 * sync tool's marker taken out: `Note (conflict 2026-09-06 12-00-00).md` and
 * `Note.sync-conflict-20260906-120000-ABCDEFG.md` are both copies of
 * `Note.md`. Null for a path that is not a conflict copy, or whose name is
 * nothing but the marker. Whether that note still exists is the caller's to
 * check: a copy can outlive its original.
 */
export function conflictOriginal(path: string): string | null {
  if (!isConflictFile(path)) return null;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const name = path
    .slice(slash + 1)
    .replace(/\.sync-conflict-[^.]*/i, "")
    .replace(/\s*\((sync-)?conflict\b[^)]*\)/i, "");
  return name === "" || name.startsWith(".") ? null : `${dir}${name}`;
}

export function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

// ---- the vault inbox (docs/ops/inbox.md) ----------------------------------

/**
 * The vault directory captures live in, at the vault root. TitleCase
 * (CLAUDE.md casing rule).
 *
 * The default, not the only value: an instance that has not run
 * `metistry migrate-layout` yet keeps its vault — and so its inbox — in
 * `Knowledge/Inbox/`, and the indexer is given that prefix instead
 * (`IndexerConfig.inboxPrefix`, resolved once at startup). Everything that
 * takes the prefix takes it as an argument for that reason.
 */
export const INBOX_PREFIX = INSTANCE_LAYOUT.inboxDir;

export function isInboxPath(path: string, prefix: string = INBOX_PREFIX): boolean {
  return path.startsWith(`${prefix}/`);
}

/**
 * Enough of a mime type for `inbox-drain`'s classifier, by extension alone.
 * A file a human dropped into the inbox carries no HTTP header to read, and
 * sniffing content would be a dependency; unknown is null, which the
 * classifier already handles.
 */
const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export function mimeForPath(path: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) ?? null;
}

const TEXTUAL = new Set(["application/json", "application/yaml", "image/svg+xml"]);

/**
 * The one-line `inbox.note` for a file nobody captured through an API: the
 * frontmatter title if there is one, else the first non-empty line with its
 * markdown heading marker stripped. Binary content has none.
 */
export function inboxNoteFor(path: string, bytes: Uint8Array): string | null {
  const mime = mimeForPath(path);
  if (mime === null ? !isMarkdown(path) : !(mime.startsWith("text/") || TEXTUAL.has(mime))) return null;
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\0")) return null; // binary wearing a text extension
  const { meta, body } = parseFrontmatter(text);
  const first = body.split(/\r?\n/).find((l) => l.trim() !== "");
  const line = (meta.title ?? first ?? "").replace(/^#{1,6}\s*/, "").trim();
  return line === "" ? null : line.slice(0, 2000);
}

// ---- the vault's tasks (docs/product/daily-flow-spec.md §1, §2, P1-4) -----

/**
 * One `- [ ] …` line, as the walk found it. The parse itself is
 * `packages/core`'s (`parseTaskLine`, P1-1) and is pure; what this adds is
 * the two things that need the FILE: where the line is, and which identity
 * it has among its neighbours.
 */
export interface ScannedTask {
  /** §2.1's identity: the anchor when the line carries one, else the hash key below. */
  task_key: string;
  /** 1-based, in the file — frontmatter included, so it is the line Obsidian jumps to. */
  line_no: number;
  parsed: ParsedTaskLine;
}

/** A `[[note#^mt-7x2k]]` / `![[note#^mt-7x2k]]`, which `knowledge_links` cannot hold (`extractLinks` strips the anchor). */
export interface NoteTaskRef {
  /** As written, minus the alias and the anchor. `""` means the note itself (`[[#^mt-7x2k]]`). */
  target: string;
  /** The block id without the caret, lowercased. */
  anchor: string;
  kind: "wikilink" | "embed";
}

/**
 * The read side of `^mt-…`: deliberately looser than the minter's shape
 * (`isTaskAnchor`), because a hand-typed or older anchor is still an
 * identity rather than stray text.
 */
const TASK_ANCHOR_RE = /^mt-[0-9a-z]{2,16}$/i;

/**
 * Vault directories whose markdown holds task-SHAPED lines that are not
 * tasks. `Templates/` is the whole list and it is not a policy about
 * ownership: a template ships `source: user` on purpose (§6.1, so
 * `ownershipRefusal` keeps it the user's hand), and its `{{ tasks … }}`
 * directive and its literal `- [ ] …` examples are a description of what
 * will be rendered, not a todo anybody has.
 *
 * Everything else is already excluded upstream and is not restated here:
 * `.metistry/`, `Artifacts/` and every dot-directory never reach this
 * module at all (`Vault.walkVault` + `isVaultPath`).
 */
export const TASK_SKIP_PREFIXES = Object.freeze(["Templates"] as const);

/** Where person pages live (TitleCase, stamped by `metistry init`), for `@Jim` → `People/Jim Fallon.md`. */
export const PEOPLE_PREFIX = "People";

/** Where project notes live, for the `+slug` a task line does not spell. */
export const PROJECTS_PREFIX = "Projects";

/** `projects.id`'s own shape (`db/migrations/0011_projects.sql`), so a derived slug is one the projects table could hold. */
const PROJECT_SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** The `source:` that means "the user's own file" when one is written out; **no** `source:` means the same thing (#231). */
const USER_SOURCE = "user";

/**
 * Whether the `- [ ]` lines in this note are TASKS — the daily flow's
 * §2.1 rule, made mechanical.
 *
 * A task exists once, on the line where it was typed. `Journal/Plan/…`,
 * `Journal/Fold/…` and `Journal/Standup/…` are machine files with one
 * writer each (§5.1, D10): what they show is a generated list today and a
 * transclusion once anchors exist, and in neither case is it a second
 * canonical line. Indexing them would double every todo the plan mentions
 * and re-date it to the day the plan was written.
 *
 * The test is the FILE'S OWN `source:` frontmatter rather than a list of
 * directory names, because that is the ownership vocabulary the repo
 * already enforces writes with (#231, `ownershipRefusal`): a machine file
 * carries the writer that produced it, a file with `source: user` or with
 * no `source:` at all is the user's. So a user who keeps their plan
 * somewhere else is still indexed, and a routine that writes somewhere new
 * is still skipped, with nothing to keep in sync.
 */
export function ownsTaskLines(meta: NoteMeta): boolean {
  return ownedByUser(meta);
}

/** The note is the user's own: no `source:`, or `source: user` (#231). An assistant-created note carries its creator's id and is never this. */
export function ownedByUser(meta: NoteMeta): boolean {
  return meta.source === null || meta.source === USER_SOURCE;
}

/** True when a path is one the task pass reads at all (`Templates/` is not). */
export function isTaskPath(path: string): boolean {
  if (!isMarkdown(path)) return false;
  return !TASK_SKIP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** An opening or closing ``` / ~~~ fence, at the start of a line. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Every task line in a note, keyed per §2.1.
 *
 * **The key degrades honestly.** With an anchor it IS the anchor, so the
 * line keeps its identity when it moves. Without one it is
 * `h:<sha256 of text_norm>:<ordinal>` — stable across a field edit
 * (`due friday` → `due 2026-09-25` leaves `text_norm` alone), unstable
 * across a text edit, which is exactly the guarantee a line with no id can
 * make.
 *
 * **The ordinal counts every identical line in the file, anchored or not**,
 * in the order they appear. Counting only the anchorless ones would look
 * tidier and would re-key the second of two identical lines the moment the
 * plugin minted an anchor on the first — and the plugin mints them one at a
 * time, in the user's editor, forever.
 *
 * **A repeated anchor cannot fail the walk.** `(path, task_key)` is the
 * primary key, so a line copy-pasted with its anchor inside one note would
 * collide; the second one falls back to its hash key instead. A derived
 * index that can refuse to be rebuilt is not derived
 * (`db/migrations/0024_vault_tasks.sql`).
 *
 * **Fenced code is not a todo list.** A ``` block holding `- [ ] …` is
 * documentation — this file's own docs contain some — and the fence state
 * is tracked line by line rather than stripped, so `line_no` stays the
 * file's own.
 */
export function extractTasks(text: string, opts: TaskDateOptions = {}): ScannedTask[] {
  const { body, bodyLine } = parseFrontmatter(text);
  const out: ScannedTask[] = [];
  const ordinals = new Map<string, number>();
  const used = new Set<string>();
  let fence: string | null = null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE_RE.exec(line)?.[1];
    if (f) {
      if (fence === null) fence = f[0]!;
      else if (fence === f[0]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const parsed = parseTaskLine(line, opts);
    if (!parsed) continue;
    const ordinal = ordinals.get(parsed.text_norm) ?? 0;
    ordinals.set(parsed.text_norm, ordinal + 1);
    const hashed = `h:${sha256(parsed.text_norm)}:${ordinal}`;
    const key = parsed.anchor !== null && !used.has(parsed.anchor) ? parsed.anchor : hashed;
    if (used.has(key)) continue; // unreachable while ordinals are per-line; a row is still never a failed walk
    used.add(key);
    out.push({ task_key: key, line_no: bodyLine + i, parsed });
  }
  return out;
}

/**
 * Block-anchored references. `knowledge_links` cannot hold these —
 * `extractLinks` strips `#` and `^` from every target and its primary key
 * has no room for one — so they are the second derived table rather than a
 * destructive widening of the first.
 */
export function extractTaskRefs(body: string): NoteTaskRef[] {
  const text = body.replace(CODE_FENCE_RE, ""); // a link inside code is not a link, here as in extractLinks
  const out: NoteTaskRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) {
    const inner = m[2]!.split("|")[0]!;
    const hash = inner.indexOf("#");
    if (hash < 0) continue;
    const frag = inner.slice(hash + 1).trim();
    if (!frag.startsWith("^")) continue;
    const anchor = frag.slice(1).trim().toLowerCase();
    if (!TASK_ANCHOR_RE.test(anchor)) continue;
    const target = inner.slice(0, hash).trim();
    const kind = m[1] ? "embed" : "wikilink";
    const key = `${target}\0${anchor}\0${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, anchor, kind });
  }
  return out;
}

/** `vault:Journal/2026-09-18.md#^mt-7x2k` — how a `work` row names a human todo (§3) and how a promotion spells `work.external_ref`. */
const VAULT_TASK_REF_RE = /^vault:(.+)#\^(mt-[0-9a-z]{2,16})$/i;

/** The `(path, anchor)` a `work.meta.blocked_by` names, or null when it is not that spelling. */
export function parseVaultTaskRef(value: unknown): { path: string; anchor: string } | null {
  if (typeof value !== "string") return null;
  const m = VAULT_TASK_REF_RE.exec(value.trim());
  if (!m?.[1] || !m[2]) return null;
  return { path: m[1], anchor: m[2].toLowerCase() };
}

/**
 * `@Jim` / `@[[Jim Fallon]]` → the person page's vault path.
 *
 * Ordinary link resolution first, so `@[[Jim Fallon]]` lands the same way
 * the wikilink it already is lands in `knowledge_links`. Then §1.3's extra
 * clause — "`@Jim` resolves to a unique `People/Jim*.md`" — as a unique
 * prefix match under `People/` and nowhere else.
 *
 * Ambiguous or unresolved, the name is STORED AS WRITTEN and flagged: a
 * field Metistry cannot read is never guessed (§1.4), and a person is a
 * field.
 */
export function resolveAssignee(
  fromPath: string,
  name: string,
  paths: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, string[]>,
  people: readonly string[],
): { assigned: string; warning: string | null } {
  const linked = resolveLink(fromPath, name, paths, byBasename);
  if (paths.has(linked)) return { assigned: linked, warning: null };
  const needle = name.toLowerCase();
  const hits = people.filter((p) => basenameTitle(p).toLowerCase().startsWith(needle));
  if (hits.length === 1) return { assigned: hits[0]!, warning: null };
  return { assigned: name, warning: `@${name} (${hits.length === 0 ? `no ${PEOPLE_PREFIX}/ page` : `${hits.length} ${PEOPLE_PREFIX}/ pages`})` };
}

/**
 * Where meeting notes live: `Journal/Meetings/<date>-<topic>.md`, archived
 * to `Journal/Meetings/<year>/<month>/` (daily-flow-spec §5.1, §5.2).
 */
export const MEETINGS_PREFIX = `${JOURNAL_DIR}/Meetings`;

/**
 * A note whose `event_id:` the walk believes. Only under `Journal/Meetings/`,
 * and that directory is the user's AT THE TOOL (`isUserOwnedPath`: every
 * principal but `user` is refused a write there, `core`'s `may()` and the
 * bridge's `writeAllowed` alike) — so no agent can mint a note that claims
 * the owner's meeting, and "Open notes" (T2-11) can never open one.
 */
export function isMeetingNotePath(path: string): boolean {
  return isMarkdown(path) && path.startsWith(`${MEETINGS_PREFIX}/`) && isUserOwnedPath(path);
}

/** A person page: any markdown under `People/`, the directory `peoplePages` reads. */
export function isPersonPath(path: string): boolean {
  return isMarkdown(path) && path.startsWith(`${PEOPLE_PREFIX}/`);
}

/** Every `People/*.md` in the vault, for `resolveAssignee`. Built once per walk, not once per task. */
export function peoplePages(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) if (p.startsWith(`${PEOPLE_PREFIX}/`) && isMarkdown(p)) out.push(p);
  return out.sort();
}

/**
 * `vault_tasks.area` — never typed on a line (§1.3). The note's own
 * frontmatter `area:` when it spells a vault prefix, else the directory the
 * note lives in. A note at the vault root has no area, and neither does one
 * whose frontmatter names something that is not a prefix shape.
 */
export function areaForPath(path: string, meta: NoteMeta): string | null {
  if (meta.area !== null && validAreaPrefix(meta.area)) return meta.area;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return validAreaPrefix(dir) ? dir : null;
}

/**
 * `vault_tasks.project` when the line does not spell one — "derived from
 * location unless overridden" (§1.3). The location that means a project is
 * a note INSIDE a project's folder (`Projects/Drey/Notes.md`); a note
 * sitting directly in `Projects/` is about the collection, not in a
 * project, which is also what keeps the seeded `Projects/README.md` from
 * inventing a project called `readme`.
 */
export function projectForPath(path: string): string | null {
  const segs = path.split("/");
  if (segs[0] !== PROJECTS_PREFIX || segs.length < 3) return null;
  const slug = segs[1]!.toLowerCase().replace(/[ _]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return PROJECT_SLUG_RE.test(slug) ? slug : null;
}
