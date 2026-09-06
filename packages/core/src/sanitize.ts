// Text boundary (§4.20): anything written by an agent or pasted by a human
// and later rendered TO an agent passes this. Two classes of trouble are
// stripped mechanically so no prompt has to ask a model to "ignore" them:
//
// - Bidi overrides (U+202A–U+202E, U+2066–U+2069) reorder what a reader
//   sees versus what a model tokenizes — the classic "Trojan Source" trick.
// - Zero-width characters (U+200B–U+200F, U+2060, U+FEFF) hide text inside
//   text and break exact-match dedupe.
//
// And a leading "/" is removed: several agent clients treat a line that
// starts with "/" as a slash command, so a note titled "/clear" must never
// arrive as one. Modules don't get to opt out (§4.20).

const STRIP = /[‪-‮⁦-⁩​-‏⁠﻿]/g;

/** Strip bidi/zero-width controls and any leading slash. Idempotent. */
export function sanitizeForAgent(text: string): string {
  return text.replace(STRIP, "").replace(/^\s*\/+/, "");
}
