// The session-start briefing, as the Claude Code plugin delivers it (X-129;
// the console's side is X-128, `GET /api/briefing`, docs/ops/client-api.md).
//
// Dependency-free Node 22+. A deliberate sibling of `plugins/opencode/scripts/
// briefing.mjs`: each plugin ships alone, so neither can import the other.
//
// The contract, all of it enforced here and none of it by a prompt:
//   * the bearer is an AGENT bearer (`metistry connect claude-code` mints it);
//     it travels in one header, is never in argv, and every string this file
//     prints passes through `redact`;
//   * the console decides everything — what the agent may be told, the budget,
//     and the owner's per-agent opt-out (`briefing: false` in its grants). An
//     opted-out agent gets an empty briefing and this file injects nothing;
//   * a failure of any kind — no URL, no token, no console, a 4xx, a body that
//     is not a briefing — injects nothing and the hook still exits 0. A
//     briefing is a convenience; it never stands between the owner and a
//     session;
//   * once per session: a marker file, created exclusively, keyed by the
//     session id, so a second invocation (a resume, a `/clear`'d session that
//     kept its id, two panes racing) exits silently. The briefing is fetched
//     once and never again mid-session — the cached prompt prefix is not
//     churned.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact, repoName } from "./lib.mjs";

/** SessionStart `source` values that open a fresh context. A resume already holds its briefing; a compaction keeps its summary. */
export const FRESH_SOURCES = new Set(["startup", "clear"]);
/** What the plugin will inject at most, whatever the console sends (the console's own budget is far below this). */
export const MAX_BRIEFING_CHARS = 32_000;
const MARKER_TTL_MS = 7 * 24 * 3600 * 1000;

/** Config from the environment only. The agent bearer first; `METISTRY_OWNER_TOKEN` carries the same bearer under `connect`'s printed lines. */
export function briefingConfig(env = process.env) {
  const token = (env.METISTRY_AGENT_TOKEN_CLAUDE_CODE ?? env.METISTRY_OWNER_TOKEN ?? "").trim();
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token,
    off: env.METISTRY_BRIEFING === "0" || env.METISTRY_BRIEFING === "off",
  };
}

/** `origin`'s URL for the checkout, without any userinfo (a token in a clone URL must not travel as a query parameter). Null when there is none. * @param {string} cwd
 * @param {any} [run]
 */
export function checkoutRemote(cwd, run = execFileSync) {
  try {
    const out = String(run("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    if (!out) return null;
    return out.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  } catch {
    return null;
  }
}

/**
 * Claim this session's one delivery. True exactly once per session id (the
 * exclusive create is the arbiter, so two racing hooks cannot both win). A
 * session with no id cannot be tracked and is allowed through. Old markers
 * are pruned on the way past, best effort.
 */
export function claimSession(sessionId, dir = join(tmpdir(), "metistry-briefing"), now = Date.now()) {
  if (typeof sessionId !== "string" || sessionId === "") return true;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f);
        if (now - statSync(p).mtimeMs > MARKER_TTL_MS) unlinkSync(p);
      } catch {
        /* a marker another hook just removed */
      }
    }
    writeFileSync(join(dir, createHash("sha256").update(sessionId).digest("hex").slice(0, 40)), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    return err?.code === "EEXIST" ? false : true; // an unwritable tmp dir must not cost the owner the briefing; only a real second run is refused
  }
}

/** The briefing text to inject, or null. Throws an already-redacted Error on a transport or protocol failure (the caller logs it and injects nothing). */
/** @param {any} [opts] */
export async function fetchBriefing({ cwd, env = process.env, fetchFn = fetch, timeoutMs = 5_000, run = execFileSync } = {}) {
  const { url, token } = briefingConfig(env);
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("METISTRY_URL is not set");
  if (!token) throw new Error("no agent token in the environment (METISTRY_AGENT_TOKEN_CLAUDE_CODE)");
  const repo = repoName(cwd);
  if (!repo) return null;
  const q = new URLSearchParams({ repo });
  const remote = checkoutRemote(cwd, run);
  if (remote) q.set("remote", remote);

  let res;
  try {
    res = await fetchFn(`${url}/api/briefing?${q}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", // never carry the bearer to wherever a redirect points
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(redact(`briefing unreachable: ${err?.cause?.message ?? err?.message ?? err}`, token));
  }
  const body = await res.text();
  if (res.status !== 200) throw new Error(redact(`briefing refused: HTTP ${res.status} ${body.slice(0, 120)}`, token));
  let b;
  try {
    b = JSON.parse(body);
  } catch {
    throw new Error("briefing unparseable");
  }
  // The console says "nothing" in two ways (the opt-out and an empty index); both mean inject nothing.
  if (!b || typeof b !== "object" || b.empty === true || typeof b.text !== "string") return null;
  const text = b.text.trim();
  if (text === "" || text.length > MAX_BRIEFING_CHARS) return null;
  return text;
}

/** What Claude Code reads from a SessionStart hook's stdout: the briefing as additional context. */
export function hookOutput(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
}

/**
 * The whole hook: decide, claim, fetch, print. Resolves to a short state word
 * (what the tests assert on); never throws.
 * @param {any} [input]
 * @param {any} [opts]
 */
export async function runSessionStart(input, { env = process.env, fetchFn = fetch, write = (s) => process.stdout.write(`${s}\n`), logErr = (s) => process.stderr.write(`${s}\n`), markerDir, run } = {}) {
  const { token, off, url } = briefingConfig(env);
  try {
    if (off) return "off";
    if (!url || !token) return "unconfigured"; // a profile that never ran `connect` is not an error worth a line
    if (typeof input?.source === "string" && !FRESH_SOURCES.has(input.source)) return "skipped";
    if (!claimSession(input?.session_id, markerDir)) return "already";
    const text = await fetchBriefing({ cwd: input?.cwd ?? process.cwd(), env, fetchFn, ...(run ? { run } : {}) });
    if (text === null) return "empty";
    write(hookOutput(text));
    return "delivered";
  } catch (err) {
    logErr(`metistry: session briefing skipped: ${redact(err?.message ?? err, token)}`);
    return "failed";
  }
}
