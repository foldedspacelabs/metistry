// Draft Reply — `POST /api/mail/messages/:id/draft` (design-build-plan §2.1,
// §2.6, §2.11 "Respond / Draft", §2.12; ticket T4-17). The `message`
// request's primary answer. **It never sends mail**: the reply is written to
// the owner's Drafts mailbox, and the owner sends it from their own mail app.
//
// `:id` is the message's reference — `payload.ref` on its request,
// `<connection>/<mailbox>/<uidvalidity>/<uid>`, percent-encoded as one path
// segment. Two calls:
//
//   1. `{body}` — the PREVIEW. The message's headers are read again from the
//      server; the reply is addressed from them (its Reply-To, else its
//      From), `Re:` its subject, threaded by its Message-ID, with `body` as
//      the owner's words. Nothing is appended. The answer shows the draft
//      and carries a single-use `confirm_token`.
//   2. `{confirm_token}` (and, if sent, the same `body`) — the CONFIRM. The
//      draft the preview showed — the same bytes, checked by digest — is
//      APPENDed to the mailbox the server marks `\Drafts`, flagged `\Draft`.
//      The message's request clears with a receipt.
//
// **Who it goes to is never the caller's.** The body is the only thing the
// client says; a field naming a recipient, a subject or a mailbox is
// refused. The service is `collectors/mail-messages/draft.ts`; the IMAP
// client under it has no send (T4-15). **Without a `draft` capability it
// is refused** before anything is dialled.
//
// **C45.** A draft the mailbox could not take — no connection, no `draft`
// capability, no Drafts mailbox, a failed sign-in — leaves the message's
// request pending with `payload.error` saying why (door `draft`); a stale
// confirm and a malformed request write nothing on the row.
//
// Not an action: `ACTION_KINDS` is untouched and there is no send action, so
// no proposal and no agent can draft or send mail. Reached only by the
// `user` principal: server.ts's management gate runs first, so an agent
// bearer and the capture owner token get the uniform 403.

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECRET_USE_META_KEY, errorEnvelope, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { ImapSyncOpener } from "@foldedspacelabs/metistry-connections";
import { DraftRefused, appendReplyDraft, previewReplyDraft, type DraftBinding, type DraftRefusalCode } from "@metistry-apps/collectors";
import type { Db } from "./auth-store.js";
import { readBody, sendJson } from "./http-util.js";
import type { ConfirmTokens } from "./door-confirm.js";

const DRAFT_ROUTE = /^POST \/api\/mail\/messages\/([^/]+)\/draft$/;
/** The door's name on its tokens: a Respond token cannot confirm a draft. */
export const DRAFT_DOOR = "mail_draft";

const BODY_FIELDS = new Set(["body", "confirm_token"]);

export const MAIL_NOT_AVAILABLE =
  "mail connections are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance whose `.metistry/connections/` holds the mail connection (docs/ops/connections.md, Mail over IMAP)";

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

export interface MailDraftDeps {
  db: Db;
  audit: Audit;
  /** Opens a mail connection by name (`instanceImapOpener`). Absent → `503`. */
  open?: ImapSyncOpener | undefined;
  tokens: ConfirmTokens<DraftBinding>;
}

export function isMailDraftRoute(key: string): boolean {
  return DRAFT_ROUTE.test(key);
}

/** Each refusal's HTTP answer. A code path each (U3); the service's message says why. */
const STATUS_OF: Readonly<Record<DraftRefusalCode, ErrorCode>> = {
  bad_request: "invalid_request",
  no_connection: "not_found",
  no_capability: "not_available",
  connection_failed: "not_available",
  not_found: "not_found",
  changed: "conflict",
  bad_draft: "invalid_request",
  no_drafts: "not_available",
};

const refuse = (res: ServerResponse, code: ErrorCode, message: string, extra: Record<string, unknown> = {}) => sendJson(res, statusFor(code), { ...errorEnvelope(code, message), ...extra });

/** C45: the waiting request for this message carries why the draft was not written (pending rows only). Draft Reply is the primary answer. */
async function recordRefusal(db: Db, ref: string, code: ErrorCode, message: string): Promise<void> {
  const error = { code, message, decision: "allow", door: "draft", at: new Date().toISOString() };
  await db.query(
    `UPDATE proposals SET payload = payload || jsonb_build_object('error', $2::jsonb)
     WHERE decision = 'pending' AND kind = 'message' AND source IS NOT NULL AND source->>'kind' = 'mail' AND payload->>'ref' = $1`,
    [ref, JSON.stringify(error)],
  );
}

export async function mailDraftRoute(req: IncomingMessage, res: ServerResponse, key: string, deps: MailDraftDeps): Promise<void> {
  const m = DRAFT_ROUTE.exec(key)!;
  let ref: string;
  try {
    ref = decodeURIComponent(m[1]!);
  } catch {
    return refuse(res, "invalid_request", "the message id is not valid percent-encoding");
  }

  let body: Record<string, unknown>;
  try {
    const text = (await readBody(req)).toString("utf8");
    const raw: unknown = text.trim() === "" ? {} : JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse(res, "invalid_request", "the body is {body} and, to confirm, confirm_token");
    body = raw as Record<string, unknown>;
  } catch {
    return refuse(res, "invalid_request", "request body is not JSON");
  }
  const extra = Object.keys(body).filter((k) => !BODY_FIELDS.has(k));
  if (extra.length > 0) {
    return refuse(res, "invalid_request", `unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} — a draft is {body, confirm_token?}: who it goes to, its subject and its thread are the message's own, and it goes to Drafts and nowhere else`);
  }
  if (body.body !== undefined && typeof body.body !== "string") return refuse(res, "invalid_request", "body is the reply's text");
  const confirmToken = body.confirm_token;
  if (confirmToken !== undefined && (typeof confirmToken !== "string" || confirmToken === "")) return refuse(res, "invalid_request", "confirm_token is the string the preview returned");
  const confirming = typeof confirmToken === "string";
  const stage = confirming ? "confirm" : "preview";

  // the connection and the outcome — never the reference, the addresses, the subject or the words
  const connection = ref.split("/")[0] ?? "";
  const audited = (ok: boolean, outcome: string, more: Record<string, unknown> = {}) => deps.audit(DRAFT_DOOR, stage, ok, { connection: connection.slice(0, 64), outcome, ...more });

  if (!deps.open) {
    await audited(false, "no_mail");
    await recordRefusal(deps.db, ref, "not_available", MAIL_NOT_AVAILABLE);
    return refuse(res, "not_available", MAIL_NOT_AVAILABLE, { reason: "no_connection" });
  }

  try {
    if (!confirming) {
      const p = await previewReplyDraft(deps.open, { ref, body: body.body });
      const token = deps.tokens.mint(DRAFT_DOOR, ref, p.binding);
      await audited(true, "previewed", p.secrets.length > 0 ? { [SECRET_USE_META_KEY]: p.secrets } : {});
      return sendJson(res, 200, {
        ok: true,
        message_id: ref,
        connection: p.connection,
        sent: false,
        preview: { mailbox: p.mailbox, from: p.from, to: p.to, cc: p.cc, subject: p.subject, in_reply_to: p.in_reply_to, body: p.body },
        ...token,
        drafted: false,
      });
    }
    // the words, if the confirm repeats them, must be the previewed ones — a token named with others stays unspent
    const binding = deps.tokens.take(confirmToken as string, DRAFT_DOOR, ref, (b) => body.body === undefined || body.body === b.input.body);
    if (!binding) {
      await audited(false, "stale_token");
      return refuse(res, "conflict", "this confirm_token is spent, expired, or was not minted for this message and these words — preview again", { reason: "stale" });
    }
    const done = await appendReplyDraft(deps.db, deps.open, binding);
    if (done.cleared.length > 0) await deps.db.query(`UPDATE proposals SET payload = payload - 'error' WHERE id = ANY($1::bigint[])`, [done.cleared]);
    await audited(true, "drafted", done.secrets.length > 0 ? { [SECRET_USE_META_KEY]: done.secrets } : {});
    return sendJson(res, 201, {
      ok: true,
      message_id: ref,
      connection: binding.connection,
      sent: false,
      drafted: true,
      draft_id: done.result.message_id,
      mailbox: done.result.mailbox,
      uid: done.result.uid,
      cleared: done.cleared.length,
    });
  } catch (err) {
    if (err instanceof DraftRefused) {
      await audited(false, err.code);
      // a stale confirm or a malformed request is not a failed answer: nothing on the row
      if (err.code !== "changed" && err.code !== "bad_request") await recordRefusal(deps.db, ref, STATUS_OF[err.code], err.message);
      return refuse(res, STATUS_OF[err.code], err.message, { reason: err.code === "changed" ? "stale" : err.code });
    }
    throw err;
  }
}
