// mail-messages: the inbox's headers, and a `message` request for each
// message that looks like it waits on the owner's reply (design-build-plan
// §2.6, §2.12; ticket T4-17; R7, C108).
//
// **Headers only — the reference, not the content (§4.12).** The IMAP
// provider cannot fetch a body (packages/connections `imap.ts`: the fetch
// items are a constant with BODY.PEEK of fixed header fields), so nothing
// here ever holds one, and no body text reaches a request, a run, the
// assistant or an agent. Each message comes back decoded, stripped of bidi
// and zero-width tricks (core's `sanitizeForAgent`) and stamped
// `source: comms`, and so is every request raised from it.
//
// **Inferred, and it says so.** §2.12's message row is the assistant's
// inference. Reading a body to infer from is gated behind the PoC-13 re-run
// bar (§4.12: ≥80% precision on a held-out set and zero misses on a
// must-catch stratum, on-device, with a deterministic redaction pass over
// what the model emits) and is not built; what this sync infers it infers
// from the headers, by rules, and every request carries `inferred: {from:
// "headers", by: "rules"}` and its reason in words. The rules are the
// deterministic prefilter §4.12 asks for first, and they aim at precision
// — a queue of forty guesses a day gets ignored:
//
//   * the source names the owner (R7): the owner's address — the
//     connection's sign-in name — is in **To** (Cc is for their
//     information);
//   * a person wrote it: not the owner, not a list or an automatic sender
//     (List-Id, Auto-Submitted, Precedence bulk/list/junk — `automated`),
//     not a no-reply or notification address;
//   * nobody has answered it: not flagged \Answered, and no message in the
//     Sent mailbox replies to it (its In-Reply-To or References name it —
//     headers again);
//   * and it asks: a **reply in a conversation** (In-Reply-To / References),
//     or written to the owner **alone**.
//
// **Once per message.** A message raises one request (core's
// `raiseMirror`, keyed by its Message-ID, so a message moved and moved
// back is the same subject); one the owner answered here (Not Mine, a
// drafted reply) is not raised again. It **clears** (`resolveAtSource`,
// with a receipt) when the source changes: the owner replied, it left the
// inbox (archived, deleted, moved), or it fell out of the week this sync
// reads.
//
// **What it may reach** is the IMAP provider's, never this file's: the
// console's opener (`instanceImapOpener`) gives a session whose host guard
// sends the app password to the connection's exact host:port on its *Sent
// only to* list, over TLS, or nowhere; the mailbox is opened with EXAMINE,
// so reading never marks a message read. No path here can send: the client
// has no send (T4-15), and Draft Reply is the owner's door (`draft.ts`).
//
// Degrades absent: no opener, or no mail connection yet, is 0 and no error.
// A connection that is there but cannot be read fails the run with the
// reason — names and hosts, never a value.

import { lastMirror, raiseMirror, resolveAtSource, type RequestSource } from "@foldedspacelabs/metistry-core";
import { IMAP_MAX_MESSAGES, IMAP_MODULE, IMAP_PROVENANCE, MAIL_SYNC, type ImapMessage, type ImapRead, type ImapSyncOpener } from "@foldedspacelabs/metistry-connections";
import type { Db } from "../github-state/run.js";
import { saveSyncState } from "../eventkit-calendar/run.js";

/** This collector's name — the `source_agent` of every request it raises (and the imap types' `sync:`). */
export const COMPONENT = MAIL_SYNC;
/** `proposals.source.kind` of its mirrors: the source system, which Needs You's *From* filter names. */
export const MAIL_SOURCE_KIND = "mail";
/** `source.external_ref`: this prefix, then `<connection>:<Message-ID>` — or the message's reference when it has no Message-ID. */
export const MAIL_REF_PREFIX = "mail:";
/** The request kind it raises (§2.12's `message` row). */
export const MESSAGE_KIND = "message";
/** The `needs_you` rule (`syncs.mail-messages.raise.message`). */
export const MESSAGE_RULE = "message";
/** `payload.event` — what raised the request. */
export const WRITTEN_EVENT = "written_to_you";
/** The manifest's `needs_you` defaults (a test holds this to manifest.yaml). */
export const RAISE_DEFAULTS: Readonly<Record<typeof MESSAGE_RULE, boolean>> = { message: true };
/** How far back a pass reads: the inbox's last week. A message older than this no longer waits here. */
export const WINDOW_DAYS = 7; // limit: fixed — a reply owed for more than a week is the owner's to remember, not a card's
/** What every request says of how it was inferred (module header). */
export const INFERRED = Object.freeze({ from: "headers", by: "rules" });

const DAY_MS = 86_400_000;
const SUBJECT_MAX = 280; // limit: fixed — the card's excerpt is a line; the message is in the owner's mail app

/** A local part that is a machine's, not a person's: no-reply, notifications, bounces. */
const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?)(?:[+._-].*)?$/i;

export interface MailCtx {
  /** the console's opener (`instanceImapOpener`); absent = no instance to read a connection from */
  openImap?: ImapSyncOpener | undefined;
  /** the runner's resolved Needs You switches (`syncs.mail-messages.raise`); absent = the manifest's defaults */
  raise?: Readonly<Record<string, boolean>> | undefined;
  /** the clock (a test's) */
  now?: () => number;
}

/** Why a message waits on the owner, in words the card shows — or null when it does not. */
export type Verdict = { reason: "reply" | "direct"; why: string } | null;

/** The owner's address from a connection's sign-in name, or null when it is not one (then no message can be said to name them). */
export function ownerAddress(username: string): string | null {
  const u = username.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u) ? u : null;
}

/** The header rules (module header). Pure: a message's headers, the owner's address, and the Message-IDs the owner's sent mail answers. */
export function waitsOnOwner(m: ImapMessage, owner: string, answered: ReadonlySet<string> = new Set()): Verdict {
  if (m.automated) return null;
  if (m.flags.some((f) => f === "\\answered" || f === "\\draft" || f === "\\deleted")) return null;
  if (m.message_id !== null && answered.has(m.message_id)) return null;
  const from = m.from?.address ?? null;
  if (from === null || from === owner) return null;
  if (NO_REPLY.test(from.slice(0, from.indexOf("@")))) return null;
  if (!m.to.some((a) => a.address === owner)) return null; // R7: the source names the owner — in To
  if (m.in_reply_to !== null || m.references.length > 0) return { reason: "reply", why: "A reply in a conversation you are in, written to you" };
  if (m.to.length === 1 && m.cc.length === 0) return { reason: "direct", why: "Written to you alone" };
  return null;
}

/** The subject a message's request mirrors: the message, by its Message-ID, in this connection. */
export function messageSource(connection: string, m: Pick<ImapMessage, "ref" | "message_id" | "from">): RequestSource {
  return { kind: MAIL_SOURCE_KIND, external_ref: m.message_id ? `${MAIL_REF_PREFIX}${connection}:${m.message_id}` : `${MAIL_REF_PREFIX}${m.ref}`, person: m.from?.address ?? null };
}

/**
 * Six or more digits in a run (spaces and hyphens allowed between them) are
 * a code, a card number or a phone number far more often than they are
 * words — scrubbed from what a request carries, as §4.3 rule 3 scrubs what a
 * reducer emits. A year (four digits) is left alone.
 */
export function scrubDigits(s: string): string {
  return s.replace(/\d(?:[ -]?\d){5,}/g, "••••••");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The request a message raises: the excerpt is its subject, the source who wrote it, and the reason in words. Headers only. */
export function messagePayload(m: ImapMessage, connection: string, verdict: NonNullable<Verdict>): Record<string, unknown> {
  const subject = clip(scrubDigits(m.subject), SUBJECT_MAX) || "(no subject)";
  const who = m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : "";
  return {
    title: subject,
    summary: subject,
    from: scrubDigits(who),
    reason: `${verdict.why} — inferred from its headers; the message itself was not read`,
    event: WRITTEN_EVENT,
    why: verdict.reason,
    inferred: INFERRED,
    source: IMAP_PROVENANCE,
    connection,
    ref: m.ref,
    message_id: m.message_id,
    date: m.date,
  };
}

/** One pass. Returns requests raised plus requests cleared. */
export async function run(db: Db, ctx: MailCtx = {}): Promise<number> {
  if (!ctx.openImap) return 0; // degrades absent
  const opened = await ctx.openImap({ sync: MAIL_SYNC, module: IMAP_MODULE });
  if (!opened.ok) {
    if (opened.status === "absent") return 0;
    throw new Error(`mail-messages: ${opened.why}`);
  }
  const sync = opened.sync;
  const raiseOn = ctx.raise && Object.hasOwn(ctx.raise, MESSAGE_RULE) ? ctx.raise[MESSAGE_RULE] === true : RAISE_DEFAULTS.message;
  const owner = ownerAddress(sync.username);
  const now = (ctx.now ?? Date.now)();
  const since = new Date(now - WINDOW_DAYS * DAY_MS);

  const session = await sync.open();
  let inbox: ImapRead;
  const answered = new Set<string>();
  try {
    inbox = await session.readHeaders("INBOX", { since, limit: IMAP_MAX_MESSAGES });
    // the owner's sent mail says which messages were answered — its In-Reply-To and References, headers again
    const sent = (await session.mailboxes()).find((b) => b.attributes.includes("\\sent") && !b.attributes.includes("\\noselect"));
    if (sent) {
      const out = await session.readHeaders(sent.name, { since, limit: IMAP_MAX_MESSAGES });
      for (const m of out.messages) for (const id of [m.in_reply_to, ...m.references]) if (id) answered.add(id);
    }
  } finally {
    await session.close();
  }

  const asking = new Map<string, { m: ImapMessage; verdict: NonNullable<Verdict> }>();
  const seen = new Map<string, ImapMessage>();
  for (const m of inbox.messages) {
    const ref = messageSource(sync.connection, m).external_ref;
    seen.set(ref, m);
    const verdict = owner ? waitsOnOwner(m, owner, answered) : null;
    if (verdict) asking.set(ref, { m, verdict });
  }

  let raised = 0;
  if (raiseOn) {
    for (const [, { m, verdict }] of asking) {
      const source = messageSource(sync.connection, m);
      const last = await lastMirror(db, source);
      if (last) continue; // a message is asked about once: waiting already, answered here, or settled at its source
      const out = await raiseMirror(db, {
        kind: MESSAGE_KIND,
        source_agent: COMPONENT,
        trust: "external", // the words are the sender's, not the owner's or the assistant's
        source,
        payload: messagePayload(m, sync.connection, verdict),
      });
      if (out.raised) raised++;
    }
  }

  // what waits from this connection, against what the inbox says now
  const complete = inbox.matched <= inbox.messages.length; // every message since `since` was read
  const oldest = inbox.messages.reduce<number>((t, m) => Math.min(t, Date.parse(m.received ?? m.date ?? "") || Infinity), Infinity);
  const waiting = await db.query(
    `SELECT source->>'external_ref' AS ref, payload->>'date' AS date FROM proposals
     WHERE decision = 'pending' AND kind = $1 AND source->>'kind' = $2 AND payload->>'connection' = $3`,
    [MESSAGE_KIND, MAIL_SOURCE_KIND, sync.connection],
  );
  let cleared = 0;
  for (const { ref, date } of waiting.rows as { ref: string; date: string | null }[]) {
    if (asking.has(ref)) continue;
    const m = seen.get(ref);
    const at = date ? Date.parse(date) : NaN;
    let receipt: string | null;
    if (m) {
      const replied = m.flags.includes("\\answered") || (m.message_id !== null && answered.has(m.message_id));
      receipt = replied ? "You replied in your mail" : "No longer waiting on your reply";
    } else if (!Number.isNaN(at) && at < since.getTime()) receipt = `Over ${WINDOW_DAYS} days old — no longer waiting here`;
    else if (complete || (!Number.isNaN(at) && at >= oldest)) receipt = "No longer in your inbox";
    else receipt = null; // older than the newest the read could hold: nothing is known of it this pass
    if (receipt) cleared += (await resolveAtSource(db, { kind: MAIL_SOURCE_KIND, external_ref: ref }, receipt)).length;
  }

  await saveSyncState(db, sync.connection, {
    window_start: since.toISOString(),
    messages: String(inbox.messages.length),
    matched: String(inbox.matched),
    asking: String(asking.size),
    owner: owner ? "known" : "unknown", // never the address
  });
  return raised + cleared;
}
