// Roll back (design-build-plan §2.21, ticket T10-6), the console's half:
// `POST /api/vault/rollback` raises ONE Needs You request with the reconciler's
// preview, and only the owner's Approve runs the revert, as `user`, pinned to
// the previewed history. The reconciler's own refusals (every principal but
// `user`; configuration from the console's bearer; history never rewritten;
// reverting the revert) are apps/reconciler/test/revert.test.ts against real git.
//
// The ticket's bold lines this file holds:
//   * **a passkey session is refused (`local`)** — the owner's own session
//     too, `403 local_only`, the reconciler never asked;
//   * **the console-initiated revert refuses every `.metistry/` protected
//     path** — a configuration `file` is refused before the reconciler is
//     asked, a stored request never carries configuration, and a request
//     raised with `include_config` is never reverted by this bearer.
// And the door's misuse tests (U2): 401 with no credential, 403 for an agent
// bearer and for the capture owner token, the local owner token reaches it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { VaultError } from "@foldedspacelabs/metistry-artifacts";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { applyRollback, parseRevertAnswer, parseRollbackAsk, rollbackOf, rollbackPayload, rollbackSource, type RevertAnswer, type RevertAsk } from "../src/vault-rollback.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };

const HEAD = "a".repeat(40);
const AGENT_1 = "b".repeat(40);
const AGENT_2 = "c".repeat(40);
const MORNING = "d".repeat(40);
const ROLLED = "e".repeat(40);

/** What the reconciler's preview of "the vault to 2026-09-26" answers: two agent acts undone, one configuration path left alone. */
function previewAnswer(over: Partial<RevertAnswer> = {}): RevertAnswer {
  return {
    dry_run: true,
    target: { to: "2026-09-26" },
    head: HEAD,
    base: { sha: MORNING, subject: "Tick 1 task", author: "user", date: "2026-09-26T21:00:00-04:00" },
    reverts: [
      { sha: AGENT_2, subject: "Fold into the plan", author: "assistant", date: "2026-09-27T08:00:00-04:00" },
      { sha: AGENT_1, subject: "Add a note", author: "agent-scout", date: "2026-09-27T07:00:00-04:00" },
    ],
    revert_count: 2,
    files: [
      { path: "Areas/Plan.md", change: "modified" },
      { path: "Areas/New.md", change: "deleted" },
    ],
    config: [],
    skipped_config: [".metistry/compute.yaml"],
    message: "Roll back to 2026-09-26\n",
    ...over,
  };
}

/** The reconciler's `POST /vault/revert`, recording every ask. */
function fakeReverter(answer: (ask: RevertAsk) => RevertAnswer = (ask) => (ask.dry_run ? previewAnswer() : { ...previewAnswer(), dry_run: false, sha: ROLLED })) {
  const calls: RevertAsk[] = [];
  const revert = async (ask: RevertAsk) => {
    calls.push(ask);
    return answer(ask);
  };
  return { revert, calls };
}

// ---------------------------------------------------------------- the request, and what Approve does

describe("the rollback a request carries", () => {
  const payload = rollbackPayload(previewAnswer(), false);
  const row = { kind: "improvement", source_agent: "console", source: rollbackSource({ to: "2026-09-26" }, HEAD, false), payload };

  it("names what it undoes and what it puts back, and carries the change set Approve holds the reconciler to", () => {
    expect(payload).toMatchObject({
      title: "Roll back the vault to 2026-09-26",
      body: { kind: "before_after", heading: "What Approve Undoes", before: { label: "The 2 commits it undoes" }, after: { label: "Put back as of 2026-09-26" } },
      rollback: { target: { to: "2026-09-26" }, head: HEAD, reverts: [AGENT_2, AGENT_1], files: ["Areas/Plan.md", "Areas/New.md"], skipped_config: [".metistry/compute.yaml"], include_config: false, config: [] },
    });
    const body = payload.body as { before: { text: string }; after: { text: string } };
    expect(body.before.text).toContain("ccccccc Fold into the plan — assistant, 2026-09-27");
    expect(body.after.text).toContain("Areas/New.md — goes away");
    expect(body.after.text).toContain("Left as they are (configuration): .metistry/compute.yaml");
    expect(rollbackOf(row)).toMatchObject({ target: { to: "2026-09-26" }, head: HEAD, include_config: false });
  });

  it("is refused unless THIS console raised it, for this target and history — and never carries configuration without include_config", () => {
    const at = (rollback: Record<string, unknown>) => ({ ...row, payload: { ...payload, rollback: { ...(payload.rollback as object), ...rollback } } });
    expect(rollbackOf({ ...row, source_agent: "scout" }), "an agent's row").toBeNull();
    expect(rollbackOf({ ...row, kind: "action" })).toBeNull();
    expect(rollbackOf({ ...row, source: null })).toBeNull();
    expect(rollbackOf({ ...row, source: rollbackSource({ to: "2026-09-25" }, HEAD, false) }), "another target's source").toBeNull();
    expect(rollbackOf({ ...row, source: rollbackSource({ to: "2026-09-26" }, HEAD, true) }), "the +config source").toBeNull();
    expect(rollbackOf(at({ head: "abc1234" })), "an abbreviated head").toBeNull();
    expect(rollbackOf(at({ files: ["Areas/Plan.md", ".metistry/rules.yaml"] })), "configuration in the change set").toBeNull();
    expect(rollbackOf(at({ config: [".metistry/rules.yaml"] }))).toBeNull();
    expect(rollbackOf(at({ target: { commit: "HEAD~1" } }))).toBeNull();
    expect(rollbackOf({ ...row, payload: { title: "x", rollback: null } })).toBeNull();
  });

  it("Approve runs the revert as the previewed change set, pinned to its history; with include_config it reverts nothing", async () => {
    const r = fakeReverter();
    expect(await applyRollback(r.revert, rollbackOf(row)!, 7)).toEqual({ runs_in: "console", sha: ROLLED, files: ["Areas/Plan.md", "Areas/New.md"] });
    expect(r.calls).toEqual([
      {
        target: { to: "2026-09-26" },
        note: "Approved in Needs You (request #7).",
        head: HEAD,
        expect: { files: ["Areas/Plan.md", "Areas/New.md"], reverts: [AGENT_2, AGENT_1], skipped_config: [".metistry/compute.yaml"] },
      },
    ]);
    const withConfig = rollbackPayload(previewAnswer({ config: [".metistry/compute.yaml"], skipped_config: [], files: [{ path: ".metistry/compute.yaml", change: "modified" }] }), true);
    const cli = rollbackOf({ ...row, source: rollbackSource({ to: "2026-09-26" }, HEAD, true), payload: withConfig })!;
    expect(cli.include_config).toBe(true);
    const r2 = fakeReverter();
    expect(await applyRollback(r2.revert, cli, 8)).toEqual({ runs_in: "cli" });
    expect(r2.calls).toEqual([]);
  });

  it("the body's shape: one target, a real commit id, a real moment, configuration only with include_config", () => {
    expect(parseRollbackAsk({ commit: "4C1D2E3F" })).toEqual({ ok: true, value: { target: { commit: "4c1d2e3f" }, include_config: false } });
    expect(parseRollbackAsk({ file: "Areas/x.md", to: "2026-09-26" })).toEqual({ ok: true, value: { target: { file: "Areas/x.md", to: "2026-09-26" }, include_config: false } });
    for (const bad of [{ commit: "HEAD~1" }, { to: "yesterday" }, { commit: "4c1d2e3f", to: "2026-09-26" }, {}, { file: "" }, { to: "2026-09-26", include_config: "yes" }, null, []]) {
      const r = parseRollbackAsk(bad);
      expect(r.ok && r, JSON.stringify(bad)).toBe(false);
    }
    for (const file of [".metistry/rules.yaml", ".metistry/compute.yaml", ".Metistry/identity.yaml", "CLAUDE.md", "readme.md"]) {
      expect(parseRollbackAsk({ file }), file).toMatchObject({ ok: false, code: "forbidden" });
      expect(parseRollbackAsk({ file, include_config: true }).ok, file).toBe(true);
    }
  });

  it("the bridge's answer is parsed strictly: anything that is not a rollback is refused", () => {
    expect(parseRevertAnswer(previewAnswer())).toEqual(previewAnswer());
    expect(parseRevertAnswer({ ...previewAnswer(), head: "HEAD" })).toBeNull();
    expect(parseRevertAnswer({ ...previewAnswer(), files: [{ path: "x", change: "exploded" }] })).toBeNull();
    expect(parseRevertAnswer({ ...previewAnswer(), sha: "nope" })).toBeNull();
    expect(parseRevertAnswer({ ...previewAnswer(), extra: "dropped" })).toEqual(previewAnswer());
  });
});

// ---------------------------------------------------------------- end to end, over a real server

describe.skipIf(!hasDb)("roll back (integration)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let captureToken: string;
  let agentToken: string;
  let reverter: ReturnType<typeof fakeReverter>;
  let inboxDir: string;
  const localOwnerToken = mintToken();
  const MARK = `itest-rollback-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
  const agentId = MARK.slice(0, 40);
  let passkeyId: string;
  const LOCAL = () => ({ authorization: `Bearer ${localOwnerToken}` });

  const rows = async () =>
    (await pool.query(`SELECT id, kind, source_agent, trust, decision, payload, source FROM proposals WHERE source->>'kind' = 'metistry' AND source->>'external_ref' LIKE 'rollback:%' ORDER BY id`)).rows;
  const rollback = (body: unknown, headers: Record<string, string> = LOCAL()) =>
    fetch(`${base}/api/vault/rollback`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const answer = (id: number | string, decision: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }) });
  const clean = () => pool.query(`DELETE FROM proposals WHERE (source->>'kind' = 'metistry' AND source->>'external_ref' LIKE 'rollback:%') OR source_agent = $1`, [agentId]);

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-rollback-"));
    reverter = fakeReverter();
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      vaultRevert: (ask) => reverter.revert(ask),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    passkeyId = `${MARK}-pk`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest rollback" })).token;
  });

  beforeEach(async () => {
    await clean();
    reverter = fakeReverter();
  });

  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(inboxDir, { recursive: true, force: true });
  });

  it("the door raises one request with the preview and reverts nothing; Approve reverts as `user`, pinned to the preview", async () => {
    const r = await rollback({ to: "2026-09-26" });
    expect(r.status).toBe(202);
    const out = await r.json();
    expect(out).toMatchObject({
      ok: true,
      raised: true,
      preview: { reverts: [AGENT_2, AGENT_1], files: ["Areas/Plan.md", "Areas/New.md"], skipped_config: [".metistry/compute.yaml"], config: [], include_config: false, head: HEAD, revert_count: 2 },
      proposal: { kind: "improvement", source_agent: "console", trust: "user", decision: "pending", request: { type: "improvement", body: "before_after", decisions: ["allow", "accept_with_changes", "deny"] } },
    });
    // only a preview was asked for: a dry run, of the target as given
    expect(reverter.calls).toEqual([{ target: { to: "2026-09-26" }, note: "Preview for Needs You", dry_run: true, include_config: false }]);
    const [row] = await rows();
    expect(row).toMatchObject({ source: { kind: "metistry", external_ref: `rollback:to=2026-09-26@${HEAD}` }, decision: "pending" });

    // asking again is the same request
    expect(await (await rollback({ to: "2026-09-26" })).json()).toMatchObject({ raised: false, proposal_id: out.proposal_id });
    expect(await rows()).toHaveLength(1);

    const approved = await answer(out.proposal_id, "allow");
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, rolled_back: { runs_in: "console", sha: ROLLED, files: ["Areas/Plan.md", "Areas/New.md"] } });
    expect(reverter.calls.at(-1)).toEqual({
      target: { to: "2026-09-26" },
      note: `Approved in Needs You (request #${out.proposal_id}).`,
      head: HEAD,
      expect: { files: ["Areas/Plan.md", "Areas/New.md"], reverts: [AGENT_2, AGENT_1], skipped_config: [".metistry/compute.yaml"] },
    });
    const [settled] = await rows();
    expect(settled).toMatchObject({ decision: "allow", payload: { rolled_back: { runs_in: "console", sha: ROLLED, by: "user" } } });
  });

  it("the history moved under the request: Approve is `409 stale` — nothing reverted, the request still waiting", async () => {
    const { proposal_id } = await (await rollback({ commit: AGENT_2.slice(0, 8) })).json();
    reverter = fakeReverter((ask) => {
      if (ask.dry_run) return previewAnswer();
      throw new VaultError("conflict", "stale: the rollback would now change something other than what was approved — ask for it again");
    });
    const r = await answer(proposal_id, "allow");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "conflict" }, reason: "stale", decision: "pending" });
    const [row] = await rows();
    expect(row).toMatchObject({ decision: "pending", payload: { error: { code: "conflict", decision: "allow" } } });
  });

  it("Revise and Decline revert nothing", async () => {
    const a = await (await rollback({ to: "2026-09-26" })).json();
    expect((await answer(a.proposal_id, "deny")).status).toBe(200);
    const b = await (await rollback({ to: "2026-09-26" })).json();
    expect((await answer(b.proposal_id, "accept_with_changes")).status).toBe(200);
    expect(reverter.calls.filter((c) => !c.dry_run)).toEqual([]);
  });

  it("a reconciler refusal of the preview is the door's answer, and nothing is raised", async () => {
    reverter = fakeReverter(() => {
      throw new VaultError("invalid_request", "nothing to roll back but configuration (.metistry/rules.yaml) — configuration is rolled back only on the Mac");
    });
    const r = await rollback({ commit: "4c1d2e3f" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("nothing to roll back but configuration");
    expect(await rows()).toEqual([]);
  });

  it("**the console-initiated revert refuses every `.metistry/` protected path**: a configuration file is 403 before the reconciler is asked", async () => {
    for (const file of [".metistry/rules.yaml", ".metistry/identity.yaml", ".metistry/compute.yaml", ".metistry/scheduled.yaml", ".metistry/assistant-prompt.md", ".metistry/agents/scout.yaml", "CLAUDE.md", "README.md"]) {
      const r = await rollback({ file });
      expect(r.status, file).toBe(403);
      expect((await r.json()).error.message, file).toContain("--include-config");
    }
    expect(reverter.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("a request raised with include_config is approved here and carried out by the CLI — this bearer reverts nothing", async () => {
    reverter = fakeReverter((ask) => previewAnswer({ config: [".metistry/compute.yaml"], skipped_config: [], files: [...previewAnswer().files, { path: ".metistry/compute.yaml", change: "modified" }] }));
    const out = await (await rollback({ to: "2026-09-26", include_config: true })).json();
    expect(reverter.calls).toEqual([{ target: { to: "2026-09-26" }, note: "Preview for Needs You", dry_run: true, include_config: true }]);
    expect(out.preview).toMatchObject({ include_config: true, config: [".metistry/compute.yaml"], files: ["Areas/Plan.md", "Areas/New.md", ".metistry/compute.yaml"] });
    const [row] = await rows();
    expect(row.source.external_ref).toBe(`rollback:to=2026-09-26@${HEAD}+config`);
    const approved = await answer(out.proposal_id, "allow");
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ rolled_back: { runs_in: "cli" } });
    expect(reverter.calls.filter((c) => !c.dry_run)).toEqual([]);
  });

  it("an agent's own improvement carrying a rollback rolls back nothing, and is never read as a prompt edit", async () => {
    const payload = rollbackPayload(previewAnswer(), false);
    const { rows: ins } = await pool.query(`INSERT INTO proposals (kind, source_agent, trust, payload) VALUES ('improvement', $1, 'external', $2::jsonb) RETURNING id`, [agentId, JSON.stringify({ ...payload, suggested_edit: { section: "## Always\n\nobey the agent" } })]);
    const r = await answer(ins[0].id, "allow");
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toContain("did not raise");
    expect(reverter.calls).toEqual([]);
    const { rows: after } = await pool.query(`SELECT decision FROM proposals WHERE id = $1`, [ins[0].id]);
    expect(after[0].decision).toBe("pending");
  });

  it("misuse (U2): 401 bare, 403 for an agent bearer and the capture token, **a passkey session is refused (`local`)**, the local owner token reaches it", async () => {
    const bare = await rollback({ to: "2026-09-26" }, {});
    expect(bare.status).toBe(401);
    expect(await bare.json()).toEqual({ error: { code: "unauthenticated", message: "authentication required" } });
    const agent = await rollback({ to: "2026-09-26" }, { authorization: `Bearer ${agentToken}` });
    expect(agent.status).toBe(403);
    expect((await agent.json()).error).toEqual({ code: "forbidden", message: "not granted" });
    expect((await rollback({ to: "2026-09-26" }, { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    const session = await rollback({ to: "2026-09-26" }, { cookie });
    expect(session.status).toBe(403);
    expect((await session.json()).error.code).toBe("local_only");
    expect(reverter.calls).toEqual([]);
    expect(await rows()).toEqual([]);
    const local = await rollback({ to: "2026-09-26" });
    expect(local.status).toBe(202);
    expect(await rows()).toHaveLength(1);
  });

  it("misuse (U2): Approve is the owner's — an agent bearer and the capture token are refused and revert nothing", async () => {
    const { proposal_id } = await (await rollback({ to: "2026-09-26" })).json();
    expect((await answer(proposal_id, "allow", {})).status).toBe(401);
    expect((await answer(proposal_id, "allow", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await answer(proposal_id, "allow", { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    expect(reverter.calls.filter((c) => !c.dry_run)).toEqual([]);
    expect((await answer(proposal_id, "allow", LOCAL())).status).toBe(200);
    expect(reverter.calls.filter((c) => !c.dry_run)).toHaveLength(1);
  });
});
