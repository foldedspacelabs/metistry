// `metistry migrate-inbox` — move an existing instance's inbox into the
// vault (owner's ruling, 2026-09-16: captures are ordinary vault content, so
// Obsidian can see and edit them).
//
// WHERE the vault inbox is depends on the instance's layout, so this verb
// asks (core's detectLayout) rather than assuming: `Inbox/` under the flat
// layout (the instance directory IS the vault, 2026-09-17), `Knowledge/Inbox/`
// under the legacy one. An instance that has not been moved to the flat
// layout yet is still served correctly — that migration is its own verb.
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
//   1. moves `<instance>/inbox/*` (or a differently-cased vault inbox) into
//      the vault inbox, with `git mv` for what git tracks and a plain move
//      for what it does not (the old inbox was gitignored, so most of it is
//      untracked);
//   2. drops `inbox/` from `.gitignore` and adds the `.large/` spill line;
//   3. rewrites `inbox.path` rows to the repo-relative form the column was
//      always documented to hold (`<vault inbox>/<file>`);
//   4. commits the result in the instance repo.
//
// The lowercase case is why the directory move is two steps: macOS is
// case-insensitive, so `git mv inbox Inbox` moves the directory INSIDE
// itself. Through a temp name it is unambiguous on both kinds of filesystem.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INSTANCE_LAYOUT, LEGACY_VAULT_DIR, detectLayout, type InstanceLayoutShape } from "@foldedspacelabs/metistry-core";
import { COMMIT_AUTHOR, GITIGNORE } from "./init.js";
import type { Exec } from "./exec.js";
import { normalizeDir } from "./instance.js";
import { openMigrationSession, type MigrationSession } from "./migrate.js";
import { StepFailed, StepRunner } from "./steps.js";

export interface InboxTarget {
  /** the layout this instance is in — flat unless it still has to be migrated */
  layout: InstanceLayoutShape;
  /** where captures live, instance-relative: `Inbox` (flat) or `Knowledge/Inbox` (legacy) */
  vaultInbox: string;
  /** the directory the vault inbox sits in, instance-relative; "" = the instance root */
  vaultRoot: string;
  /** gitignored spill for captures git should not carry (docs/ops/inbox.md) */
  largeIgnoreLine: string;
  /** the intermediate name the two-step rename passes through on a case-insensitive filesystem */
  tempInbox: string;
}

/**
 * Where the vault inbox is for a given layout. `legacy` keeps the pre-flat
 * spelling so an instance that has not run the layout migration is moved to
 * a place that exists; `unknown` is treated as flat (a fresh directory).
 */
export function inboxTargetFor(layout: InstanceLayoutShape): InboxTarget {
  const legacy = layout === "legacy";
  const vaultRoot = legacy ? LEGACY_VAULT_DIR : "";
  const vaultInbox = legacy ? `${LEGACY_VAULT_DIR}/${INSTANCE_LAYOUT.inboxDir}` : INSTANCE_LAYOUT.inboxDir;
  return {
    layout,
    vaultInbox,
    vaultRoot,
    largeIgnoreLine: `${vaultInbox}/.large/`,
    tempInbox: `${vaultInbox}-migrating`,
  };
}

/** The flat layout's answers, for callers (and tests) that only want the current shape. */
export const VAULT_INBOX = inboxTargetFor("flat").vaultInbox;
export const LARGE_IGNORE_LINE = inboxTargetFor("flat").largeIgnoreLine;
export const TEMP_INBOX = inboxTargetFor("flat").tempInbox;

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
export function rewriteGitignore(existing: string, largeIgnoreLine: string = LARGE_IGNORE_LINE): string {
  const lines = existing.split("\n");
  const kept = lines.filter((l) => !/^\/?inbox\/?$/.test(l.trim()));
  if (!kept.some((l) => l.trim().replace(/\/$/, "") === largeIgnoreLine.replace(/\/$/, ""))) {
    const i = kept.findIndex((l) => l.trim() === "");
    const at = i === -1 ? kept.length : i;
    kept.splice(at, 0, largeIgnoreLine);
  }
  const out = kept.join("\n");
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * The real name of a directory entry under `dir`, case-insensitively — how
 * a lowercase `inbox` is detected on a filesystem that would happily answer
 * `existsSync("Inbox")` for it.
 */
export async function actualName(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.find((e) => e.toLowerCase() === name.toLowerCase());
}

/**
 * Rows whose path is not yet the vault inbox's, rewritten in place.
 * Idempotent: a second run matches nothing.
 *
 * The prefixes stripped are the shapes a row could have held BEFORE this
 * verb: the old gitignored `inbox/`, and the legacy vault inbox in either
 * casing. Deliberately not `Inbox/` — the flat layout's own prefix is
 * excluded by the WHERE clause anyway, and stripping it would collapse
 * `Inbox/x.md` and a bare `x.md` onto the same path, which the partial
 * unique index would (correctly) refuse.
 */
export function rewritePathsSql(vaultInbox: string): string {
  return `UPDATE inbox
   SET path = '${vaultInbox}/' || regexp_replace(path, '^(inbox/|Knowledge/[Ii]nbox/)', '')
 WHERE path NOT LIKE '${vaultInbox}/%'`;
}

/** The flat layout's statement, for callers that only want the current shape. */
export const REWRITE_PATHS_SQL = rewritePathsSql(VAULT_INBOX);

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

  const target = inboxTargetFor(detectLayout(dir));
  const { vaultInbox, tempInbox, largeIgnoreLine } = target;

  r.section(`inbox → ${vaultInbox}`);
  r.note(`instance layout: ${target.layout} — the vault inbox is ${vaultInbox}/`);
  let from: string | null = null;
  let moved = 0;

  // A second instance that already moved its inbox, under another spelling.
  const vaultRootDir = target.vaultRoot ? join(dir, target.vaultRoot) : dir;
  const inVault = existsSync(vaultRootDir) ? await actualName(vaultRootDir, INSTANCE_LAYOUT.inboxDir) : undefined;
  if (inVault !== undefined && inVault !== INSTANCE_LAYOUT.inboxDir) {
    from = target.vaultRoot ? `${target.vaultRoot}/${inVault}` : inVault;
    r.note(`${from} is the vault inbox under another spelling — renaming it through ${tempInbox} (macOS would otherwise move it inside itself)`);
    if (await tracked(from)) {
      await git(["mv", from, tempInbox]);
      await git(["mv", tempInbox, vaultInbox]);
    } else if (r.action(`move ${from} → ${tempInbox} → ${vaultInbox}`)) {
      await rename(join(dir, from), join(dir, tempInbox));
      await rename(join(dir, tempInbox), join(dir, vaultInbox));
    }
    moved = 1;
  }

  // The pre-2026-09-16 layout: a gitignored `inbox/` beside the vault.
  //
  // Only when the vault inbox is somewhere ELSE. Under the flat layout the
  // vault inbox IS `Inbox/` at the root, macOS answers `existsSync("inbox")`
  // for it, and treating it as a legacy source would move the directory into
  // itself and then remove "the empty legacy directory" — i.e. delete the
  // vault inbox. The rename above is what handles a mis-cased one there.
  const legacyApplies = vaultInbox.toLowerCase() !== "inbox";
  const legacy = join(dir, "inbox");
  const legacyEntries = legacyApplies && existsSync(legacy) ? (await readdir(legacy)).filter((e) => e !== ".DS_Store").sort() : [];
  if (legacyApplies && existsSync(legacy)) {
    from = from ?? "inbox";
    if (!r.dryRun) await mkdir(join(dir, vaultInbox), { recursive: true });
    for (const entry of legacyEntries) {
      const src = `inbox/${entry}`;
      const dst = `${vaultInbox}/${entry}`;
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
  if (from === null) r.note(`no inbox/ and no differently-cased ${vaultInbox} — nothing to move`);

  r.section(".gitignore");
  const ignorePath = join(dir, ".gitignore");
  const before = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : GITIGNORE;
  const after = rewriteGitignore(before, largeIgnoreLine);
  let gitignore: MigrateInboxResult["gitignore"] = "unchanged";
  if (after !== before) {
    gitignore = "updated";
    await r.write(ignorePath, after, `inbox/ dropped (captures are tracked now), ${largeIgnoreLine} added`);
  } else {
    r.note(`already carries ${largeIgnoreLine} and no inbox/ line`);
  }

  r.section("inbox rows");
  let rowsRewritten = 0;
  const openSession = opts.openSession ?? openMigrationSession;
  if (r.action(`UPDATE inbox SET path = '${vaultInbox}/' || … WHERE path NOT LIKE '${vaultInbox}/%'`)) {
    const session = await openSession(env);
    if (!session) {
      r.note("no METISTRY_DB_PASSWORD — inbox rows left alone; re-run with the install's environment to rewrite them");
    } else {
      try {
        const res = (await session.query(rewritePathsSql(vaultInbox))) as { rowCount?: number | null };
        rowsRewritten = res.rowCount ?? 0;
        r.note(`${rowsRewritten} row(s) now point at ${vaultInbox}/`);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new StepFailed(
          e.code === "23505"
            ? `two inbox rows would end up at the same ${vaultInbox}/ path — resolve the duplicate by hand, then re-run`
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
    await git(["add", "-A", "--", vaultInbox, ".gitignore"], "only the paths this verb touched");
    const commit = await r.run("git", ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", `Inbox moved into the vault (${vaultInbox})`], {
      env: { ...env, GIT_AUTHOR_NAME: COMMIT_AUTHOR.name, GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email, GIT_COMMITTER_NAME: COMMIT_AUTHOR.name, GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email },
      tolerateFailure: true,
    });
    if (commit.code !== 0) r.note("commit skipped (nothing staged, or the reconciler holds the index) — the reconciler sweeps the vault into a `user` commit on its next cycle");
  }

  r.section("next");
  r.note("nothing was restarted. Bring the install up so the console picks up the new inbox path:");
  r.note("  metistry up");
  r.note(`Obsidian needs no change: ${vaultInbox}/ is an ordinary folder in the vault.`);
  return { code: 0, commands: r.commands, from, moved, rowsRewritten, gitignore, alreadyDone };
}
