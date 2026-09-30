// Draft Reply — `POST /api/mail/messages/:id/draft` (design-build-plan §2.6,
// §2.11, §2.12; T4-17), over real sockets against the scratch database. The
// mailbox is a local IMAP fixture server (packages/connections/test/
// imap-server.ts — 127.0.0.1, an ephemeral port, never a real mail service)
// behind a scratch instance's connection, opened by the console's own opener
// (`instanceImapOpener`), the app password filled into LOGIN by the host
// guard.
//
// What it proves: U2's four; **nothing sends** — a reply lands in \Drafts
// and nowhere else, addressed from the message's own headers, never from the
// caller; preview-then-confirm with a single-use token bound to the draft
// the preview rendered; and the message's request clears once it is drafted.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { QueryStore } from "@foldedspacelabs/metistry-queries";
import { mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { instanceImapOpener } from "@foldedspacelabs/metistry-connections";
import { fakeImap, fixtureMailboxes, type FixtureImap, type FixtureMailbox } from "../../../packages/connections/test/imap-server.js";
import { run as mailSync } from "../../../collectors/mail-messages/run.js";
import { makeServer } from "../src/server.js";
import { isMailDraftRoute } from "../src/mail-draft-route.js";
import * as store from "../src/auth-store.js";
import * as agents from "../src/agents.js";

const { hasDb } = loadTestEnv(new URL("../../../.env", import.meta.url));
const policy = { idleDays: 30, maxDays: 365 };
const MARK = "itest-draft";
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const SEED = fileURLToPath(new URL("../../../seed", import.meta.url));
const USER = "me@example.com";
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join(""); // an app password's shape, built at run time
const CONN = `itest-draft-${suffix}`;
const NOW = Date.parse("2026-09-30T12:00:00Z");
const ADA = `${CONN}/INBOX/1700/12`;
const JOSE = `${CONN}/INBOX/1700/13`;

describe("the route (pure)", () => {
  it("matches the draft door and nothing near it", () => {
    expect(isMailDraftRoute(`POST /api/mail/messages/${encodeURIComponent(ADA)}/draft`)).toBe(true);
    for (const k of ["GET /api/mail/messages/x/draft", "POST /api/mail/messages/x/send", "POST /api/mail/messages/x", "POST /api/mail/messages/a/b/draft", "POST /api/mail/drafts"]) expect(isMailDraftRoute(k), k).toBe(false);
  });
});

describe.skipIf(!hasDb)("Draft Reply: POST /api/mail/messages/:id/draft", () => {
  let pool: pg.Pool;
  let imap: FixtureImap;
  let boxes: FixtureMailbox[];
  let server: ReturnType<typeof makeServer>;
  let bareServer: ReturnType<typeof makeServer>;
  let base: string;
  let bare: string;
  let sessionCookie: string;
  let ownerToken: string;
  let agentToken: string;
  const dirs: string[] = [];
  const localOwnerToken = mintToken();
  const agentId = `itest-draft-${suffix}`;
  const passkeyIds: string[] = [];
  const local = { authorization: `Bearer ${localOwnerToken}` };

  async function post(ref: string, body: unknown, headers: Record<string, string> = local, at = base) {
    const r = await fetch(`${at}/api/mail/messages/${encodeURIComponent(ref)}/draft`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: JSON.parse(await r.text()) as Record<string, any> };
  }
  const drafts = () => boxes.find((b) => b.name === "[Gmail]/Drafts")!.messages;
  const appends = () => imap.commands.filter((l) => / APPEND /.test(l));

  beforeAll(async () => {
    pool = await testDb(pg.Pool);
    const queries = new QueryStore(pool);
    await queries.loadDir(fileURLToPath(new URL("../../../seed/queries", import.meta.url)));
    boxes = fixtureMailboxes();
    imap = await fakeImap({ username: USER, password: PASSWORD, mailboxes: boxes });
    const dir = mkdtempSync(join(tmpdir(), "metistry-draft-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
    writeFileSync(
      join(dir, ".metistry", "connections", `${CONN}.yaml`),
      `name: ${CONN}\ntype: mail\nprovider: imap\nreach:\n  imap: { host: ${imap.host}, port: ${imap.port}, security: plain, username: ${USER}, secret: mail_password }\nsecrets: [mail_password]\n`,
    );
    writeFileSync(join(dir, ".metistry", "secrets.yaml"), `secrets:\n  mail_password:\n    hosts: ["${imap.host}:${imap.port}"]\n    grants: { "connection:${CONN}": on }\n`);
    const mail = instanceImapOpener({ instanceDir: dir, seedDir: SEED, extensions: false, env: { METISTRY_SECRET_MAIL_PASSWORD: PASSWORD }, timeoutMs: 5_000 });
    // the mail sync raises the messages' requests first (the collectors' own tests prove how)
    await mailSync(pool, { openImap: mail, now: () => NOW });
    const serve = async (withMail: boolean) => {
      const inboxDir = mkdtempSync(join(tmpdir(), "metistry-draft-inbox-"));
      dirs.push(inboxDir);
      const s = makeServer(pool, queries, { origin: "http://127.0.0.1:0", inboxDir, policy, secureCookies: false, localOwner: { token: localOwnerToken, trusted: [] }, ...(withMail ? { mail } : {}) });
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    ({ s: server, url: base } = await serve(true));
    ({ s: bareServer, url: bare } = await serve(false));
    const pkId = `${MARK}-${mintToken(8)}`;
    passkeyIds.push(pkId);
    await store.storePasskey(pool, { id: pkId, publicKey: new Uint8Array([1]), signCount: 0, transports: [], origin: "t", label: MARK });
    sessionCookie = `metistry_session=${await store.issueSession(pool, pkId, policy)}`;
    ownerToken = await store.mintOwnerToken(pool, MARK);
    agentToken = (await agents.createAgent(pool, { id: agentId, display_name: "itest draft" })).token;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM proposals WHERE kind = 'message' AND payload->>'connection' = $1`, [CONN]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [CONN]);
    await pool.query(`DELETE FROM runs WHERE component = 'console' AND kind = 'mail_draft' AND meta->>'connection' = $1`, [CONN]);
    await pool.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await pool.query(`DELETE FROM owner_tokens WHERE label = $1`, [MARK]).catch(() => undefined);
    await pool.query(`DELETE FROM auth_sessions WHERE passkey_id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await pool.query(`DELETE FROM passkeys WHERE id = ANY($1)`, [passkeyIds]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bareServer.close(() => r()));
    await imap.close();
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  describe("who may draft (U2)", () => {
    it("no credential is the uniform 401, and the mail server hears nothing", async () => {
      const before = imap.connections;
      expect((await post(JOSE, { body: "x" }, {})).status).toBe(401);
      expect(imap.connections).toBe(before);
    });

    it("an agent bearer is refused 403 — nothing is dialled", async () => {
      const before = imap.connections;
      expect((await post(JOSE, { body: "x" }, { authorization: `Bearer ${agentToken}` })).status).toBe(403);
      expect(imap.connections).toBe(before);
    });

    it("the capture owner token is refused 403 — capture is its whole reach", async () => {
      const before = imap.connections;
      expect((await post(JOSE, { body: "x" }, { authorization: `Bearer ${ownerToken}` })).status).toBe(403);
      expect(imap.connections).toBe(before);
    });

    it("the local owner token reaches it, and so does a passkey session", async () => {
      const r = await post(JOSE, { body: "x" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ ok: true, message_id: JOSE, connection: CONN, sent: false, drafted: false });
      expect((await post(JOSE, { body: "x" }, { cookie: sessionCookie })).status).toBe(200);
    });
  });

  it("**never sends**: previews the reply addressed from the message's own headers, appends to \\Drafts only as previewed, and clears the request", async () => {
    const p = await post(ADA, { body: "Thursday works." });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({
      ok: true,
      message_id: ADA,
      connection: CONN,
      sent: false,
      preview: { mailbox: "[Gmail]/Drafts", from: USER, to: ["ada@example.net"], cc: [], subject: "Re: Café plans ☕", in_reply_to: "<a-12@example.net>", body: "Thursday works." },
      expires_in_sec: 300,
      drafted: false,
    });
    expect(appends()).toHaveLength(0); // a preview appends nothing

    // the words must be the previewed ones — the token survives a mismatch, and nothing is written
    const changed = await post(ADA, { body: "Friday.", confirm_token: p.body.confirm_token });
    expect(changed.status).toBe(409);
    expect(appends()).toHaveLength(0);

    const c = await post(ADA, { body: "Thursday works.", confirm_token: p.body.confirm_token });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ ok: true, message_id: ADA, connection: CONN, sent: false, drafted: true, mailbox: "[Gmail]/Drafts", cleared: 1 });
    expect(typeof c.body.draft_id).toBe("string");
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]!.flags).toEqual(["\\Draft", "\\Seen"]);
    expect(drafts()[0]!.header).toMatch(/^To: ada@example\.net$/m);
    // only \Drafts: every other mailbox is as it was, and no command but the closed set's was sent
    for (const b of boxes.filter((x) => x.name !== "[Gmail]/Drafts")) expect(b.messages.some((m) => m.body.includes("Thursday") || m.header.includes("Re: Caf")), b.name).toBe(false);
    expect(appends().every((l) => l.includes('"[Gmail]/Drafts" (\\Draft \\Seen)'))).toBe(true);
    const verbs = new Set(imap.commands.map((l) => (l.split(" ")[1] === "UID" ? `UID ${l.split(" ")[2]}` : l.split(" ")[1]!).toUpperCase()));
    expect([...verbs].every((v) => ["LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "APPEND", "LOGOUT"].includes(v))).toBe(true);
    const row = (await pool.query(`SELECT decision, payload->'cleared' AS cleared FROM proposals WHERE kind = 'message' AND source->>'external_ref' = $1`, [`mail:${CONN}:<a-12@example.net>`])).rows;
    expect(row).toEqual([{ decision: "resolved_at_source", cleared: { what: "You drafted a reply — it is in your Drafts, unsent", where: "mail" } }]);

    // spent
    expect((await post(ADA, { confirm_token: p.body.confirm_token })).status).toBe(409);
    expect(drafts()).toHaveLength(1);
    // the audit rows carry the connection and the outcome — never the reference, an address, a subject or the words
    const audit = (await pool.query(`SELECT tool, meta FROM runs WHERE component = 'console' AND kind = 'mail_draft' AND meta->>'connection' = $1 ORDER BY id`, [CONN])).rows;
    expect(audit.map((r) => r.meta.outcome)).toContain("drafted");
    expect(JSON.stringify(audit)).not.toMatch(/ada@example|Café|Thursday|INBOX\/1700/);
  });

  it("refuses a body that names a recipient, a subject or a mailbox — who it goes to is never the caller's", async () => {
    const before = imap.connections;
    for (const extra of [{ to: ["someone@else.example"] }, { subject: "hi" }, { mailbox: "INBOX" }, { send: true }]) {
      const r = await post(JOSE, { body: "x", ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await post(JOSE, { body: 42 })).status).toBe(400);
    expect(imap.connections).toBe(before);
  });

  it("refuses what is not a message here: a reference that is not one, another connection, a renumbered or missing message, no mail here", async () => {
    expect((await post("not-a-ref", { body: "x" })).body).toMatchObject({ error: { code: "invalid_request" }, reason: "bad_request" });
    expect((await post(`nope/INBOX/1700/12`, { body: "x" })).status).toBe(404);
    expect((await post(`${CONN}/INBOX/1699/12`, { body: "x" })).body).toMatchObject({ error: { code: "conflict" }, reason: "stale" });
    expect((await post(`${CONN}/INBOX/1700/99`, { body: "x" })).status).toBe(404);
    const none = await post(JOSE, { body: "x" }, local, bare);
    expect(none.status).toBe(503);
    expect((await post(JOSE, { confirm_token: "never-minted" })).status).toBe(409);
  });
});
