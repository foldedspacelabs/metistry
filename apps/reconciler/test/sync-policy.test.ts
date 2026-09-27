// The vault's sync policy, scheduled (§2.21, T10-2). HOW a sync runs —
// fetch, integrate, never force, a conflict stops — is sync.test.ts's
// (T10-3). This file is WHEN, and what `GET /vault/status` says:
//
//   * the schedule against a fake clock and counted ops — **each policy
//     schedules as written**: after_commit, every N, manual, pull every N,
//     the old variable's override, and a standing conflict stopping pushes;
//   * the policy file: overlay, hot re-read, the last good policy kept;
//   * the status body against real repositories and a bare remote, through
//     the real committer.
//
// No database: the commit recorder is held to the row shape the console's
// event mapper reads (`kind = vault_sync`, `meta.state`) with a fake.
import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintToken, resolveVaultSync, vaultStatusSchema, type ResolvedVaultSync, type VaultSyncBlock } from "@foldedspacelabs/metistry-core";
import { Committer, type PushResult } from "../src/committer.js";
import { makeBridge } from "../src/server.js";
import { AFTER_COMMIT_RETRY_MS, aheadBehind, commitRecorder, lastLine, readVaultStatus, SyncScheduler, unmergedPaths, VaultPolicySource, type SyncOps, type VaultConflict } from "../src/sync-policy.js";
import { Vault } from "../src/vault.js";
import { tempRepo, type TempRepo } from "./helpers.js";

const MIN = 60_000;
const PUSHED: PushResult = { attempted: true, ok: true, remote: "origin", integrated: "up_to_date", ahead: 0, behind: 0, pushed: true };
const PULLED: PushResult = { attempted: true, ok: true, remote: "origin", integrated: "up_to_date", ahead: 0, behind: 0, pushed: false };

/** A clock, the ops counted, and every recorded commit. */
function harness(block: VaultSyncBlock | undefined, env: Record<string, string> = {}, o: { ahead?: number | null } = {}) {
  let t = 1_000_000;
  let policy: ResolvedVaultSync = resolveVaultSync(block, env);
  const calls = { push: 0, pull: 0 };
  const commits: number[] = [];
  const state: { ahead: number | null; push: PushResult; pull: PushResult; conflict: VaultConflict | null } = { ahead: o.ahead ?? 0, push: PUSHED, pull: PULLED, conflict: null };
  const ops: SyncOps = {
    push: async () => (calls.push++, state.push),
    pull: async () => (calls.pull++, state.pull),
    ahead: async () => state.ahead,
    conflict: () => state.conflict,
  };
  const sched = new SyncScheduler(() => policy, ops, async (n) => void commits.push(n), () => t);
  return {
    sched,
    calls,
    commits,
    state,
    advance: (ms: number) => (t += ms),
    setPolicy: (b: VaultSyncBlock | undefined, e: Record<string, string> = {}) => (policy = resolveVaultSync(b, e)),
  };
}

describe("each policy schedules as written", () => {
  it("push after_commit: a flush that made commits pushes; an empty flush does not; the tick retries only what is unpushed, at most every five minutes", async () => {
    const h = harness({ push: "after_commit", pull: { every: "5m" } });
    await h.sched.afterFlush(0);
    expect(h.calls.push).toBe(0);
    expect(h.commits).toEqual([]);
    await h.sched.afterFlush(2);
    expect(h.calls.push).toBe(1);
    expect(h.commits).toEqual([2]);

    // nothing left to push: the tick never pushes, however long it waits
    h.advance(10 * MIN);
    await h.sched.tick();
    expect(h.calls.push).toBe(1);

    // the push failed and commits are waiting: retried by the tick, not sooner than the retry window
    h.state.ahead = 3;
    h.state.push = { attempted: true, ok: false, remote: "origin", error: "fatal: unable to access" };
    await h.sched.afterFlush(1);
    expect(h.calls.push).toBe(2);
    h.advance(AFTER_COMMIT_RETRY_MS - 1);
    await h.sched.tick();
    expect(h.calls.push).toBe(2);
    h.advance(1);
    await h.sched.tick();
    expect(h.calls.push).toBe(3);
    expect(h.sched.lastPush?.result.ok).toBe(false);
  });

  it("push after_commit: commits left from before a restart go on the first tick", async () => {
    const h = harness({ push: "after_commit" }, {}, { ahead: 4 });
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
  });

  it("push every 15m: never after a flush, on the tick once 15 minutes have passed — and only with something to push", async () => {
    const h = harness({ push: { every: "15m" } }, {}, { ahead: 2 });
    await h.sched.afterFlush(3);
    expect(h.calls.push).toBe(0);
    expect(h.commits).toEqual([3]);
    h.advance(15 * MIN - 1);
    await h.sched.tick();
    expect(h.calls.push).toBe(0);
    h.advance(1);
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
    h.advance(MIN);
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
    // the next window, with nothing unpushed: no push, and the interval restarts
    h.state.ahead = 0;
    h.advance(15 * MIN);
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
    h.state.ahead = 1;
    h.advance(14 * MIN);
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
    h.advance(MIN);
    await h.sched.tick();
    expect(h.calls.push).toBe(2);
  });

  it("push manual: never — not after a commit, not on any tick, whatever is waiting — while pull still runs", async () => {
    const h = harness({ push: "manual" }, {}, { ahead: 9 });
    await h.sched.afterFlush(5);
    for (let i = 0; i < 50; i++) {
      h.advance(30 * MIN);
      await h.sched.tick();
    }
    expect(h.calls.push).toBe(0);
    expect(h.commits).toEqual([5]);
    expect(h.calls.pull).toBe(50);
  });

  it("pull every 5m: on the first tick, then every five minutes", async () => {
    const h = harness({ push: "manual", pull: { every: "5m" } });
    await h.sched.tick();
    expect(h.calls.pull).toBe(1);
    h.advance(5 * MIN - 1);
    await h.sched.tick();
    expect(h.calls.pull).toBe(1);
    h.advance(1);
    await h.sched.tick();
    expect(h.calls.pull).toBe(2);
  });

  it("pull every 1h honours its own interval", async () => {
    const h = harness({ pull: { every: "1h" }, push: "manual" });
    await h.sched.tick();
    h.advance(59 * MIN);
    await h.sched.tick();
    expect(h.calls.pull).toBe(1);
    h.advance(MIN);
    await h.sched.tick();
    expect(h.calls.pull).toBe(2);
  });

  it("a standing conflict stops pushing — after a commit and on every policy's tick — and the pull keeps running to clear it", async () => {
    for (const block of [{ push: "after_commit" }, { push: { every: "15m" } }] as VaultSyncBlock[]) {
      const h = harness(block, {}, { ahead: 3 });
      h.state.conflict = { paths: ["now.md"] };
      await h.sched.afterFlush(1);
      for (let i = 0; i < 6; i++) {
        h.advance(15 * MIN);
        await h.sched.tick();
      }
      expect(h.calls.push, JSON.stringify(block)).toBe(0);
      expect(h.calls.pull).toBe(6);
      // resolved: the next pull integrates cleanly, and pushing resumes
      h.state.conflict = null;
      h.advance(15 * MIN);
      await h.sched.tick();
      expect(h.calls.push).toBe(1);
    }
  });

  it("METISTRY_PUSH_SCHEDULE overrides push for this release: never is manual, @hourly is every hour", async () => {
    const never = harness({ push: "after_commit" }, { METISTRY_PUSH_SCHEDULE: "never" }, { ahead: 3 });
    await never.sched.afterFlush(2);
    never.advance(2 * 60 * MIN);
    await never.sched.tick();
    expect(never.calls.push).toBe(0);

    const hourly = harness({ push: "after_commit" }, { METISTRY_PUSH_SCHEDULE: "@hourly" }, { ahead: 3 });
    await hourly.sched.afterFlush(2);
    expect(hourly.calls.push).toBe(0);
    hourly.advance(60 * MIN);
    await hourly.sched.tick();
    expect(hourly.calls.push).toBe(1);
  });

  it("a policy change takes effect on the next tick", async () => {
    const h = harness({ push: "manual" }, {}, { ahead: 1 });
    await h.sched.tick();
    expect(h.calls.push).toBe(0);
    h.setPolicy({ push: "after_commit" });
    await h.sched.tick();
    expect(h.calls.push).toBe(1);
  });

  it("last push is a push that went out or failed — never a sync that found nothing to send", async () => {
    const h = harness({ push: "after_commit" }, {}, { ahead: 1 });
    h.state.push = { ...PULLED };
    await h.sched.afterFlush(1);
    expect(h.sched.lastPush).toBeNull();
    h.state.push = PUSHED;
    await h.sched.afterFlush(1);
    expect(h.sched.lastPush?.result.pushed).toBe(true);
  });

  it("a recorder that throws never stops the push", async () => {
    let pushes = 0;
    const s = new SyncScheduler(
      () => resolveVaultSync({ push: "after_commit" }),
      { push: async () => (pushes++, PUSHED), pull: async () => PULLED, ahead: async () => 0, conflict: () => null },
      async () => {
        throw new Error("db down");
      },
      () => 0,
    );
    await s.afterFlush(1);
    expect(pushes).toBe(1);
  });
});

describe("the commit row the event mapper reads", () => {
  it("kind vault_sync, meta.state commit, ok", async () => {
    const q: Array<{ text: string; values: unknown[] }> = [];
    const db = {
      query: async (text: string, values: unknown[]) => {
        q.push({ text, values });
        return { rows: [{ id: 7 }] };
      },
    };
    await commitRecorder(db)(3);
    expect(q[0]!.values[0]).toBe("reconciler");
    expect(q[0]!.values[1]).toBe("vault_sync");
    expect(JSON.parse(q[0]!.values[6] as string)).toEqual({ state: "commit", commits: 3 });
    expect(q[1]!.values[1]).toBe(true); // finishRun's ok
  });
});

describe("the policy file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "metistry-vault-policy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("seed then instance, per key; re-read when the file changes; a broken file keeps the last good policy and says why", async () => {
    const seed = join(dir, "seed.yaml");
    const inst = join(dir, "deployment.yaml");
    await writeFile(seed, "shape: compose\nvault:\n  pull:\n    every: 10m\nservices: {}\n");
    const src = new VaultPolicySource([seed, inst], {});
    expect(src.current().policy.push).toBe("after_commit");
    expect(src.current().policy.pull).toEqual({ every: "10m" });
    expect(src.refresh()).toBe(false); // nothing moved

    await writeFile(inst, "shape: launchd\nvault:\n  push: manual\n");
    expect(src.refresh()).toBe(true);
    expect(src.current().policy.push).toBe("manual");
    expect(src.current().policy.pull).toEqual({ every: "10m" });

    await writeFile(inst, "shape: launchd\nvault:\n  push: sometimes\n");
    src.refresh();
    expect(src.current().policy.push).toBe("manual");
    expect(src.current().error).toMatch(/vault\.push/);

    await writeFile(inst, "shape: launchd\nvault:\n  push:\n    every: 30m\n");
    src.refresh();
    expect(src.current().policy.push).toEqual({ every: "30m" });
    expect(src.current().error).toBeUndefined();
  });

  it("the old variable is checked at start: a bad value stops the process there, as it always has", () => {
    expect(() => new VaultPolicySource([], { METISTRY_PUSH_SCHEDULE: "sometimes" })).toThrow(/METISTRY_PUSH_SCHEDULE must be/);
    expect(new VaultPolicySource([], { METISTRY_PUSH_SCHEDULE: "@daily" }).current().policy.push_override).toBe("@daily");
  });
});

// ---- real git ------------------------------------------------------------------

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => exec("git", args, { cwd, env: { ...GIT_ENV, HOME: cwd } });
const commitAs = (cwd: string, msg: string) => sh(cwd, "-c", "user.name=owner", "-c", "user.email=o@test", "commit", "-q", "-am", msg);

describe("GET /vault/status's body, against a real remote and the real committer", () => {
  let repo: TempRepo;
  let remoteDir: string;
  let otherDir: string;
  let committer: Committer;

  beforeEach(async () => {
    repo = await tempRepo();
    remoteDir = await mkdtemp(join(tmpdir(), "metistry-vault-remote-"));
    otherDir = await mkdtemp(join(tmpdir(), "metistry-vault-other-"));
    await sh(remoteDir, "init", "-q", "--bare", "-b", "main");
    committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
  });
  afterEach(async () => {
    await repo.cleanup();
    await rm(remoteDir, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  });

  const status = (extra: Partial<Parameters<typeof readVaultStatus>[0]> = {}) =>
    readVaultStatus({ git: repo.git, policy: () => ({ policy: resolveVaultSync(undefined) }), lastPush: () => committer.lastPush, lastPull: () => committer.lastPull, conflict: () => committer.vault.conflict, ...extra });

  it("no remote: ahead and behind are null, and the body is the schema's", async () => {
    const s = await status();
    expect(vaultStatusSchema.parse(s)).toEqual(s);
    expect(s).toMatchObject({ branch: "main", remote: null, ahead: null, behind: null, last_push: null, last_pull: null, conflict: null });
    expect(s.last_commit).toMatchObject({ subject: "seed", author: "seed" });
    expect(s.policy).toEqual({ push: "after_commit", pull: { every: "5m" } });
  });

  it("a remote that never had the branch: every commit is ahead; after a push, none — and the commit's author is its Brain-Source principal", async () => {
    await sh(repo.root, "remote", "add", "origin", remoteDir);
    expect((await aheadBehind(repo.git)).ahead).toBe(1);

    await writeFile(join(repo.root, "now.md"), "# Now\n\npushed\n");
    committer.enqueue({ paths: ["now.md"], principal: "assistant", message: "now: pushed" });
    await committer.flush();
    expect((await aheadBehind(repo.git)).ahead).toBe(2);
    expect((await committer.push()).pushed).toBe(true);

    const s = await status();
    expect(s).toMatchObject({ remote: "origin", ahead: 0, behind: 0 });
    expect(s.last_commit).toMatchObject({ subject: "now: pushed", author: "assistant" });
    expect(s.last_push).toMatchObject({ ok: true, remote: "origin" });
  });

  it("the owner pushes from another clone: behind counts it once fetched, and a pull brings it in", async () => {
    await sh(repo.root, "remote", "add", "origin", remoteDir);
    await committer.push();
    await exec("git", ["clone", "-q", remoteDir, otherDir], { env: GIT_ENV });
    await writeFile(join(otherDir, "now.md"), "# Now\n\nfrom the laptop\n");
    await commitAs(otherDir, "edit on the laptop");
    await sh(otherDir, "push", "-q", "origin", "main");

    await sh(repo.root, "fetch", "-q", "origin");
    expect(await aheadBehind(repo.git)).toMatchObject({ ahead: 0, behind: 1 });
    const pulled = await committer.pull();
    expect(pulled.ok).toBe(true);
    const s = await status();
    expect(s).toMatchObject({ ahead: 0, behind: 0 });
    expect(s.last_pull).toMatchObject({ ok: true, remote: "origin" });
    expect(s.last_commit?.subject).toBe("edit on the laptop");
  });

  it("the committer's conflict is the status's conflict; unmerged paths the owner left count too", async () => {
    expect((await status({ conflict: () => ({ paths: ["Areas/Beta.md"] }) })).conflict).toEqual({ paths: ["Areas/Beta.md"] });

    await sh(repo.root, "checkout", "-q", "-b", "side");
    await writeFile(join(repo.root, "now.md"), "# Now\n\nside\n");
    await commitAs(repo.root, "side");
    await sh(repo.root, "checkout", "-q", "main");
    await writeFile(join(repo.root, "now.md"), "# Now\n\nmain\n");
    await commitAs(repo.root, "main");
    // an identity, or a CI box with none refuses the merge before it ever conflicts
    await sh(repo.root, "-c", "user.name=owner", "-c", "user.email=o@test", "merge", "-q", "side").catch(() => undefined);
    expect(await unmergedPaths(repo.git)).toEqual({ paths: ["now.md"] });
    expect((await status()).conflict).toEqual({ paths: ["now.md"] });
    await sh(repo.root, "merge", "--abort");
    expect((await status()).conflict).toBeNull();
  });

  it("the policy in force, the override, a file error and a failed pull ride in the body — any URL credential masked", async () => {
    const s = await readVaultStatus({
      git: repo.git,
      policy: () => ({ policy: resolveVaultSync({ push: "manual" }, { METISTRY_PUSH_SCHEDULE: "@daily" }), error: "deployment.yaml: vault.pull: …" }),
      lastPush: () => null,
      lastPull: () => ({ at: Date.parse("2026-09-28T13:00:00Z"), result: { attempted: true, ok: false, remote: "origin", error: "fetch: fatal: unable to access 'https://x-access-token:ghp_abc@github.com/me/v.git/'" } }),
    });
    expect(s.policy).toEqual({ push: { every: "24h" }, pull: { every: "5m" }, push_override: "@daily", error: "deployment.yaml: vault.pull: …" });
    expect(s.last_pull).toEqual({ at: "2026-09-28T13:00:00.000Z", ok: false, remote: "origin", error: "fetch: fatal: unable to access 'https://***@github.com/me/v.git/'" });
    expect(vaultStatusSchema.safeParse(s).success).toBe(true);
    expect(lastLine("a\nb", "")).toBe("b");
  });
});

describe("GET /vault/status on the bridge", () => {
  it("needs a bearer; either class may read it; not_available when this process has no schedule", async () => {
    const repo = await tempRepo();
    try {
      const token = mintToken();
      const ownerToken = mintToken();
      const committer = new Committer(repo.git, { authorPrefix: "Metistry", authorEmail: "metistry@test", sourceTrailer: "Brain-Source" });
      const vault = new Vault(repo.root, repo.git, committer, { maxBytes: 4096 });
      const vaultStatus = () => readVaultStatus({ git: repo.git, policy: () => ({ policy: resolveVaultSync(undefined) }), lastPush: () => null, lastPull: () => null });
      for (const [deps, want] of [
        [{ vault, committer, vaultStatus }, 200],
        [{ vault, committer }, 503],
      ] as const) {
        const server = makeBridge(deps, { token, ownerToken, maxBodyBytes: 4096 });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
          expect((await fetch(`${base}/vault/status`)).status).toBe(401);
          for (const bearer of [token, ownerToken]) {
            const r = await fetch(`${base}/vault/status`, { headers: { authorization: `Bearer ${bearer}` } });
            expect(r.status).toBe(want);
            const body = await r.json();
            if (want === 200) expect(vaultStatusSchema.parse(body).branch).toBe("main");
            else expect(body.error.code).toBe("not_available");
          }
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
      }
    } finally {
      await repo.cleanup();
    }
  });
});
