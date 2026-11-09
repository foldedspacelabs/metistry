// Project repos and captured sessions (research 2026-10-04 §6, CM-3 and
// CM-4): the walk derives `project_repos` from a project page's `repos:` and
// `vault_sessions` from every `kind: session` note under `Inbox/`. The
// parsing is pure and tested first; the tables need the real (scratch)
// database, because "derived" is a claim about what one walk rebuilds after a
// wipe and "the owner's word" is a claim about which files the walk believes.
// The DB half is skipped without a db. The read half — `project_for_repo`'s
// normalisation and refusal, `recent_sessions`' fold gate — is
// `apps/console/test/seed-queries.test.ts`.
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Indexer, projectRepoPairs } from "../src/indexer.js";
import { emptyNoteMeta, isProjectPagePath, parseFrontmatter, projectRepos, type NoteMeta } from "../src/notes.js";
import { tempRepo, type TempRepo } from "./helpers.js";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

describe("repos: in a project page's frontmatter (pure)", () => {
  it("`repos:` takes one remote or a list, each reduced to host/path; what is not plainly a remote is dropped and duplicates collapse", () => {
    expect(projectRepos("git@github.com:foldedspacelabs/metistry.git")).toEqual(["github.com/foldedspacelabs/metistry"]);
    expect(projectRepos(["https://github.com/foldedspacelabs/metistry", "git@github.com:foldedspacelabs/metistry.git", "ssh://git@gitlab.example/g/r", "not a remote", 42, null])).toEqual([
      "github.com/foldedspacelabs/metistry",
      "gitlab.example/g/r",
    ]);
    expect(projectRepos(undefined)).toEqual([]);
    expect(projectRepos({ origin: "git@github.com:a/b" })).toEqual([]); // a map is not the schema, and is not guessed at
    expect(projectRepos(Array.from({ length: 40 }, (_, i) => `https://example.org/o/r${i}`))).toHaveLength(16); // one page cannot flood the table
  });

  it("parseFrontmatter carries repos, and a note without them carries none", () => {
    expect(parseFrontmatter("---\nrepos:\n  - git@github.com:a/b.git\n---\n# x\n").meta.repos).toEqual(["github.com/a/b"]);
    expect(parseFrontmatter("---\nrepos: https://github.com/a/b\n---\n").meta.repos).toEqual(["github.com/a/b"]);
    expect(parseFrontmatter("# no frontmatter\n").meta).toEqual(emptyNoteMeta());
  });

  it("a project page is Projects/<Name>.md — one level down, markdown, nothing else", () => {
    expect(isProjectPagePath("Projects/Metistry.md")).toBe(true);
    expect(isProjectPagePath("Projects/Drey Build.md")).toBe(true);
    for (const p of ["Projects/Drey/Notes.md", "Projects/Drey/Drey.md", "Projects/Metistry.png", "projects/Metistry.md", "Areas/Dev/Metistry.md", "Metistry.md", "Projects/", "People/Metistry.md"]) {
      expect(isProjectPagePath(p), p).toBe(false);
    }
  });

  it("only a project page the USER owns maps a remote; the fold's page, a note in a project folder and a conflict copy never do", () => {
    const note = (path: string, meta: Partial<NoteMeta>, conflict = false) => ({ path, conflict, meta: { ...emptyNoteMeta(), ...meta } });
    const pairs = projectRepoPairs([
      note("Projects/Metistry.md", { repos: ["github.com/foldedspacelabs/metistry", "github.com/foldedspacelabs/metistry-instance"] }),
      note("Projects/Drey.md", { source: "user", repos: ["github.com/drey/app"] }),
      note("Projects/Fold Made This.md", { source: "knowledge-fold", repos: ["github.com/foldedspacelabs/metistry"] }), // the fold's page claims the owner's repo
      note("Projects/Drey/Notes.md", { repos: ["github.com/drey/notes"] }),
      note("Areas/Dev/Repos.md", { repos: ["github.com/elsewhere/x"] }),
      note("Projects/Metistry (conflict copy).md", { repos: ["github.com/foldedspacelabs/metistry"] }, true),
    ]);
    expect([...pairs.values()].sort()).toEqual([
      ["github.com/drey/app", "Projects/Drey.md"],
      ["github.com/foldedspacelabs/metistry", "Projects/Metistry.md"],
      ["github.com/foldedspacelabs/metistry-instance", "Projects/Metistry.md"],
    ]);
  });
});

// This suite takes the two tables it tests, and `knowledge_files` with them,
// for the reason `meeting-refs.integration.test.ts` gives: the walk owns them
// whole, so a leftover row is one this suite would delete and then miscount.
// `fileParallelism: false` is what makes it safe.
describe.skipIf(!hasDb)("project repos and captured sessions are derived by the walk (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let indexer: Indexer;
  const MARKER = `Itest${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const PAGE = `Projects/${MARKER} Metistry.md`;
  const FOLD_PAGE = `Projects/${MARKER} Fold.md`;
  const SESSION = `Inbox/claude-code-session-${MARKER.toLowerCase()}.md`;
  const CURSOR = `Inbox/cursor-session-${MARKER.toLowerCase()}.md`;
  const REMOTE = `github.com/${MARKER.toLowerCase()}/metistry`;

  const sessionNote = (repoName: string, prompt: string, reply: string, source = "claude-code") =>
    [
      "---",
      'kind: "session"',
      `source: "${source}"`,
      `title: "Claude Code session — ${repoName} — 2026-10-01"`,
      'session_id: "11111111-2222-3333-4444-555555555555"',
      `project: "/Users/example/Development/${repoName}"`,
      `repo: "${repoName}"`,
      'branch: "main"',
      'started: "2026-10-01T10:00:00.000Z"',
      'ended: "2026-10-01T10:30:00.000Z"',
      "turns: 3",
      'host: "mac"',
      'captured_at: "2026-10-01T10:31:00.000Z"',
      'idempotency_key: "k"',
      "---",
      "",
      `# Claude Code session — ${repoName} — 2026-10-01`,
      "",
      "## Session",
      "",
      "- Turns: 3 user, 4 assistant",
      "- Duration: 30m",
      "",
      "## Tools",
      "",
      "- Read × 2",
      "",
      "## Files touched",
      "",
      "- `src/a.ts`",
      "- `src/b.ts`",
      "",
      "## First prompt",
      "",
      prompt,
      "",
      "## Last response",
      "",
      reply,
    ];

  const clean = async () => {
    await pool.query(`DELETE FROM project_repos`);
    await pool.query(`DELETE FROM vault_sessions`);
    await pool.query(`DELETE FROM inbox WHERE path LIKE 'Inbox/%' AND path LIKE $1`, [`%${MARKER.toLowerCase()}%`]);
    await pool.query(`DELETE FROM vault_tasks`);
    await pool.query(`DELETE FROM vault_task_refs`);
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };
  const write = async (rel: string, lines: string[]) => {
    const abs = join(repo.root, rel);
    await mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await writeFile(abs, `${lines.join("\n")}\n`);
  };
  const repos = async () => (await pool.query(`SELECT remote, path FROM project_repos ORDER BY remote COLLATE "C", path COLLATE "C"`)).rows;
  const sessions = async () =>
    (await pool.query(`SELECT path, tool, repo, branch, started, turns, files, first_prompt FROM vault_sessions ORDER BY path COLLATE "C"`)).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await clean();
    repo = await tempRepo(MARKER);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false });
  });
  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("indexes a project page's remotes and a captured session's handles — and nothing a file did not say", async () => {
    await write(PAGE, ["---", "title: Metistry", `repos:`, `  - git@github.com:${MARKER.toLowerCase()}/metistry.git`, `  - https://github.com/${MARKER.toLowerCase()}/metistry-instance/`, "---", "# Metistry"]);
    // the fold created this page (its source: is its own id) and claims the owner's repository
    await write(FOLD_PAGE, ["---", "source: knowledge-fold", "fold: true", `repos: https://github.com/${MARKER.toLowerCase()}/metistry`, "---", "# Fold's page"]);
    // a note INSIDE a project folder is in the project, not the page for it
    await write(`Projects/${MARKER}/Notes.md`, ["---", `repos: https://github.com/${MARKER.toLowerCase()}/notes`, "---", "# notes"]);
    await write(SESSION, sessionNote(`${MARKER}-repo`, "Fix the loader test", "AGENT-REPLY-SHOULD-NEVER-BE-STORED"));
    await write(CURSOR, sessionNote(`${MARKER}-repo`, "Rename the module", "ANOTHER-REPLY", "cursor"));
    // an ordinary capture in the inbox is not a session
    await write(`Inbox/note-${MARKER.toLowerCase()}.md`, ["# just a note", "", "## First prompt", "", "not a session"]);

    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ project_repos: 2, sessions: 2 });
    expect(await repos()).toEqual([
      { remote: REMOTE, path: PAGE },
      { remote: `${REMOTE}-instance`, path: PAGE },
    ]);
    const rows = await sessions();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: SESSION, tool: "claude-code", repo: `${MARKER}-repo`, branch: "main", turns: 3, files: ["src/a.ts", "src/b.ts"], first_prompt: "Fix the loader test" });
    expect(rows[1]).toMatchObject({ path: CURSOR, tool: "cursor", first_prompt: "Rename the module" });
    expect(new Date(rows[0]!.started as string).toISOString()).toBe("2026-10-01T10:00:00.000Z");
    // **never the agent's reply**: not in any column
    const dump = JSON.stringify((await pool.query(`SELECT * FROM vault_sessions`)).rows);
    expect(dump).not.toContain("AGENT-REPLY");
    expect(dump).not.toContain("ANOTHER-REPLY");
  });

  it("a second walk with nothing changed writes nothing and says the same", async () => {
    const before = [await repos(), await sessions()];
    const s = await indexer.reconcile("test");
    expect(s).toMatchObject({ project_repos: 2, sessions: 2 });
    expect([await repos(), await sessions()]).toEqual(before);
  });

  it("an edit, a takeover, a rename and a delete move the rows with the files", async () => {
    await write(PAGE, ["---", "title: Metistry", `repos: git@github.com:${MARKER.toLowerCase()}/metistry.git`, "---", "# Metistry — one repo now"]);
    // the owner takes over the fold's page: now it is theirs, and its remote counts (two pages claim one remote — both rows; the query refuses)
    await write(FOLD_PAGE, ["---", "source: user", `repos: https://github.com/${MARKER.toLowerCase()}/metistry`, "---", "# Fold's page, now mine"]);
    await write(SESSION, sessionNote(`${MARKER}-repo`, "Fix the loader test, then the docs", "A NEW REPLY"));
    const moved = `Inbox/moved-${MARKER.toLowerCase()}.md`;
    await rename(join(repo.root, CURSOR), join(repo.root, moved));

    await indexer.reconcile("test");
    expect(await repos()).toEqual([
      { remote: REMOTE, path: FOLD_PAGE },
      { remote: REMOTE, path: PAGE },
    ]);
    const rows = await sessions();
    expect(rows.map((r) => r.path)).toEqual([SESSION, moved]);
    expect(rows[0]!.first_prompt).toBe("Fix the loader test, then the docs");

    await unlink(join(repo.root, moved));
    await indexer.reconcile("test");
    expect((await sessions()).map((r) => r.path)).toEqual([SESSION]);
  });

  it("rebuilds both tables exactly after a wipe (derived, invariant 1)", async () => {
    const before = [await repos(), await sessions()];
    expect(before[0]!.length + before[1]!.length).toBe(3);
    await pool.query(`DELETE FROM project_repos`);
    await pool.query(`DELETE FROM vault_sessions`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM knowledge_links`);
    await indexer.reconcile("test");
    expect([await repos(), await sessions()]).toEqual(before);
  });
});
