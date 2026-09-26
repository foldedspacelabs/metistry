// The vault inbox against the real (scratch) database: a file that appears
// under `Inbox/` without a capture call must get a triage row, a
// human's edit must refresh it (and re-open it for the drain), and a
// deleted file must archive it — the owner's 2026-09-16 ruling that edits
// made in `` are first-class and never lost. Skipped without a db.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDb } from "@foldedspacelabs/metistry-core/test-env";
import { Committer } from "../src/committer.js";
import { Vault } from "../src/vault.js";
import { Indexer } from "../src/indexer.js";
import { tempRepo, type TempRepo } from "./helpers.js";

try {
  for (const line of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const hasDb = !!process.env.METISTRY_DB_PASSWORD;
const INBOX = "Inbox";

// This suite never asserts on knowledge_files/knowledge_links — it only
// wants the reconcile side effect of indexing the fixture vault gone
// afterwards. A random marker keeps that cleanup scoped to this file's own
// rows, so it can never delete a sibling reconciler test file's rows in the
// shared scratch db (docs/ops/testing.md, "count your own rows").
const MARKER = `itest-${randomUUID().slice(0, 8)}`;
const PREFIX = `Areas/${MARKER}/`;

describe.skipIf(!hasDb)("the vault inbox is indexed from the tree (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let indexer: Indexer;

  const rowsNow = async () =>
    (await pool.query(`SELECT path, source, mime, note, sha256, status FROM inbox WHERE path LIKE $1 ORDER BY path`, [`${INBOX}/%`])).rows;
  const clean = async () => {
    await pool.query(`DELETE FROM inbox WHERE path LIKE $1`, [`${INBOX}/%`]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1 OR to_path LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await clean();
    repo = await tempRepo(MARKER);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false });
    await mkdir(join(repo.root, INBOX), { recursive: true });
  });
  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("a note written in Obsidian (no capture call) becomes a triage row", async () => {
    await writeFile(join(repo.root, INBOX, "1757980000000-idea.md"), "# Rebuild the deck\n\nstart from the Q3 numbers\n");
    const s = await indexer.reconcile("test");
    expect(s.inbox).toEqual({ added: 1, changed: 0, archived: 0 });
    expect(await rowsNow()).toEqual([
      {
        path: `${INBOX}/1757980000000-idea.md`,
        source: "vault",
        mime: "text/markdown",
        note: "Rebuild the deck",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "new",
      },
    ]);
  });

  it("a second pass over an unchanged inbox does nothing", async () => {
    const s = await indexer.reconcile("test");
    expect(s.inbox).toEqual({ added: 0, changed: 0, archived: 0 });
  });

  it("a human's refinement re-hashes the row and sends a classified capture back to the drain", async () => {
    const path = `${INBOX}/1757980000000-idea.md`;
    const before = (await rowsNow())[0];
    await pool.query(`UPDATE inbox SET status = 'classified', proposal = '{"kind":"note"}'::jsonb WHERE path = $1`, [path]);
    await writeFile(join(repo.root, path), "# Rebuild the deck (this quarter)\n\nstart from the Q3 numbers, then the pipeline\n");

    const s = await indexer.reconcile("test");
    expect(s.inbox).toEqual({ added: 0, changed: 1, archived: 0 });
    const row = (await pool.query(`SELECT sha256, status, note, proposal FROM inbox WHERE path = $1`, [path])).rows[0];
    expect(row.sha256).not.toBe(before.sha256);
    expect(row.status).toBe("new"); // a refinement is new information
    expect(row.proposal).toBeNull();
    expect(row.note).toBe("Rebuild the deck (this quarter)");
  });

  it("a rejected row is not re-opened by an edit — the user's no stands", async () => {
    const path = `${INBOX}/1757980000001-nope.md`;
    await writeFile(join(repo.root, path), "junk\n");
    await indexer.reconcile("test");
    await pool.query(`UPDATE inbox SET status = 'rejected' WHERE path = $1`, [path]);
    await writeFile(join(repo.root, path), "junk, with a typo fixed\n");

    const s = await indexer.reconcile("test");
    expect(s.inbox.changed).toBe(1);
    expect((await pool.query(`SELECT status FROM inbox WHERE path = $1`, [path])).rows[0].status).toBe("rejected");
  });

  it("a deleted file archives its row, and the same file coming back re-opens it", async () => {
    const path = `${INBOX}/1757980000001-nope.md`;
    await rm(join(repo.root, path));
    expect((await indexer.reconcile("test")).inbox).toEqual({ added: 0, changed: 0, archived: 1 });
    expect((await pool.query(`SELECT status FROM inbox WHERE path = $1`, [path])).rows[0].status).toBe("archived");

    await writeFile(join(repo.root, path), "junk, restored from git\n");
    expect((await indexer.reconcile("test")).inbox).toEqual({ added: 0, changed: 1, archived: 0 });
    expect((await pool.query(`SELECT status FROM inbox WHERE path = $1`, [path])).rows[0].status).toBe("new");
  });

  it("an existing capture row is left alone, and `.large/` rows are never archived", async () => {
    const captured = `${INBOX}/1757980000002-photo.jpg`;
    await writeFile(join(repo.root, captured), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    await pool.query(`INSERT INTO inbox (source, path, mime, note, sha256, status) VALUES ('http', $1, 'image/jpeg', 'the whiteboard', $2, 'classified')`, [
      captured,
      "0".repeat(64),
    ]);
    // a large capture lives in a dot-directory the walk never sees
    await pool.query(`INSERT INTO inbox (source, path, mime, sha256) VALUES ('http', $1, 'video/quicktime', $2)`, [`${INBOX}/.large/1757980000003-clip.mov`, "1".repeat(64)]);

    const s = await indexer.reconcile("test");
    expect(s.inbox.added).toBe(0); // the capture already had a row
    expect(s.inbox.archived).toBe(0); // .large/ is invisible, not gone
    const rows = await pool.query(`SELECT path, status, source, note FROM inbox WHERE path LIKE $1 ORDER BY path`, [`${INBOX}/.large/%`]);
    expect(rows.rows).toEqual([{ path: `${INBOX}/.large/1757980000003-clip.mov`, status: "new", source: "http", note: null }]);
    const cap = (await pool.query(`SELECT status, note, source FROM inbox WHERE path = $1`, [captured])).rows[0];
    expect(cap).toEqual({ status: "new", note: "the whiteboard", source: "http" }); // re-hashed (the row's sha was a placeholder), note kept
  });

  it("one row per inbox file, whoever writes it (the 0015 partial unique index)", async () => {
    await expect(
      pool.query(`INSERT INTO inbox (source, path, sha256) VALUES ('http', $1, $2)`, [`${INBOX}/1757980000000-idea.md`, "2".repeat(64)]),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

// ---- the same scan on an instance that has not been migrated yet -------------
//
// A legacy instance keeps its captures at `Knowledge/Inbox/` and its triage
// rows under that prefix (migration 0015's partial index still covers them).
// The flat-only prefix made the cycle look for `Inbox/%`: it found none of
// the existing rows and made no new ones, so the capture → triage pipeline
// stopped on exactly the installs that had not migrated.

const LEGACY_INBOX = "Knowledge/Inbox";
const LEGACY_MARKER = `itest-${randomUUID().slice(0, 8)}`;
const LEGACY_PREFIX = `Areas/${LEGACY_MARKER}/`;

describe.skipIf(!hasDb)("the vault inbox on a legacy instance (real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let indexer: Indexer;

  const clean = async () => {
    await pool.query(`DELETE FROM inbox WHERE path LIKE $1`, [`${LEGACY_INBOX}/%`]);
    await pool.query(`DELETE FROM knowledge_links WHERE from_path LIKE $1 OR to_path LIKE $1`, [`${LEGACY_PREFIX}%`]);
    await pool.query(`DELETE FROM knowledge_files WHERE path LIKE $1`, [`${LEGACY_PREFIX}%`]);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await clean();
    repo = await tempRepo(LEGACY_MARKER);
    const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    // what `resolveInstanceLayout` hands the reconciler on a legacy instance
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: false, inboxPrefix: LEGACY_INBOX });
    await mkdir(join(repo.root, LEGACY_INBOX), { recursive: true });
  });
  afterAll(async () => {
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  it("makes triage rows under the legacy prefix, and archives them there", async () => {
    const path = `${LEGACY_INBOX}/1757990000000-idea.md`;
    await writeFile(join(repo.root, path), "# A legacy idea\n\nstill a capture\n");
    expect((await indexer.reconcile("test")).inbox).toEqual({ added: 1, changed: 0, archived: 0 });
    expect((await pool.query(`SELECT path, source, note, status FROM inbox WHERE path LIKE $1`, [`${LEGACY_INBOX}/%`])).rows).toEqual([
      { path, source: "vault", note: "A legacy idea", status: "new" },
    ]);

    await rm(join(repo.root, path));
    expect((await indexer.reconcile("test")).inbox).toEqual({ added: 0, changed: 0, archived: 1 });
    expect((await pool.query(`SELECT status FROM inbox WHERE path = $1`, [path])).rows[0].status).toBe("archived");
  });

  it("does not touch a flat-layout row that happens to be in the same table", async () => {
    await pool.query(`INSERT INTO inbox (source, path, mime, sha256) VALUES ('http', $1, 'text/markdown', $2)`, ["Inbox/1757990000001-other.md", "2".repeat(64)]);
    expect((await indexer.reconcile("test")).inbox).toEqual({ added: 0, changed: 0, archived: 0 });
    expect((await pool.query(`SELECT status FROM inbox WHERE path = $1`, ["Inbox/1757990000001-other.md"])).rows[0].status).toBe("new");
    await pool.query(`DELETE FROM inbox WHERE path = $1`, ["Inbox/1757990000001-other.md"]);
  });
});
