// Product files whose only difference from the seed is CASE — `Me/Profile.md`
// where the product reads `Me/profile.md` — renamed to the seed's spelling.
//
// The 0.14.2 owner instance was seeded on 2026-09-06 with `Me/Profile.md`;
// the seed and core's PROFILE_PATH have said `Me/profile.md` since, and
// `metistry migrate-layout` (2026-09-19) moved the file without looking at
// its case. Reads are case-exact (the casing rule, apps/reconciler paths.ts),
// so every working-day and timezone read failed from then on.
//
// THE CANONICAL LIST IS THE SEED. Every file under `seed/vault/` is a name the
// product ships and may read by that name; nothing else in the vault is
// looked at, so the owner's own files are never touched whatever their case.
// A file counts only when its directory is spelled exactly and the file
// differs by case alone, with exactly one such file (a case-sensitive tree
// holding BOTH spellings is two files, not a spelling mistake, and is left
// for the owner).
//
// THE RENAME IS TWO STEPS, through a temporary name, on every filesystem:
// on a case-insensitive one (macOS) `Profile.md` → `profile.md` is the same
// path to the OS and to git (`core.ignorecase`), so neither a plain rename
// nor a pathspec commit records it. Each step is its own commit.
//
//   bridge configured → `POST /vault/rename` as `user` (the owner bearer when
//                       this process holds it), `POST /flush` after each step
//                       — the reconciler stays the instance repo's sole
//                       committer (D5);
//   no bridge         → `git mv` + a pathspec commit per step, directly —
//                       refused while a reconciler job is running.
//
// Idempotent: a second run finds nothing to rename. It never fails `update`:
// a rename it could not make is named, with the rerun.

import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { detectLayout } from "@foldedspacelabs/metistry-core";
import { COMMIT_AUTHOR, SEED_VAULT_DIR } from "./init.js";
import { hostLocal } from "./doctor.js";
import { OWNER_BRIDGE_TOKEN, RECONCILER_LABEL } from "./protected-write.js";
import { StepFailed, type StepRunner } from "./steps.js";

export interface CaseMismatch {
  /** The seed's spelling — what the product reads. */
  canonical: string;
  /** What the vault has. */
  actual: string;
}

export interface VaultCaseResult {
  /** `actual → canonical`, renamed (or, in a dry run, that would be) */
  renamed: CaseMismatch[];
  /** mismatches left as they were, each with why */
  left: Array<CaseMismatch & { why: string }>;
}

/** The suffix of the intermediate name. Unlikely to exist, and not a `.md`: nothing indexes it as a note for the moment it lives. */
export const CASE_RENAME_SUFFIX = ".metistry-case-rename";

/** Every file the seed's vault ships, vault-relative, sorted. */
export async function seedVaultFiles(seedDir: string): Promise<string[]> {
  const root = join(seedDir, SEED_VAULT_DIR);
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await walk("");
  return out.sort();
}

/** The entries of a directory reached by EXACT names — `existsSync` answers case-insensitively on macOS, which is the very thing being asked about. */
async function exactEntries(root: string, segments: readonly string[]): Promise<string[] | null> {
  let cur = root;
  for (const seg of segments) {
    const entries = await readdir(cur).catch(() => null);
    if (!entries?.includes(seg)) return null;
    cur = join(cur, seg);
  }
  return readdir(cur).catch(() => null);
}

/** The seed's files the vault has under another case only. */
export async function vaultCaseMismatches(seedDir: string, instanceDir: string): Promise<CaseMismatch[]> {
  const out: CaseMismatch[] = [];
  for (const canonical of await seedVaultFiles(seedDir)) {
    const segments = canonical.split("/");
    const name = segments.pop()!;
    const entries = await exactEntries(instanceDir, segments);
    if (!entries || entries.includes(name)) continue;
    const folded = entries.filter((e) => e.toLowerCase() === name.toLowerCase());
    if (folded.length !== 1) continue;
    out.push({ canonical, actual: [...segments, folded[0]!].join("/") });
  }
  return out;
}

/** One line per mismatch, for doctor and the plan. */
export function describeMismatch(m: CaseMismatch): string {
  return `${m.actual} → ${m.canonical}`;
}

export interface VaultCaseOptions {
  seedDir: string;
  instanceDir: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
}

/** `update`'s step: rename every mismatch to the seed's spelling. */
export async function renameCaseMismatches(r: StepRunner, o: VaultCaseOptions): Promise<VaultCaseResult> {
  const result: VaultCaseResult = { renamed: [], left: [] };
  const dir = o.instanceDir?.replace(/\/+$/, "");
  if (!dir) {
    r.note("vault case: no METISTRY_INSTANCE_DIR — no vault to look at");
    return result;
  }
  const shape = detectLayout(dir);
  if (shape !== "flat") {
    r.note(`vault case: ${dir} is on the ${shape} layout — not looked at (\`metistry migrate-layout\` first)`);
    return result;
  }
  const found = await vaultCaseMismatches(o.seedDir, dir);
  if (found.length === 0) {
    r.note("vault case: every product file is spelled as the seed spells it — nothing renamed");
    return result;
  }
  for (const m of found) {
    try {
      const how = o.env.METISTRY_RECONCILER_URL ? await viaBridge(r, m, o) : await directly(r, dir, m, o);
      result.renamed.push(m);
      r.note(`vault case: ${describeMismatch(m)} — ${how}`);
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
      result.left.push({ ...m, why: err.message });
      r.note(`vault case: ${m.actual} was NOT renamed (${err.message}) — the update is unaffected; rerun \`metistry update\` once that is fixed`);
    }
  }
  return result;
}

const tmpOf = (m: CaseMismatch): string => `${m.actual}${CASE_RENAME_SUFFIX}`;
const MESSAGE = (m: CaseMismatch, step: 1 | 2): string => `metistry update: rename ${m.actual} to ${m.canonical}, the name the product reads (step ${step} of 2 — a case-only rename)`;

async function viaBridge(r: StepRunner, m: CaseMismatch, o: VaultCaseOptions): Promise<string> {
  const base = hostLocal(o.env.METISTRY_RECONCILER_URL!);
  const tmp = tmpOf(m);
  const one = r.action(`POST ${base}/vault/rename ${m.actual} → ${tmp}, then /flush (principal user)`);
  const two = r.action(`POST ${base}/vault/rename ${tmp} → ${m.canonical}, then /flush (principal user)`);
  if (!one || !two) return "the reconciler would commit it as two renames";
  const token = o.env[OWNER_BRIDGE_TOKEN] ?? o.env.METISTRY_BRIDGE_TOKEN_RECONCILER;
  if (!token) throw new StepFailed(`METISTRY_RECONCILER_URL is set but neither ${OWNER_BRIDGE_TOKEN} nor METISTRY_BRIDGE_TOKEN_RECONCILER is`);
  const call = async (path: string, body?: unknown): Promise<Response> => {
    try {
      return await o.fetchFn(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new StepFailed(`reconciler bridge at ${base} did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  const rename = async (from: string, to: string, step: 1 | 2): Promise<void> => {
    const res = await call("/vault/rename", { from, to, intent: { principal: "user", message: MESSAGE(m, step) } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new StepFailed(`reconciler refused to rename ${from} to ${to} (${body?.error?.code ?? res.status}${body?.error?.message ? `: ${body.error.message}` : ""})`);
    }
  };
  /** Did the flush commit a change touching `path`? A paused or failed flush leaves the next step's commit to collide with this one's. */
  const committed = async (path: string): Promise<boolean> => {
    const res = await call("/flush");
    if (!res.ok) return false;
    const out = (await res.json().catch(() => null)) as { commits?: Array<{ paths?: string[] }> } | null;
    return (out?.commits ?? []).some((c) => (c.paths ?? []).includes(path));
  };

  await rename(m.actual, tmp, 1);
  if (!(await committed(tmp))) {
    // Put it back rather than leave the file under a name nothing reads.
    await rename(tmp, m.actual, 1);
    await call("/flush");
    throw new StepFailed(`the reconciler did not commit the first step (a merge or rebase in progress, or a failed commit) — ${m.actual} was put back`);
  }
  await rename(tmp, m.canonical, 2);
  if (!(await committed(m.canonical))) throw new StepFailed(`${m.canonical} is renamed on disk but the reconciler has not committed it yet — its next flush will`);
  return "renamed through the reconciler as user, in two commits";
}

async function directly(r: StepRunner, dir: string, m: CaseMismatch, o: VaultCaseOptions): Promise<string> {
  if (o.platform === "darwin" && !r.dryRun) {
    const probe = await r.exec("launchctl", ["print", `gui/${o.uid}/${RECONCILER_LABEL}`]);
    if (probe.code === 0 && /^\s*state = running/m.test(probe.stdout)) {
      throw new StepFailed(`a reconciler job is running but METISTRY_RECONCILER_URL is unset — add it (and ${OWNER_BRIDGE_TOKEN}) to .env so this renames ${m.actual} through the bridge; refusing to commit behind the sole committer`);
    }
  }
  const tmp = tmpOf(m);
  const env = {
    ...o.env,
    GIT_AUTHOR_NAME: COMMIT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email,
  };
  const git = (args: string[]) => r.run("git", ["-C", dir, ...args], { env });
  const tracked = r.dryRun ? true : (await r.exec("git", ["-C", dir, "ls-files", "--error-unmatch", "--", m.actual], { env })).code === 0;
  if (!tracked) {
    // Not in git yet: move the file itself; the reconciler, once running, sweeps it in.
    if (r.action(`rename ${m.actual} → ${tmp} → ${m.canonical} (untracked, so no commit)`)) {
      await rename(join(dir, m.actual), join(dir, tmp));
      await rename(join(dir, tmp), join(dir, m.canonical));
    }
    return "renamed on disk (the file was not in git yet)";
  }
  await git(["mv", "--", m.actual, tmp]);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", MESSAGE(m, 1), "--", m.actual, tmp]);
  await git(["mv", "--", tmp, m.canonical]);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", MESSAGE(m, 2), "--", tmp, m.canonical]);
  return "renamed with git directly (no reconciler configured), in two commits";
}
