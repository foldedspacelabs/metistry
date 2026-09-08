// The question-answer convention (§4.21 prompt cards, docs/product/ux-direction.md
// "Rich request–response dialogues"). When a reply ENDS with a fenced
// `decision` block, the sender is blocked on the user's answer:
//
//     ```decision
//     title: Which repo should this land in?
//     options:
//     - metistry
//     - metistry-instance
//     ```
//
// The emitter parses it once, at the point the reply is stored, and turns it
// into a `proposals` row of kind `decision` — so a blocking question is in the
// one "Needs You" queue like everything else, answerable from chat, from
// triage, or from a notification. Nothing here trusts the model beyond the
// shape: a malformed block is ignored (the reply still sends, it simply does
// not create a queue item), the options are the ONLY answers the server will
// later accept, and no field is executable.
//
// Deliberately a tiny hand-rolled parser rather than YAML: this runs on every
// reply, the grammar is four line shapes, and an over-permissive parser here
// would widen what a model can put into the user's queue.

export interface DecisionBlock {
  title: string;
  options: string[];
}

const FENCE = /(?:^|\n)```decision[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/;
const MAX_TITLE = 200;
const MAX_OPTION = 80;
const MAX_OPTIONS = 8;
const MIN_OPTIONS = 2;

const unquote = (s: string): string => (/^(".*"|'.*')$/.test(s) ? s.slice(1, -1).trim() : s);

/** Parse a trailing ```decision block; null when there is none or it is malformed. */
export function parseDecisionBlock(reply: unknown): DecisionBlock | null {
  if (typeof reply !== "string") return null;
  const m = FENCE.exec(reply.trimEnd());
  if (!m?.[1]) return null;

  let title = "";
  let inOptions = false;
  const options: string[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!inOptions && /^title:/i.test(line)) {
      if (title !== "") return null; // two titles: malformed
      title = unquote(line.slice(6).trim());
      continue;
    }
    if (!inOptions && /^options:$/i.test(line)) {
      inOptions = true;
      continue;
    }
    if (inOptions && /^-\s*/.test(line)) {
      options.push(unquote(line.replace(/^-\s*/, "").trim()));
      continue;
    }
    return null; // anything else in the block: malformed, ignore the whole thing
  }

  if (!title || title.length > MAX_TITLE) return null;
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;
  if (options.some((o) => o === "" || o.length > MAX_OPTION)) return null;
  if (new Set(options).size !== options.length) return null;
  return { title, options };
}
