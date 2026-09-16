// `metistry migrate-inbox` — move an existing instance's inbox into the
// vault (owner's ruling, 2026-09-16: captures live at `Knowledge/Inbox/` so
// Obsidian, whose vault root is `Knowledge/`, can see and edit them).
//
// Why a verb and not an instance migration. `instance-migrations/` is SQL
// for a local extension's own tables; there is no repo-layout step in
// `metistry update`, and inventing one for a single move would be a
// mechanism nothing else uses. This is the same shape as `migrate-shape`:
// one verb, the shared StepRunner so `--dry-run` is the same code path, and
// it changes nothing that is running — it prints the `metistry up` line and
// stops.
//
// What it does, idempotently:
//   1. moves `<instance>/inbox/*` (or a second instance's lowercase
//      `Knowledge/inbox/`) into `Knowledge/Inbox/`, with `git mv` for what
//      git tracks and a plain move for what it does not (the old inbox was
//      gitignored, so most of it is untracked);
//   2. drops `inbox/` from `.gitignore` and adds `Knowledge/Inbox/.large/`;
//   3. rewrites `inbox.path` rows to the repo-relative form the column was
//      always documented to hold (`Knowledge/Inbox/<file>`);
//   4. commits the result in the instance repo.
//
// The lowercase case is why the directory move is two steps: macOS is
// case-insensitive, so `git mv Knowledge/inbox Knowledge/Inbox` moves the
// directory INSIDE itself. Through a temp name it is unambiguous on both
// kinds of filesystem.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMIT_AUTHOR, GITIGNORE } from "./init.js";
import type { Exec } from "./exec.js";
import { normalizeDir } from "./instance.js";
import { openMigrationSession, type MigrationSession } from "./migrate.js";
import { StepFailed, StepRunner } from "./steps.js";

/** Where captures live now. TitleCase, like everything under `Knowledge/` (CLAUDE.md). */
export const VAULT_INBOX = "Knowledge/Inbox";
/** Gitignored spill for captures git should not carry (docs/ops/inbox.md). */
export const LARGE_IGNORE_LINE = "Knowledge/Inbox/.large/";
/** The intermediate name the two-step rename passes through on a case-insensitive filesystem. */
export const TEMP_INBOX = "Knowledge/Inbox-migrating";

export interface MigrateInboxOptions {
  instanceDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  out?: ((line: string) => void) | undefined;
  dryRun?: boolean | undefined;
  /** test seam: a single-session db handle (null = no db configured, so rows are left alone) */
  openSession?: ((env: NodeJS.ProcessEnv) => Promise<(MigrationSession & { end(): Promise<void> }) | null>) | undefined;
}

export interface MigrateInboxResult {
  code: number;
  commands: string[];
  /** the directory the captures came from, relative to the instance repo; null = nothing to move */
  from: string | null;
  /** how many entries were moved */
  moved: number;
  /** `inbox` rows rewritten to the repo-relative path */
  rowsRewritten: number;
  gitignore: "updated" | "unchanged";
  /** true when there was nothing left to do — a second run says so and changes nothing */
  alreadyDone: boolean;
}

/** `.gitignore` after the move: `inbox/` is gone (captures are tracked now), `.large/` is in. */
export function rewriteGitignore(existing: string): string {
  const lines = existing.split("\n");
  const kept = lines.filter((l) => !/^\/?inbox\/?$/.test(l.trim()));
  if (!kept.some((l) => l.trim().replace(/\/$/, "") === LARGE_IGNORE_LINE.replace(/\/$/, ""))) {
    const i = kept.findIndex((l) => l.trim() === "");
    const at = i === -1 ? kept.length : i;
    kept.splice(at, 0, LARGE_IGNORE_LINE);
  }
  const out = kept.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * The real name of a directory entry under `dir`, case-insensitively — how
 * a lowercase `Knowledge/inbox` is detected on a filesystem that would
 * happily answer `existsSync("Knowledge/Inbox")` for it.
 */
export async function actualName(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.find((e) => e.toLowerCase() === name.toLowerCase());
}

/** Rows whose path is not yet repo-relative, rewritten in place. Idempotent: a second run matches nothing. */
export const REWRITE_PATHS_SQL = `UPDATE inbox
   SET path = 'Knowledge/Inbox/' || regexp_replace(path, '^(inbox/|Knowledge/inbox/)', '')
 WHERE path NOT LIKE 'Knowledge/Inbox/%'`;

export async function migrateInbox(opts: MigrateInboxOptions): Promise<MigrateInboxResult> {
  const dir = normalizeDir(opts.instanceDir);
  const env = opts.env ?? process.env;
  const r = new StepRunner({
    dryRun: opts.dryRun === true,
    out: opts.out ?? ((l) => console.log(l)),
    ...(opts.exec ? { exec: opts.exec } : {}),
    env,
  });
  if (!existsSync(join(dir, ".git"))) throw new StepFailed(`${dir} is not a git repository — pass --instance <dir> or set METISTRY_INSTANCE_DIR`);

  const git = (args: string[], comment?: string) =>
    r.run("git", ["-C", dir, ...args], {
      env: { ...env, GIT_AUTHOR_NAME: COMMIT_AUTHOR.name, GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email, GIT_COMMITTER_NAME: COMMIT_AUTHOR.name, GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email },
      ...(comment ? { comment } : {}),
    });
  const tracked = async (rel: string): Promise<boolean> => {
    if (r.dryRun) return false;
    const out = await r.exec("git", ["-C", dir, "ls-files", "--", rel], { env });
    return out.code === 0 && out.stdout.trim() !== "";
  };

  r.section("inbox → Knowledge/Inbox");
  let from: string | null = null;
  let moved = 0;

  // A second instance that already moved its inbox, in lowercase.
  const knowledgeDir = join(dir, "Knowledge");
  const inKnowledge = existsSync(knowledgeDir) ? await actualName(knowledgeDir, "Inbox") : undefined;
  if (inKnowledge !== undefined && inKnowledge !== "Inbox") {
    from = `Knowledge/${inKnowledge}`;
    r.note(`${from} is the vault inbox under another spelling — renaming it through ${TEMP_INBOX} (macOS would otherwise move it inside itself)`);
    if (await tracked(from)) {
      await git(["mv", from, TEMP_INBOX]);
      await git(["mv", TEMP_INBOX, VAULT_INBOX]);
    } else if (r.action(`move ${from} → ${TEMP_INBOX} → ${VAULT_INBOX}`)) {
      await rename(join(dir, from), join(dir, TEMP_INBOX));
      await rename(join(dir, TEMP_INBOX), join(dir, VAULT_INBOX));
    }
    moved = 1;
  }

  // The pre-2026-09-16 layout: a gitignored `inbox/` beside the vault.
  const legacy = join(dir, "inbox");
  const legacyEntries = existsSync(legacy) ? (await readdir(legacy)).filter((e) => e !== ".DS_Store").sort() : [];
  if (existsSync(legacy)) {
    from = from ?? "inbox";
    if (!r.dryRun) await mkdir(join(dir, VAULT_INBOX), { recursive: true });
    for (const entry of legacyEntries) {
      const src = `inbox/${entry}`;
      const dst = `${VAULT_INBOX}/${entry}`;
      if (existsSync(join(dir, dst))) {
        r.note(`skipped ${src}: ${dst} already exists`);
        continue;
      }
      if (await tracked(src)) await git(["mv", src, dst]);
      else if (r.action(`move ${src} → ${dst}`)) await rename(join(dir, src), join(dir, dst));
      moved++;
    }
    if (r.action(`remove the empty ${legacy}`)) await rm(legacy, { recursive: true, force: true });
  }
  if (from === null) r.note("no inbox/ and no lowercase Knowledge/inbox — nothing to move");

  r.section(".gitignore");
  const ignorePath = join(dir, ".gitignore");
  const before = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : GITIGNORE;
  const after = rewriteGitignore(before);
  let gitignore: MigrateInboxResult["gitignore"] = "unchanged";
  if (after !== before) {
    gitignore = "updated";
    await r.write(ignorePath, after, "inbox/ dropped (captures are tracked now), Knowledge/Inbox/.large/ added");
  } else {
    r.note("already carries Knowledge/Inbox/.large/ and no inbox/ line");
  }

  r.section("inbox rows");
  let rowsRewritten = 0;
  const openSession = opts.openSession ?? openMigrationSession;
  if (r.action("UPDATE inbox SET path = 'Knowledge/Inbox/' || … WHERE path NOT LIKE 'Knowledge/Inbox/%'")) {
    const session = await openSession(env);
    if (!session) {
      r.note("no METISTRY_DB_PASSWORD — inbox rows left alone; re-run with the install's environment to rewrite them");
    } else {
      try {
        const res = (await session.query(REWRITE_PATHS_SQL)) as { rowCount?: number | null };
        rowsRewritten = res.rowCount ?? 0;
        r.note(`${rowsRewritten} row(s) now point at Knowledge/Inbox/`);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new StepFailed(
          e.code === "23505"
            ? "two inbox rows would end up at the same Knowledge/Inbox/ path — resolve the duplicate by hand, then re-run"
            : `rewriting inbox rows failed: ${e.message ?? String(err)}`,
        );
      } finally {
        await session.end().catch(() => {});
      }
    }
  }

  r.section("commit");
  const alreadyDone = from === null && gitignore === "unchanged" && rowsRewritten === 0;
  if (alreadyDone) {
    r.note("nothing changed — this instance is already on the vault inbox");
  } else {
    await git(["add", "-A", "--", VAULT_INBOX, ".gitignore"], "only the paths this verb touched");
    const commit = await r.run("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Inbox moved into the vault (Knowledge/Inbox)"], {
      env: { ...env, GIT_AUTHOR_NAME: COMMIT_AUTHOR.name, GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email, GIT_COMMITTER_NAME: COMMIT_AUTHOR.name, GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email },
      tolerateFailure: true,
    });
    if (commit.code !== 0) r.note("commit skipped (nothing staged, or the reconciler holds the index) — the reconciler sweeps Knowledge/ into a `user` commit on its next cycle");
  }

  r.section("next");
  r.note("nothing was restarted. Bring the install up so the console picks up the new inbox path:");
  r.note("  metistry up");
  r.note("Obsidian needs no change: the vault root is still Knowledge/, and Inbox/ is now a folder inside it.");
  return { code: 0, commands: r.commands, from, moved, rowsRewritten, gitignore, alreadyDone };
}
