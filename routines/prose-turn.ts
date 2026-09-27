// A routine's ONE assistant turn for the prose slots of its own file
// (design-build-plan §2.13; C103, T3-6).
//
// The Morning Brief and the Standup write their files themselves, under
// their own principals (owner ruling (a), W1): every directive but `prose` is
// filled model-free, and each `prose` slot is left as a pending marker line.
// A routine calls no model (invariant 4), so the slots ride on one turn it
// enqueues — the fold's pattern — and the assistant fills them through
// `knowledge_write`, which, for a file in a routine's own folder, accepts a
// change to the pending slot lines and nothing else (`fillProseSlots`,
// packages/core/src/prose-slots.ts). What the turn says is guidance; what the
// tool accepts is the control.
//
// One turn per file per run: every slot of the file is in this one message,
// and a file with no slot enqueues nothing — a morning with no meetings and a
// template with no `prose` line costs no model call at all.

import { ROUTINE_TIER, type ProseRequest } from "@foldedspacelabs/metistry-core";
import type { Db } from "./morning-brief/run.js";

/** The first line the assistant's prompt keys on (`seed/assistant-prompt.md`, "A routine's prose slots"). `inbound_messages` has no kind column, so meta.kind AND a recognisable first line — as the fold does. */
export const PROSE_TURN_PREFIX = "✍️ prose slots";

export const MAX_PROSE_TURN_SLOTS = 24; // limit: fixed — a brief's one paragraph plus a working day's meetings; more is a turn nobody reads

export interface ProseTurn {
  /** The routine enqueuing it — its thread, and `meta.source`. */
  component: string;
  /** The file the slots are in: `Journal/Brief/<date>.md`. */
  path: string;
  date: string;
  requests: readonly ProseRequest[];
}

/** The turn's text: whose turn it is, the slots numbered as the file numbers them, and how the write is checked. */
export function proseTurnText(turn: ProseTurn): string {
  const slots = turn.requests.slice(0, MAX_PROSE_TURN_SLOTS);
  return [
    `${PROSE_TURN_PREFIX} — ${turn.component}, ${turn.path}`,
    "",
    `This is the ${turn.component} routine's turn for ${turn.date}, not the user's: nobody is waiting on a reply. The routine wrote ${turn.path} and left ${slots.length} prose slot${slots.length === 1 ? "" : "s"} for you:`,
    "",
    ...slots.map((r) => `${r.index}. ${r.prompt}${r.using ? ` (read ${r.using})` : ""}`),
    "",
    `knowledge_read ${turn.path}, replace each \`<!-- metistry:prose N --> _pending…_\` with your one line for slot N, and knowledge_write the file back with the sha256 you read. Only those lines may change — anything else is refused and nothing is written.`,
  ].join("\n");
}

/** Enqueue the turn; returns the `inbound_messages` id. The caller has already written the file, so the slots the turn names exist on disk. */
export async function enqueueProseTurn(db: Db, turn: ProseTurn): Promise<number> {
  const { rows } = await db.query(`INSERT INTO inbound_messages (thread, text, meta) VALUES ($1, $2, $3) RETURNING id`, [
    turn.component,
    proseTurnText(turn),
    // `tier: routine` — machine-assembled, cheap by default; `fresh_session` —
    // the slots are this file's task and never continue a chat's context;
    // `kind` makes it a machine turn to the drain (apps/assistant `isChatTurn`).
    JSON.stringify({
      kind: "prose",
      tier: ROUTINE_TIER,
      fresh_session: true,
      source: turn.component,
      path: turn.path,
      slots: Math.min(turn.requests.length, MAX_PROSE_TURN_SLOTS),
    }),
  ]);
  return Number(rows[0]?.id);
}
