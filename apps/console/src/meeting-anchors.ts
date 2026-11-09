// A meeting's jots, promoted on Approve (plan §2.12, §3.3 T8-7; C77, C81;
// screen 3 §10.3; the owner's ruling on W3 question 29).
//
// While a recording runs, a Note or To-do the owner makes from the bar is a
// capture anchored to (session, offset): the transcript it belongs beside
// does not exist yet. When the session ends the inbox drain opens the
// meeting's card — one `group_id = meeting:<session>` over its rows — and
// the owner's Approve of its transcript is the moment the anchors move: each
// of that session's jots has its `capture_session` line rewritten to
// `source: "meeting:<transcript path>"`, its offset kept.
//
// What makes it the owner's hand, and nothing else's:
//
//   * **Only the drain's own card.** The row must be a `knowledge` row the
//     inbox drain raised at `user` trust — the owner's own door's capture —
//     classified `transcript`, whose `group_id` is `meeting:<session>` for
//     the session its `payload.meeting` names. A row an agent raised with the
//     same group and the same payload promotes nothing (`meetingAnchorOf`
//     reads it as no anchor at all) and is answered like any note.
//   * **Only the owner's jots, found by the session.** The jots are the
//     `inbox` rows the drain settled as `jot` for that session from the
//     owner's door (`source_agent IS NULL`) — never a list from the request,
//     and never the payload's handles, which are a card's count.
//   * **Only `Journal/Transcripts/`.** An anchor is promoted to the
//     transcript's own path, and only when that is under the ruled folder
//     (core `isTranscriptPath`); anywhere else, nothing is rewritten and the
//     receipt says why — the session anchor still names the transcript.
//   * **One line, through the audited vault path.** Core's
//     `promoteJotAnchor` rewrites exactly the session line and proves its
//     own output; the write goes through the reconciler's bridge as `user`,
//     compare-and-swap on the bytes it read (`expected_sha256`), so an edit
//     the owner made a moment before is never overwritten — it is read again
//     once, and otherwise kept on its session anchor and named in the
//     receipt. The `inbox` row is brought to the new bytes in the same step,
//     so the reconciler's walk finds nothing changed to re-open.
//   * **Before the row is settled**, like every other consequence (C45): a
//     vault that cannot be reached leaves the request pending with the
//     reason. A retry promotes only what is left — a promoted jot reads as
//     `already`.
//
// No model is anywhere in it, and nothing here reads a transcript's words.

import { isTranscriptPath, meetingGroupId, promoteJotAnchor, sessionOfMeetingGroup } from "@foldedspacelabs/metistry-core";
import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

/** The inbox drain's `source_agent` — the one raiser whose meeting card promotes anchors. */
export const DRAIN_AGENT = "inbox-drain";

/** A meeting transcript row's anchor target: the session and where its transcript lives. */
export interface MeetingAnchor {
  session: string;
  path: string;
}

/** What Approve did to a meeting's jots — the receipt it answers with and keeps on the row. */
export interface AnchorReceipt {
  session: string;
  /** The transcript the jots now point into, or null when it is not under `Journal/Transcripts/` (nothing was rewritten). */
  path: string | null;
  /** Inbox ids whose anchor this Approve promoted. */
  promoted: number[];
  /** Inbox ids already promoted — a retry, or a second answer. */
  already: number[];
  /** Jots left on their session anchor, and why. */
  kept: { inbox_id: number; why: string }[];
}

const WHY = {
  not_filed: "the transcript is not filed under Journal/Transcripts/, so the jot keeps its session anchor",
  gone: "the jot's file is no longer in the vault",
  moved: "the jot was edited while its anchor was being moved; it keeps its session anchor",
  unreadable: "the jot no longer reads as this meeting's jot; it was left as it is",
} as const;

/**
 * The anchor target of a meeting's transcript row, or undefined for any row
 * that is not one the inbox drain raised from the owner's own door — so an
 * agent's row carrying the same group and payload promotes nothing.
 */
export function meetingAnchorOf(row: { kind?: unknown; source_agent?: unknown; trust?: unknown; group_id?: unknown; payload?: unknown }): MeetingAnchor | undefined {
  if (row.kind !== "knowledge" || row.source_agent !== DRAIN_AGENT || row.trust !== "user") return undefined;
  const session = sessionOfMeetingGroup(row.group_id);
  if (session === undefined) return undefined;
  const p = row.payload as { path?: unknown; classification?: { kind?: unknown } | null; meeting?: { session_id?: unknown; transcript_path?: unknown } | null } | null;
  if (!p || p.classification?.kind !== "transcript" || p.meeting?.session_id !== session) return undefined;
  if (typeof p.path !== "string" || p.path === "" || p.meeting?.transcript_path !== p.path) return undefined;
  if (meetingGroupId(session) !== row.group_id) return undefined;
  return { session, path: p.path };
}

/** The owner's jots for one session, as the drain settled them. */
const JOTS_SQL = `SELECT id, path FROM inbox
  WHERE proposal->>'kind' = 'jot' AND proposal->>'capture_session' = $1 AND source_agent IS NULL AND status <> 'archived'
  ORDER BY id`;

/**
 * Promote every one of the session's jots to the transcript's path. Throws
 * the vault's own error for anything but a moved file (the bridge down, a
 * refusal): the caller leaves the request pending with it (C45).
 */
export async function promoteMeetingJots(db: Db, vault: VaultClient | undefined, anchor: MeetingAnchor, proposalId: number): Promise<AnchorReceipt> {
  const jots = (await db.query(JOTS_SQL, [anchor.session])).rows as { id: number | string; path: string }[];
  const receipt: AnchorReceipt = { session: anchor.session, path: isTranscriptPath(anchor.path) ? anchor.path : null, promoted: [], already: [], kept: [] };
  if (jots.length === 0) return receipt;
  if (receipt.path === null) {
    receipt.kept = jots.map((j) => ({ inbox_id: Number(j.id), why: WHY.not_filed }));
    return receipt;
  }
  if (!vault) throw new VaultError("not_available", `approving this meeting moves ${jots.length} jot${jots.length === 1 ? "" : "s"} to ${receipt.path}, and no vault bridge is configured in this deployment — METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER (docs/ops/reconciler.md)`);
  for (const j of jots) {
    const id = Number(j.id);
    const outcome = await promoteOne(db, vault, j.path, id, anchor.session, receipt.path, proposalId);
    if (outcome === "promoted") receipt.promoted.push(id);
    else if (outcome === "already") receipt.already.push(id);
    else receipt.kept.push({ inbox_id: id, why: WHY[outcome] });
  }
  return receipt;
}

async function promoteOne(db: Db, vault: VaultClient, jotPath: string, inboxId: number, session: string, path: string, proposalId: number): Promise<"promoted" | "already" | "gone" | "moved" | "unreadable"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await vault.read(jotPath);
    if (!file) return "gone";
    const r = promoteJotAnchor(file.content.toString("utf8"), session, path);
    if (!r.ok) return r.why === "already" ? "already" : "unreadable";
    const bytes = Buffer.from(r.text, "utf8");
    try {
      const written = await vault.write(jotPath, bytes, { principal: "user", message: `meeting: anchor a jot to ${path} (approved #${proposalId}, as you)`, group: `meeting-${session}` }, file.sha256);
      // the inbox row follows its file, so the walk sees nothing to re-open
      await db.query(
        `UPDATE inbox SET note = $2, sha256 = $3, proposal = (proposal - 'capture_session') || jsonb_build_object('source', $4::text) WHERE id = $1`,
        [inboxId, r.text, written.sha256, `meeting:${path}`],
      );
      return "promoted";
    } catch (err) {
      if (err instanceof VaultError && err.code === "conflict") continue; // edited between the read and the write: read it again, once
      throw err;
    }
  }
  return "moved";
}
