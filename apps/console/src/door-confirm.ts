// Single-use confirm tokens for the owner's preview-then-confirm doors that
// hold their rule here rather than at a bridge (T4-17: Respond to an
// invitation, Draft Reply). Move a meeting's token is the eventkit bridge's
// (T2-12); these doors reach a connection directly, so the console holds it.
//
// A preview mints a token bound to exactly what it showed — the event and
// the answer and the ETag the calendar gave; the message and the rendered
// draft and its digest — and the confirm names only the token. What the
// confirm does is the BINDING, never anything the client sends again, so a
// client cannot preview one thing and confirm another. A token is:
//
//   * **single-use** — taken on the confirm, whatever the outcome;
//   * **bound to its door and its subject** — a Respond token confirms only
//     that event's answer, a Draft token only that message's draft; named
//     on another, it is refused and stays unspent;
//   * **short-lived** — five minutes (`CONFIRM_TTL_MS`), then gone;
//   * **per process, in memory** — a console restart forgets them, and the
//     client previews again (a `409 stale`, as for any spent token). Nothing
//     is lost: a preview writes nothing.
//
// 32 random bytes, base64url: unguessable, and never logged — the audit
// rows these doors write carry the subject and the outcome, not the token.

import { randomBytes } from "node:crypto";

/** How long a preview's token may be confirmed. */
export const CONFIRM_TTL_MS = 5 * 60_000; // limit: fixed — a preview is read and pressed in a minute; past five the calendar or mailbox may have moved
const MAX_TOKENS = 1_000; // limit: fixed — outstanding previews per console; the oldest go first past it, and preview again

interface Held<T> {
  door: string;
  subject: string;
  binding: T;
  expires: number;
}

export class ConfirmTokens<T> {
  readonly #held = new Map<string, Held<T>>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** A token for this binding: `door` and `subject` are what a confirm must name again. */
  mint(door: string, subject: string, binding: T): { confirm_token: string; expires_in_sec: number } {
    this.#sweep();
    while (this.#held.size >= MAX_TOKENS) {
      const oldest = this.#held.keys().next().value;
      if (oldest === undefined) break;
      this.#held.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.#held.set(token, { door, subject, binding, expires: this.clock() + CONFIRM_TTL_MS });
    return { confirm_token: token, expires_in_sec: CONFIRM_TTL_MS / 1000 };
  }

  /**
   * The binding a token holds, once: `null` for a token this console never
   * minted, one already taken, one expired, or one minted for another door
   * or subject — or one whose binding `matches` refuses (both stay
   * unspent: the client named the wrong one, or said something the preview
   * did not show).
   */
  take(token: string, door: string, subject: string, matches: (binding: T) => boolean = () => true): T | null {
    this.#sweep();
    const held = this.#held.get(token);
    if (!held || held.door !== door || held.subject !== subject || !matches(held.binding)) return null;
    this.#held.delete(token);
    return held.binding;
  }

  #sweep(): void {
    const now = this.clock();
    for (const [k, v] of this.#held) if (v.expires <= now) this.#held.delete(k);
  }
}
