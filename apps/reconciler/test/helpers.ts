// A throwaway instance repo per test file: `git init` in a temp dir with a
// Knowledge/ vault and the protected files, seeded with one commit.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Git } from "../src/git.js";

const exec = promisify(execFile);

export interface TempRepo {
  root: string;
  git: Git;
  cleanup(): Promise<void>;
}

export async function tempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "metistry-reconciler-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  await mkdir(join(root, "Knowledge", "Areas"), { recursive: true });
  await writeFile(join(root, "Knowledge", "now.md"), "# Now\n\nNothing yet.\n");
  await writeFile(join(root, "Knowledge", "Areas", "Alpha.md"), "---\ntitle: Alpha\ndescription: the first area\n---\n\nSee [[Beta]] and [[Areas/Gamma|G]].\n");
  await writeFile(join(root, "Knowledge", "Areas", "Beta.md"), "# Beta\n\nplain note mentioning zebra\n");
  await writeFile(join(root, "Knowledge", "Areas", "Draft.md"), "---\nstatus: draft\n---\n\nzebra appears here too but unsettled\n");
  await writeFile(join(root, "identity.yaml"), "name: Example\n");
  await writeFile(join(root, "rules.yaml"), "rules: []\n");
  await mkdir(join(root, "instance-migrations"), { recursive: true });
  await writeFile(join(root, "instance-migrations", "0001_local.sql"), "-- local\n");
  await writeFile(join(root, ".gitignore"), ".obsidian/\n");
  await exec("git", ["add", "-A"], { cwd: root, env });
  await exec("git", ["-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-q", "-m", "seed"], { cwd: root, env });
  const git = new Git(root);
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}
