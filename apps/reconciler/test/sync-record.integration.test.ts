// What a vault sync leaves in Postgres (§2.21 rule 3, §2.20): one `runs`
// row of kind `vault_sync` per act, and ONE Needs You `report` per conflict
// episode — however many attempts find it, and even after the owner has
// dismissed it. End to end against a real bare remote, then row by row.
// Skipped without a db.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeRequest } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { Committer, type SyncConflict } from "../src/committer.js";
import { conflictKey, recordSync, syncRecorder, SYNC_RUN_KIND } from "../src/sync-record.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const exec = promisify(execFile);

/** A fork point no other test can share — this file counts only its own rows (docs/ops/testing.md). */
const fakeBase = () => randomBytes(20).toString("hex");

function conflict(base: string, paths = ["now.md"]): SyncConflict {
  return {
    reason: "diverged",
    paths,
    path_count: paths.length,
    base,
    local: { sha: "a".repeat(40), ahead: 1 },
    remote: { sha: "b".repeat(40), behind: 2 },
    sides: [{ path: paths[0]!, local: { sha: "a".repeat(40), author: "Metistry assistant", subject: "Brief" }, remote: { sha: "b".repeat(40), author: "Owner", subject: "Edit on GitHub" } }],
    remote_name: "origin",
    branch: "main",
    since: new Date().toISOString(),
  };
}

describe.skipIf(!hasDb)("vault sync on the record (real db)", () => {
  let pool: pg.Pool;
  const keys: string[] = [];
  const runIds: number[] = [];

  const reports = async (key: string) =>
    (await pool.query(`SELECT id, kind, source_agent, trust, decision, payload FROM proposals WHERE kind = 'report' AND source_agent = 'reconciler' AND payload->>'idempotency_key' = $1`, [key])).rows;

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  afterAll(async () => {
    if (keys.length) await pool.query(`DELETE FROM proposals WHERE kind = 'report' AND source_agent = 'reconciler' AND payload->>'idempotency_key' = ANY($1::text[])`, [keys]);
    if (runIds.length) await pool.query(`DELETE FROM runs WHERE id = ANY($1::bigint[])`, [runIds]);
    await pool.end();
  });

  it("two attempts that find the same conflict → two `vault_sync` runs, ONE report; a dismissed one stays dismissed", async () => {
    const c = conflict(fakeBase());
    keys.push(conflictKey(c));
    const first = await recordSync(pool, { state: "conflict", ok: false, error: "now.md changed both here and on origin/main", remote: "origin", branch: "main", meta: { reason: c.reason }, conflict: c });
    const second = await recordSync(pool, { state: "conflict", ok: false, remote: "origin", branch: "main", meta: {}, conflict: { ...c, remote: { ...c.remote, sha: "c".repeat(40), behind: 3 } } });
    runIds.push(first.runId, second.runId);
    expect([first.reported, second.reported]).toEqual([true, false]);

    const rows = await reports(conflictKey(c));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "report", source_agent: "reconciler", trust: "internal", decision: "pending" });
    const payload = rows[0]!.payload as Record<string, any>;
    expect(payload.title).toBe("Vault sync stopped: 1 file changed here and on origin/main");
    expect(payload.body).toContain("Nothing was pushed and nothing was overwritten");
    expect(payload.refs).toEqual(["now.md"]);
    expect(payload.sides).toMatchObject({ local: { ref: "main", commits: 1 }, remote: { ref: "origin/main", commits: 2 }, by_path: [{ path: "now.md", remote: { author: "Owner" } }] });
    expect(payload.provenance).toEqual({ component: "reconciler", run_id: first.runId });
    // F-5's table reads it as a report drawn as an excerpt, Dismiss its answer
    expect(describeRequest("report", payload)).toMatchObject({ type: "report", body: "excerpt", decline: { label: "Dismiss" } });

    const runs = (await pool.query(`SELECT kind, component, ok, error, meta FROM runs WHERE id = ANY($1::bigint[]) ORDER BY id`, [[first.runId, second.runId]])).rows;
    expect(runs.map((r) => [r.kind, r.component, r.ok, (r.meta as { state: string }).state])).toEqual([
      [SYNC_RUN_KIND, "reconciler", false, "conflict"],
      [SYNC_RUN_KIND, "reconciler", false, "conflict"],
    ]);

    // the owner dismisses it while it still stands: the next attempt does not raise it again
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE id = $1`, [rows[0]!.id]);
    const third = await recordSync(pool, { state: "conflict", ok: false, remote: "origin", branch: "main", meta: {}, conflict: c });
    runIds.push(third.runId);
    expect(third.reported).toBe(false);
    expect(await reports(conflictKey(c))).toHaveLength(1);

    // a later, different conflict is a new episode and a new report
    const other = conflict(fakeBase(), [".metistry/rules.yaml"]);
    keys.push(conflictKey(other));
    const fourth = await recordSync(pool, { state: "conflict", ok: false, remote: "origin", branch: "main", meta: {}, conflict: { ...other, reason: "local_changes" } });
    runIds.push(fourth.runId);
    expect(fourth.reported).toBe(true);
    expect(((await reports(conflictKey(other)))[0]!.payload as { body: string }).body).toContain("a `.metistry/` file is yours to commit");
  });

  it("a pull and a push are `vault_sync` rows with their state — what `vault.sync {state}` is mapped from", async () => {
    const pull = await recordSync(pool, { state: "pull", ok: true, remote: "origin", branch: "main", meta: { integrated: "rebased", behind: 1 } });
    const push = await recordSync(pool, { state: "push", ok: false, error: "rejected", remote: "origin", branch: "main", meta: { ahead: 2 } });
    runIds.push(pull.runId, push.runId);
    const rows = (await pool.query(`SELECT ok, error, finished_at IS NOT NULL AS finished, meta FROM runs WHERE id = ANY($1::bigint[]) ORDER BY id`, [[pull.runId, push.runId]])).rows;
    expect(rows).toMatchObject([
      { ok: true, error: null, finished: true, meta: { state: "pull", integrated: "rebased", behind: 1, remote: "origin", branch: "main" } },
      { ok: false, error: "rejected", finished: true, meta: { state: "push", ahead: 2 } },
    ]);
  });

  it("end to end: the owner's conflicting push, two scheduled pushes → one request, nothing overwritten", async () => {
    const repo: TempRepo = await tempRepo();
    const scratch = await mkdtemp(join(tmpdir(), "metistry-syncdb-"));
    try {
      const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch };
      const asOwner = (cwd: string, args: string[]) => exec("git", ["-c", "user.name=Owner", "-c", "user.email=owner@example.test", ...args], { cwd, env });
      const bare = join(scratch, "remote.git");
      await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
      await exec("git", ["remote", "add", "origin", bare], { cwd: repo.root });
      const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
      committer.hooks = { record: syncRecorder(pool) };
      const before = Number((await pool.query(`SELECT coalesce(max(id), 0) AS id FROM runs`)).rows[0]!.id);
      await committer.push();
      await exec("git", ["clone", "-q", bare, join(scratch, "owner")], { env });
      await writeFile(join(scratch, "owner", "now.md"), "the owner's\n");
      await asOwner(join(scratch, "owner"), ["commit", "-qam", "Owner rewrites now"]);
      await asOwner(join(scratch, "owner"), ["push", "-q", "origin", "main"]);
      await mkdir(dirname(join(repo.root, "now.md")), { recursive: true });
      await writeFile(join(repo.root, "now.md"), "the assistant's\n");
      committer.enqueue({ paths: ["now.md"], principal: "assistant", message: "Brief rewrites now" });

      expect(await committer.push()).toMatchObject({ ok: false, integrated: "conflict" });
      expect(await committer.push()).toMatchObject({ ok: false, integrated: "conflict" });
      const key = conflictKey(committer.vault.conflict!);
      keys.push(key);
      expect(await reports(key)).toHaveLength(1);
      const rows = (await pool.query(`SELECT id, meta->>'state' AS state FROM runs WHERE id > $1 AND kind = $2 ORDER BY id`, [before, SYNC_RUN_KIND])).rows;
      runIds.push(...rows.map((r) => Number(r.id)));
      expect(rows.map((r) => r.state)).toEqual(["push", "conflict", "conflict"]);
    } finally {
      await repo.cleanup();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
