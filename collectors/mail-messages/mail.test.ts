// The mail sync and Draft Reply (T4-17), against a local IMAP fixture server
// (packages/connections/test/imap-server.ts — 127.0.0.1, an ephemeral port,
// never a real mail service) read through the console's own opener
// (`instanceImapOpener`) and the scratch database.
//
// What it proves: message requests are inferred from HEADERS ONLY — no body
// byte reaches a request, and the server was never asked for one; the
// source names the owner (R7) or nothing is raised; a mirror clears, with a
// receipt, when the source changes; and Draft Reply writes a draft to
// \Drafts addressed from the message's own headers — nothing sends.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { loadKind, mintToken } from "@foldedspacelabs/metistry-core";
import { loadTestEnv, testDb } from "@foldedspacelabs/metistry-core/test-env";
import { instanceImapOpener, type ImapMessage, type ImapSyncOpener } from "@foldedspacelabs/metistry-connections";
import { fakeImap, fixtureMailboxes, type FixtureImap, type FixtureMailbox } from "../../packages/connections/test/imap-server.js";
import { COMPONENT, INFERRED, MAIL_SOURCE_KIND, MESSAGE_KIND, RAISE_DEFAULTS, messagePayload, run, scrubDigits, waitsOnOwner } from "./run.js";
import { DraftRefused, appendReplyDraft, previewReplyDraft } from "./draft.js";

const { hasDb } = loadTestEnv(new URL("../../.env", import.meta.url)); // METISTRY_DB_* only (docs/ops/testing.md)
const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
const USER = "me@example.com";
// an app password's shape; built at run time so no key-shaped literal is in the tree
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("");
const NOW = Date.parse("2026-09-30T12:00:00Z");
const suffix = mintToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "").slice(0, 6) || "x";
const CONN = `itest-mail-${suffix}`;

const CRLF = (lines: string[]) => lines.join("\r\n");

/** The fixture inbox, plus the messages the rules must pass over. */
function mailboxes(): FixtureMailbox[] {
  const boxes = fixtureMailboxes();
  const inbox = boxes[0]!;
  const msg = (uid: number, day: string, header: string[]) => ({ uid, flags: [] as string[], internaldate: `${day}-Sep-2026 10:00:00 +0000`, header: CRLF(header), body: `BODY-MARKER-${uid} the confidential part` });
  inbox.messages.push(
    msg(14, "29", ["From: Service <no-reply@service.example>", `To: ${USER}`, "Subject: Your receipt", "Message-ID: <s-14@service.example>"]),
    msg(15, "29", ["From: Sam <sam@example.org>", "To: team@example.org", `Cc: ${USER}`, "Subject: FYI the plan", "Message-ID: <s-15@example.org>"]),
    msg(16, "29", [`From: Me <${USER}>`, `To: ${USER}`, "Subject: note to self", "Message-ID: <m-16@example.com>"]),
    msg(17, "29", ["From: Bank Person <person@bank.example>", `To: ${USER}`, "Subject: Your code is 481 516 — call me back", "Message-ID: <b-17@bank.example>"]),
  );
  return boxes;
}

const servers: FixtureImap[] = [];
const dirs: string[] = [];
async function server(boxes = mailboxes()): Promise<FixtureImap> {
  const s = await fakeImap({ username: USER, password: PASSWORD, mailboxes: boxes });
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function instance(s: FixtureImap, provider = "imap"): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-mail-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  writeFileSync(
    join(dir, ".metistry", "connections", `${CONN}.yaml`),
    `name: ${CONN}\ntype: mail\nprovider: ${provider}\nreach:\n  imap: { host: ${s.host}, port: ${s.port}, security: plain, username: ${USER}, secret: mail_password }\nsecrets: [mail_password]\n`,
  );
  writeFileSync(join(dir, ".metistry", "secrets.yaml"), `secrets:\n  mail_password:\n    hosts: ["${s.host}:${s.port}"]\n    grants: { "connection:${CONN}": on }\n`);
  return dir;
}
const opener = (dir: string): ImapSyncOpener => instanceImapOpener({ instanceDir: dir, seedDir: SEED_DIR, extensions: false, env: { METISTRY_SECRET_MAIL_PASSWORD: PASSWORD }, timeoutMs: 5_000 });

/** Every command verb the fixture was sent. */
const verbs = (s: FixtureImap) => new Set(s.commands.map((l) => (l.split(" ")[1] === "UID" ? `UID ${l.split(" ")[2]}` : l.split(" ")[1]!).toUpperCase()));

describe("the mail-messages collector's manifest", () => {
  it("loads through the collector registry as a sync every 15 minutes, its raise rule the one run.ts defaults", async () => {
    const reg = await loadKind("collector", { productDir: fileURLToPath(new URL("../..", import.meta.url)) });
    const m = reg.get("mail-messages")?.manifest;
    expect(m, JSON.stringify(reg.skipped)).toMatchObject({ name: COMPONENT, display_name: "Mail", schedule: { every: "15m" }, writes: ["proposals", "sync_state"] });
    expect(m?.type === "collector" ? Object.fromEntries(Object.entries(m.needs_you ?? {}).map(([k, v]) => [k, v.default])) : null).toEqual(RAISE_DEFAULTS);
  });
});

describe("the header rules (pure)", () => {
  const m = (over: Partial<ImapMessage> = {}): ImapMessage => ({
    ref: "mail/INBOX/1/1",
    source: "comms",
    mailbox: "INBOX",
    uid: 1,
    uid_validity: 1,
    date: "2026-09-29T10:00:00.000Z",
    received: "2026-09-29T10:00:00.000Z",
    from: { name: "Ada", address: "ada@example.net" },
    reply_to: [],
    to: [{ name: null, address: USER }],
    cc: [],
    subject: "Lunch?",
    message_id: "<a@example.net>",
    in_reply_to: null,
    references: [],
    flags: [],
    size: 10,
    automated: false,
    ...over,
  });

  it("asks when a person wrote to the owner alone, or replied in a conversation to them — and says so in words", () => {
    expect(waitsOnOwner(m(), USER)).toEqual({ reason: "direct", why: "Written to you alone" });
    expect(waitsOnOwner(m({ to: [{ name: null, address: USER }, { name: null, address: "bo@example.net" }], in_reply_to: "<r@x>" }), USER)?.reason).toBe("reply");
    expect(waitsOnOwner(m({ to: [{ name: null, address: USER }], references: ["<r@x>"], cc: [{ name: null, address: "bo@x.net" }] }), USER)?.reason).toBe("reply");
  });

  it("asks nothing the headers do not ask of the owner (R7 and the prefilter)", () => {
    const none = {
      "a list or an automatic sender": m({ automated: true }),
      "only Cc'd": m({ to: [{ name: null, address: "team@x.net" }], cc: [{ name: null, address: USER }] }),
      "to several, not a reply": m({ to: [{ name: null, address: USER }, { name: null, address: "bo@x.net" }] }),
      "from the owner": m({ from: { name: null, address: USER } }),
      "from a no-reply address": m({ from: { name: null, address: "noreply+x@service.example" } }),
      "from notifications": m({ from: { name: null, address: "notifications@github.example" } }),
      "already answered": m({ flags: ["\\answered"] }),
      "a draft": m({ flags: ["\\draft"] }),
      "no sender": m({ from: null }),
    };
    for (const [why, msg] of Object.entries(none)) expect(waitsOnOwner(msg, USER), why).toBeNull();
    // the owner's sent mail answers it
    expect(waitsOnOwner(m(), USER, new Set(["<a@example.net>"]))).toBeNull();
  });

  it("scrubs a code or a number from what a request carries — a year stays", () => {
    expect(scrubDigits("Your code is 481 516 — call 555-123-4567 by 2026")).toBe("Your code is •••••• — call •••••• by 2026");
    const p = messagePayload(m({ subject: "PIN 12345678" }), "mail", { reason: "direct", why: "Written to you alone" });
    expect(p).toMatchObject({ title: "PIN ••••••", summary: "PIN ••••••", from: "Ada <ada@example.net>", source: "comms", inferred: INFERRED, event: "written_to_you" });
    expect(p.reason).toBe("Written to you alone — inferred from its headers; the message itself was not read");
  });
});

describe("mail-messages run — degrades absent", () => {
  const fakeDb = () => ({ q: [] as string[], async query(text: string) { this.q.push(text); return { rows: [] }; } });

  it("no opener (no instance) is 0 and no statement", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("no mail connection yet is 0, no statement, nothing dialled", async () => {
    const s = await server();
    const dir = mkdtempSync(join(tmpdir(), "metistry-mail-empty-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
    const db = fakeDb();
    expect(await run(db, { openImap: opener(dir) })).toBe(0);
    expect(db.q).toHaveLength(0);
    expect(s.connections).toBe(0);
  });
});

describe.skipIf(!hasDb)("message requests and Draft Reply (real db)", () => {
  let pool: pg.Pool;
  const mirrors = async () =>
    (await pool.query(`SELECT id, decision, source_agent, trust, source, payload FROM proposals WHERE kind = $1 AND source->>'kind' = $2 AND payload->>'connection' = $3 ORDER BY id`, [MESSAGE_KIND, MAIL_SOURCE_KIND, CONN])).rows;
  const clean = async () => {
    await pool.query(`DELETE FROM proposals WHERE kind = $1 AND payload->>'connection' = $2`, [MESSAGE_KIND, CONN]);
    await pool.query(`DELETE FROM sync_state WHERE connection = $1`, [CONN]);
  };
  beforeAll(async () => {
    pool = await testDb(pg.Pool);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("**infers from headers only**: raises for the three messages written to the owner that ask — no body byte anywhere, none asked for, nothing marked read", async () => {
    const s = await server();
    const ctx = { openImap: opener(instance(s)), now: () => NOW };
    expect(await run(pool, ctx)).toBe(3);
    const rows = await mirrors();
    // not the list (11), the no-reply receipt (14), the Cc (15) or the owner's own (16)
    expect(rows.map((r) => r.source.external_ref)).toEqual([`mail:${CONN}:<b-17@bank.example>`, `mail:${CONN}:<j-13@example.com>`, `mail:${CONN}:<a-12@example.net>`]);
    const [, jose, ada] = rows;
    expect(ada).toMatchObject({
      decision: "pending",
      source_agent: "mail-messages",
      trust: "external",
      source: { kind: "mail", person: "ada@example.net" },
      payload: { title: "Café plans ☕", from: "Ada Lovelace <ada@example.net>", why: "reply", ref: `${CONN}/INBOX/1700/12`, message_id: "<a-12@example.net>", source: "comms", inferred: { from: "headers", by: "rules" } },
    });
    expect(jose!.payload).toMatchObject({ why: "direct", title: "clear gnp.exe invoice" });
    expect(JSON.stringify(rows)).not.toMatch(/BODY-MARKER|secret recipe|ignore previous|confidential/);
    // nothing but headers was ever asked for, and nothing was marked read
    expect(s.commands.some((l) => / SELECT /.test(l))).toBe(false);
    expect(s.commands.filter((l) => / UID FETCH /.test(l)).every((l) => l.includes("BODY.PEEK[HEADER.FIELDS ("))).toBe(true);
    expect([...verbs(s)].sort()).toEqual(["EXAMINE", "LIST", "LOGIN", "LOGOUT", "UID FETCH", "UID SEARCH"]);
    expect(s.mailboxes[0]!.messages.map((m) => m.flags)).toEqual([[], ["\\Seen"], [], [], [], [], []]);
    // the sync's bookkeeping never names the owner
    const state = (await pool.query(`SELECT key, value FROM sync_state WHERE connection = $1 ORDER BY key`, [CONN])).rows;
    expect(JSON.stringify(state)).not.toContain(USER);
    // a second pass asks nothing new
    expect(await run(pool, ctx)).toBe(0);
  });

  it("the code-bearing message raises with its code scrubbed", async () => {
    const boxes = mailboxes();
    boxes[0]!.messages = boxes[0]!.messages.filter((m) => m.uid === 17);
    const s = await server(boxes);
    expect(await run(pool, { openImap: opener(instance(s)), now: () => NOW })).toBe(1);
    const [row] = await mirrors();
    expect(row.payload.title).toBe("Your code is •••••• — call me back");
    expect(JSON.stringify(row)).not.toContain("481");
  });

  it("**a mirror clears when the source changes** — replied, answered, left the inbox, a week old — each with a receipt", async () => {
    const boxes = mailboxes();
    const s = await server(boxes);
    const ctx = (now = NOW) => ({ openImap: opener(instance(s)), now: () => now });
    const extra = { uid: 18, flags: [] as string[], internaldate: "29-Sep-2026 11:00:00 +0000", header: CRLF(["From: Kim <kim@example.org>", `To: ${USER}`, "Subject: A question", "Message-ID: <k-18@example.org>"]), body: "BODY" };
    boxes[0]!.messages.push(extra);
    expect(await run(pool, ctx())).toBe(4); // 12, 13, 17, 18

    // the owner replied from their mail app to 13 (its Sent says so), flagged 12 answered, archived 18
    boxes.find((b) => b.name === "[Gmail]/Sent Mail")!.messages.push({ uid: 1, flags: ["\\Seen"], internaldate: "30-Sep-2026 09:00:00 +0000", header: CRLF([`From: ${USER}`, "To: jose@example.com", "Subject: Re: invoice", "Message-ID: <r-1@example.com>", "In-Reply-To: <j-13@example.com>"]), body: "BODY" });
    boxes[0]!.messages.find((m) => m.uid === 12)!.flags.push("\\Answered");
    boxes[0]!.messages = boxes[0]!.messages.filter((m) => m.uid !== 18);
    expect(await run(pool, ctx())).toBe(3);
    const receipt = (id: string) => mirrors().then((rows) => rows.filter((r) => r.source.external_ref === `mail:${CONN}:${id}`).map((r) => [r.decision, r.payload.cleared]));
    expect(await receipt("<j-13@example.com>")).toEqual([["resolved_at_source", { what: "You replied in your mail", where: "mail" }]]);
    expect(await receipt("<a-12@example.net>")).toEqual([["resolved_at_source", { what: "You replied in your mail", where: "mail" }]]);
    expect(await receipt("<k-18@example.org>")).toEqual([["resolved_at_source", { what: "No longer in your inbox", where: "mail" }]]);

    // a week on, the last one falls out of the window
    expect(await run(pool, ctx(NOW + 8 * 86_400_000))).toBe(1);
    expect(await receipt("<b-17@bank.example>")).toEqual([["resolved_at_source", { what: "Over 7 days old — no longer waiting here", where: "mail" }]]);
    // and none of them is raised again
    expect(await run(pool, ctx())).toBe(0);
  });

  it("one the owner put down (Not Mine) is not raised again; with the rule off nothing is raised", async () => {
    const s = await server();
    const dir = instance(s);
    expect(await run(pool, { openImap: opener(dir), now: () => NOW, raise: { message: false } })).toBe(0);
    expect(await mirrors()).toEqual([]);
    await run(pool, { openImap: opener(dir), now: () => NOW });
    await pool.query(`UPDATE proposals SET decision = 'deny', decided_at = now() WHERE kind = $1 AND payload->>'connection' = $2`, [MESSAGE_KIND, CONN]);
    expect(await run(pool, { openImap: opener(dir), now: () => NOW })).toBe(0);
    expect((await mirrors()).map((r) => r.decision)).toEqual(["deny", "deny", "deny"]);
  });

  describe("Draft Reply", () => {
    it("**never sends**: previews a reply addressed from the message's own headers, appends it to \\Drafts only as previewed, and clears the request", async () => {
      const boxes = mailboxes();
      // Ada asks replies to go to her assistant
      const ada = boxes[0]!.messages.find((m) => m.uid === 12)!;
      ada.header = `${ada.header}\r\nReply-To: Ada's desk <desk@example.net>`;
      const s = await server(boxes);
      const open = opener(instance(s));
      await run(pool, { openImap: open, now: () => NOW });
      const p = await previewReplyDraft(open, { ref: `${CONN}/INBOX/1700/12`, body: "Thursday works." });
      expect(p).toMatchObject({ ref: `${CONN}/INBOX/1700/12`, connection: CONN, mailbox: "[Gmail]/Drafts", from: USER, to: ["desk@example.net"], cc: [], subject: "Re: Café plans ☕", in_reply_to: "<a-12@example.net>", body: "Thursday works.", secrets: ["mail_password"] });
      expect(p.binding.input.references).toEqual(["<root@example.net>", "<a-12@example.net>"]);
      expect(boxes.find((b) => b.name === "[Gmail]/Drafts")!.messages).toHaveLength(0); // a preview appends nothing

      // a binding that is not the preview's is refused, and nothing is written
      await expect(appendReplyDraft(pool, open, { ...p.binding, input: { ...p.binding.input, to: ["someone@else.example"] } })).rejects.toMatchObject({ code: "changed" });
      expect(boxes.find((b) => b.name === "[Gmail]/Drafts")!.messages).toHaveLength(0);

      const done = await appendReplyDraft(pool, open, p.binding);
      expect(done.result).toMatchObject({ connection: CONN, mailbox: "[Gmail]/Drafts", message_id: p.binding.confirm.message_id });
      const drafts = boxes.find((b) => b.name === "[Gmail]/Drafts")!.messages;
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.flags).toEqual(["\\Draft", "\\Seen"]);
      expect(drafts[0]!.header).toMatch(/^To: desk@example\.net$/m);
      expect(drafts[0]!.header).toMatch(/^In-Reply-To: <a-12@example\.net>$/m);
      for (const other of boxes.filter((b) => b.name !== "[Gmail]/Drafts")) expect(other.messages.some((m) => m.header.includes("Thursday")), other.name).toBe(false);
      expect([...verbs(s)].every((v) => ["LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "APPEND", "LOGOUT"].includes(v))).toBe(true);
      const [row] = (await mirrors()).filter((r) => r.source.external_ref === `mail:${CONN}:<a-12@example.net>`);
      expect(row).toMatchObject({ decision: "resolved_at_source", payload: { cleared: { what: "You drafted a reply — it is in your Drafts, unsent", where: "mail" } } });
      // and the sync does not ask about it again
      expect(await run(pool, { openImap: open, now: () => NOW })).toBe(0);
    });

    it("refuses a reference that is not one, a renumbered or missing message, a connection that cannot draft — before anything is sent", async () => {
      const s = await server();
      const open = opener(instance(s));
      const code = (p: Promise<unknown>) => p.then(() => "ok", (e: DraftRefused) => e.code);
      expect(await code(previewReplyDraft(open, { ref: "not a ref", body: "x" }))).toBe("bad_request");
      expect(await code(previewReplyDraft(open, { ref: `${CONN}/INBOX/1700/12`, body: 42 }))).toBe("bad_request");
      expect(await code(previewReplyDraft(open, { ref: `nope/INBOX/1700/12`, body: "x" }))).toBe("no_connection");
      expect(await code(previewReplyDraft(open, { ref: `${CONN}/INBOX/1699/12`, body: "x" }))).toBe("changed");
      expect(await code(previewReplyDraft(open, { ref: `${CONN}/INBOX/1700/99`, body: "x" }))).toBe("not_found");
      const before = s.connections;
      const readOnly: ImapSyncOpener = async (req) => {
        const o = await open(req);
        return o.ok ? { ok: true, sync: { ...o.sync, capabilities: ["read"] } } : o;
      };
      expect(await code(previewReplyDraft(readOnly, { ref: `${CONN}/INBOX/1700/12`, body: "x" }))).toBe("no_capability");
      expect(s.connections).toBe(before);
    });
  });
});
