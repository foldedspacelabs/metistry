// Resolve a conflict on the bridge (design-build-plan §2.11, T2-10):
// `POST /vault/conflicts/resolve` against a throwaway instance repo and the
// scratch database — the index is what says a path is in `conflict`, and the
// conflict's review is a row, so both halves need Postgres. Skipped without one.
//
// Misuse first, and the ticket's bold line: **a path not in `conflict` is
// refused** — a note that never was one, a copy the index has not seen, a copy
// already settled — as a 409 carrying `current: null`, with nothing written.
// Then the 409 for a side that moved, and the two settles, each of which must
// leave the side it gave up in history (C136).
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { mintToken, RESOLVED_AT_SOURCE } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { Committer } from "../src/committer.js";
import { Indexer, conflictSource } from "../src/indexer.js";
import { sha256 } from "../src/notes.js";
import { makeBridge } from "../src/server.js";
import { Vault } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)

// This package's db suites run one file at a time and each owns the index
// (vitest.config.ts; indexer.integration.test.ts says why) — the marker keeps
// this file's literal paths apart from a sibling's leftovers all the same.
const MARKER = `resolve-${randomUUID().slice(0, 8)}`;
const PREFIX = `Areas/${MARKER}/`;
const token = mintToken();
const ownerToken = mintToken();
const hash = (s: string) => sha256(Buffer.from(s));

describe.skipIf(!hasDb)("Resolve a conflict: POST /vault/conflicts/resolve (T2-10, real db)", () => {
  let pool: pg.Pool;
  let repo: TempRepo;
  let committer: Committer;
  let indexer: Indexer;
  let server: ReturnType<typeof makeBridge>;
  let bare: ReturnType<typeof makeBridge>;
  let base: string;
  let bareBase: string;
  const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const clean = async () => {
    await pool.query(`DELETE FROM vault_tasks`);
    await pool.query(`DELETE FROM vault_task_refs`);
    await pool.query(`DELETE FROM knowledge_links`);
    await pool.query(`DELETE FROM knowledge_files`);
    await pool.query(`DELETE FROM proposals WHERE source_agent = 'reconciler'`);
    await pool.query(`DELETE FROM runs WHERE component = 'reconciler'`);
  };

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    await clean();
    repo = await tempRepo(MARKER);
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test" });
    const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 65536 });
    indexer = new Indexer(pool, vault, committer, { commitExternalEdits: true });
    server = makeBridge({ vault, committer, indexer, db: pool }, { token, ownerToken, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // the same vault with no database: nothing can say a path is in conflict
    bare = makeBridge({ vault, committer }, { token, ownerToken, maxBodyBytes: 64 * 1024 });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    await indexer.reconcile("test");
    await committer.flush();
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bare.close(() => r()));
    await repo.cleanup();
    await clean();
    await pool.end();
  });

  const settle = (body: Record<string, unknown>, headers: Record<string, string> = H, at = base) =>
    fetch(`${at}/vault/conflicts/resolve`, { method: "POST", headers, body: JSON.stringify(body) });
  const copyOf = (name: string) => `${PREFIX}${name}.sync-conflict-20260927-101500-ABCDEFG.md`;
  const disk = (p: string) => readFile(join(repo.root, p), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  const git = (...args: string[]) => repo.git.run(args);
  const head = async () => (await repo.git.head())!;
  const reviews = async (copy: string) =>
    (await pool.query(`SELECT id, decision, payload FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id`, [conflictSource(copy).kind, conflictSource(copy).external_ref])).rows;
  /** Two edits of one note, as a sync tool leaves them — indexed, reviewed, and (unless `dirty`) the note committed. */
  const conflict = async (name: string, mine: string | null, theirs: string, opts: { dirty?: boolean } = {}) => {
    const original = `${PREFIX}${name}.md`;
    const copy = copyOf(name);
    if (mine !== null) await writeFile(join(repo.root, original), mine);
    if (!opts.dirty) {
      await indexer.reconcile("test");
      await committer.flush();
    }
    await writeFile(join(repo.root, copy), theirs);
    await indexer.reconcile("test");
    return { original, copy };
  };

  // ---------------------------------------------------------------- the door

  it("MISUSE: 401 with no bearer or a wrong one — before the body is read", async () => {
    for (const headers of [{ "content-type": "application/json" }, { authorization: "Bearer nope", "content-type": "application/json" }]) {
      const r = await settle({ path: copyOf("Nobody"), keep: "mine", expected_sha256: "" }, headers);
      expect(r.status).toBe(401);
      expect((await r.json()).error.code).toBe("unauthenticated");
    }
  });

  it("MISUSE: **a path not in `conflict` is refused** — 409, `current: null`, nothing written", async () => {
    const before = await head();
    // a note that never was a conflict
    const beta = `${PREFIX}Beta.md`;
    const betaBytes = (await disk(beta))!;
    for (const keep of ["mine", "theirs"]) {
      const r = await settle({ path: beta, keep, expected_sha256: hash(betaBytes) });
      expect(r.status, keep).toBe(409);
      expect(await r.json(), keep).toEqual({ error: { code: "conflict", message: `${beta} is not in conflict — it was settled, or it never was` }, current: null });
    }
    expect(await disk(beta)).toBe(betaBytes);
    // a copy on disk the index has not seen yet: the reconciler does not have it in `conflict`
    const unseen = copyOf("Unseen");
    await writeFile(join(repo.root, unseen), "arrived a moment ago\n");
    const r = await settle({ path: unseen, keep: "mine", expected_sha256: hash("arrived a moment ago\n") });
    expect(r.status).toBe(409);
    expect((await r.json()).current).toBeNull();
    expect(await disk(unseen)).toBe("arrived a moment ago\n");
    await unlink(join(repo.root, unseen));
    expect(await head()).toBe(before);
  });

  it("MISUSE: not knowledge, or not a path at all — refused before anything is read", async () => {
    const r = await settle({ path: ".metistry/rules.yaml", keep: "theirs", expected_sha256: "" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("forbidden");
    const audit = await pool.query(`SELECT meta FROM runs WHERE component = 'reconciler' AND kind = 'auth' AND tool = 'vault_resolve_conflict' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]?.meta).toMatchObject({ path: ".metistry/rules.yaml", code: "forbidden", principal: "user" });
    for (const path of ["../outside.md", "/etc/passwd", ".git/config"]) {
      const t = await settle({ path, keep: "mine", expected_sha256: "" });
      expect([400, 403], path).toContain(t.status);
    }
  });

  it("MISUSE: a body that is not {path, keep, expected_sha256} is 400; no database is 503", async () => {
    const { copy } = await conflict("Shape", "# Shape\n\nmine\n", "# Shape\n\ntheirs\n");
    for (const body of [
      { path: copy, keep: "both", expected_sha256: "" },
      { path: copy, keep: "MINE", expected_sha256: "" },
      { path: copy, expected_sha256: "" },
      { path: copy, keep: "mine" },
      { path: copy, keep: "mine", expected_sha256: "abc" },
      { path: copy, keep: "mine", expected_sha256: "A".repeat(64) },
    ]) {
      const r = await settle(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const r = await settle({ path: copy, keep: "mine", expected_sha256: hash("# Shape\n\ntheirs\n") }, H, bareBase);
    expect(r.status).toBe(503);
    expect(await disk(copy)).toBe("# Shape\n\ntheirs\n"); // untouched by every refusal
  });

  it("409 when the side given up is not what was seen — the conflict as it stands, nothing written, the review still waiting", async () => {
    const mine = "# Epsilon\n\nmine\n";
    const theirs = "# Epsilon\n\ntheirs\n";
    const { original, copy } = await conflict("Epsilon", mine, theirs);
    const before = await head();
    const current = { path: copy, original, sha256: hash(theirs), original_sha256: hash(mine) };
    // keep mine gives up THEIRS: the note's hash is the wrong one to send
    let r = await settle({ path: copy, keep: "mine", expected_sha256: hash(mine) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: { code: "conflict", message: `${copy} is not what you saw — look at both sides again before discarding one` }, current });
    // take theirs gives up MINE, which the owner has since edited
    r = await settle({ path: copy, keep: "theirs", expected_sha256: hash("# Epsilon\n\nwhat it said an hour ago\n") });
    expect(r.status).toBe(409);
    expect((await r.json()).current).toEqual(current);
    expect(await disk(original)).toBe(mine);
    expect(await disk(copy)).toBe(theirs);
    await committer.flush();
    expect(await head()).toBe(before);
    expect((await reviews(copy)).map((x) => x.decision)).toEqual(["pending"]);
  });

  it("Keep Mine: the copy goes, its bytes stay in history, and the review and the index row clear now", async () => {
    const mine = "# Delta\n\nmine\n";
    const theirs = "# Delta\n\nthe phone's version\n";
    const { original, copy } = await conflict("Delta", mine, theirs);
    expect((await reviews(copy)).map((x) => x.decision)).toEqual(["pending"]);

    const r = await settle({ path: copy, keep: "mine", expected_sha256: hash(theirs) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ path: original, copy, kept: "mine", sha256: hash(mine), bytes: Buffer.byteLength(mine), recorded: expect.stringMatching(/^[0-9a-f]{40}$/), queued: true });
    expect(await disk(copy)).toBeNull();
    expect(await disk(original)).toBe(mine);
    await committer.flush();

    // history: the copy was added (recorded), then removed (settled) — both the owner's
    expect((await git("show", `${body.recorded}:${copy}`))).toBe(theirs);
    const log = (await git("log", "--format=%an|%s", "--", copy)).trim().split("\n");
    expect(log).toEqual([`Metistry user|Settle the conflict on ${original}: keep mine`, `Metistry user|Record ${copy} before the conflict on ${original} is settled`]);
    expect((await git("ls-files", "--", copy)).trim()).toBe("");
    expect((await git("status", "--porcelain", "--", copy, original)).trim()).toBe("");

    // the review cleared at its source, and the index no longer has the copy
    expect((await reviews(copy)).map((x) => x.decision)).toEqual([RESOLVED_AT_SOURCE]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM knowledge_files WHERE path = $1`, [copy])).rows[0].n).toBe(0);

    // settled is not in conflict: the second press — another device — is the 409 with nothing to show
    const again = await settle({ path: copy, keep: "mine", expected_sha256: hash(theirs) });
    expect(again.status).toBe(409);
    expect((await again.json()).current).toBeNull();
  });

  it("Take the Other: the copy's bytes become the note, and the note's own unrecorded edit is committed first", async () => {
    const committed = "# Zeta\n\nas committed\n";
    const edited = "# Zeta\n\nedited in Obsidian, not yet swept\n";
    const theirs = "# Zeta\n\nthe laptop's version\n";
    await writeFile(join(repo.root, PREFIX, "Zeta.md"), committed);
    await indexer.reconcile("test");
    await committer.flush();
    const { original, copy } = await conflict("Zeta", edited, theirs, { dirty: true });

    const r = await settle({ path: copy, keep: "theirs", expected_sha256: hash(edited) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ path: original, copy, kept: "theirs", sha256: hash(theirs), bytes: Buffer.byteLength(theirs), recorded: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await disk(original)).toBe(theirs);
    expect(await disk(copy)).toBeNull();
    await committer.flush();

    // the discarded side — the edit nobody had committed — is in history, one commit before the settle
    expect(await git("show", `${body.recorded}:${original}`)).toBe(edited);
    expect(await git("show", `HEAD:${original}`)).toBe(theirs);
    expect((await git("log", "-1", "--format=%an|%s", "--", original)).trim()).toBe(`Metistry user|Settle the conflict on ${original}: take the other`);
    // an untracked copy leaves no trace of its own: it never was in history, and it is not now
    expect((await git("log", "--format=%h", "--", copy)).trim()).toBe("");
    expect((await reviews(copy)).map((x) => x.decision)).toEqual([RESOLVED_AT_SOURCE]);
  });

  it("with no note beside the copy: Keep Mine is refused (nothing to keep); Take the Other creates it, and records nothing", async () => {
    const theirs = "only the copy survived\n";
    const { original, copy } = await conflict("Orphan", null, theirs);
    const refused = await settle({ path: copy, keep: "mine", expected_sha256: hash(theirs) });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toBe(`there is no ${original} to keep — take the other, or settle it in Obsidian`);

    const r = await settle({ path: copy, keep: "theirs", expected_sha256: "" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ path: original, kept: "theirs", sha256: hash(theirs), recorded: null });
    expect(await disk(original)).toBe(theirs);
    await committer.flush();
  });

  it("mid-merge is 503 and discards nothing: history could not be made to hold the side given up", async () => {
    const theirs = "# Eta\n\ntheirs\n";
    const { copy } = await conflict("Eta", "# Eta\n\nmine\n", theirs);
    const marker = join(repo.root, ".git", "MERGE_HEAD");
    await writeFile(marker, `${await head()}\n`);
    try {
      const r = await settle({ path: copy, keep: "mine", expected_sha256: hash(theirs) });
      expect(r.status).toBe(503);
      expect((await r.json()).error.message).toContain("mid-merge");
      expect(await disk(copy)).toBe(theirs);
    } finally {
      await unlink(marker);
    }
    expect((await settle({ path: copy, keep: "mine", expected_sha256: hash(theirs) })).status).toBe(200);
    await committer.flush();
  });

  it("the sweep commits a tracked copy's deletion (a settle refused after the record, then settled in Obsidian), never an untracked copy", async () => {
    const tracked = copyOf("Theta");
    const loose = copyOf("Iota");
    await writeFile(join(repo.root, tracked), "recorded, then deleted by hand\n");
    await writeFile(join(repo.root, loose), "never recorded\n");
    committer.enqueue({ paths: [tracked], principal: "user", message: "Record it" });
    await committer.flush();
    expect((await git("ls-files", "--", tracked)).trim()).toBe(tracked);

    await unlink(join(repo.root, tracked));
    const swept = await committer.sweepExternalEdits();
    expect(swept).toContain(tracked);
    expect(swept).not.toContain(loose);
    await committer.flush();
    expect((await git("ls-files", "--", tracked)).trim()).toBe("");
    expect((await git("status", "--porcelain", "--", tracked)).trim()).toBe("");
    await unlink(join(repo.root, loose));
  });
});
