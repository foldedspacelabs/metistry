// A throwaway instance repo per test file, in the flat layout (2026-09-17):
// `git init` in a temp dir whose ROOT is the vault, with the protected files
// under `.metistry/`, seeded with one commit.
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
  await mkdir(join(root, "Areas"), { recursive: true });
  await writeFile(join(root, "now.md"), "# Now\n\nNothing yet.\n");
  await writeFile(join(root, "Areas", "Alpha.md"), "---\ntitle: Alpha\ndescription: the first area\n---\n\nSee [[Beta]] and [[Areas/Gamma|G]].\n");
  await writeFile(join(root, "Areas", "Beta.md"), "# Beta\n\nplain note mentioning zebra\n");
  await writeFile(join(root, "Areas", "Draft.md"), "---\nstatus: draft\n---\n\nzebra appears here too but unsettled\n");
  await mkdir(join(root, ".metistry", "instance-migrations"), { recursive: true });
  await writeFile(join(root, ".metistry", "identity.yaml"), "name: Example\n");
  await writeFile(join(root, ".metistry", "rules.yaml"), "rules: []\n");
  await writeFile(join(root, ".metistry", "instance-migrations", "0001_local.sql"), "-- local\n");
  // Artifacts/ is owner-visible content at the root that the knowledge walk
  // must skip — a fixture for exactly that
  await mkdir(join(root, "Artifacts", "bundle-1"), { recursive: true });
  await writeFile(join(root, "Artifacts", "bundle-1", "report.md"), "# not knowledge\n");
  await writeFile(join(root, ".gitignore"), ".obsidian/\n");
  await exec("git", ["add", "-A"], { cwd: root, env });
  await exec("git", ["-c", "user.name=seed", "-c", "user.email=seed@test", "commit", "-q", "-m", "seed"], { cwd: root, env });
  const git = new Git(root);
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}
