// Draft Reply — the `message` request's primary answer (design-build-plan
// §2.6, §2.11 "Respond / Draft", §2.12; ticket T4-17). The service behind
// `POST /api/mail/messages/:id/draft`; the confirm token and who may press
// it are the console door's (`apps/console/src/mail-draft-route.ts`).
//
// **Nothing sends mail.** A reply is written into the owner's Drafts
// mailbox (IMAP APPEND to the mailbox the server marks `\Drafts`,
// packages/connections `imap.ts`) and the owner sends it from their own mail
// app. There is no send anywhere in the product.
//
// **Who it goes to is the message's, never the caller's.** The caller names
// a message (its reference) and the words of the reply, and nothing else.
// The message's headers are read again from the server — to its Reply-To,
// else its From; the subject `Re:` its own; threaded by its Message-ID —
// so a client cannot address a draft anywhere the message did not come
// from. Never its body: the provider cannot fetch one.
//
// **Preview, then confirm.** The preview renders the exact message and its
// digest and appends nothing; the confirm re-renders from the same input
// with the preview's date and Message-ID and appends only if the digest
// matches (`changed` otherwise). Then the message's request, if one waits,
// is resolved at source: a reply is drafted.

import { EgressRefused, resolveAtSource } from "@foldedspacelabs/metistry-core";
import {
  IMAP_MODULE,
  ImapError,
  MAIL_SYNC,
  parseImapRef,
  type AppendResult,
  type DraftConfirm,
  type DraftInput,
  type ImapMessage,
  type ImapSession,
  type ImapSyncOpener,
} from "@foldedspacelabs/metistry-connections";
import type { Db } from "../github-state/run.js";
import { MAIL_SOURCE_KIND, messageSource } from "./run.js";

/** The capability Draft Reply needs (core's CONNECTION_CAPABILITIES.mail). */
export const DRAFT_CAPABILITY = "draft";

/** Why Draft Reply refused. Each a code path with a test (U3). */
export const DRAFT_REFUSAL_CODES = ["bad_request", "no_connection", "no_capability", "connection_failed", "not_found", "changed", "bad_draft", "no_drafts"] as const;
export type DraftRefusalCode = (typeof DRAFT_REFUSAL_CODES)[number];

export class DraftRefused extends Error {
  override readonly name = "DraftRefused";
  constructor(
    readonly code: DraftRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a confirm appends — held by the door, never by the client. */
export interface DraftBinding {
  ref: string;
  connection: string;
  input: DraftInput;
  confirm: DraftConfirm;
  /** the message's request subject, cleared once the draft is in */
  subject_ref: string;
}

export interface ReplyDraftPreview {
  ref: string;
  connection: string;
  /** the Drafts mailbox, as the owner reads its name */
  mailbox: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  in_reply_to: string | null;
  body: string;
  binding: DraftBinding;
  secrets: string[];
}

const MSG_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]{1,994}>$/;
const MAX_REFERENCES = 20; // limit: fixed — the chain kept on a reply; the newest are what threading reads
const SUBJECT_MAX = 900; // limit: fixed — planDraft's own ceiling for a subject

function refusal(err: unknown): never {
  if (err instanceof DraftRefused) throw err;
  if (err instanceof ImapError) {
    const map: Partial<Record<ImapError["code"], DraftRefusalCode>> = { not_found: "not_found", changed: "changed", bad_draft: "bad_draft", no_drafts: "no_drafts", not_capable: "no_capability" };
    throw new DraftRefused(map[err.code] ?? "connection_failed", err.message);
  }
  // the host guard's refusals name names and hosts, never a value; nothing further was sent
  if (err instanceof EgressRefused) throw new DraftRefused("connection_failed", err.message);
  throw err;
}

/** The reply to one message, from its headers alone: to whom, about what, in which thread. */
export function replyTo(m: ImapMessage, body: string): DraftInput {
  const to = m.reply_to[0]?.address ?? m.from?.address;
  if (!to) throw new DraftRefused("bad_draft", "the message names nobody to reply to");
  const subject = /^re\s*:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  const thread = m.message_id && MSG_ID.test(m.message_id) ? m.message_id : undefined;
  const references = [...m.references.filter((r) => MSG_ID.test(r)), ...(thread ? [thread] : [])].slice(-MAX_REFERENCES);
  return {
    to: [to],
    subject: subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject,
    body,
    ...(thread ? { in_reply_to: thread } : {}),
    ...(references.length > 0 ? { references: [...new Set(references)] } : {}),
  };
}

async function openFor(open: ImapSyncOpener, connection: string): Promise<{ session: ImapSession; secrets: () => string[] }> {
  const opened = await open({ sync: MAIL_SYNC, module: IMAP_MODULE, connection });
  if (!opened.ok) throw new DraftRefused(opened.status === "absent" ? "no_connection" : "connection_failed", opened.why);
  if (!opened.sync.capabilities.includes(DRAFT_CAPABILITY)) {
    throw new DraftRefused("no_capability", `connection ${connection}'s provider ${opened.sync.provider} cannot draft (no ${DRAFT_CAPABILITY} capability) — nothing was sent`);
  }
  try {
    return { session: await opened.sync.open(), secrets: () => opened.sync.secretsUsed() };
  } catch (err) {
    refusal(err);
  }
}

/** Preview a reply to one message: to whom, about what, into which Drafts mailbox. Appends nothing, sends nothing. */
export async function previewReplyDraft(open: ImapSyncOpener, req: { ref: string; body: unknown }): Promise<ReplyDraftPreview> {
  const at = parseImapRef(req.ref);
  if (!at) throw new DraftRefused("bad_request", "a message is named by its reference, as its request carries it (`payload.ref`)");
  if (req.body !== undefined && typeof req.body !== "string") throw new DraftRefused("bad_request", "body is the reply's text");
  const body = (req.body as string | undefined) ?? "";
  const { session, secrets } = await openFor(open, at.connection);
  try {
    const m = await session.readMessage(at.mailbox, at.uid, at.uid_validity);
    const input = replyTo(m, body);
    const p = await session.previewDraft(input);
    return {
      ref: req.ref,
      connection: at.connection,
      mailbox: p.mailbox_label,
      from: p.plan.from,
      to: p.plan.to,
      cc: p.plan.cc,
      subject: p.plan.subject,
      in_reply_to: p.plan.in_reply_to,
      body,
      binding: { ref: req.ref, connection: at.connection, input, confirm: p.confirm, subject_ref: messageSource(at.connection, m).external_ref },
      secrets: secrets(),
    };
  } catch (err) {
    refusal(err);
  } finally {
    await session.close();
  }
}

/** Append the reply its preview showed to Drafts — only if it is that draft — and clear the message's request. Sends nothing. */
export async function appendReplyDraft(db: Db, open: ImapSyncOpener, b: DraftBinding): Promise<{ result: AppendResult; cleared: number[]; secrets: string[] }> {
  const { session, secrets } = await openFor(open, b.connection);
  let result: AppendResult;
  try {
    result = await session.appendDraft(b.input, b.confirm);
  } catch (err) {
    refusal(err);
  } finally {
    await session.close();
  }
  const cleared = await resolveAtSource(db, { kind: MAIL_SOURCE_KIND, external_ref: b.subject_ref }, "You drafted a reply — it is in your Drafts, unsent");
  return { result, cleared, secrets: secrets() };
}
