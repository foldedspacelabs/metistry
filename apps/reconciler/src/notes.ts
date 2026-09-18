// Note parsing for the index (§4.13): content hash, frontmatter (title,
// description, draft), link extraction, and Obsidian/Syncthing conflict-file
// detection. Pure functions — the indexer feeds them bytes.

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { INSTANCE_LAYOUT } from "@foldedspacelabs/metistry-core";

export interface NoteMeta {
  title: string | null;
  description: string | null;
  draft: boolean;
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

/** Frontmatter fields the index serves. Never throws — bad YAML is "no frontmatter". */
export function parseFrontmatter(text: string): { meta: NoteMeta; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  const none: NoteMeta = { title: null, description: null, draft: false };
  if (!m) return { meta: none, body: text };
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return { meta: none, body: text.slice(m[0].length) };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { meta: none, body: text.slice(m[0].length) };
  const o = fm as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : typeof v === "number" ? String(v) : null);
  const status = typeof o.status === "string" ? o.status.trim().toLowerCase() : "";
  return {
    meta: { title: str(o.title), description: str(o.description), draft: status === "draft" || o.draft === true },
    body: text.slice(m[0].length),
  };
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
