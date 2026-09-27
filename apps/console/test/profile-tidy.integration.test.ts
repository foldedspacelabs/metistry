// The standup move and *Tidy Me/profile.md* (design-build-plan §2.5, §4 Q13;
// ticket T3-4). The ticket's own tests, in bold there:
//
//   * **nothing edits `Me/profile.md` before Approve** — the move writes the
//     overlay and raises a request; only the owner's Approve writes Me/, as
//     `user`, and a file that changed since is refused `stale`;
//   * **the proposal is raised once** — a second pass, a pass after Decline,
//     a pass after Approve: never a second row;
//   * a profile with no working days → the routine is absent, not guessed
//     (packages/core/test/profile-facts.test.ts, beside the readers).
//
// And the door's misuse tests (U2): Approve is `POST /api/proposals/:id`,
// whose reach is `owner` — 401 with no credential, 403 for an agent bearer
// and for the capture owner token, and the local owner token reaches it.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken, withoutProfileKeys } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { VaultError, type VaultClient, type VaultIntent } from "@foldedspacelabs/metistry-artifacts";
import { makeServer } from "../src/server.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";
import { SCHEDULED_PATH, TIDY_SOURCE, applyMeEdit, meEditOf, moveStandupFacts, tidyPayload, type TidyDeps } from "../src/profile-tidy.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const PROFILE_PATH = "Me/profile.md";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

const PROFILE = `---
source: user
timezone: America/New_York
working_days: [mon, tue, wed, thu, fri]
standup_days: [mon, tue, wed, thu, fri]
standup_time: "09:15"
today_cap: 3
---
# Working profile
`;
const TIDIED = withoutProfileKeys(PROFILE, ["standup_days", "standup_time"])!;

/** An in-memory vault that records every write, and can refuse one path the way the reconciler does. */
function fakeVault(seed: Record<string, string>, refuse: Record<string, "forbidden"> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const writes: { path: string; content: string; intent: VaultIntent; expected?: string | undefined }[] = [];
  const client = {
    async read(path: string) {
      const content = files.get(path);
      if (content === undefined) return null;
      return { path, content: Buffer.from(content, "utf8"), sha256: sha(content), bytes: content.length };
    },
    async write(path: string, content: Buffer, intent: VaultIntent, expectedSha256?: string) {
      if (refuse[path]) throw new VaultError(refuse[path]);
      const text = content.toString("utf8");
      const existing = files.get(path);
      if (expectedSha256 !== undefined && expectedSha256 !== (existing === undefined ? "" : sha(existing))) throw new VaultError("conflict");
      writes.push({ path, content: text, intent, expected: expectedSha256 });
      files.set(path, text);
      return { path, sha256: sha(text), bytes: text.length, created: existing === undefined };
    },
  } as unknown as VaultClient;
  return { client, files, writes };
}

describe("the Me/ edit a request carries", () => {
  const payload = tidyPayload({ text: PROFILE, sha256: sha(PROFILE) }, TIDIED, ["standup_days", "standup_time"]);

  it("is exactly the before and after the owner is shown", () => {
    expect(payload).toMatchObject({ title: "Tidy Me/profile.md", body: { kind: "before_after", before: { text: PROFILE }, after: { text: TIDIED } } });
    expect(meEditOf(payload)).toEqual({ path: PROFILE_PATH, base_sha256: sha(PROFILE), before: PROFILE, after: TIDIED });
  });

  it("is refused anywhere but Me/, and without a before, an after or a base", () => {
    const at = (path: string) => ({ ...payload, edit: { path, base_sha256: sha(PROFILE) } });
    for (const path of [".metistry/rules.yaml", "Areas/x.md", "Me/../CLAUDE.md", "Me", "Me/", "Me/profile.yaml", "Journal/2026-09-26.md", "me/profile.md"]) {
      expect(meEditOf(at(path)), path).toBeNull();
    }
    expect(meEditOf({ ...payload, edit: { path: PROFILE_PATH, base_sha256: "abc" } })).toBeNull();
    expect(meEditOf({ ...payload, body: { kind: "preview", before: { text: PROFILE }, after: { text: TIDIED } } })).toBeNull();
    expect(meEditOf({ edit: (payload as { edit: unknown }).edit })).toBeNull();
    expect(meEditOf({ suggested_edit: { content: "x" } })).toBeNull(); // the prompt overlay's improvement is not this
    expect(meEditOf(null)).toBeNull();
  });

  it("Approve writes the after as `user`, compare-and-swap on the before", async () => {
    const v = fakeVault({ [PROFILE_PATH]: PROFILE });
    await applyMeEdit(v.client, meEditOf(payload)!, 7);
    expect(v.writes).toEqual([{ path: PROFILE_PATH, content: TIDIED, intent: { principal: "user", message: "Me/profile.md: approved request #7" }, expected: sha(PROFILE) }]);
  });

  it("a file that changed since is refused, and nothing is written", async () => {
    const v = fakeVault({ [PROFILE_PATH]: PROFILE.replace("today_cap: 3", "today_cap: 4") });
    await expect(applyMeEdit(v.client, meEditOf(payload)!, 7)).rejects.toMatchObject({ code: "conflict" });
    const gone = fakeVault({});
    await expect(applyMeEdit(gone.client, meEditOf(payload)!, 7)).rejects.toMatchObject({ code: "conflict" });
    expect([...v.writes, ...gone.writes]).toEqual([]);
  });
});

describe.skipIf(!hasDb)("the standup move and Tidy Me/profile.md (integration)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof makeServer>;
  let base: string;
  let cookie: string;
  let captureToken: string;
  let agentToken: string;
  let vault: ReturnType<typeof fakeVault>;
  let overlay: string | null;
  let inboxDir: string;
  const localOwnerToken = mintToken();
  const MARK = `itest-tidy-${mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
  const agentId = MARK.slice(0, 40);
  let passkeyId: string;

  const deps = (): TidyDeps => ({ vault: vault.client, db: pool, readOverlay: async () => (overlay === null ? null : Buffer.from(overlay, "utf8")) });
  const tidyRows = async () =>
    (await pool.query(`SELECT id, kind, source_agent, trust, decision, payload FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2 ORDER BY id`, [TIDY_SOURCE.kind, TIDY_SOURCE.external_ref])).rows;
  const answer = (id: number, decision: string, headers: Record<string, string> = { cookie }) =>
    fetch(`${base}/api/proposals/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }) });

  beforeAll(async () => {
    vault = fakeVault({ [PROFILE_PATH]: PROFILE });
    pool = await testDb(pg.Pool);
    inboxDir = await mkdtemp(join(tmpdir(), "metistry-tidy-"));
    server = makeServer(pool, new QueryStore(pool), {
      origin: "http://127.0.0.1:0",
      inboxDir,
      policy,
      secureCookies: false,
      localOwner: { token: localOwnerToken, trusted: [] },
      // the SAME fake the move writes through: each test's fresh one is the one Approve sees
      vault: {
        read: (path: string) => vault.client.read(path),
        write: (...a: Parameters<VaultClient["write"]>) => vault.client.write(...a),
      } as unknown as VaultClient,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    passkeyId = `${MARK}-pk`;
    await store.storePasskey(pool, { id: passkeyId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    cookie = `metistry_session=${await store.issueSession(pool, passkeyId, policy)}`;
    captureToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest tidy" })).token;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2`, [TIDY_SOURCE.kind, TIDY_SOURCE.external_ref]);
    vault = fakeVault({ [PROFILE_PATH]: PROFILE });
    overlay = null;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE source->>'kind' = $1 AND source->>'external_ref' = $2`, [TIDY_SOURCE.kind, TIDY_SOURCE.external_ref]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = $1`, [passkeyId]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = $1`, [passkeyId]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
    await rm(inboxDir, { recursive: true, force: true });
  });

  it("**nothing edits Me/profile.md before Approve**: the move writes the overlay, as `user`, then raises one request", async () => {
    const out = await moveStandupFacts(deps());
    expect(out).toMatchObject({ state: "raised", moved: true, done: true });
    // the ONLY write is the overlay — Me/profile.md is byte for byte what it was
    expect(vault.writes.map((w) => w.path)).toEqual([SCHEDULED_PATH]);
    expect(vault.writes[0]!.intent.principal).toBe("user");
    expect(vault.writes[0]!.expected).toBe(""); // there was no file: create, never overwrite
    expect(vault.writes[0]!.content).toContain(`standup:\n    schedule: { days: working_days, at: [ "09:15" ] }`);
    expect(vault.files.get(PROFILE_PATH)).toBe(PROFILE);

    const rows = await tidyRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(out.proposal);
    expect(rows[0]).toMatchObject({ kind: "improvement", source_agent: "console", trust: "internal", decision: "pending" });
    expect(rows[0].payload).toMatchObject({ title: "Tidy Me/profile.md", body: { kind: "before_after", before: { text: PROFILE }, after: { text: TIDIED } }, edit: { path: PROFILE_PATH, base_sha256: sha(PROFILE) } });
  });

  it("**the proposal is raised once** — a second pass, and a pass after Decline, raise nothing", async () => {
    const first = await moveStandupFacts(deps());
    overlay = vault.files.get(SCHEDULED_PATH)!; // the next pass reads what the first wrote
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "already_raised", done: true });
    expect(await tidyRows()).toHaveLength(1);

    const declined = await answer(first.proposal!, "deny");
    expect(declined.status).toBe(200);
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "already_raised" });
    const rows = await tidyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("deny");
    // Decline leaves the lines, and writes nothing
    expect(vault.files.get(PROFILE_PATH)).toBe(PROFILE);
    expect(vault.writes.map((w) => w.path)).toEqual([SCHEDULED_PATH]);
  });

  it("Approve writes the tidied profile as `user`, and the move then has nothing left to do", async () => {
    const { proposal } = await moveStandupFacts(deps());
    const r = await answer(proposal!, "allow");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, applied: { path: PROFILE_PATH } });
    expect(vault.files.get(PROFILE_PATH)).toBe(TIDIED);
    const write = vault.writes.at(-1)!;
    expect(write).toMatchObject({ path: PROFILE_PATH, intent: { principal: "user" }, expected: sha(PROFILE) });
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "none", done: true });
    expect(await tidyRows()).toHaveLength(1);
  });

  it("Approve after the file changed is refused `stale` — nothing written, the request still waiting", async () => {
    const { proposal } = await moveStandupFacts(deps());
    const edited = PROFILE.replace("today_cap: 3", "today_cap: 5");
    vault.files.set(PROFILE_PATH, edited); // the owner edited it in Obsidian meanwhile
    const before = vault.writes.length;
    const r = await answer(proposal!, "allow");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "conflict" }, reason: "stale", decision: "pending" });
    expect(vault.files.get(PROFILE_PATH)).toBe(edited);
    expect(vault.writes.length).toBe(before);
    expect((await tidyRows())[0].decision).toBe("pending");
  });

  it("Revise records the owner's words and writes nothing", async () => {
    const { proposal } = await moveStandupFacts(deps());
    const before = vault.writes.length;
    expect((await answer(proposal!, "accept_with_changes")).status).toBe(200);
    expect(vault.writes.length).toBe(before);
    expect(vault.files.get(PROFILE_PATH)).toBe(PROFILE);
  });

  it("lines the owner deletes by hand clear a waiting request at its source", async () => {
    await moveStandupFacts(deps());
    vault.files.set(PROFILE_PATH, TIDIED);
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "resolved" });
    expect((await tidyRows())[0].decision).toBe("resolved_at_source");
  });

  it("an overlay write the reconciler refuses moves nothing and proposes nothing (console authority is T3-2's)", async () => {
    vault = fakeVault({ [PROFILE_PATH]: PROFILE }, { [SCHEDULED_PATH]: "forbidden" });
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "forbidden", done: true });
    expect(vault.writes).toEqual([]);
    expect(await tidyRows()).toHaveLength(0);
  });

  it("an invalid overlay is never rewritten, and nothing is proposed until it is fixed", async () => {
    overlay = "routines:\n  standup: { every: 10m }\n";
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "overlay_invalid", done: false });
    expect(vault.writes).toEqual([]);
    expect(await tidyRows()).toHaveLength(0);
  });

  it("a standup schedule the owner already set wins: the overlay is left alone, and the tidy is still offered", async () => {
    overlay = `# mine\nroutines:\n  standup:\n    schedule: { days: [sat], at: ["10:00"] }\n`;
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "raised", moved: false });
    expect(vault.writes).toEqual([]);
    expect(await tidyRows()).toHaveLength(1);
  });

  it("an existing overlay is written compare-and-swap, keeping the owner's comments", async () => {
    overlay = "# my changes\nroutines:\n  plan-tomorrow: { paused: true }\n";
    vault.files.set(SCHEDULED_PATH, overlay); // the reconciler's view of the same file
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "raised", moved: true });
    expect(vault.writes[0]!.expected).toBe(sha(overlay));
    expect(vault.writes[0]!.content).toContain("# my changes");
  });

  it("an unreadable key, no profile, no instance directory: nothing moves, nothing is raised", async () => {
    vault = fakeVault({ [PROFILE_PATH]: "---\nstandup_time: after coffee\n---\n" });
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "unreadable", done: true });
    vault = fakeVault({});
    expect(await moveStandupFacts(deps())).toMatchObject({ state: "no_profile", done: true });
    vault = fakeVault({ [PROFILE_PATH]: PROFILE });
    expect(await moveStandupFacts({ ...deps(), readOverlay: async () => undefined })).toMatchObject({ state: "overlay_unseen", done: true });
    expect(vault.writes).toEqual([]);
    expect(await tidyRows()).toHaveLength(0);
  });

  it("misuse (U2): Approve is the owner's — 401 bare, 403 for an agent bearer and the capture token, the local owner token reaches it", async () => {
    const { proposal } = await moveStandupFacts(deps());
    expect((await answer(proposal!, "allow", {})).status).toBe(401);
    expect((await answer(proposal!, "allow", { authorization: `Bearer ${agentToken}` })).status).toBe(403);
    expect((await answer(proposal!, "allow", { authorization: `Bearer ${captureToken}` })).status).toBe(403);
    expect(vault.files.get(PROFILE_PATH)).toBe(PROFILE); // none of them wrote a byte
    const local = await answer(proposal!, "allow", { authorization: `Bearer ${localOwnerToken}` });
    expect(local.status).toBe(200);
    expect(vault.files.get(PROFILE_PATH)).toBe(TIDIED);
  });
});
