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
  /**
   * The vault-relative directory the knowledge fixture (now.md, Alpha,
   * Beta, Draft) was written under — `""` when `tempRepo()` was called with
   * no marker (the original, un-namespaced layout). A db-backed suite passes
   * a marker so its path-keyed rows (knowledge_files, knowledge_links,
   * embeddings) never share a literal path with a sibling file's rows in the
   * shared scratch db (docs/ops/testing.md, "count your own rows"); a suite
   * that never touches Postgres has no reason to and gets the old paths.
   */
  prefix: string;
  cleanup(): Promise<void>;
}

export async function tempRepo(marker = ""): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "metistry-reconciler-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  const areasDir = marker ? join(root, "Areas", marker) : join(root, "Areas");
  const prefix = marker ? `Areas/${marker}/` : "";
  await mkdir(areasDir, { recursive: true });
  await writeFile(marker ? join(areasDir, "now.md") : join(root, "now.md"), "# Now\n\nNothing yet.\n");
  await writeFile(join(areasDir, "Alpha.md"), "---\ntitle: Alpha\ndescription: the first area\n---\n\nSee [[Beta]] and [[Areas/Gamma|G]].\n");
  await writeFile(join(areasDir, "Beta.md"), "# Beta\n\nplain note mentioning zebra\n");
  await writeFile(join(areasDir, "Draft.md"), "---\nstatus: draft\n---\n\nzebra appears here too but unsettled\n");
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
  return { root, git, prefix, cleanup: () => rm(root, { recursive: true, force: true }) };
}
