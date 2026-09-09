// `metistry import-sessions` — back-fill Claude Code sessions as summaries
// (stash review 2026-09-09, item 2; docs/research/2026-09-stash-review.md).
//
// Host-only by construction: it reads `~/.claude/projects/**/*.jsonl`, and the
// console container has no home directory to read. It posts *summaries*, never
// transcripts — full-transcript capture is the thing the review declined.
//
// No model is called (invariant 4 in spirit: the CLI decides nothing a model
// would): the summariser in `@foldedspacelabs/metistry-core` is deterministic.
//
// Idempotency has two halves:
//   * a local ledger (`~/.metistry/imported-sessions.json`) keyed by session id
//     + transcript mtime, so a re-run posts nothing for an unchanged session;
//   * an `idempotency_key` in the note frontmatter, derived from the
//     transcript's content, so the server can dedupe later across this verb
//     and the plugin's SessionEnd hook (they compute the same key).

import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeProjectDir, idempotencyKey, renderSessionNote, sessionTitle, summarizeTranscript, type SessionSummary } from "@foldedspacelabs/metistry-core";
import { realExec, type Exec } from "./exec.js";
import { Keychain, keychainAccount } from "./keychain.js";

export const SOURCE = "claude-code";
/** Two at a time: the console is one small container, and this can be a hundred sessions. */
export const DEFAULT_CONCURRENCY = 2;

export interface ImportSessionsOptions {
  out: (line: string) => void;
  err?: ((line: string) => void) | undefined;
  since?: string | undefined;
  /** Only sessions whose cwd is, or is under, this path. */
  project?: string | undefined;
  limit?: number | undefined;
  dryRun?: boolean | undefined;
  /** Overrides for tests. */
  home?: string | undefined;
  transcriptsDir?: string | undefined;
  ledgerPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  platform?: NodeJS.Platform | undefined;
  fetchFn?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  host?: string | undefined;
  concurrency?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface ImportSessionsResult {
  code: number;
  found: number;
  skipped: number;
  posted: number;
  failed: number;
  empty: number;
}

interface Candidate {
  path: string;
  sessionId: string;
  mtimeMs: number;
  projectDir: string;
}

export interface LedgerEntry {
  mtime_ms: number;
  imported_at: string;
  idempotency_key: string;
  inbox_id?: number | undefined;
}

export interface Ledger {
  version: 1;
  sessions: Record<string, LedgerEntry>;
}

const EMPTY_LEDGER: Ledger = { version: 1, sessions: {} };

export function ledgerPathFor(home: string): string {
  return join(home, ".metistry", "imported-sessions.json");
}

export function transcriptsDirFor(home: string): string {
  return join(home, ".claude", "projects");
}

export async function readLedger(path: string): Promise<Ledger> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ...EMPTY_LEDGER, sessions: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Ledger;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object" || !parsed.sessions) throw new Error("shape");
    return { version: 1, sessions: parsed.sessions };
  } catch {
    // A corrupt ledger must not stop a capture; the server-side
    // idempotency_key is the second line of defence against duplicates.
    return { ...EMPTY_LEDGER, sessions: {} };
  }
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

/** Every transcript under the projects dir, newest last. Missing dir → no candidates, not an error. */
export async function findTranscripts(dir: string): Promise<Candidate[]> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const projectDir of projectDirs.sort()) {
    let files: string[];
    try {
      files = (await readdir(join(dir, projectDir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const path = join(dir, projectDir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = Math.floor((await stat(path)).mtimeMs);
      } catch {
        continue;
      }
      out.push({ path, sessionId: file.replace(/\.jsonl$/, ""), mtimeMs, projectDir });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** `--since 2026-09-01` or a full ISO stamp. A typo must not silently import everything. */
export function parseSince(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) throw new Error(`--since must be a date (YYYY-MM-DD) or an ISO timestamp, not ${JSON.stringify(v)}`);
  return ms;
}

/** The session's cwd, from the transcript when it says, else decoded from the directory name (lossy). */
function projectOf(summary: SessionSummary, candidate: Candidate): string {
  return summary.project ?? decodeProjectDir(candidate.projectDir);
}

/** METISTRY_URL / METISTRY_OWNER_TOKEN from the environment, else the login Keychain (`metistry:<VAR>`). */
export async function resolveTarget(opts: ImportSessionsOptions): Promise<{ url: string; token: string }> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  let url = (env.METISTRY_URL ?? "").trim().replace(/\/+$/, "");
  let token = (env.METISTRY_OWNER_TOKEN ?? "").trim();
  if ((!url || !token) && platform === "darwin") {
    const kc = new Keychain(opts.exec ?? realExec, keychainAccount(env));
    if (!token) token = (await kc.getSecret("METISTRY_OWNER_TOKEN"))?.trim() ?? "";
    if (!url) url = ((await kc.getSecret("METISTRY_URL"))?.trim() ?? "").replace(/\/+$/, "");
  }
  if (!url) throw new Error("METISTRY_URL is not set (env, .env in the checkout, or the login Keychain)");
  if (!token) throw new Error("METISTRY_OWNER_TOKEN is not set (env, .env in the checkout, or `metistry secrets mint METISTRY_OWNER_TOKEN`)");
  return { url, token };
}

/** Redact before printing: a token must not reach stdout, a log, or an error message. */
function redact(text: unknown, token: string): string {
  const s = text instanceof Error ? (text.message ?? String(text)) : String(text);
  return token ? s.split(token).join("[redacted]") : s;
}

export function filenameFor(summary: SessionSummary, candidate: Candidate): string {
  const stamp = (summary.started ?? new Date(candidate.mtimeMs).toISOString()).replaceAll(/[-:]/g, "").replace(/\.\d+Z?$/, "Z");
  return `${SOURCE}-session-${stamp}-${candidate.sessionId.slice(0, 8)}.md`;
}

async function postCapture(
  url: string,
  token: string,
  body: { note: string; filename: string },
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ id?: number }> {
  let res: Response;
  try {
    res = await fetchFn(`${url}/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`capture unreachable: ${(err as any)?.cause?.message ?? (err as Error)?.message ?? String(err)}`);
  }
  const text = await res.text();
  if (res.status !== 201) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as { id?: number };
  } catch {
    return {};
  }
}

export async function importSessions(opts: ImportSessionsOptions): Promise<ImportSessionsResult> {
  const out = opts.out;
  const err = opts.err ?? out;
  const now = opts.now ?? (() => new Date());
  const home = opts.home ?? homedir();
  const dir = opts.transcriptsDir ?? transcriptsDirFor(home);
  const ledgerPath = opts.ledgerPath ?? ledgerPathFor(home);
  const dryRun = opts.dryRun === true;
  const since = parseSince(opts.since);
  const projectFilter = opts.project ? opts.project.replace(/\/+$/, "") : undefined;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : undefined;

  const target = dryRun ? { url: "", token: "" } : await resolveTarget(opts);
  const ledger = await readLedger(ledgerPath);
  const candidates = await findTranscripts(dir);
  const result: ImportSessionsResult = { code: 0, found: candidates.length, skipped: 0, posted: 0, failed: 0, empty: 0 };

  out(`${candidates.length} transcript(s) under ${dir}${dryRun ? " (dry run — nothing is posted)" : ""}`);

  interface Job {
    candidate: Candidate;
    summary: SessionSummary;
    key: string;
    note: string;
    filename: string;
  }
  const jobs: Job[] = [];
  for (const candidate of candidates) {
    if (limit !== undefined && jobs.length >= limit) break;
    const previous = ledger.sessions[candidate.sessionId];
    if (previous && previous.mtime_ms === candidate.mtimeMs) {
      result.skipped++;
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(candidate.path, "utf8");
    } catch (e) {
      result.failed++;
      err(`  ! ${candidate.sessionId.slice(0, 8)} unreadable: ${(e as Error).message}`);
      continue;
    }
    const summary = summarizeTranscript(raw, { sessionId: candidate.sessionId, project: decodeProjectDir(candidate.projectDir) });
    if (!summary) {
      result.empty++;
      continue;
    }
    const startedMs = summary.started ? Date.parse(summary.started) : candidate.mtimeMs;
    if (since !== undefined && Number.isFinite(startedMs) && startedMs < since) {
      result.skipped++;
      continue;
    }
    const project = projectOf(summary, candidate);
    if (projectFilter && project !== projectFilter && !project.startsWith(`${projectFilter}/`)) {
      result.skipped++;
      continue;
    }
    const key = idempotencyKey(summary, SOURCE);
    jobs.push({
      candidate,
      summary,
      key,
      note: renderSessionNote(summary, { source: SOURCE, host: opts.host ?? hostname(), capturedAt: now().toISOString(), key }),
      filename: filenameFor(summary, candidate),
    });
  }

  if (dryRun) {
    for (const job of jobs) {
      const s = job.summary;
      out("");
      out(`--- ${job.filename}`);
      out(
        `    ${sessionTitle(s)} · ${s.turns} turns · ${s.files.length} file(s) · ${s.tools.length} tool(s) · ${s.models.join(", ") || "no model recorded"}`,
      );
      out(`    idempotency_key: ${job.key}`);
      out(
        job.note
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
    out("");
    out(`would post ${jobs.length}; skipped ${result.skipped} (ledger/filters), ${result.empty} with nothing to say`);
    return result;
  }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const queue = [...jobs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        const r = await postCapture(target.url, target.token, { note: job.note, filename: job.filename }, fetchFn, timeoutMs);
        result.posted++;
        ledger.sessions[job.candidate.sessionId] = {
          mtime_ms: job.candidate.mtimeMs,
          imported_at: now().toISOString(),
          idempotency_key: job.key,
          ...(typeof r.id === "number" ? { inbox_id: r.id } : {}),
        };
        out(`  → ${job.filename} (inbox #${r.id ?? "?"}, ${job.summary.turns} turns)`);
      } catch (e) {
        result.failed++;
        err(`  ! ${job.filename}: ${redact(e, target.token)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  // The ledger is written even on a partial failure: what posted must never post twice.
  try {
    await writeLedger(ledgerPath, ledger);
  } catch (e) {
    err(`ledger not written (${ledgerPath}): ${redact(e, target.token)} — the next run may re-post what just posted`);
    result.code = 1;
  }
  out(`posted ${result.posted}, skipped ${result.skipped}, empty ${result.empty}, failed ${result.failed} → ${ledgerPath}`);
  // A hard failure is: nothing got through when something should have.
  if (result.failed > 0 && result.posted === 0) result.code = 1;
  return result;
}
