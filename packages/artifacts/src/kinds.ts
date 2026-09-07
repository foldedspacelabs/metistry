// Kind sniffing (§4.21): the console picks the viewer by kind and never
// trusts the extension over the sniffed type. Magic bytes decide binary
// kinds; text kinds come from the content's shape; the extension is only a
// tie-breaker where content cannot tell (a `.csv` and a `.txt` with commas
// are the same bytes). Anything that could carry script — HTML, SVG, XML
// with markup — is `html`, and `html` only ever renders sandboxed.

export const FILE_KINDS = ["markdown", "text", "json", "csv", "html", "image", "pdf", "binary"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const utf8 = new TextDecoder("utf-8", { fatal: true });

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

const IMAGE_MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // png
  [0xff, 0xd8, 0xff], // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif
  [0x42, 0x4d], // bmp
];

// Markup that can execute or embed: the head of the document is enough.
const MARKUP_RE = /<\s*(!doctype\s+html|html|head|body|script|iframe|object|embed|svg|link|meta)\b/i;
const MD_RE = /^(#{1,6}\s|\s*[-*+]\s+\S|\s*\d+\.\s+\S|>\s|\s*```)/m;
const MD_INLINE_RE = /\[\[[^\]]+\]\]|\]\([^)]*\)|\*\*[^*]+\*\*/;

export function sniffKind(path: string, content: Uint8Array): FileKind {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  if (startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (IMAGE_MAGIC.some((m) => startsWith(content, m))) return "image";
  if (startsWith(content, [0x52, 0x49, 0x46, 0x46]) && content.length >= 12 && String.fromCharCode(...content.subarray(8, 12)) === "WEBP") return "image";

  const head = content.subarray(0, 8192);
  if (head.includes(0)) return "binary";
  let text: string;
  try {
    text = utf8.decode(head);
  } catch {
    return "binary";
  }
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (MARKUP_RE.test(trimmed) || ext === "html" || ext === "htm" || ext === "svg" || ext === "xhtml") return "html";
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && content.length <= 8192) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {}
  } else if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && ext === "json") {
    return "json"; // too big to parse cheaply; the extension breaks the tie
  }
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "md" || ext === "markdown" || MD_RE.test(trimmed) || MD_INLINE_RE.test(trimmed)) return "markdown";
  return "text";
}

/**
 * The artifact's kind from its manifest: a single file is its kind; a
 * bundle with an entry file takes the entry's kind (`index.html` → a
 * small site, `index.md`/`README.md` → a report); anything else is a
 * `bundle`.
 */
export function artifactKind(manifest: Record<string, { kind: FileKind }>): FileKind | "bundle" {
  const paths = Object.keys(manifest).sort();
  if (paths.length === 0) return "bundle";
  if (paths.length === 1) return manifest[paths[0]!]!.kind;
  for (const entry of ["index.html", "index.md", "README.md", "index.json"]) {
    if (manifest[entry]) return manifest[entry]!.kind;
  }
  return "bundle";
}

/** What a browser may be told a raw file is (§6 #14): images and PDFs render natively; everything else is a download. */
export function contentTypeFor(kind: FileKind, path: string): { type: string; inline: boolean } {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  if (kind === "pdf") return { type: "application/pdf", inline: true };
  if (kind === "image") {
    const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext] ?? "application/octet-stream";
    return { type, inline: type !== "application/octet-stream" };
  }
  return { type: "application/octet-stream", inline: false };
}
