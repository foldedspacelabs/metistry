// The IMAP provider (plan §2.6, §4 Q8; T4-15), against a local IMAP fixture
// server (`imap-server.ts`: 127.0.0.1, an ephemeral port — never a real mail
// service). What it proves:
//
//  * **no code path can send**: the commands this client can issue are a
//    closed set with fixed shapes (a body fetch, a flag store, a second
//    command smuggled after a line break are all refused before anything is
//    written); a submission port is never dialled; no source file in the
//    package speaks SMTP; a draft goes to the \Drafts mailbox and nowhere
//    else; and across every exchange below, the server saw nothing but the
//    allowed commands;
//  * the app password goes only through the host guard — to the exact
//    host:port on its *Sent only to* list, over TLS unless loopback, when
//    granted — and is never in an error, even when a server echoes it;
//  * reading is headers only, from a mailbox opened read-only: no body, no
//    flag changed, every message stamped `source: comms`, its text decoded
//    and stripped of bidi and zero-width tricks;
//  * a draft is previewed, then appended only if it is the one previewed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EgressRefused, SecretRedactor, parseSecretsFile, planSocketEgress, type SecretSource } from "@foldedspacelabs/metistry-core";
import {
  ConnectionPool,
  IMAP_COMMANDS,
  IMAP_FETCH_ITEMS,
  ImapError,
  ResponseFramer,
  checkConnection,
  decodeEncodedWords,
  describeConnections,
  decodeMailboxName,
  imapCommandLine,
  MAIL_SYNC,
  openImap,
  openSyncImap,
  parseAddresses,
  parseImapRef,
  syncSecretNames,
  parseInternalDate,
  planDraft,
  quoted,
  tokenize,
  type ImapReach,
  type OpenImapOptions,
} from "../src/index.js";
import { catalogOf } from "./helpers.js";
import { fakeImap, fixtureMailboxes, type FixtureImap, type FixtureOptions } from "./imap-server.js";

const seedType = (name: string) => parse(readFileSync(new URL(`../../../seed/connection-types/${name}/manifest.yaml`, import.meta.url), "utf8")) as Record<string, unknown>;
const TYPES = [seedType("imap"), seedType("gmail-mail")];

const USER = "me@example.com";
// an app password's shape (Google's 16 letters); built at run time so no key-shaped literal is in the tree
const PASSWORD = ["qzvt", "hmwk", "rbxe", "lpfa"].join("");
/** A source holding the app password — or `null` for none. */
const source = (v: string | null = PASSWORD): SecretSource => ({ value: async (n) => (n === "mail_password" && v !== null ? v : undefined) });

const servers: FixtureImap[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(opts: Partial<FixtureOptions> = {}): Promise<FixtureImap> {
  const s = await fakeImap({ username: USER, password: PASSWORD, mailboxes: fixtureMailboxes(), ...opts });
  servers.push(s);
  return s;
}

const secretsFor = (entry: string, grant = "on") => parseSecretsFile(`secrets:\n  mail_password:\n    hosts: [${JSON.stringify(entry)}]\n    grants: { "connection:mail": ${grant} }\n`);

function options(s: FixtureImap, over: Partial<OpenImapOptions> = {}): OpenImapOptions {
  const reach: ImapReach = { host: s.host, port: s.port, security: "plain", username: USER, secret: "mail_password" };
  return {
    connection: "mail",
    reach,
    capabilities: ["read", "draft"],
    secretsFile: secretsFor(`${s.host}:${s.port}`),
    source: source(),
    redactor: new SecretRedactor(),
    timeoutMs: 5_000,
    ...over,
  };
}

/** Every command verb the fixture was sent, across every test that ran against it. */
const verbs = (s: FixtureImap) =>
  s.commands.map((l) => {
    const w = l.split(" ");
    return (w[1] === "UID" ? `UID ${w[2]}` : w[1]!).toUpperCase();
  });

describe("no code path can send", () => {
  it("the commands are a closed set: anything else is refused before it is written, by name where one is likely", () => {
    for (const c of ["SELECT", "STORE", "UID STORE", "COPY", "UID MOVE", "MOVE", "EXPUNGE", "UID EXPUNGE", "DELETE", "CREATE", "RENAME", "FETCH", "STARTTLS", "AUTHENTICATE"]) {
      expect(() => imapCommandLine("a1", c, "")).toThrow(ImapError);
      try {
        imapCommandLine("a1", c, "");
      } catch (err) {
        expect((err as ImapError).code).toBe("command_refused");
        expect((err as ImapError).message).toMatch(/not a command this client issues — /);
      }
    }
    for (const c of ["SEND", "SMTP", "MAIL FROM", "RCPT", "DATA", "XSEND", "ID", "ENABLE", "IDLE", "select"]) expect(() => imapCommandLine("a1", c, "")).toThrow(/command_refused/);
    expect(IMAP_COMMANDS).toEqual(["CAPABILITY", "LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "APPEND", "NOOP", "LOGOUT"]);
  });

  it("each command's arguments are one fixed shape: no body fetch, no second command after a line break", () => {
    // the one fetch — headers, with PEEK
    expect(imapCommandLine("a1", "UID FETCH", `1,2 ${IMAP_FETCH_ITEMS}`)).toBe(`a1 UID FETCH 1,2 ${IMAP_FETCH_ITEMS}\r\n`);
    expect(IMAP_FETCH_ITEMS).toContain("BODY.PEEK[HEADER.FIELDS (");
    for (const bad of ["1 (BODY[])", "1 (BODY[TEXT])", "1 (BODY.PEEK[TEXT])", "1 (RFC822)", "1 (BODY[HEADER.FIELDS (FROM)])", "1:* (FLAGS)", `1 ${IMAP_FETCH_ITEMS.replace("BODY.PEEK", "BODY")}`]) {
      expect(() => imapCommandLine("a1", "UID FETCH", bad)).toThrow(/fixed shape/);
    }
    expect(() => imapCommandLine("a1", "EXAMINE", `"INBOX"\r\na2 STORE 1 +FLAGS (\\Deleted)`)).toThrow(/fixed shape/);
    expect(() => imapCommandLine("a1", "LOGIN", `"u" "p"\r\na2 DELETE "INBOX"`)).toThrow(/fixed shape/);
    expect(() => imapCommandLine("a1", "UID SEARCH", "ALL\r\na2 EXPUNGE")).toThrow(/fixed shape/);
    expect(() => imapCommandLine("a1", "LIST", `"" "%"`)).toThrow(/fixed shape/);
    // APPEND takes only the draft flags
    expect(imapCommandLine("a1", "APPEND", `"Drafts" (\\Draft \\Seen) {12}`)).toMatch(/^a1 APPEND/);
    expect(() => imapCommandLine("a1", "APPEND", `"Drafts" (\\Seen) {12}`)).toThrow(/fixed shape/);
    expect(() => imapCommandLine("a1", "APPEND", `"Outbox" (\\Draft \\Seen) {12}\r\nx`)).toThrow(/fixed shape/);
    expect(() => imapCommandLine("a 1", "NOOP")).toThrow(/tag/);
    // a quoted argument never carries a line break
    expect(() => quoted("INBOX\r\nA2 DELETE INBOX", "the mailbox")).toThrow(/line break/);
  });

  it("a submission port is refused at the file, and never dialled even when handed one directly", async () => {
    const f = (port: number) => ({ name: "mail", type: "mail", provider: "imap", reach: { imap: { host: "mail.example.com", port, username: USER, secret: "mail_password" } }, secrets: ["mail_password"] });
    for (const port of [25, 465, 587, 2525]) {
      const e = catalogOf([f(port)], { types: TYPES }).entries[0]!;
      expect(e.status).toBe("failed");
      expect(e.issues.join(" ")).toMatch(/mail submission port/);
    }
    let dialled = 0;
    const opts: OpenImapOptions = {
      connection: "mail",
      reach: { host: "mail.example.com", port: 587, security: "tls", username: USER, secret: "mail_password" },
      capabilities: ["read", "draft"],
      secretsFile: secretsFor("mail.example.com:587"),
      source: source(),
      dial: async () => {
        dialled++;
        throw new Error("never");
      },
    };
    await expect(openImap(opts)).rejects.toThrow(/submission port/);
    expect(dialled).toBe(0);
  });

  it("no source file in the package speaks SMTP or names a submission port, and no mail type ships a send capability", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8")
        // the refusals name what they refuse; the code must not do it
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/\bsmtp\b|MAIL FROM|RCPT TO|\bEHLO\b|\bHELO\b|nodemailer|sendmail/i);
      expect(src, f).not.toMatch(/port:\s*(?:25|465|587|2525)\b/);
    }
    for (const t of TYPES) {
      expect(t.provides).toBe("mail");
      expect(t.capabilities).toEqual(["read", "draft"]);
    }
  });

  it("a draft goes to the mailbox marked \\Drafts, flagged \\Draft — never Sent, never an Outbox — and the whole run used only the allowed commands", async () => {
    const s = await server();
    const session = await openImap(options(s));
    try {
      const input = { to: ["ada@example.net"], subject: "Re: Café plans ☕", body: "Sounds good.\nSee you then.", in_reply_to: "<a-12@example.net>", references: ["<root@example.net>"] };
      const preview = await session.previewDraft(input, new Date("2026-09-30T12:00:00Z"));
      expect(preview.mailbox).toBe("[Gmail]/Drafts");
      const done = await session.appendDraft(input, preview.confirm);
      expect(done).toMatchObject({ mailbox: "[Gmail]/Drafts", uid: 1, message_id: preview.plan.message_id });
      const [drafts, sent, outbox] = ["[Gmail]/Drafts", "[Gmail]/Sent Mail", "Outbox"].map((n) => s.mailboxes.find((m) => m.name === n)!);
      expect(drafts!.messages).toHaveLength(1);
      expect(drafts!.messages[0]!.flags).toEqual(["\\Draft", "\\Seen"]);
      expect(sent!.messages).toHaveLength(0);
      expect(outbox!.messages).toHaveLength(0);
      await session.readHeaders("INBOX");
    } finally {
      await session.close();
    }
    expect(new Set(verbs(s))).toEqual(new Set(["LOGIN", "LIST", "APPEND", "EXAMINE", "UID SEARCH", "UID FETCH", "LOGOUT"]));
    const appends = s.commands.filter((l) => / APPEND /.test(l));
    expect(appends).toEqual([expect.stringMatching(/^m\d+ APPEND "\[Gmail\]\/Drafts" \(\\Draft \\Seen\) \{\d+\}$/)]);
  });
});

describe("the host guard — the app password goes to its listed host:port, over TLS, when granted, or nowhere", () => {
  it("signs in with the app password over the one LOGIN, and reports the secret's name as used", async () => {
    const s = await server();
    const used: string[] = [];
    const session = await openImap(options(s, { onUse: ({ names }) => void used.push(...names) }));
    await session.close();
    expect(used).toEqual(["mail_password"]);
    const withPassword = s.commands.filter((l) => l.includes(PASSWORD));
    expect(withPassword).toEqual([expect.stringMatching(/^m\d+ LOGIN "me@example.com" "/)]);
  });

  it("refuses before dialling: a host:port not on the list, a grant not given, Ask without approval, no item", async () => {
    const s = await server();
    const cases: Array<[Partial<OpenImapOptions>, string]> = [
      [{ secretsFile: secretsFor("imap.gmail.com:993") }, "host_not_listed"],
      [{ secretsFile: secretsFor(`${s.host}:${s.port + 1}`) }, "host_not_listed"],
      [{ secretsFile: secretsFor(`${s.host}:${s.port}`, "off") }, "not_granted"],
      [{ secretsFile: secretsFor(`${s.host}:${s.port}`, "ask") }, "needs_approval"],
      [{ source: source(null) }, "missing_secret"],
    ];
    for (const [over, code] of cases) {
      const err = await openImap(options(s, over)).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(EgressRefused);
      expect((err as EgressRefused).code).toBe(code);
      expect((err as Error).message).not.toContain(PASSWORD);
    }
    expect(s.connections).toBe(0);
    // an approved Ask is the owner's approval of this session
    const ok = await openImap(options(s, { secretsFile: secretsFor(`${s.host}:${s.port}`, "ask"), approved: ["mail_password"] }));
    await ok.close();
    expect(s.connections).toBe(1);
  });

  it("never sends the password without TLS off this Mac (cleartext), and the file refuses plain off loopback", () => {
    const rules = { secrets: secretsFor("mail.example.com:143"), grantee: "connection:mail", purpose: "service" as const, redactor: new SecretRedactor() };
    expect(() => planSocketEgress({ host: "mail.example.com", port: 143, tls: false }, ["mail_password"], rules)).toThrow(/cleartext/);
    expect(planSocketEgress({ host: "127.0.0.1", port: 1143, tls: false }, ["mail_password"], { ...rules, secrets: secretsFor("127.0.0.1:1143") }).destination.entry).toBe("127.0.0.1:1143");
    const e = catalogOf([{ name: "mail", type: "mail", provider: "imap", reach: { imap: { host: "mail.example.com", port: 143, security: "plain", username: USER, secret: "mail_password" } }, secrets: ["mail_password"] }], { types: TYPES }).entries[0]!;
    expect(e.status).toBe("failed");
    expect(e.issues.join(" ")).toMatch(/plain is for a server on this Mac only/);
  });

  it("a refused sign-in is unauthorized with the app-password hint — and a server that echoes the password shows its name", async () => {
    const s = await server({ echoPassword: true, password: "something-else" });
    const err = (await openImap(options(s)).catch((e: unknown) => e)) as ImapError;
    expect(err).toBeInstanceOf(ImapError);
    expect(err.code).toBe("unauthorized");
    expect(err.message).toMatch(/AUTHENTICATIONFAILED/);
    expect(err.message).toMatch(/2-Step Verification on, then an app password/);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).toContain("***REDACTED secret.mail_password***");
  });

  it("refuses a server that is not IMAP, one that says LOGINDISABLED, and one that never answers", async () => {
    const bye = await server({ greeting: "BYE go away" });
    expect(await openImap(options(bye)).catch((e: ImapError) => e.code)).toBe("not_imap");
    const disabled = await server({ greeting: "OK [CAPABILITY IMAP4rev1 LOGINDISABLED] ready" });
    expect(await openImap(options(disabled)).catch((e: ImapError) => e.code)).toBe("login_disabled");
    expect(disabled.commands).toEqual([]);
    const silent = await server({ silent: true });
    expect(await openImap(options(silent, { timeoutMs: 200 })).catch((e: ImapError) => e.code)).toBe("timeout");
  });

  it("the default dialer verifies the server's certificate: a self-signed one is refused (tls) before LOGIN", async (ctx) => {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "imap-tls-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    } catch {
      if (dir) rmSync(dir, { recursive: true, force: true });
      ctx.skip();
      return;
    }
    try {
      const s = await server({ tls: { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") } });
      const err = (await openImap(options(s, { reach: { host: s.host, port: s.port, security: "tls", username: USER, secret: "mail_password" } })).catch((e: unknown) => e)) as ImapError;
      expect(err.code).toBe("tls");
      expect(s.commands).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("read — headers, never bodies, from a mailbox opened read-only", () => {
  it("returns the newest messages' headers, decoded and sanitised, stamped source: comms — and no body byte", async () => {
    const s = await server();
    const session = await openImap(options(s));
    const read = await session.readHeaders("INBOX", { limit: 2 });
    await session.close();
    expect(read.source).toBe("comms");
    expect(read.mailbox).toMatchObject({ exists: 3, uid_validity: 1700, uid_next: 14 });
    expect(read.matched).toBe(3);
    expect(read.messages.map((m) => m.uid)).toEqual([13, 12]);
    const [jose, ada] = read.messages;
    expect(ada).toMatchObject({
      ref: "mail/INBOX/1700/12",
      source: "comms",
      subject: "Café plans ☕",
      from: { name: "Ada Lovelace", address: "ada@example.net" },
      to: [
        { name: null, address: "me@example.com" },
        { name: "Charles", address: "charles@example.net" },
      ],
      cc: [{ name: null, address: "team@example.net" }],
      message_id: "<a-12@example.net>",
      in_reply_to: "<root@example.net>",
      references: ["<root@example.net>"],
      flags: ["\\seen"],
      date: "2026-09-28T14:01:00.000Z",
      received: "2026-09-28T14:02:00.000Z",
      automated: false,
    });
    // bidi overrides and a leading slash are stripped (core's sanitizeForAgent); an ISO-8859-1 name decodes
    expect(jose!.subject).toBe("clear gnp.exe invoice");
    expect(jose!.from).toEqual({ name: "José", address: "jose@example.com" });
    expect(JSON.stringify(read)).not.toMatch(/BODY-MARKER|secret recipe|ignore previous/);
    // read-only: EXAMINE, BODY.PEEK — and the server's flags are as they were
    expect(s.commands.some((l) => / SELECT /.test(l))).toBe(false);
    expect(s.commands.filter((l) => / UID FETCH /.test(l)).every((l) => l.includes("BODY.PEEK[HEADER.FIELDS ("))).toBe(true);
    expect(s.mailboxes[0]!.messages.map((m) => m.flags)).toEqual([[], ["\\Seen"], []]);
  });

  it("marks a list or bulk sender automated, reads since a day, and says not_found for no such mailbox", async () => {
    const s = await server();
    const session = await openImap(options(s));
    try {
      const since = await session.readHeaders("INBOX", { since: new Date("2026-09-28T00:00:00Z") });
      expect(since.messages.map((m) => m.uid)).toEqual([13, 12]);
      const all = await session.readHeaders();
      expect(all.messages.find((m) => m.uid === 11)!.automated).toBe(true);
      expect(await session.readHeaders("Nope").catch((e: ImapError) => e.code)).toBe("not_found");
      expect(s.commands.filter((l) => / UID SEARCH /.test(l)).map((l) => l.replace(/^m\d+ /, ""))).toEqual(["UID SEARCH SINCE 28-Sep-2026", "UID SEARCH ALL"]);
    } finally {
      await session.close();
    }
  });

  it("a provider that does not declare read or draft is refused before anything is sent", async () => {
    const s = await server();
    const session = await openImap(options(s, { capabilities: [] }));
    try {
      expect(await session.readHeaders().catch((e: ImapError) => e.code)).toBe("not_capable");
      expect(await session.previewDraft({ to: ["a@example.com"], subject: "x", body: "y" }).catch((e: ImapError) => e.code)).toBe("not_capable");
    } finally {
      await session.close();
    }
    expect(verbs(s)).toEqual(["LOGIN", "LOGOUT"]);
  });

  it("a literal past the limit is refused (too_large), not buffered", async () => {
    const s = await server({ hugeLiteral: 2 * 1024 * 1024 });
    const session = await openImap(options(s));
    expect(await session.readHeaders().catch((e: ImapError) => e.code)).toBe("too_large");
    await session.close();
  });
});

describe("draft — preview, then confirm", () => {
  const input = { to: ["ada@example.net"], cc: ["team@example.net"], subject: "Re: plans", body: "Yes — Thursday.", in_reply_to: "<a-12@example.net>" };

  it("renders a plain-text RFC 5322 message, deterministic given its date and Message-ID", () => {
    const plan = planDraft(input, { username: USER, now: new Date("2026-09-30T12:00:00Z") });
    expect(plan.message).toMatch(/^Date: Wed, 30 Sep 2026 12:00:00 \+0000\r\nFrom: me@example.com\r\nTo: ada@example.net\r\nCc: team@example.net\r\nSubject: Re: plans\r\nMessage-ID: <[0-9a-f-]+@example\.com>\r\nIn-Reply-To: <a-12@example\.net>\r\nReferences: <a-12@example\.net>\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
    expect(plan.message).not.toMatch(/^Bcc:/im);
    const again = planDraft(input, { username: USER, fixed: { date: plan.date, message_id: plan.message_id } });
    expect(again.digest).toBe(plan.digest);
    const utf = planDraft({ ...input, subject: "Re: Café ☕" }, { username: USER });
    expect(utf.message).toMatch(/\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    expect(decodeEncodedWords(/Subject: (.*)\r\n/.exec(utf.message)![1]!)).toBe("Re: Café ☕");
  });

  it("refuses a header injection, a non-address, no recipient, and a body past the limit", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...input, subject: "hi\r\nBcc: everyone@example.com" },
      { ...input, to: ["Ada <ada@example.net>"] },
      { ...input, to: ["ada@example.net\r\nBcc: x@example.com"] },
      { ...input, to: [] },
      { ...input, in_reply_to: "not-an-id" },
      { ...input, body: "x".repeat(300 * 1024) },
      { ...input, from: "nobody" },
    ];
    for (const b of bad) expect(() => planDraft(b as never, { username: USER }), JSON.stringify(b).slice(0, 60)).toThrow(/bad_draft/);
    expect(() => planDraft({ to: ["a@example.com"], subject: "x", body: "y" }, { username: "not-an-address" })).toThrow(/from:/);
  });

  it("appends only the draft its preview showed — a changed draft is refused and nothing is written", async () => {
    const s = await server();
    const session = await openImap(options(s));
    try {
      const preview = await session.previewDraft(input);
      expect(await session.appendDraft({ ...input, body: "No." }, preview.confirm).catch((e: ImapError) => e.code)).toBe("changed");
      expect(await session.appendDraft({ ...input, to: ["someone-else@example.com"] }, preview.confirm).catch((e: ImapError) => e.code)).toBe("changed");
      expect(await session.appendDraft(input, { ...preview.confirm, digest: "0".repeat(64) }).catch((e: ImapError) => e.code)).toBe("changed");
      expect(await session.appendDraft(input, undefined as never).catch((e: ImapError) => e.code)).toBe("changed");
      expect(s.commands.some((l) => / APPEND /.test(l))).toBe(false);
      const done = await session.appendDraft(input, preview.confirm);
      const stored = s.mailboxes.find((m) => m.name === "[Gmail]/Drafts")!.messages[0]!;
      expect(`${stored.header}\r\n\r\n${stored.body}`).toBe(preview.plan.message);
      expect(done.digest).toBe(preview.plan.digest);
    } finally {
      await session.close();
    }
  });

  it("no mailbox marked \\Drafts and none named Drafts: no_drafts; a top-level Drafts is used when unmarked", async () => {
    const none = await server({ mailboxes: fixtureMailboxes().filter((m) => m.name !== "[Gmail]/Drafts") });
    const a = await openImap(options(none));
    expect(await a.previewDraft(input).catch((e: ImapError) => e.code)).toBe("no_drafts");
    await a.close();
    const plain = await server({ mailboxes: [...fixtureMailboxes().filter((m) => m.name !== "[Gmail]/Drafts"), { name: "Drafts", attributes: [], uidValidity: 5, messages: [] }] });
    const b = await openImap(options(plain));
    expect((await b.previewDraft(input)).mailbox).toBe("Drafts");
    await b.close();
  });
});

describe("the connection file and check()", () => {
  const file = (over: Record<string, unknown> = {}, imap: Record<string, unknown> = {}) => ({
    name: "gmail",
    type: "mail",
    provider: "gmail-mail",
    reach: { imap: { host: "imap.gmail.com", username: "me@gmail.com", secret: "mail_password", ...imap } },
    secrets: ["mail_password"],
    ...over,
  });

  it("the shipped types load; Gmail is imap.gmail.com:993 over TLS and nowhere else", () => {
    const c = catalogOf([file(), file({ name: "other" }, { host: "imap.example.com" }), file({ name: "port" }, { port: 143 })], { types: TYPES });
    expect(c.entries.map((e) => [e.name, e.status])).toEqual([
      ["gmail", "ok"],
      ["other", "failed"],
      ["port", "failed"],
    ]);
    expect(c.entries[0]!.connection!.reach.imap).toEqual({ host: "imap.gmail.com", port: 993, security: "tls", username: "me@gmail.com", secret: "mail_password" });
    expect(c.entries[1]!.issues.join(" ")).toMatch(/Gmail is imap\.gmail\.com:993 over TLS and nowhere else/);
    // any other server is the imap type
    expect(catalogOf([file({ provider: "imap" }, { host: "imap.example.com" })], { types: TYPES }).entries[0]!.status).toBe("ok");
  });

  it("refuses at the file: an http reach for an imap type, imap for a calendar, a key pasted as the username, a custom mail connection", () => {
    const issues = (f: Record<string, unknown>) => catalogOf([f], { types: TYPES }).entries[0]!.issues.join(" | ");
    expect(issues(file({ reach: { http: { url: "https://imap.gmail.com/", auth: { scheme: "basic", username: "me", secret: "mail_password" } } } }))).toMatch(/reached by imap/);
    expect(issues(file({ provider: "custom" }))).toMatch(/needs a connection type/);
    expect(issues(file({}, { username: `sk-${"a".repeat(40)}` }))).toMatch(/looks like a key/);
    expect(issues(file({}, { username: "{{ secret.mail_password }}" }))).toMatch(/no control character, quote, backslash or template/);
    expect(issues(file({ secrets: [] }))).toMatch(/is used but not listed in secrets/);
  });

  it("the listing says host, port and TLS — never the username — and names a host:port the secret may not go to", async () => {
    const good = `secrets:\n  mail_password:\n    hosts: ["imap.gmail.com:993"]\n    grants: { "connection:gmail": on }\n`;
    const [row] = await describeConnections(catalogOf([file()], { types: TYPES, secrets: good }));
    expect(row).toMatchObject({ status: "ok", reach: { class: "imap", host: "imap.gmail.com", port: 993, security: "tls", auth: "basic" }, secrets: ["mail_password"] });
    expect(JSON.stringify(row)).not.toContain("me@gmail.com");
    const [bad] = await describeConnections(catalogOf([file()], { types: TYPES, secrets: good.replace("imap.gmail.com:993", "imap.gmail.com") }));
    expect(bad!.status).toBe("failed");
    expect(bad!.issues).toContain("mail_password may not be sent to imap.gmail.com:993 — it is not on the secret's *Sent only to* list (`metistry secrets hosts mail_password imap.gmail.com imap.gmail.com:993`)");
  });

  it("check() signs in, lists folders, finds Drafts and examines INBOX — reading no message", async () => {
    const s = await server();
    const f = { name: "mail", type: "mail", provider: "imap", reach: { imap: { host: s.host, port: s.port, security: "plain", username: USER, secret: "mail_password" } }, secrets: ["mail_password"] };
    const secrets = `secrets:\n  mail_password:\n    hosts: ["${s.host}:${s.port}"]\n    grants: { "connection:mail": on }\n`;
    const catalog = catalogOf([f], { types: TYPES, secrets });
    const events: unknown[] = [];
    const pool = new ConnectionPool({ catalog: async () => catalog, secrets: source(), onEvent: (e) => void events.push(e) });
    try {
      const r = await checkConnection(pool, catalog, "mail");
      expect(r.status).toBe("ok");
      expect(r.meta).toEqual({ mailboxes: 5, drafts: "[Gmail]/Drafts", inbox_messages: 3 });
      expect(r.probe).toMatch(/LOGIN \+ LIST over IMAP \(127\.0\.0\.1:\d+\): signed in; 5 mailboxes, Drafts is \[Gmail\]\/Drafts, 3 in INBOX/);
      expect(events).toEqual([expect.objectContaining({ kind: "connection_check", connection: "mail", ok: true, secrets: ["mail_password"] })]);
      expect(new Set(verbs(s))).toEqual(new Set(["LOGIN", "LIST", "EXAMINE", "LOGOUT"]));

      const wrong = new ConnectionPool({ catalog: async () => catalog, secrets: source("nope") });
      const bad = await checkConnection(wrong, catalog, "mail");
      expect(bad.status).toBe("failed");
      expect(bad.remediation).toMatch(/app password/);
      await wrong.close();

      const none = new ConnectionPool({ catalog: async () => catalog, secrets: source(null) });
      expect((await checkConnection(none, catalog, "mail")).status).toBe("absent");
      await none.close();

      const noDrafts = await server({ mailboxes: fixtureMailboxes().filter((m) => m.name !== "[Gmail]/Drafts") });
      const f2 = { ...f, reach: { imap: { ...f.reach.imap, port: noDrafts.port } } };
      const c2 = catalogOf([f2], { types: TYPES, secrets: secrets.replace(String(s.port), String(noDrafts.port)) });
      const p2 = new ConnectionPool({ catalog: async () => c2, secrets: source() });
      const d = await checkConnection(p2, c2, "mail");
      expect(d.status).toBe("degraded");
      expect(d.remediation).toMatch(/drafting will be refused/);
      await p2.close();
    } finally {
      await pool.close();
    }
  });

  it("the pool never dials an IMAP connection as MCP, and opens a mailbox only for the IMAP module", async () => {
    const catalog = catalogOf([file()], { types: TYPES, secrets: `secrets:\n  mail_password:\n    hosts: ["imap.gmail.com:993"]\n    grants: { "connection:gmail": on }\n` });
    const pool = new ConnectionPool({ catalog: async () => catalog, secrets: source(), imapDial: async () => Promise.reject(new Error("no network in tests")) });
    try {
      await expect(pool.upstreamTools("gmail")).rejects.toMatchObject({ code: "not_built" });
      await expect(pool.call({ connection: "gmail", tool: "send", args: {} })).rejects.toMatchObject({ code: "not_built" });
      await expect(pool.openImap("nope")).rejects.toMatchObject({ code: "unknown_connection" });
    } finally {
      await pool.close();
    }
  });
});

describe("one message by its reference, and the mail sync's opener (T4-17)", () => {
  const mailFile = (s: FixtureImap, over: Record<string, unknown> = {}) => ({
    name: "mail",
    type: "mail",
    provider: "imap",
    reach: { imap: { host: s.host, port: s.port, security: "plain", username: USER, secret: "mail_password" } },
    secrets: ["mail_password"],
    ...over,
  });
  const secretsYaml = (s: FixtureImap, grantee = "mail") => `secrets:\n  mail_password:\n    hosts: ["${s.host}:${s.port}"]\n    grants: { "connection:${grantee}": on }\n`;

  it("a reference comes apart one way only, and anything else is no reference", () => {
    expect(parseImapRef("mail/INBOX/1700/12")).toEqual({ connection: "mail", mailbox: "INBOX", uid_validity: 1700, uid: 12 });
    expect(parseImapRef("gmail/%5BGmail%5D%2FAll%20Mail/9/3")).toEqual({ connection: "gmail", mailbox: "[Gmail]/All Mail", uid_validity: 9, uid: 3 });
    for (const bad of ["", "mail/INBOX/1700", "mail/INBOX/1700/0", "mail/INBOX/x/12", "mail//1700/12", "mail/INBOX/1700/12/13", "mail/%E0%A4%A/1/2", "mail/[Gmail]%2FAll/1/2", "mail/INBOX/1/99999999999", "mail/IN\nBOX/1/2", 12, null]) {
      expect(parseImapRef(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("reads one message's headers by UID from a mailbox opened read-only — never its body — and refuses a renumbered or missing one", async () => {
    const s = await server();
    const session = await openImap(options(s));
    try {
      const m = await session.readMessage("INBOX", 12, 1700);
      expect(m).toMatchObject({ ref: "mail/INBOX/1700/12", subject: "Café plans ☕", message_id: "<a-12@example.net>", from: { address: "ada@example.net" } });
      expect(JSON.stringify(m)).not.toMatch(/BODY-MARKER|secret recipe/);
      expect(await session.readMessage("INBOX", 12, 1699).catch((e: ImapError) => e.code)).toBe("changed");
      expect(await session.readMessage("INBOX", 99, 1700).catch((e: ImapError) => e.code)).toBe("not_found");
      expect(await session.readMessage("INBOX", 0).catch((e: ImapError) => e.code)).toBe("not_found");
      expect(s.commands.some((l) => / SELECT /.test(l))).toBe(false);
      expect(s.commands.filter((l) => / UID FETCH /.test(l)).every((l) => l.includes("BODY.PEEK[HEADER.FIELDS ("))).toBe(true);
      expect(s.mailboxes[0]!.messages.map((m) => m.flags)).toEqual([[], ["\\Seen"], []]);
    } finally {
      await session.close();
    }
  });

  it("the imap types are read by the mail sync, so their app password is one the console is delivered", async () => {
    const s = await server();
    const catalog = catalogOf([mailFile(s)], { types: TYPES, secrets: secretsYaml(s) });
    expect(TYPES.map((t) => t.sync)).toEqual([MAIL_SYNC, MAIL_SYNC]);
    expect(syncSecretNames(catalog)).toEqual(["mail_password"]);
  });

  it("opens the one mailbox the sync reads — or the one named — through the host guard, and dials nothing until asked", async () => {
    const s = await server();
    const catalog = catalogOf([mailFile(s)], { types: TYPES, secrets: secretsYaml(s) });
    const opened = openSyncImap({ catalog, sync: MAIL_SYNC, module: "imap", secrets: source() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(s.connections).toBe(0);
    expect(opened.sync).toMatchObject({ connection: "mail", provider: "imap", server: `${s.host}:${s.port}`, username: USER, capabilities: ["read", "draft"], raise: {} });
    const session = await opened.sync.open();
    await session.close();
    expect(opened.sync.secretsUsed()).toEqual(["mail_password"]);
    expect(JSON.stringify(opened.sync)).not.toContain(PASSWORD);

    // by name: another sync's reading does not matter, and an unknown name is absent
    expect(openSyncImap({ catalog, sync: MAIL_SYNC, module: "imap", connection: "mail", secrets: source() }).ok).toBe(true);
    expect(openSyncImap({ catalog, sync: MAIL_SYNC, module: "imap", connection: "nope", secrets: source() })).toMatchObject({ ok: false, status: "absent" });
    // no mail connection at all: absent, not an error
    expect(openSyncImap({ catalog: catalogOf([], { types: TYPES }), sync: MAIL_SYNC, module: "imap", secrets: source() })).toMatchObject({ ok: false, status: "absent" });
    // a module that does not implement it is the file's fault
    expect(openSyncImap({ catalog, sync: MAIL_SYNC, module: "caldav", secrets: source() })).toMatchObject({ ok: false, status: "failed" });
  });

  it("a password not granted to this connection is refused at open, before anything is dialled", async () => {
    const s = await server();
    const catalog = catalogOf([mailFile(s)], { types: TYPES, secrets: secretsYaml(s, "someone-else") });
    const opened = openSyncImap({ catalog, sync: MAIL_SYNC, module: "imap", secrets: source() });
    if (!opened.ok) throw new Error(opened.why);
    await expect(opened.sync.open()).rejects.toBeInstanceOf(EgressRefused);
    expect(s.connections).toBe(0);
  });
});

describe("the wire", () => {
  it("frames a literal split across chunks, and refuses one past the limit", () => {
    const f = new ResponseFramer();
    f.push(Buffer.from("* 1 FETCH (UID 5 BODY[HEADER.FIELDS (SUBJECT)] {18}\r\nSubject: hel"));
    expect(f.take()).toBeUndefined();
    f.push(Buffer.from("lo\r\n\r\n)\r\n* OK next\r\n"));
    const first = f.take()!;
    expect(tokenize(first.subarray(2))).toEqual(["1", "FETCH", ["UID", "5", "BODY[HEADER.FIELDS (SUBJECT)]", Buffer.from("Subject: hello\r\n\r\n")]]);
    expect(f.take()!.toString()).toBe("* OK next");
    const big = new ResponseFramer();
    big.push(Buffer.from("* 1 FETCH (BODY[] {99999999}\r\n"));
    expect(() => big.take()).toThrow(/past the/);
  });

  it("tokenizes quoted strings, NIL and nested lists; decodes modified UTF-7 names, internal dates and addresses", () => {
    expect(tokenize(Buffer.from('LIST (\\HasNoChildren \\Drafts) "/" "[Gmail]/Brouillons" NIL "a\\"b"'))).toEqual(["LIST", ["\\HasNoChildren", "\\Drafts"], "/", "[Gmail]/Brouillons", null, 'a"b']);
    expect(decodeMailboxName("Entw&APw-rfe")).toBe("Entwürfe");
    expect(decodeMailboxName("&ZeVnLIqe-")).toBe("日本語");
    expect(parseInternalDate("28-Sep-2026 10:01:00 -0400")).toBe("2026-09-28T14:01:00.000Z");
    expect(parseAddresses('team: a@example.com, "B, Esq." <b@example.com>;')).toEqual([
      { name: null, address: "a@example.com" },
      { name: "B, Esq.", address: "b@example.com" },
    ]);
    expect(parseAddresses("undisclosed-recipients:;")).toEqual([]);
  });
});
