// The session fold's prompt — the one text the owner reviews (T3-10's accept,
// plan §3.4 W3). It rides on the turn itself, whole, the way a routine's
// prose-slot turn does (routines/prose-turn.ts): the assistant's standing
// prompt needs no section for it, and a change to it is a change to this
// file, reviewed like any other.
//
// What it SAYS is guidance. What holds is the harvest (learned.ts): a kind
// outside the three, a turn the fold did not show, a quote the owner never
// typed, a profile value in the wrong shape — each is dropped there, whatever
// this text says. Nothing here, and nothing the model answers, writes `Me/`.

import { MAX_ITEMS, MAX_LESSON_CHARS, MAX_QUOTE_CHARS } from "./learned.js";
import { PROFILE_FACT_KEYS } from "./edits.js";

/** The first line the turn starts with. `inbound_messages` has no kind column, so `meta.kind` AND a recognisable first line — as the fold does. */
export const SESSION_FOLD_PREFIX = "🧭 session fold";

/** One turn as the brief shows it: its handle, where and when, what the owner typed, and how it went. */
export interface BriefTurn {
  id: number;
  thread: string;
  /** Local `YYYY-MM-DD HH:MM`. */
  when: string;
  owner: string;
  /** The start of the assistant's answer, for context — never a source of quotes. */
  reply: string;
  /** Tools that failed in the turn — where a lesson usually starts. */
  failed: string[];
}

/** The instructions, before the turns. */
export function foldInstructions(date: string, turns: number): string {
  return [
    `${SESSION_FOLD_PREFIX} — ${date}`,
    "",
    `This is the Session Fold routine's turn, not the owner's: nobody is waiting on a reply. Below are ${turns} of the owner's chat turns you have not yet learned from, each under its handle (#id). Read them for three things only:`,
    "",
    `- **preference** — how the owner wants you to work, in their words ("lead with the number"). Not a one-off request: something they would want every time.`,
    "- **lesson** — something that went wrong in a turn (a failed tool call, a correction from the owner) and the one-line fix that would have avoided it.",
    `- **profile** — a fact Me/profile.md keeps, and only these: ${PROFILE_FACT_KEYS.join(", ")}.`,
    "",
    "Nothing you answer is written anywhere by you or by this turn. The routine turns your answer into requests in the owner's Needs You; only their Approve writes Me/Working Style.md (preferences, lessons) or Me/profile.md (profile), as them. Do not call knowledge_write for any of this.",
    "",
    "Answer with ONE fenced block, a JSON list, and nothing else of substance:",
    "",
    "```learned",
    "[",
    `  {"kind": "preference", "turn": 812, "quote": "lead with the number"},`,
    `  {"kind": "lesson", "turn": 815, "text": "Search Areas/ with knowledge_grep before asking where a note is", "quote": "it's in Areas, just look"},`,
    `  {"kind": "profile", "turn": 820, "quote": "I don't work Fridays", "key": "working_days", "value": ["mon", "tue", "wed", "thu"]}`,
    "]",
    "```",
    "",
    "What the routine checks — an item that fails one is dropped, and the owner never sees it:",
    "",
    `- \`turn\` is a handle shown below. \`quote\` is copied exactly from what the OWNER typed in that turn — a phrase of theirs, never your paraphrase, never your reply; at most ${MAX_QUOTE_CHARS} characters. A preference is written as its quote.`,
    `- a lesson's \`text\` is the fix, one line, at most ${MAX_LESSON_CHARS} characters; its \`quote\` is optional.`,
    `- a profile \`value\` has the shape Me/profile.md takes: timezone an IANA zone ("Europe/London"); working_days a list of mon … sun; working_hours "HH:MM-HH:MM"; daily_capacity_min and today_cap whole numbers; task_size_minutes {"s": 15, "m": 45, "l": 90} in minutes.`,
    `- at most ${MAX_ITEMS} items. Anything already in the owner's files, or that they declined before, is dropped for you.`,
    "",
    "When there is nothing worth keeping — most turns — answer:",
    "",
    "```learned",
    "[]",
    "```",
  ].join("\n");
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const OWNER_CHARS = 1200; // limit: fixed — a chat message longer than this is a paste, not a preference; the head is where they say how they want it
export const REPLY_CHARS = 240; // limit: fixed — the reply is context for the owner's words, not material

/** One turn's lines in the brief. The owner's words are fenced as a quote block so they read as data, not instructions. */
export function turnBlock(t: BriefTurn): string {
  const lines = [`#${t.id} · ${t.thread} · ${t.when}`, ...clip(t.owner, OWNER_CHARS).split("\n").map((l) => `> ${l}`)];
  if (t.reply) lines.push(`you answered: ${clip(t.reply, REPLY_CHARS)}`);
  if (t.failed.length > 0) lines.push(`tools that failed: ${[...new Set(t.failed)].join(", ")}`);
  return lines.join("\n");
}
