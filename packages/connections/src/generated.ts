// Generated tools — how an agent reaches a connection that is not an MCP
// server (plan §2.6, C115; T4-10). "The proxy speaks MCP to agents and each
// connection's own protocol behind it; non-MCP types get generated tools"
// (DEVELOPER-HANDOFF). The pool offers these exactly as it offers an MCP
// server's tools — through `connections_list { connection }` and
// `connections_call`, lazily: none of them is ever on the bridge's eager
// `tools/list` — and every rule of the pool holds: the file's `tools:` is the
// allowlist, the owner's mode decides how each runs (a tool that changes
// something is preview-then-confirm at Allow and waits for Approve at Ask
// First, in mcp-brain), and every request leaves through the egress door.
//
// The set is closed and small, by type and reach:
//
//   api    (http)  `get` (Reads) — a GET under the connection's URL;
//                  `request` (Changes things) — POST, PUT, PATCH or DELETE.
//   feed   (http)  `list_items`, `get_item`, `search_items` (Reads) — RSS 2.0,
//                  RSS 1.0 or Atom, parsed by the package's own XML reader.
//   files  (path)  `list_files`, `read_file`, `search_files` (Reads) — under
//                  the connection's folder or file, its include and skip
//                  patterns applied, never outside it.
//   files  (http)  `read_page` (Reads) — the page at the connection's URL.
//
// What each makes impossible rather than discouraged:
//
//   * **Leaving the connection.** An API path is relative and resolves under
//     the connection's URL — same origin, same path prefix; `..`, a scheme or
//     `//host` is refused before anything is sent. A files path resolves
//     under the root, `..` is refused, and a symbolic link that leads outside
//     it is refused after it is resolved.
//   * **A caller naming a secret.** A `{{ secret.… }}` anywhere in the
//     arguments is refused (the pool's `secret_reference`, for every
//     connection): the door fills references, so a reference an agent writes
//     would be a value it chose where to send.
//   * **A caller's header.** The headers are the connection file's and the
//     auth shortcut's — nothing an argument sets.
//   * **Unbounded reads.** Every body and file is read to a fixed cap and
//     said to be truncated; a walk stops at a fixed count.
//
// Nothing here writes a file. Nothing here imports Postgres, the vault or
// project config.

import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConnectionFile, ToolGroup, VariablesFile } from "@foldedspacelabs/metistry-core";
import type { Parsed } from "./catalog.js";
import { DavXmlError, parseXml, type XmlElement } from "./dav-xml.js";
import { ConnectionRefused } from "./errors.js";
import type { ConnectionEntry } from "./load.js";
import { planHttp, variableFiller, type HttpDial } from "./plan.js";

/** The connection types reached through generated tools. */
export const GENERATED_TYPES = ["api", "feed", "files"] as const;
export type GeneratedType = (typeof GENERATED_TYPES)[number];

export function isGeneratedType(t: string | null | undefined): t is GeneratedType {
  return (GENERATED_TYPES as readonly string[]).includes(t ?? "");
}

/** One generated tool: what `tools/list` would have said, and the group that decides how it runs. */
export interface GeneratedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  group: ToolGroup;
}

// ---- the fixed limits --------------------------------------------------------------

/** An API answer or a web page, read this far and no further. */
export const GENERATED_BODY_MAX_BYTES = 256 * 1024; // limit: fixed — what one tool result may carry back into a model's context
/** A feed document, read this far. */
export const GENERATED_FEED_MAX_BYTES = 5 * 1024 * 1024; // limit: fixed — a feed larger than this is not one a person subscribes to
/** A file, read this far. */
export const GENERATED_FILE_MAX_BYTES = 1024 * 1024; // limit: fixed — one tool result's worth of text
/** Files one search looks at. */
export const GENERATED_WALK_MAX_FILES = 5000; // limit: fixed — a search is not an indexer
/** Entries one listing returns. */
const LIST_MAX_ENTRIES = 1000; // limit: fixed — one screenful for a model, far beyond one for a person
/** A summary in a listing; the full text is `get_item`'s. */
const SUMMARY_IN_LIST = 500; // limit: fixed — keeps a list of items a list
const SUMMARY_MAX = 20_000; // limit: fixed — one item's text
const MAX_RESULTS = 100; // limit: fixed — the largest `limit` a caller may ask for

// ---- the tool sets ------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const LIMIT = { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: `how many (default 20, at most ${MAX_RESULTS})` };
const PATH_API = { type: "string", description: "a path under the connection's URL (relative: `issues/42`, not `/issues/42` or a full URL)" };
const QUERY = { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "query parameters, added to the connection's own" };

const API_TOOLS: GeneratedToolDef[] = [
  { name: "get", group: "reads", description: "GET a resource under this API's URL. Answers the status, the content type and the body (text, capped).", inputSchema: obj({ path: PATH_API, query: QUERY }) },
  {
    name: "request",
    group: "changes",
    description: "Send a POST, PUT, PATCH or DELETE under this API's URL. A JSON body is sent as JSON; a string as text. Answers the status, the content type and the body.",
    inputSchema: obj({ method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] }, path: PATH_API, query: QUERY, body: { description: "a JSON value, or a string" } }, ["method"]),
  },
];

const FEED_TOOLS: GeneratedToolDef[] = [
  { name: "list_items", group: "reads", description: "The feed's items, in the feed's order: id, title, link, date and a short summary.", inputSchema: obj({ limit: LIMIT }) },
  { name: "get_item", group: "reads", description: "One item of the feed, by the id list_items gave, with its full summary.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "search_items", group: "reads", description: "Items whose title or summary contains the words (case-insensitive).", inputSchema: obj({ query: { type: "string", minLength: 1 }, limit: LIMIT }, ["query"]) },
];

const FILES_PATH_TOOLS: GeneratedToolDef[] = [
  { name: "list_files", group: "reads", description: "What is in a folder of this connection (one level): each entry's path, whether it is a file or a folder, and its size.", inputSchema: obj({ path: { type: "string", description: "a folder under the connection's root; empty for the root" } }) },
  { name: "read_file", group: "reads", description: "A text file of this connection, capped. A binary file is refused.", inputSchema: obj({ path: { type: "string" } }, ["path"]) },
  { name: "search_files", group: "reads", description: "Lines of this connection's text files that contain the words (case-insensitive), with their paths and line numbers.", inputSchema: obj({ query: { type: "string", minLength: 1 }, limit: LIMIT }, ["query"]) },
];

const FILES_HTTP_TOOLS: GeneratedToolDef[] = [
  { name: "read_page", group: "reads", description: "The page at this connection's URL, as text (HTML is reduced to its text), capped.", inputSchema: obj({}) },
];

/** The tools Metistry generates for a connection of a generated type — by its type and how it is reached. Empty for any other. */
export function generatedToolsFor(c: Pick<ConnectionFile, "type" | "reach">): GeneratedToolDef[] {
  const copy = (tools: GeneratedToolDef[]) => tools.map((t) => ({ ...t, inputSchema: structuredClone(t.inputSchema) }));
  if (c.type === "api" && c.reach.http) return copy(API_TOOLS);
  if (c.type === "feed" && c.reach.http) return copy(FEED_TOOLS);
  if (c.type === "files" && c.reach.path) return copy(FILES_PATH_TOOLS);
  if (c.type === "files" && c.reach.http) return copy(FILES_HTTP_TOOLS);
  return [];
}

// ---- the plan ------------------------------------------------------------------------

/** A generated connection, planned: its HTTP reach (the same plan an MCP dial makes, auth shortcut and all), or its folder. */
export type GeneratedPlan =
  | { kind: "generated"; type: "api" | "feed" | "files"; http: HttpDial }
  | { kind: "generated"; type: "files"; path: { root: string; include: string[]; skip: string[] } };

/** A generated connection's plan, or the refusal that stops it before anything is read. */
export function planGenerated(entry: ConnectionEntry, variables: Parsed<VariablesFile>, baseDir?: string | undefined): GeneratedPlan {
  const c = entry.connection;
  if (!c || entry.status !== "ok") throw new ConnectionRefused("not_ready", entry.name, entry.issues.join("; ") || "the connection is not ready");
  if (!isGeneratedType(c.type)) throw new ConnectionRefused("not_built", c.name, `${c.type} is not reached through generated tools`);
  if (entry.provider && entry.provider.manifest.implementation.kind !== "native") {
    throw new ConnectionRefused("not_built", c.name, `provider ${entry.provider.name} is ${entry.provider.manifest.implementation.kind} — its own code reaches it, not generated tools`);
  }
  if (c.reach.http) return { kind: "generated", type: c.type, http: planHttp(entry, variables) };
  if (c.reach.path && c.type === "files") {
    const fill = variableFiller(c.name, variables);
    const raw = fill(c.reach.path.path, "reach.path.path");
    const root = isAbsolute(raw) ? resolve(raw) : resolve(baseDir ?? process.cwd(), raw);
    return {
      kind: "generated",
      type: "files",
      path: {
        root,
        include: c.reach.path.include.map((p, i) => fill(p, `reach.path.include.${i}`)),
        skip: c.reach.path.skip.map((p, i) => fill(p, `reach.path.skip.${i}`)),
      },
    };
  }
  throw new ConnectionRefused("not_built", c.name, `a ${c.type} connection reached by ${c.reach.command ? "a command" : "a path"} has no generated tools`);
}

// ---- running one -----------------------------------------------------------------------

export interface GeneratedContext {
  /** the connection's door: pinned to its origin, guarded, no redirect — `pinnedDoor` */
  fetch: typeof fetch;
  /** per request */
  timeoutMs: number;
}

export interface GeneratedResult {
  content: unknown[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

/** A caller's argument the tool cannot take. Answered as a tool error — the connection was not reached. */
class BadArgument extends Error {}

function answer(result: Record<string, unknown>, isError = false): GeneratedResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError };
}

function str(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new BadArgument(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new BadArgument(`${key} is a string`);
  return v;
}

function limitOf(args: Record<string, unknown>): number {
  const v = args.limit;
  if (v === undefined || v === null) return 20;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_RESULTS) throw new BadArgument(`limit is a whole number from 1 to ${MAX_RESULTS}`);
  return v;
}

function onlyKeys(args: Record<string, unknown>, keys: string[]): void {
  const extra = Object.keys(args).filter((k) => !keys.includes(k));
  if (extra.length) throw new BadArgument(`this tool takes ${keys.length ? keys.join(", ") : "no arguments"} — not ${extra.join(", ")}`);
}

/** Run one generated tool. The pool has already held the file's allowlist, the mode and the caller's credential. */
export async function callGenerated(plan: GeneratedPlan, tool: string, args: Record<string, unknown>, ctx: GeneratedContext): Promise<GeneratedResult> {
  try {
    if ("path" in plan) return await filesCall(plan.path, tool, args);
    if (plan.type === "api") return await apiCall(plan.http, tool, args, ctx);
    if (plan.type === "feed") return await feedCall(plan.http, tool, args, ctx);
    return await pageCall(plan.http, tool, args, ctx);
  } catch (err) {
    if (err instanceof BadArgument) return answer({ error: "invalid_argument", message: err.message }, true);
    throw err;
  }
}

/** Reach the connection once without a caller's arguments — what `check()` and `connections add` do for a generated type. Answers one line of what was found. */
export async function probeGenerated(plan: GeneratedPlan, ctx: GeneratedContext): Promise<string> {
  if ("path" in plan) {
    const st = await stat(plan.path.root);
    return st.isDirectory() ? `the folder is there (${(await readdir(plan.path.root)).length} entries at the top)` : `the file is there (${st.size} bytes)`;
  }
  if (plan.type === "feed") {
    const items = await readFeed(plan.http, ctx);
    return `the feed answered with ${items.length} item${items.length === 1 ? "" : "s"}`;
  }
  const res = await ctx.fetch(plan.http.url, { method: "GET", headers: plan.http.headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
  await res.body?.cancel().catch(() => undefined);
  if (res.status >= 500) throw new Error(`the service answered HTTP ${res.status}`);
  return `the service answered HTTP ${res.status}`;
}

// ---- bodies, capped ---------------------------------------------------------------------

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!res.body) return { text: "", truncated: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > max) {
      chunks.push(value.subarray(0, max - bytes));
      bytes = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), truncated, bytes };
}

// ---- api -------------------------------------------------------------------------------

/**
 * A path under the connection's URL: relative, no scheme, no `//`, no
 * `..` — and after resolving, the same origin and still under the base's
 * path. The connection's own query parameters stay; a caller's are added,
 * and cannot replace one the file sets.
 */
export function apiUrl(base: string, path: string | undefined, query: unknown): string {
  const p = path ?? "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//") || p.startsWith("/") || p.includes("\\")) {
    throw new BadArgument("path is relative to the connection's URL — no scheme, no leading /, no host");
  }
  const [pathPart, qs] = p.split("?", 2) as [string, string | undefined];
  if (pathPart.split("/").some((seg) => seg === ".." || seg === "." || /%2e%2e|%2f|%5c/i.test(seg))) throw new BadArgument("path cannot climb out of the connection's URL");
  const b = new URL(base);
  const dir = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
  const u = new URL(pathPart === "" ? b.pathname : `${dir}${pathPart}`, b.origin);
  if (u.origin !== b.origin || !(u.pathname === b.pathname || u.pathname.startsWith(dir))) throw new BadArgument("path cannot leave the connection's URL");
  const own = new Set(b.searchParams.keys());
  b.searchParams.forEach((v, k) => u.searchParams.append(k, v));
  const add = (k: string, v: string) => {
    if (own.has(k)) throw new BadArgument(`the query parameter ${k} is the connection's own`);
    u.searchParams.append(k, v);
  };
  if (qs !== undefined) new URLSearchParams(qs).forEach((v, k) => add(k, v));
  if (query !== undefined && query !== null) {
    if (typeof query !== "object" || Array.isArray(query)) throw new BadArgument("query is an object of names to values");
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new BadArgument(`query.${k} is a string, a number or true/false`);
      add(k, String(v));
    }
  }
  return u.href;
}

async function apiCall(http: HttpDial, tool: string, args: Record<string, unknown>, ctx: GeneratedContext): Promise<GeneratedResult> {
  let method = "GET";
  let body: string | undefined;
  const headers: Record<string, string> = { ...http.headers, accept: http.headers.accept ?? "application/json, text/*;q=0.9, */*;q=0.5" };
  if (tool === "get") {
    onlyKeys(args, ["path", "query"]);
  } else if (tool === "request") {
    onlyKeys(args, ["method", "path", "query", "body"]);
    const m = str(args, "method", true)!.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(m)) throw new BadArgument("method is POST, PUT, PATCH or DELETE — a read is `get`");
    method = m;
    if (args.body !== undefined) {
      if (typeof args.body === "string") {
        body = args.body;
        headers["content-type"] ??= "text/plain; charset=utf-8";
      } else {
        body = JSON.stringify(args.body);
        headers["content-type"] ??= "application/json";
      }
    }
  } else {
    throw new ConnectionRefused("tool_not_listed", "", `${tool} is not a tool Metistry generates for an API connection`, tool);
  }
  const url = apiUrl(http.url, str(args, "path", false), args.query);
  const res = await ctx.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(http.timeoutMs ?? ctx.timeoutMs) });
  const { text, truncated } = await readCapped(res, GENERATED_BODY_MAX_BYTES);
  const contentType = res.headers.get("content-type") ?? "";
  let json: unknown;
  if (/\bjson\b/i.test(contentType) && !truncated) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return answer({ status: res.status, content_type: contentType, ...(json !== undefined ? { json } : { body: text }), ...(truncated ? { truncated: true } : {}) }, res.status >= 400);
}

// ---- a web page --------------------------------------------------------------------------

/** HTML reduced to its text: no script, no style, tags gone, entities for the common few, whitespace folded. Not a renderer — a reader. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

async function pageCall(http: HttpDial, tool: string, args: Record<string, unknown>, ctx: GeneratedContext): Promise<GeneratedResult> {
  if (tool !== "read_page") throw new ConnectionRefused("tool_not_listed", "", `${tool} is not a tool Metistry generates for a web page`, tool);
  onlyKeys(args, []);
  const res = await ctx.fetch(http.url, { method: "GET", headers: { ...http.headers, accept: "text/html, text/plain;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(http.timeoutMs ?? ctx.timeoutMs) });
  const { text, truncated } = await readCapped(res, GENERATED_BODY_MAX_BYTES);
  const contentType = res.headers.get("content-type") ?? "";
  return answer({ status: res.status, content_type: contentType, text: /html/i.test(contentType) ? htmlText(text) : text, ...(truncated ? { truncated: true } : {}) }, res.status >= 400);
}

// ---- feeds ---------------------------------------------------------------------------------

/** One item of a feed, as the tools answer it. */
export interface FeedItem {
  id: string;
  title: string;
  link: string | null;
  published: string | null;
  summary: string;
}

const ATOM_NS = "http://www.w3.org/2005/Atom";

function allText(el: XmlElement | undefined): string {
  if (!el) return "";
  return [el.text, ...el.children.map(allText)].join(" ");
}

function kid(el: XmlElement, name: string, ns?: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name && (ns === undefined || c.ns === ns));
}

function clean(s: string, max: number): string {
  const t = htmlText(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** RSS 2.0, RSS 1.0 (RDF) or Atom, to items. Anything else is refused, not guessed at. */
export function parseFeed(xml: string): FeedItem[] {
  let doc: XmlElement;
  try {
    doc = parseXml(xml);
  } catch (err) {
    throw new Error(`not a feed this reader can read (${err instanceof DavXmlError ? err.message : "not XML"})`);
  }
  const root = doc.name === "#document" ? doc.children[0] : doc;
  if (!root) throw new Error("not a feed: the document is empty");
  const items: FeedItem[] = [];
  if (root.name === "feed" && root.ns === ATOM_NS) {
    for (const e of root.children.filter((c) => c.name === "entry" && c.ns === ATOM_NS)) {
      const links = e.children.filter((c) => c.name === "link" && c.ns === ATOM_NS);
      const link = (links.find((l) => (l.attrs.rel ?? "alternate") === "alternate") ?? links[0])?.attrs.href ?? null;
      const id = allText(kid(e, "id", ATOM_NS)).trim() || link || allText(kid(e, "title", ATOM_NS)).trim();
      items.push({
        id,
        title: clean(allText(kid(e, "title", ATOM_NS)), 500),
        link,
        published: (allText(kid(e, "published", ATOM_NS)) || allText(kid(e, "updated", ATOM_NS))).trim() || null,
        summary: clean(allText(kid(e, "summary", ATOM_NS)) || allText(kid(e, "content", ATOM_NS)), SUMMARY_MAX),
      });
    }
    return items;
  }
  const rssItems = root.name === "rss" ? (kid(root, "channel")?.children ?? []).filter((c) => c.name === "item") : root.name === "RDF" ? root.children.filter((c) => c.name === "item") : undefined;
  if (!rssItems) throw new Error(`not a feed: the document is <${root.name}>, not RSS or Atom`);
  for (const it of rssItems) {
    const text = (name: string) => allText(it.children.find((c) => c.name === name)).trim();
    const link = text("link") || null;
    const id = text("guid") || it.attrs["rdf:about"] || it.attrs.about || link || text("title");
    items.push({ id, title: clean(text("title"), 500), link, published: text("pubDate") || text("date") || null, summary: clean(text("description") || text("encoded"), SUMMARY_MAX) });
  }
  return items;
}

async function readFeed(http: HttpDial, ctx: GeneratedContext): Promise<FeedItem[]> {
  const res = await ctx.fetch(http.url, {
    method: "GET",
    headers: { ...http.headers, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
    signal: AbortSignal.timeout(http.timeoutMs ?? ctx.timeoutMs),
  });
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`the feed answered HTTP ${res.status}`);
  }
  const { text, truncated } = await readCapped(res, GENERATED_FEED_MAX_BYTES);
  if (truncated) throw new Error(`the feed is larger than ${GENERATED_FEED_MAX_BYTES / (1024 * 1024)} MB — not read`);
  return parseFeed(text);
}

async function feedCall(http: HttpDial, tool: string, args: Record<string, unknown>, ctx: GeneratedContext): Promise<GeneratedResult> {
  const short = (i: FeedItem) => ({ ...i, summary: i.summary.length > SUMMARY_IN_LIST ? `${i.summary.slice(0, SUMMARY_IN_LIST)}…` : i.summary });
  if (tool === "list_items") {
    onlyKeys(args, ["limit"]);
    const limit = limitOf(args);
    const items = await readFeed(http, ctx);
    return answer({ total: items.length, items: items.slice(0, limit).map(short) });
  }
  if (tool === "get_item") {
    onlyKeys(args, ["id"]);
    const id = str(args, "id", true)!;
    const item = (await readFeed(http, ctx)).find((i) => i.id === id);
    return item ? answer({ item }) : answer({ error: "not_found", message: `no item with id ${JSON.stringify(id.slice(0, 200))} in the feed now` }, true);
  }
  if (tool === "search_items") {
    onlyKeys(args, ["query", "limit"]);
    const q = str(args, "query", true)!.trim().toLowerCase();
    if (q === "") throw new BadArgument("query is some words");
    const limit = limitOf(args);
    const hits = (await readFeed(http, ctx)).filter((i) => `${i.title}\n${i.summary}`.toLowerCase().includes(q));
    return answer({ total: hits.length, items: hits.slice(0, limit).map(short) });
  }
  throw new ConnectionRefused("tool_not_listed", "", `${tool} is not a tool Metistry generates for a feed`, tool);
}

// ---- files -----------------------------------------------------------------------------------

/** `*` within a segment, `**` across them, `?` one character. A pattern with no `/` matches a name at any depth. */
export function globMatcher(pattern: string): (rel: string) => boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  const byName = !pattern.includes("/");
  return (rel) => rx.test(byName ? basename(rel) : rel);
}

interface FilesRoot {
  root: string;
  include: string[];
  skip: string[];
}

function filters(r: FilesRoot): { shown: (rel: string, dir: boolean) => boolean } {
  const inc = r.include.map(globMatcher);
  const skp = r.skip.map(globMatcher);
  return {
    shown: (rel, dir) => {
      if (basename(rel).startsWith(".")) return false; // a hidden file stays hidden
      if (skp.some((m) => m(rel))) return false;
      return dir || inc.length === 0 || inc.some((m) => m(rel));
    },
  };
}

/** A path under the root, or the refusal: relative, no `..`, and — once symbolic links are resolved — still under the root. */
async function underRoot(r: FilesRoot, rel: string): Promise<{ abs: string; rel: string }> {
  if (isAbsolute(rel) || rel.includes("\0")) throw new BadArgument("path is relative to the connection's folder");
  const parts = rel.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new BadArgument("path cannot climb out of the connection's folder");
  const root = await realpath(r.root);
  const abs = resolve(root, ...parts);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new BadArgument(`no such file or folder: ${parts.join("/") || "."}`);
  }
  if (real !== root && !real.startsWith(root + sep)) throw new BadArgument("path leads outside the connection's folder");
  return { abs: real, rel: relative(root, real).split(sep).join("/") };
}

async function isBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

async function readText(abs: string): Promise<{ text: string; truncated: boolean; size: number }> {
  const fh = await open(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const n = Math.min(size, GENERATED_FILE_MAX_BYTES);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: size > GENERATED_FILE_MAX_BYTES, size };
  } finally {
    await fh.close();
  }
}

async function filesCall(r: FilesRoot, tool: string, args: Record<string, unknown>): Promise<GeneratedResult> {
  const f = filters(r);
  const rootStat = await stat(r.root).catch(() => undefined);
  if (!rootStat) return answer({ error: "not_found", message: "the connection's folder or file is not there" }, true);
  const single = rootStat.isFile();
  if (tool === "list_files") {
    onlyKeys(args, ["path"]);
    if (single) return answer({ entries: [{ path: basename(r.root), type: "file", size: rootStat.size }] });
    const { abs, rel } = await underRoot(r, str(args, "path", false) ?? "");
    if (!(await stat(abs)).isDirectory()) throw new BadArgument(`${rel} is a file — read_file reads it`);
    const entries: Array<{ path: string; type: "file" | "folder"; size?: number }> = [];
    for (const d of (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel === "" ? d.name : `${rel}/${d.name}`;
      const dir = d.isDirectory();
      // a symbolic link is not listed: what it points at may be anywhere (read_file refuses one that leads out)
      if (!f.shown(p, dir) || (!dir && !d.isFile())) continue;
      entries.push(dir ? { path: p, type: "folder" } : { path: p, type: "file", size: (await lstat(join(abs, d.name))).size });
      if (entries.length >= LIST_MAX_ENTRIES) break;
    }
    return answer({ path: rel, entries, ...(entries.length >= LIST_MAX_ENTRIES ? { truncated: true } : {}) });
  }
  if (tool === "read_file") {
    onlyKeys(args, ["path"]);
    const asked = str(args, "path", true)!;
    let abs: string;
    let rel: string;
    if (single) {
      if (asked !== basename(r.root) && asked !== "") throw new BadArgument(`this connection is one file: ${basename(r.root)}`);
      abs = r.root;
      rel = basename(r.root);
    } else {
      ({ abs, rel } = await underRoot(r, asked));
      if (!f.shown(rel, false)) throw new BadArgument(`no such file or folder: ${rel}`);
    }
    if (!(await stat(abs)).isFile()) throw new BadArgument(`${rel} is a folder — list_files lists it`);
    if (await isBinary(abs)) return answer({ error: "binary", message: `${rel} is not a text file` }, true);
    const { text, truncated, size } = await readText(abs);
    return answer({ path: rel, size, text, ...(truncated ? { truncated: true } : {}) });
  }
  if (tool === "search_files") {
    onlyKeys(args, ["query", "limit"]);
    const q = str(args, "query", true)!.trim().toLowerCase();
    if (q === "") throw new BadArgument("query is some words");
    const limit = limitOf(args);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const root = await realpath(r.root);
    let looked = 0;
    const files: string[] = single ? [""] : [];
    if (!single) {
      const queue: string[] = [""];
      while (queue.length && files.length < GENERATED_WALK_MAX_FILES) {
        const dirRel = queue.shift()!;
        const dirAbs = dirRel === "" ? root : join(root, dirRel);
        for (const d of (await readdir(dirAbs, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
          const p = dirRel === "" ? d.name : `${dirRel}/${d.name}`;
          // a symbolic link is not followed by a walk: what it points at may be anywhere
          if (d.isSymbolicLink() || !f.shown(p, d.isDirectory())) continue;
          if (d.isDirectory()) queue.push(p);
          else if (d.isFile()) files.push(p);
        }
      }
    }
    for (const p of files) {
      if (matches.length >= limit) break;
      const abs = single ? r.root : join(root, p);
      looked++;
      if (await isBinary(abs).catch(() => true)) continue;
      const { text } = await readText(abs);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        if (lines[i]!.toLowerCase().includes(q)) matches.push({ path: single ? basename(r.root) : p, line: i + 1, text: lines[i]!.slice(0, 500) });
      }
    }
    return answer({ matches, files_searched: looked, ...(files.length >= GENERATED_WALK_MAX_FILES ? { truncated: true } : {}) });
  }
  throw new ConnectionRefused("tool_not_listed", "", `${tool} is not a tool Metistry generates for a files connection`, tool);
}
