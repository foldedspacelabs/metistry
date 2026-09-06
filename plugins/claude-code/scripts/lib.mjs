// Shared capture logic for the Claude Code plugin (plan §4.11, external
// capture). Dependency-free Node 22+: global fetch, node:os, node:fs.
//
// The server contract is POST /capture with a JSON body of
// { note, filename } (apps/console/src/server.ts). /capture has no
// metadata field, so provenance rides in the note's frontmatter — the same
// place §4.15 puts it once a proposal is accepted into Knowledge/.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

export const SOURCE = "claude-code";
export const KINDS = ["decision", "finding", "note", "session-summary"];

/** Read config from the environment only — never from files (README). */
export function config(env = process.env) {
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.METISTRY_OWNER_TOKEN ?? "").trim(),
  };
}

/** Every string the plugin prints passes through here. */
export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

/** Name of the enclosing git checkout (walks up to the nearest .git). */
export function repoName(cwd) {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) return basename(cwd) || null;
    dir = parent;
  }
}

export function provenance({ sessionId, cwd = process.cwd(), env = process.env, now = new Date() } = {}) {
  return {
    source: SOURCE,
    session_id: sessionId ?? env.CLAUDE_SESSION_ID ?? null,
    host: hostname(),
    cwd,
    repo: repoName(cwd),
    captured_at: now.toISOString(),
  };
}

// JSON string literals are valid YAML double-quoted scalars, so this yields
// well-formed frontmatter without a YAML dependency.
const yaml = (v) => (v === null || v === undefined ? "null" : JSON.stringify(String(v)));

export function renderNote({ kind, title, body, prov }) {
  return [
    "---",
    `source: ${yaml(prov.source)}`,
    `kind: ${yaml(kind)}`,
    `title: ${yaml(title)}`,
    `session_id: ${yaml(prov.session_id)}`,
    `host: ${yaml(prov.host)}`,
    `repo: ${yaml(prov.repo)}`,
    `cwd: ${yaml(prov.cwd)}`,
    `captured_at: ${yaml(prov.captured_at)}`,
    "---",
    "",
    `# ${title}`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

/**
 * POST one capture. Resolves to the server's { id, path, sha256 }; throws
 * with an already-redacted message on any failure.
 */
export async function capture({ kind, title, body, sessionId, cwd = process.cwd(), env = process.env, timeoutMs = 15_000 }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join("|")}`);
  if (!title?.trim()) throw new Error("title is required");
  const { url, token } = config(env);
  if (!url) throw new Error("METISTRY_URL is not set");
  if (!token) throw new Error("METISTRY_OWNER_TOKEN is not set");

  const prov = provenance({ sessionId, cwd, env });
  const note = renderNote({ kind, title: title.trim(), body: body ?? "", prov });
  const stamp = prov.captured_at.replaceAll(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const filename = `${SOURCE}-${kind}-${stamp}.md`;

  let res;
  try {
    res = await fetch(`${url}/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ note, filename }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(redact(`capture unreachable: ${err?.cause?.message ?? err?.message ?? err}`, token));
  }
  const text = await res.text();
  if (res.status !== 201) throw new Error(redact(`capture failed: HTTP ${res.status} ${text.slice(0, 200)}`, token));
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(redact(`capture failed: unparseable response ${text.slice(0, 200)}`, token));
  }
}
