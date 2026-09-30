// The `imap` provider (plan §2.6, §4 Q8; T4-15): a `mail` connection type
// whose implementation is this module — any IMAP server, and Gmail as a
// known service, signed in with an **app password**. Capabilities `read`
// and `draft`; **no SMTP, so nothing can send**.
//
// **How it reaches the server.** A mail server is not an HTTP service, so an
// IMAP connection has a reach class of its own (`reach.imap`: host, port,
// security, username, secret — core's `reachSchema`) and a host guard of its
// own (core's `planSocketEgress`), run before anything is dialled: the app
// password goes only to the exact `host:port` on the secret's *Sent only to*
// list, only over TLS (implicit TLS, RFC 8314; `security: plain` is for a
// server on this Mac and is refused anywhere else), and only when the owner
// granted it to `connection:<name>`. The value is filled into the one LOGIN
// command and nowhere else, learned by the redactor first — so a server that
// echoes it, or an error that carries it, shows the secret's name — and it is
// never in a URL, a file, a log, a run or an error.
//
// **Nothing sends.** No part of this package speaks SMTP or dials a
// submission port (25, 465, 587, 2525 — refused at the file and again here).
// IMAP itself cannot send: APPEND stores a message in a mailbox. And the
// commands this client can issue are a closed set (`IMAP_COMMANDS`), each
// with a fixed argument shape checked by `imapCommandLine` — the one function
// every command line passes through — so there is no path to a command that
// is not on the list. `APPEND` takes no mailbox argument from a caller: it
// writes to the mailbox the server marks `\Drafts` (RFC 6154), flagged
// `\Draft`, and nowhere else.
//
// **Read — headers, never bodies.** `readHeaders` EXAMINEs a mailbox (read
// only: no flag changes, not even `\Seen`) and fetches a fixed set of header
// fields with `BODY.PEEK` — the fetch items are a constant
// (`IMAP_FETCH_ITEMS`), not a parameter, so this client cannot fetch a
// message body. Mail is third-party text, and §4.12's rule holds: the
// reference, not the content. Every message comes back with a reference
// (`ref`) an assistant can ask about, its header text decoded, stripped of
// bidi and zero-width controls (core's `sanitizeForAgent`) and capped, and
// stamped `source: comms` — the provenance the data policy acts on (a brief
// carrying it never leaves the machine, `apps/console/src/dispatch.ts`).
//
// **Draft (`draft`)** — preview, then confirm. `previewDraft` renders the
// message (RFC 5322, plain text, UTF-8, base64 body) and returns it with a
// digest; `appendDraft` re-renders from the same input and refuses unless
// the digest matches (`changed`), then APPENDs it to Drafts. The owner sends
// it from their own mail app. The confirm token and who may press it belong
// to the console door (T4-17, `POST /api/mail/messages/:id/draft`).
//
// Pure over a socket: no Postgres, no vault (the dependency arrow).

import { createHash, randomUUID } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  EgressRefused,
  MAIL_SUBMISSION_PORTS,
  SecretRedactor,
  planSocketEgress,
  sanitizeForAgent,
  type ConnectionFile,
  type SecretSource,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";
import { MAX_RESPONSE_BYTES, ImapWireError, ResponseFramer, classify, decodeMailboxName, quoted, text, tokenize, untaggedStatus, type ImapValue } from "./imap-wire.js";

/** The builtin module name every IMAP connection type's `implementation` names. */
export const IMAP_MODULE = "imap";

/** The provenance every message read here carries — the class the data policy's `deny_sources` names (§4.12). */
export const IMAP_PROVENANCE = "comms";

/**
 * The known services (plan §2.6): each ships as its own connection type over
 * this module, pinned to its server. A connection of a known service pointed
 * anywhere else is refused; any other IMAP server is the `imap` type.
 */
export const IMAP_KNOWN_SERVICES: Readonly<Record<string, { label: string; host: string; port: number }>> = {
  "gmail-mail": { label: "Gmail", host: "imap.gmail.com", port: 993 },
};

/**
 * The only commands this client issues — a closed set. Each has a fixed
 * argument shape (`imapCommandLine`). SELECT is absent on purpose: EXAMINE
 * opens a mailbox read-only, so reading never changes a flag.
 */
export const IMAP_COMMANDS = ["CAPABILITY", "LOGIN", "LIST", "EXAMINE", "UID SEARCH", "UID FETCH", "APPEND", "NOOP", "LOGOUT"] as const;
export type ImapCommand = (typeof IMAP_COMMANDS)[number];

/** Commands refused by name, with the reason — what an author is likely to reach for, and why it is not here. */
export const IMAP_REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  SELECT: "EXAMINE opens a mailbox read-only — reading never changes a flag",
  STORE: "reading changes no flag, and nothing here marks, moves or deletes mail",
  "UID STORE": "reading changes no flag, and nothing here marks, moves or deletes mail",
  COPY: "nothing here moves or copies mail",
  "UID COPY": "nothing here moves or copies mail",
  MOVE: "nothing here moves or copies mail",
  "UID MOVE": "nothing here moves or copies mail",
  EXPUNGE: "nothing here deletes mail",
  "UID EXPUNGE": "nothing here deletes mail",
  DELETE: "nothing here deletes a mailbox",
  CREATE: "nothing here creates a mailbox",
  RENAME: "nothing here renames a mailbox",
  FETCH: "UID FETCH, with the fixed header items, is the one fetch",
  STARTTLS: "an IMAP connection is implicit TLS from the first byte (RFC 8314) — never upgraded from plain",
  AUTHENTICATE: "LOGIN with the app password is the one sign-in",
};

/** The header fields `readHeaders` fetches — enough to show a message, thread a reply and tell a person from a mailing list. */
export const IMAP_HEADER_FIELDS = [
  "DATE",
  "FROM",
  "SENDER",
  "REPLY-TO",
  "TO",
  "CC",
  "SUBJECT",
  "MESSAGE-ID",
  "IN-REPLY-TO",
  "REFERENCES",
  "LIST-ID",
  "AUTO-SUBMITTED",
  "PRECEDENCE",
] as const;

/** The one set of fetch items — a constant, so no caller can ask for a body. `BODY.PEEK` sets no `\Seen`. */
export const IMAP_FETCH_ITEMS = `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${IMAP_HEADER_FIELDS.join(" ")})])`;

/** The flags every draft is appended with. */
const DRAFT_FLAGS = "(\\Draft \\Seen)";

const DEFAULT_TIMEOUT_MS = 30_000; // limit: fixed — one IMAP command; past this the server is wedged, and the caller says so
const MAX_MAILBOXES = 2_000; // limit: fixed — past any one person's folder list; LIST stops rather than read a server's whole tree
/** How many messages one `readHeaders` returns at most — the newest, when more match. */
export const IMAP_MAX_MESSAGES = 500; // limit: fixed — a window of headers, not a mailbox export
const DEFAULT_MESSAGES = 50;
const MAX_SUBJECT = 998; // RFC 5322 §2.1.1: a line is at most 998 characters
const MAX_NAME = 256; // limit: fixed — a display name shown in a list
const MAX_ADDRESSES = 100; // limit: fixed — recipients read from one header
const MAX_REFERENCES = 100; // limit: fixed — a References chain kept for threading
/** The largest draft body `previewDraft` renders. */
export const IMAP_MAX_DRAFT_BYTES = 256 * 1024; // limit: fixed — a reply, not an attachment
const MAX_DRAFT_RECIPIENTS = 50; // limit: fixed — a reply's To and Cc together

/** Why an IMAP call failed or was refused. A closed set: each is a code path with a test (U3). */
export const IMAP_ERROR_CODES = [
  "unreachable",
  "tls",
  "timeout",
  "protocol",
  "too_large",
  "not_imap",
  "login_disabled",
  "unauthorized",
  "refused",
  "command_refused",
  "not_capable",
  "not_found",
  "no_drafts",
  "bad_draft",
  "changed",
  "closed",
] as const;
export type ImapErrorCode = (typeof IMAP_ERROR_CODES)[number];

/** A refusal or failure. Names the connection, the host and the reason — never a value; a server's words are redacted first. */
export class ImapError extends Error {
  override readonly name = "ImapError";
  constructor(
    readonly code: ImapErrorCode,
    message: string,
  ) {
    super(`imap (${code}): ${message}`);
  }
}

/** The file's `reach.imap`, validated. */
export type ImapReach = NonNullable<ConnectionFile["reach"]["imap"]>;

// ---- the connection file ------------------------------------------------------------

const LOOPBACK = /^(?:localhost|127(?:\.[0-9]{1,3}){3})$/;

/**
 * The rules an IMAP connection file must keep, beside the frozen schema —
 * run by `judgeConnection` for every provider this module implements. Empty =
 * none broken. Names hosts and fields, never a value.
 */
export function imapConnectionIssues(c: ConnectionFile, provider: string): string[] {
  const imap = c.reach.imap;
  if (!imap) return [`reach: ${provider} is reached by imap — reach.imap { host, port, username, secret }`];
  const issues: string[] = [];
  const known = Object.hasOwn(IMAP_KNOWN_SERVICES, provider) ? IMAP_KNOWN_SERVICES[provider] : undefined;
  if (known && (imap.host !== known.host || imap.port !== known.port || imap.security !== "tls")) {
    issues.push(`reach.imap: ${known.label} is ${known.host}:${known.port} over TLS and nowhere else — this connection is ${imap.host}:${imap.port}${imap.security === "plain" ? " without TLS" : ""}`);
  }
  if (imap.security === "plain" && !LOOPBACK.test(imap.host)) issues.push(`reach.imap.security: plain is for a server on this Mac only — ${imap.host} is reached over TLS`);
  if (MAIL_SUBMISSION_PORTS.includes(imap.port)) issues.push(`reach.imap.port: ${imap.port} is a mail submission port — nothing sends mail`);
  return issues;
}

// ---- the command line: the closed set -----------------------------------------------

const QUOTED = String.raw`"(?:[^"\\\r\n]|\\["\\])*"`;
const SHAPES: Readonly<Record<ImapCommand, RegExp>> = {
  CAPABILITY: /^$/,
  NOOP: /^$/,
  LOGOUT: /^$/,
  LOGIN: new RegExp(`^${QUOTED} ${QUOTED}$`),
  LIST: /^"" "\*"$/,
  EXAMINE: new RegExp(`^${QUOTED}$`),
  "UID SEARCH": /^(?:ALL|SINCE [0-9]{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{4})$/,
  "UID FETCH": new RegExp(`^[0-9]+(?:,[0-9]+)* ${IMAP_FETCH_ITEMS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  APPEND: new RegExp(`^${QUOTED} \\(\\\\Draft \\\\Seen\\) \\{[0-9]{1,7}\\}$`),
};

/**
 * The one way a command line is made. Refused, with `command_refused`, for a
 * command not in `IMAP_COMMANDS` (by name where `IMAP_REFUSED_COMMANDS` has
 * one), for arguments not of that command's fixed shape — a body fetch, a
 * flag store, a second command after a line break — and for a tag that is
 * not alphanumeric. The message never repeats the arguments (a LOGIN line
 * carries the password).
 */
export function imapCommandLine(tag: string, command: string, args = ""): string {
  if (!/^[A-Za-z0-9]{1,16}$/.test(tag)) throw new ImapError("command_refused", "a tag is 1–16 letters and digits");
  const upper = command.toUpperCase();
  if (!(IMAP_COMMANDS as readonly string[]).includes(command)) {
    const why = Object.hasOwn(IMAP_REFUSED_COMMANDS, upper) ? IMAP_REFUSED_COMMANDS[upper] : `the commands are ${IMAP_COMMANDS.join(", ")}`;
    throw new ImapError("command_refused", `${JSON.stringify(command.slice(0, 32))} is not a command this client issues — ${why}`);
  }
  if (/[\r\n\0]/.test(args) || !SHAPES[command as ImapCommand].test(args)) {
    throw new ImapError("command_refused", `${command}: arguments not of its fixed shape — refused before anything is written`);
  }
  return `${tag} ${command}${args === "" ? "" : ` ${args}`}\r\n`;
}

// ---- the socket ---------------------------------------------------------------------

/** How a session reaches its server. The default is Node's own TLS (certificate and host name verified) or, for loopback plain, TCP. A test hands in its own. */
export type ImapDialer = (to: { host: string; port: number; tls: boolean; timeoutMs: number }) => Promise<Socket>;

const TLS_ERROR = /CERT|SSL|TLS|SELF_SIGNED|ALTNAME|UNABLE_TO_(?:VERIFY|GET)|EPROTO/;

/** Node's TLS, verifying the certificate and the host name (the default), TLS 1.2 or later. */
export const defaultImapDialer: ImapDialer = ({ host, port, tls, timeoutMs }) =>
  new Promise<Socket>((resolve, reject) => {
    const socket: Socket = tls ? tlsConnect({ host, port, ...(isIP(host) ? {} : { servername: host }), minVersion: "TLSv1.2" }) : netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`no answer from ${host}:${port} in ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once(tls ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });

/** Sequential commands over one socket. No pipelining: a command is written only after the last one's tagged response. */
class Wire {
  readonly #socket: Socket;
  readonly #framer = new ResponseFramer();
  readonly #ready: Buffer[] = [];
  #waiter: ((v: Buffer | Error) => void) | undefined;
  #failure: Error | undefined;
  #tag = 0;

  constructor(
    socket: Socket,
    readonly redactor: SecretRedactor,
    readonly timeoutMs: number,
    readonly where: string,
  ) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      try {
        this.#framer.push(chunk);
        for (let r = this.#framer.take(); r !== undefined; r = this.#framer.take()) this.#deliver(r);
      } catch (err) {
        this.#fail(err instanceof ImapWireError ? new ImapError(err.code, `${where}: ${err.message}`) : new ImapError("protocol", `${where}: an unreadable response`));
        socket.destroy();
      }
    });
    socket.on("error", (err) => this.#fail(new ImapError("unreachable", `${where}: ${this.redactor.redactText(err.message)}`)));
    socket.on("close", () => this.#fail(new ImapError("closed", `${where} closed the connection`)));
  }

  #deliver(r: Buffer): void {
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = undefined;
      w(r);
    } else this.#ready.push(r);
  }

  #fail(err: Error): void {
    if (this.#failure) return;
    this.#failure = err;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = undefined;
      w(err);
    }
  }

  get closed(): boolean {
    return this.#failure !== undefined;
  }

  /** The next response, or the failure that ended the connection. */
  next(): Promise<Buffer> {
    const queued = this.#ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        const err = new ImapError("timeout", `${this.where} did not answer in ${this.timeoutMs} ms`);
        this.#fail(err);
        this.#socket.destroy();
        reject(err);
      }, this.timeoutMs);
      this.#waiter = (v) => {
        clearTimeout(timer);
        if (v instanceof Error) reject(v);
        else resolve(v);
      };
    });
  }

  write(data: string | Buffer): void {
    if (this.#failure) throw this.#failure;
    this.#socket.write(data);
  }

  nextTag(): string {
    this.#tag += 1;
    return `m${this.#tag}`;
  }

  end(): void {
    this.#socket.end();
    this.#socket.destroy();
  }
}

/** A command's untagged responses and its tagged completion. */
interface Completed {
  untagged: Buffer[];
  code: string | undefined;
  text: string;
}

// ---- header text --------------------------------------------------------------------

/** Undo header folding (RFC 5322 §2.2.3) and split into fields. Names lowercased; the last of a repeated field wins. */
export function headerFields(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    out.set(name, line.slice(colon + 1).trim());
  }
  return out;
}

function decodeCharset(bytes: Buffer, charset: string): string | undefined {
  try {
    return new TextDecoder(charset.replace(/\*.*$/, "").trim().toLowerCase()).decode(bytes);
  } catch {
    return undefined;
  }
}

/** RFC 2047 encoded words → text. Adjacent encoded words separated only by whitespace join without it. An undecodable word stays as it was. */
export function decodeEncodedWords(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const decoded = value.replace(word, (whole, charset: string, enc: string, payload: string) => {
    let bytes: Buffer;
    if (enc.toUpperCase() === "B") bytes = Buffer.from(payload, "base64");
    else bytes = Buffer.from(payload.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    const t = decodeCharset(bytes, charset);
    return t === undefined ? whole : `\u0000EW${t}\u0000`;
  });
  // whitespace between two decoded words is dropped (RFC 2047 §6.2), then the markers go
  return decoded.replace(/\u0000(\s+)\u0000EW/g, "\u0000\u0000EW").replace(/\u0000EW/g, "").replace(/\u0000/g, "");
}

/** Header text as it may be shown to a person or an agent: encoded words decoded, controls removed, bidi and zero-width stripped, capped. */
function clean(value: string | undefined, max: number): string {
  if (value === undefined) return "";
  const t = sanitizeForAgent(decodeEncodedWords(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim());
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One mailbox address from a header, with its display name. */
export interface MailAddress {
  name: string | null;
  address: string;
}

/** Split an address list on commas outside quotes, angle brackets and comments. */
function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let k = 0; k < value.length; k++) {
    const c = value[k]!;
    if (quote) {
      cur += c;
      if (c === "\\" && k + 1 < value.length) cur += value[++k];
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if ((c === "," || c === ";") && angle === 0 && paren === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** An address list (RFC 5322 §3.4), leniently: `Name <a@b>`, `a@b`, `"Name" <a@b>`, groups flattened. Anything without an `@` is dropped. */
export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  for (let part of splitAddresses(value)) {
    // a group's display name (`team: a@b, c@d;`) is not an address
    const group = /^[^"<]*?:\s*(.*)$/.exec(part);
    if (group) part = group[1]!;
    const angle = /^(.*)<([^<>]*)>\s*(?:\(.*\))?$/.exec(part);
    const address = (angle ? angle[2]! : part.replace(/\(.*?\)/g, "")).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const rawName = angle ? angle[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1") : "";
    const name = clean(rawName, MAX_NAME);
    out.push({ name: name === "" ? null : name, address: clean(address, 320).toLowerCase() });
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^<>\s]{1,996}>/g)].map((m) => m[0]).slice(-MAX_REFERENCES);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `28-Sep-2026 10:00:00 +0000` (RFC 3501 date-time) → ISO, or null. */
export function parseInternalDate(value: string | undefined): string | null {
  const m = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (month < 0) return null;
  const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const t = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A SEARCH date (`28-Sep-2026`), in UTC. */
export function searchDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// ---- what a read returns ------------------------------------------------------------

/** A mailbox as LIST names it. `name` is the server's (modified UTF-7) — what commands use; `label` is for people. */
export interface ImapMailbox {
  name: string;
  label: string;
  delimiter: string | null;
  /** lowercased, e.g. `\drafts`, `\noselect` */
  attributes: string[];
}

/** A mailbox opened read-only. */
export interface ImapExamined {
  mailbox: string;
  exists: number;
  uid_validity: number | null;
  uid_next: number | null;
}

/** One message's headers — never its body. Text fields are decoded, sanitised and capped. */
export interface ImapMessage {
  /** what an assistant asks about: `<connection>/<mailbox>/<uidvalidity>/<uid>` — the reference, not the content (§4.12) */
  ref: string;
  /** always `comms` — the data policy's provenance class */
  source: typeof IMAP_PROVENANCE;
  mailbox: string;
  uid: number;
  uid_validity: number;
  /** the Date header, or the server's arrival time when that does not parse */
  date: string | null;
  received: string | null;
  from: MailAddress | null;
  reply_to: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  /** lowercased: `\seen`, `\answered`, `\flagged`, `\draft`, and any keyword */
  flags: string[];
  size: number | null;
  /** a list or an automatic sender says so (List-Id, Auto-Submitted other than `no`, Precedence bulk/list/junk) — what a deterministic prefilter reads (§4.12) */
  automated: boolean;
}

/** Headers of the newest messages in one mailbox. */
export interface ImapRead {
  connection: string;
  source: typeof IMAP_PROVENANCE;
  mailbox: ImapExamined;
  /** newest first */
  messages: ImapMessage[];
  /** matched, before the limit */
  matched: number;
}

// ---- drafts -------------------------------------------------------------------------

/** What a draft says. Addresses only — no display names, no Bcc (a draft is the owner's to address and send). */
export interface DraftInput {
  /** the owner's address; default the connection's username when it is one */
  from?: string | undefined;
  to: string[];
  cc?: string[] | undefined;
  subject: string;
  body: string;
  /** the message being answered (`<id@host>`), for threading */
  in_reply_to?: string | undefined;
  references?: string[] | undefined;
}

/** A rendered draft: the exact bytes APPENDed, and what the confirm must name. */
export interface DraftPlan {
  message: string;
  digest: string;
  /** RFC 5322 date the message carries — part of the confirm */
  date: string;
  /** its Message-ID — part of the confirm */
  message_id: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  in_reply_to: string | null;
  references: string[];
  bytes: number;
}

/** What `previewDraft` returns: where it would go and what it says. */
export interface DraftPreview {
  connection: string;
  /** the server's name for Drafts, and its label */
  mailbox: string;
  mailbox_label: string;
  plan: DraftPlan;
  /** pass back to `appendDraft` */
  confirm: DraftConfirm;
}

export interface DraftConfirm {
  digest: string;
  date: string;
  message_id: string;
}

export interface AppendResult {
  connection: string;
  mailbox: string;
  /** the server's UID for it, when it says (UIDPLUS) */
  uid: number | null;
  message_id: string;
  digest: string;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,994}>$/;

function draftAddress(a: string, field: string): string {
  const s = String(a).trim();
  if (!ADDRESS.test(s)) throw new ImapError("bad_draft", `${field}: not an address this release drafts to (ASCII addr-spec, no display name)`);
  return s;
}

/** RFC 5322 date, in UTC. */
function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** A subject header value: ASCII as it is; anything else as RFC 2047 B words of at most 45 UTF-8 bytes each, folded. */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk !== "") words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/**
 * Render a draft (RFC 5322, text/plain, UTF-8, base64 body). Deterministic
 * given `fixed` — so the confirm re-renders exactly what the preview showed.
 * Refused (`bad_draft`): an address that is not a plain ASCII addr-spec, no
 * recipient or too many, a subject with a line break, a malformed
 * Message-ID, a body past `IMAP_MAX_DRAFT_BYTES`.
 */
export function planDraft(input: DraftInput, opts: { username?: string | undefined; fixed?: { date: string; message_id: string } | undefined; now?: Date | undefined } = {}): DraftPlan {
  if (input === null || typeof input !== "object") throw new ImapError("bad_draft", "a draft is { to, subject, body, cc?, from?, in_reply_to?, references? }");
  const fromRaw = input.from ?? (opts.username && ADDRESS.test(opts.username) ? opts.username : undefined);
  if (fromRaw === undefined) throw new ImapError("bad_draft", "from: the connection's username is not an address — name the owner's address");
  const from = draftAddress(fromRaw, "from");
  if (!Array.isArray(input.to) || (input.cc !== undefined && !Array.isArray(input.cc))) throw new ImapError("bad_draft", "to and cc are lists of addresses");
  const to = input.to.map((a, i) => draftAddress(a, `to.${i}`));
  const cc = (input.cc ?? []).map((a, i) => draftAddress(a, `cc.${i}`));
  if (to.length === 0) throw new ImapError("bad_draft", "to: a draft has at least one recipient");
  if (to.length + cc.length > MAX_DRAFT_RECIPIENTS) throw new ImapError("bad_draft", `to + cc: at most ${MAX_DRAFT_RECIPIENTS} recipients`);
  if (typeof input.subject !== "string" || /[\r\n\0]/.test(input.subject)) throw new ImapError("bad_draft", "subject: one line of text");
  const subject = input.subject.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (subject.length > 900) throw new ImapError("bad_draft", "subject: at most 900 characters");
  if (typeof input.body !== "string") throw new ImapError("bad_draft", "body: text");
  if (Buffer.byteLength(input.body, "utf8") > IMAP_MAX_DRAFT_BYTES) throw new ImapError("bad_draft", `body: past ${IMAP_MAX_DRAFT_BYTES} bytes — a draft is a reply, not an attachment`);
  const inReplyTo = input.in_reply_to === undefined ? null : String(input.in_reply_to).trim();
  if (inReplyTo !== null && !MSG_ID.test(inReplyTo)) throw new ImapError("bad_draft", "in_reply_to: a Message-ID, <id@host>");
  const references = (input.references ?? []).map((r) => String(r).trim());
  if (!Array.isArray(input.references ?? []) || references.some((r) => !MSG_ID.test(r)) || references.length > MAX_REFERENCES) {
    throw new ImapError("bad_draft", `references: at most ${MAX_REFERENCES} Message-IDs, each <id@host>`);
  }
  if (inReplyTo !== null && !references.includes(inReplyTo)) references.push(inReplyTo);

  const domain = from.slice(from.indexOf("@") + 1).toLowerCase();
  const date = opts.fixed?.date ?? rfc5322Date(opts.now ?? new Date());
  const messageId = opts.fixed?.message_id ?? `<${randomUUID()}@${domain}>`;
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(date)) throw new ImapError("bad_draft", "date: an RFC 5322 date");
  if (!MSG_ID.test(messageId)) throw new ImapError("bad_draft", "message_id: <id@host>");

  const body = Buffer.from(input.body.replace(/\r\n|\r|\n/g, "\r\n"), "utf8").toString("base64");
  const lines = [
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to.join(",\r\n ")}`,
    ...(cc.length ? [`Cc: ${cc.join(",\r\n ")}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join("\r\n ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(body.match(/.{1,76}/g) ?? []),
    "",
  ];
  const message = lines.join("\r\n");
  const digest = createHash("sha256").update(message, "utf8").digest("hex");
  return { message, digest, date, message_id: messageId, from, to, cc, subject, in_reply_to: inReplyTo, references, bytes: Buffer.byteLength(message, "utf8") };
}

// ---- the session --------------------------------------------------------------------

export interface OpenImapOptions {
  /** the connection's name — its grantee is `connection:<name>` */
  connection: string;
  reach: ImapReach;
  /** what its provider declares it can do — a read needs `read`, a draft needs `draft`, checked before anything is sent */
  capabilities: readonly string[];
  /** `.metistry/secrets.yaml`, parsed — the *Sent only to* list and the grants */
  secretsFile: SecretsFile;
  /** where the app password comes from (the Keychain in the CLI; the delivered environment in the console) */
  source: SecretSource;
  redactor?: SecretRedactor | undefined;
  /** secret names whose Ask grant the owner approved for this session */
  approved?: readonly string[] | undefined;
  dial?: ImapDialer | undefined;
  timeoutMs?: number | undefined;
  /** told the NAMES (never values) once the password has been sent */
  onUse?: ((use: { names: string[]; destination: string }) => void | Promise<void>) | undefined;
}

/** An open, signed-in IMAP connection. `close()` it. */
export class ImapSession {
  readonly #wire: Wire;
  readonly #opts: OpenImapOptions;
  #capabilities: string[];
  #mailboxes: ImapMailbox[] | undefined;

  /** @internal — `openImap` makes one */
  constructor(wire: Wire, opts: OpenImapOptions, capabilities: string[]) {
    this.#wire = wire;
    this.#opts = opts;
    this.#capabilities = capabilities;
  }

  get connection(): string {
    return this.#opts.connection;
  }

  /** What the server said it can do, uppercased. */
  get serverCapabilities(): readonly string[] {
    return this.#capabilities;
  }

  async #run(command: ImapCommand, args = "", literal?: Buffer): Promise<Completed> {
    const tag = this.#wire.nextTag();
    this.#wire.write(imapCommandLine(tag, command, args));
    return complete(this.#wire, tag, command, literal);
  }

  #need(capability: "read" | "draft"): void {
    if (!this.#opts.capabilities.includes(capability)) throw new ImapError("not_capable", `${this.#opts.connection}: its provider does not declare ${capability}`);
  }

  /** Every mailbox, as LIST names it. */
  async mailboxes(): Promise<ImapMailbox[]> {
    if (this.#mailboxes) return this.#mailboxes;
    const done = await this.#run("LIST", `"" "*"`);
    const out: ImapMailbox[] = [];
    for (const raw of done.untagged) {
      const t = tokenize(raw);
      if (String(t[0]).toUpperCase() !== "LIST" || !Array.isArray(t[1])) continue;
      const name = text(t[3]);
      if (name === undefined) continue;
      out.push({
        name,
        label: decodeMailboxName(name),
        delimiter: text(t[2]) ?? null,
        attributes: (t[1] as ImapValue[]).map((a) => String(text(a) ?? "").toLowerCase()).filter((a) => a !== ""),
      });
      if (out.length >= MAX_MAILBOXES) break;
    }
    this.#mailboxes = out;
    return out;
  }

  /** The mailbox drafts go to: the one the server marks `\Drafts` (RFC 6154), else a top-level mailbox named Drafts. `no_drafts` when neither. */
  async drafts(): Promise<ImapMailbox> {
    const all = await this.mailboxes();
    const selectable = all.filter((m) => !m.attributes.includes("\\noselect") && !m.attributes.includes("\\nonexistent"));
    const marked = selectable.filter((m) => m.attributes.includes("\\drafts"));
    if (marked.length === 1) return marked[0]!;
    if (marked.length > 1) throw new ImapError("no_drafts", `${this.#opts.connection}: the server marks ${marked.length} mailboxes \\Drafts — which one is not a guess this client makes`);
    const named = selectable.filter((m) => m.name.toLowerCase() === "drafts");
    if (named.length === 1) return named[0]!;
    throw new ImapError("no_drafts", `${this.#opts.connection}: no mailbox is marked \\Drafts and none is named Drafts — a draft has nowhere to go`);
  }

  /** Open a mailbox read-only (EXAMINE). `not_found` when the server says there is no such mailbox. */
  async examine(mailbox: string): Promise<ImapExamined> {
    this.#need("read");
    let done: Completed;
    try {
      done = await this.#run("EXAMINE", quoted(mailbox, "the mailbox name"));
    } catch (err) {
      if (err instanceof ImapError && err.code === "refused") throw new ImapError("not_found", `${this.#opts.connection}: no mailbox ${JSON.stringify(decodeMailboxName(mailbox))} — ${err.message}`);
      throw err;
    }
    let exists = 0;
    let uidValidity: number | null = null;
    let uidNext: number | null = null;
    const codeNum = (code: string | undefined, key: string): number | null => {
      const m = code && new RegExp(`^${key} (\\d+)`, "i").exec(code);
      return m ? Number(m[1]) : null;
    };
    for (const raw of done.untagged) {
      const s = untaggedStatus(raw);
      if (s) {
        uidValidity ??= codeNum(s.code, "UIDVALIDITY");
        uidNext ??= codeNum(s.code, "UIDNEXT");
        continue;
      }
      const m = /^(\d+) EXISTS$/i.exec(raw.toString("latin1"));
      if (m) exists = Number(m[1]);
    }
    return { mailbox, exists, uid_validity: uidValidity, uid_next: uidNext };
  }

  /**
   * The headers of the newest messages in `mailbox` — since `since` when
   * given, at most `limit` (default 50, never past `IMAP_MAX_MESSAGES`).
   * Never a body: the fetch items are `IMAP_FETCH_ITEMS`, with BODY.PEEK.
   */
  async readHeaders(mailbox = "INBOX", opts: { since?: Date | undefined; limit?: number | undefined } = {}): Promise<ImapRead> {
    this.#need("read");
    const limit = Math.max(1, Math.min(IMAP_MAX_MESSAGES, Math.floor(opts.limit ?? DEFAULT_MESSAGES)));
    const box = await this.examine(mailbox);
    const base: ImapRead = { connection: this.#opts.connection, source: IMAP_PROVENANCE, mailbox: box, messages: [], matched: 0 };
    if (box.exists === 0) return base;
    const search = await this.#run("UID SEARCH", opts.since ? `SINCE ${searchDate(opts.since)}` : "ALL");
    const uids: number[] = [];
    for (const raw of search.untagged) {
      const t = raw.toString("latin1").split(" ");
      if (t[0]?.toUpperCase() !== "SEARCH") continue;
      for (const n of t.slice(1)) if (/^\d+$/.test(n)) uids.push(Number(n));
    }
    uids.sort((a, b) => a - b);
    const chosen = uids.slice(-limit);
    if (chosen.length === 0) return { ...base, matched: 0 };
    const fetched = await this.#run("UID FETCH", `${chosen.join(",")} ${IMAP_FETCH_ITEMS}`);
    const messages: ImapMessage[] = [];
    for (const raw of fetched.untagged) {
      const m = fetchedMessage(raw, this.#opts.connection, mailbox, box.uid_validity ?? 0);
      if (m && chosen.includes(m.uid)) messages.push(m);
    }
    messages.sort((a, b) => b.uid - a.uid);
    return { ...base, messages, matched: uids.length };
  }

  /** Render a draft and say where it would go. Sends nothing; appends nothing. */
  async previewDraft(input: DraftInput, now?: Date): Promise<DraftPreview> {
    this.#need("draft");
    const plan = planDraft(input, { username: this.#opts.reach.username, now });
    const box = await this.drafts();
    return { connection: this.#opts.connection, mailbox: box.name, mailbox_label: box.label, plan, confirm: { digest: plan.digest, date: plan.date, message_id: plan.message_id } };
  }

  /**
   * APPEND the draft its preview showed to Drafts, flagged `\Draft`. The
   * draft is re-rendered from `input` with the preview's date and Message-ID;
   * a digest that differs from the confirm's is `changed` and nothing is
   * written. There is no mailbox argument: Drafts is the only place it goes.
   */
  async appendDraft(input: DraftInput, confirm: DraftConfirm): Promise<AppendResult> {
    this.#need("draft");
    if (!confirm || typeof confirm.digest !== "string") throw new ImapError("changed", "a draft is appended only with the confirm its preview returned");
    const plan = planDraft(input, { username: this.#opts.reach.username, fixed: { date: confirm.date, message_id: confirm.message_id } });
    if (plan.digest !== confirm.digest) throw new ImapError("changed", `${this.#opts.connection}: the draft is not the one previewed — preview it again`);
    const box = await this.drafts();
    const bytes = Buffer.from(plan.message, "utf8");
    const done = await this.#run("APPEND", `${quoted(box.name, "the Drafts mailbox name")} ${DRAFT_FLAGS} {${bytes.length}}`, bytes);
    const uid = done.code && /^APPENDUID \d+ (\d+)$/i.exec(done.code);
    return { connection: this.#opts.connection, mailbox: box.name, uid: uid ? Number(uid[1]) : null, message_id: plan.message_id, digest: plan.digest };
  }

  /** LOGOUT and close. Never throws. */
  async close(): Promise<void> {
    if (!this.#wire.closed) {
      try {
        await this.#run("LOGOUT");
      } catch {
        /* closing anyway */
      }
    }
    this.#wire.end();
  }
}

/** Read responses until `tag` completes. A continuation is answered with `literal` once; NO/BAD is an error with the server's words redacted. */
async function complete(wire: Wire, tag: string, command: ImapCommand, literal?: Buffer): Promise<Completed> {
  const untagged: Buffer[] = [];
  let total = 0;
  let sent = false;
  for (;;) {
    const raw = await wire.next();
    total += raw.length;
    if (total > MAX_RESPONSE_BYTES) {
      wire.end();
      throw new ImapError("too_large", `${wire.where}: ${command} answered past ${MAX_RESPONSE_BYTES} bytes`);
    }
    const r = classify(raw);
    if (r.kind === "untagged") {
      const bye = untaggedStatus(r.raw);
      if (bye?.status === "BYE" && command !== "LOGOUT") throw new ImapError("closed", `${wire.where} said goodbye: ${wire.redactor.redactText(bye.text).slice(0, 200)}`);
      untagged.push(r.raw);
      continue;
    }
    if (r.kind === "continuation") {
      if (!literal || sent) throw new ImapError("protocol", `${wire.where} asked for more of ${command} than it has`);
      wire.write(Buffer.concat([literal, Buffer.from("\r\n")]));
      sent = true;
      continue;
    }
    if (r.tag !== tag) throw new ImapError("protocol", `${wire.where} answered a command that was not sent`);
    if (r.status === "OK") return { untagged, code: r.code, text: r.text };
    const said = wire.redactor.redactText(`${r.code ? `[${r.code}] ` : ""}${r.text}`).slice(0, 300);
    throw new ImapError(command === "LOGIN" ? "unauthorized" : "refused", `${wire.where} refused ${command}: ${said}`);
  }
}

/** One `* n FETCH (…)` → a message, or undefined when it carries no headers (an unsolicited flag update). */
function fetchedMessage(raw: Buffer, connection: string, mailbox: string, uidValidity: number): ImapMessage | undefined {
  let t: ImapValue[];
  try {
    t = tokenize(raw);
  } catch {
    return undefined;
  }
  if (String(t[1]).toUpperCase() !== "FETCH" || !Array.isArray(t[2])) return undefined;
  const items = t[2];
  let uid: number | undefined;
  let flags: string[] = [];
  let internal: string | undefined;
  let size: number | null = null;
  let header: string | undefined;
  for (let k = 0; k + 1 < items.length; k += 2) {
    const key = String(text(items[k]) ?? "").toUpperCase();
    const v = items[k + 1];
    if (key === "UID") uid = Number(text(v));
    else if (key === "FLAGS" && Array.isArray(v)) flags = v.map((f) => String(text(f) ?? "").toLowerCase()).filter((f) => f !== "");
    else if (key === "INTERNALDATE") internal = text(v);
    else if (key === "RFC822.SIZE") size = Number(text(v)) || null;
    else if (key.startsWith("BODY[HEADER.FIELDS")) header = text(v) ?? "";
  }
  if (uid === undefined || !Number.isInteger(uid) || header === undefined) return undefined;
  const h = headerFields(header);
  const dateHeader = h.get("date");
  const parsed = dateHeader ? Date.parse(dateHeader.replace(/\s*\([^)]*\)\s*$/, "")) : NaN;
  const received = parseInternalDate(internal);
  const from = parseAddresses(h.get("from"))[0] ?? parseAddresses(h.get("sender"))[0] ?? null;
  const auto = (h.get("auto-submitted") ?? "").trim().toLowerCase();
  const precedence = (h.get("precedence") ?? "").trim().toLowerCase();
  const inReplyTo = messageIds(h.get("in-reply-to"))[0] ?? null;
  const msgId = messageIds(h.get("message-id"))[0] ?? null;
  return {
    ref: `${connection}/${encodeURIComponent(mailbox)}/${uidValidity}/${uid}`,
    source: IMAP_PROVENANCE,
    mailbox,
    uid,
    uid_validity: uidValidity,
    date: Number.isNaN(parsed) ? received : new Date(parsed).toISOString(),
    received,
    from,
    reply_to: parseAddresses(h.get("reply-to")),
    to: parseAddresses(h.get("to")),
    cc: parseAddresses(h.get("cc")),
    subject: clean(h.get("subject"), MAX_SUBJECT),
    message_id: msgId,
    in_reply_to: inReplyTo,
    references: messageIds(h.get("references")),
    flags,
    size,
    automated: h.has("list-id") || (auto !== "" && auto !== "no") || ["bulk", "list", "junk"].includes(precedence),
  };
}

function capabilitiesFrom(code: string | undefined): string[] | undefined {
  const m = code && /^CAPABILITY (.*)$/i.exec(code);
  return m ? m[1]!.trim().split(/\s+/).map((c) => c.toUpperCase()) : undefined;
}

/**
 * Open and sign in. In order, and each step refuses before the next:
 *
 *   1. the host guard (core's `planSocketEgress`) — the password may go to
 *      this exact `host:port`, over TLS, for this connection, or nothing is
 *      dialled (`EgressRefused`: host_not_listed, cleartext, not_granted,
 *      needs_approval);
 *   2. a submission port is never dialled;
 *   3. the value is read (`missing_secret` when there is none) and learned
 *      by the redactor;
 *   4. the greeting must be IMAP4rev1 (or rev2), not BYE; LOGINDISABLED is
 *      refused rather than worked around;
 *   5. LOGIN — a NO is `unauthorized`, with the server's words redacted.
 */
export async function openImap(opts: OpenImapOptions): Promise<ImapSession> {
  const { reach, connection } = opts;
  const redactor = opts.redactor ?? new SecretRedactor();
  const tls = reach.security === "tls";
  const plan = planSocketEgress({ host: reach.host, port: reach.port, tls }, [reach.secret], {
    secrets: opts.secretsFile,
    grantee: `connection:${connection}`,
    purpose: "service",
    redactor,
    approved: opts.approved,
  });
  const where = `${connection} (${plan.destination.entry})`;
  if (MAIL_SUBMISSION_PORTS.includes(reach.port)) throw new ImapError("refused", `${where}: port ${reach.port} is a mail submission port — nothing sends mail`);
  const value = await opts.source.value(reach.secret);
  if (value === undefined || value === "") {
    throw new EgressRefused("missing_secret", [reach.secret], plan.destination.entry, `no item in this instance for ${reach.secret} — \`metistry secrets set ${reach.secret}\` stores one; nothing was sent`);
  }
  redactor.learn(reach.secret, value);
  if (/[\r\n\0]/.test(value) || /[^\x01-\x7f]/.test(value)) {
    throw new ImapError("unauthorized", `${where}: the app password in ${reach.secret} has a character an IMAP LOGIN cannot carry (a line break, NUL, or non-ASCII) — nothing was sent`);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let socket: Socket;
  try {
    socket = await (opts.dial ?? defaultImapDialer)({ host: reach.host, port: reach.port, tls, timeoutMs });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = redactor.redactText(e?.message ?? String(err));
    if (e?.code === "ETIMEDOUT") throw new ImapError("timeout", `${where}: ${msg}`);
    if (tls && TLS_ERROR.test(`${e?.code ?? ""} ${msg}`)) throw new ImapError("tls", `${where}: the server's certificate or TLS was refused — ${msg}`);
    throw new ImapError("unreachable", `${where}: ${msg}`);
  }
  const wire = new Wire(socket, redactor, timeoutMs, where);
  try {
    // the greeting: OK (or PREAUTH), never BYE
    const first = classify(await wire.next());
    const greeting = first.kind === "untagged" ? untaggedStatus(first.raw) : undefined;
    if (!greeting || greeting.status === "BYE" || greeting.status === "NO" || greeting.status === "BAD") {
      throw new ImapError("not_imap", `${where} did not greet as an IMAP server${greeting ? `: ${redactor.redactText(greeting.text).slice(0, 200)}` : ""}`);
    }
    let caps = capabilitiesFrom(greeting.code);
    if (!caps) {
      const tag = wire.nextTag();
      wire.write(imapCommandLine(tag, "CAPABILITY"));
      const done = await complete(wire, tag, "CAPABILITY");
      for (const raw of done.untagged) {
        const line = raw.toString("latin1");
        if (/^CAPABILITY /i.test(line)) caps = line.slice(11).trim().split(/\s+/).map((c) => c.toUpperCase());
      }
    }
    caps ??= [];
    if (!caps.includes("IMAP4REV1") && !caps.includes("IMAP4REV2")) throw new ImapError("not_imap", `${where} does not speak IMAP4rev1`);
    if (greeting.status !== "PREAUTH") {
      if (caps.includes("LOGINDISABLED")) throw new ImapError("login_disabled", `${where} refuses LOGIN on this connection (LOGINDISABLED) — nothing was sent`);
      const tag = wire.nextTag();
      // the one line that carries the value: built, written, and never kept, logged or put in an error
      wire.write(imapCommandLine(tag, "LOGIN", `${quoted(reach.username, "the username")} ${quoted(value, reach.secret)}`));
      let done: Completed;
      try {
        done = await complete(wire, tag, "LOGIN");
      } finally {
        await opts.onUse?.({ names: plan.names, destination: plan.destination.entry });
      }
      caps = capabilitiesFrom(done.code) ?? caps;
    }
    return new ImapSession(wire, { ...opts, redactor }, caps);
  } catch (err) {
    wire.end();
    if (err instanceof ImapError && err.code === "unauthorized") {
      throw new ImapError("unauthorized", `${err.message.replace(/^imap \(unauthorized\): /, "")} — sign in with an app password (for Gmail: 2-Step Verification on, then an app password), never the account's own password`);
    }
    if (err instanceof ImapError || err instanceof EgressRefused) throw err;
    if (err instanceof ImapWireError) throw new ImapError(err.code, `${where}: ${err.message}`);
    throw redactor.redactError(err);
  }
}
