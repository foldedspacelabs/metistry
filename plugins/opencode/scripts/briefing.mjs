// The session-start briefing, as the OpenCode plugin delivers it (X-129; the
// console's side is X-128, `GET /api/briefing`, docs/ops/client-api.md).
//
// Dependency-free, Node 22+ / Bun. A deliberate sibling of
// `plugins/claude-code/scripts/briefing.mjs`: each plugin ships alone.
//
// OpenCode has no SessionStart event, but it has a hook that runs whenever the
// system prompt is assembled for a turn: `experimental.chat.system.transform`
// (`@opencode-ai/plugin` 1.18.30, `Hooks`). The briefing is fetched ONCE per
// session — a memoised promise per session id — and the same text is added to
// the system prompt on every turn, so the console is asked once and the prompt
// prefix does not change from turn to turn (the cache-churn risk the Context
// Mode review named).
//
// What is enforced here, and not by a prompt:
//   * the bearer is an AGENT bearer, only ever in the Authorization header;
//   * the console decides what is said, the budget and the owner's per-agent
//     opt-out (`briefing: false`): an opted-out agent is answered the empty
//     briefing and nothing is added;
//   * any failure adds nothing and throws nothing at OpenCode.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redact } from "./lib.mjs";

/** What the plugin will add at most, whatever the console sends (the console's own budget is far below this). */
export const MAX_BRIEFING_CHARS = 32_000;

/** The agent bearer `metistry connect opencode` filed, then the variable its printed lines also set. */
export function briefingConfig(env = process.env) {
  return {
    url: (env.METISTRY_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.METISTRY_AGENT_TOKEN_OPENCODE ?? env.METISTRY_OWNER_TOKEN ?? "").trim(),
    off: env.METISTRY_BRIEFING === "0" || env.METISTRY_BRIEFING === "off",
  };
}

/** Name of the enclosing git checkout (walks up to the nearest .git, a directory or a worktree's file); the directory's own name if there is none. */
export function checkoutName(dir) {
  if (!dir) return null;
  let d = dir;
  for (;;) {
    if (existsSync(join(d, ".git"))) return basename(d) || null;
    const parent = dirname(d);
    if (parent === d) return basename(dir) || null;
    d = parent;
  }
}

/** `origin`'s URL for the checkout, without userinfo. Null when there is none. * @param {string} dir
 * @param {any} [run]
 */
export function checkoutRemote(dir, run = execFileSync) {
  try {
    const out = String(run("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] })).trim();
    return out ? out.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1") : null;
  } catch {
    return null;
  }
}

/** The briefing text to add, or null. Throws an already-redacted Error on a transport or protocol failure. */
/** @param {any} [opts] */
export async function fetchBriefing({ directory, env = process.env, fetchFn = fetch, timeoutMs = 5_000, run = execFileSync } = {}) {
  const { url, token, off } = briefingConfig(env);
  if (off || !url || !token || !/^https?:\/\//i.test(url)) return null; // not configured: not an error
  const repo = checkoutName(directory);
  if (!repo) return null;
  const q = new URLSearchParams({ repo });
  const remote = checkoutRemote(directory, run);
  if (remote) q.set("remote", remote);

  let res;
  try {
    res = await fetchFn(`${url}/api/briefing?${q}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
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
  if (!b || typeof b !== "object" || b.empty === true || typeof b.text !== "string") return null;
  const text = b.text.trim();
  return text === "" || text.length > MAX_BRIEFING_CHARS ? null : text;
}

/**
 * The per-session once-only machine. `systemFor(sessionId)` resolves to the
 * text to add to that session's system prompt (or null) and asks the console
 * at most once per session id, however many turns follow.
 * @param {any} [opts]
 */
export function createBriefer({ directory = null, env = process.env, fetchFn = fetch, run, log = async () => {} } = {}) {
  /** sessionID → Promise<string | null> */
  const memo = new Map();
  return {
    memo,
    async systemFor(sessionId) {
      const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "";
      let p = memo.get(key);
      if (!p) {
        p = fetchBriefing({ directory, env, fetchFn, ...(run ? { run } : {}) }).catch(async (err) => {
          await log(`session briefing skipped: ${redact(err?.message ?? err, briefingConfig(env).token)}`);
          return null;
        });
        memo.set(key, p);
      }
      return await p;
    },
    /** A deleted session needs no briefing again. */
    forget(sessionId) {
      memo.delete(typeof sessionId === "string" ? sessionId : "");
    },
  };
}
