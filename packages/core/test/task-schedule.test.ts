// The Defer door's one edit (design-build-plan §2.11, T2-5; owner ruling K6).
// `setTaskScheduled` writes one `do <date>` or one `someday` — the spelling
// `formatTaskLine` emits — and nothing else. The ticket's tests: the result
// round-trips through the parser, and **no emoji is ever written**; plus the
// cases where it must write NOTHING, because a line it cannot prove it changed
// by exactly the day is refused, never approximated.
import { describe, expect, it } from "vitest";
import { formatTaskLine, parseTaskLine, setTaskScheduled, SOMEDAY_TOKEN, type TaskDeferral } from "../src/task-line.js";

const opts = { now: new Date("2026-09-28T15:00:00Z"), timeZone: "America/New_York" };

function defer(line: string, when: TaskDeferral) {
  const r = setTaskScheduled(line, when, opts);
  if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
  return r.line;
}

/** The run a reviewer's diff would show as added. */
function byteDiff(a: string, b: string): { removed: string; added: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { removed: a.slice(s, ea), added: b.slice(s, eb) };
}

/** Every pictographic or emoji-presentation character in a string — what "no emoji" is checked against. */
const emoji = (s: string): string[] => [...s].filter((c) => /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u{FE0F}/u.test(c));

describe("the `someday` token (K6)", () => {
  it("is a field of the trailing run, read and emitted as the bare word", () => {
    const p = parseTaskLine("- [ ] Learn the cello someday ^mt-abcdefgh", opts)!;
    expect(p.someday).toBe(true);
    expect(p.text).toBe("Learn the cello");
    expect(formatTaskLine(p)).toBe("- [ ] Learn the cello someday ^mt-abcdefgh");
    expect(SOMEDAY_TOKEN).toBe("someday");
  });

  it("is not read in the middle of the text — the run never reaches it", () => {
    const p = parseTaskLine("- [ ] Someday we should talk about the roof", opts)!;
    expect(p.someday).toBe(false);
    expect(p.text).toBe("Someday we should talk about the roof");
  });

  it("is not the `#someday` tag: a tag is the user's own text", () => {
    const p = parseTaskLine("- [ ] Learn the cello #someday", opts)!;
    expect(p.someday).toBe(false);
    expect(p.text).toBe("Learn the cello #someday");
  });

  it("round-trips beside the other fields", () => {
    const p = parseTaskLine("- [ ] Learn the cello @Jim waiting p2 someday +music", opts)!;
    expect(p).toMatchObject({ someday: true, waiting: true, priority: 2, project: "music", assigned: "Jim" });
    expect(parseTaskLine(formatTaskLine(p), opts)).toEqual(p);
  });
});

describe("setTaskScheduled — to a day", () => {
  it("writes `do <date>` at the end of the run, before the anchor, and nothing else", () => {
    const line = "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s ^mt-7f3k2a";
    const out = defer(line, { do: "2026-09-30" });
    expect(out).toBe("- [ ] Send Dana the fixture format due 2026-09-28 p2 size s do 2026-09-30 ^mt-7f3k2a");
    expect(out.replace(" do 2026-09-30", "")).toBe(line);
  });

  it("re-dates a `do` already on the line in place rather than adding a second", () => {
    expect(defer("- [ ] Pay rent do 2026-09-29 p1 ^mt-abcdefgh", { do: "2026-10-01" })).toBe("- [ ] Pay rent do 2026-10-01 p1 ^mt-abcdefgh");
    // a relative `do friday` is the owner's spelling of a day; the new day replaces it resolved
    expect(defer("- [ ] Pay rent do friday", { do: "2026-10-05" })).toBe("- [ ] Pay rent do 2026-10-05");
  });

  it("takes `someday` off, because a day was chosen", () => {
    expect(defer("- [ ] Learn the cello someday ^mt-abcdefgh", { do: "2026-10-01" })).toBe("- [ ] Learn the cello do 2026-10-01 ^mt-abcdefgh");
    expect(defer("- [ ] Learn the cello someday p3", { do: "2026-10-01" })).toBe("- [ ] Learn the cello p3 do 2026-10-01");
  });

  it("never moves `due`: a hard date the owner set", () => {
    const out = defer("- [ ] File taxes due 2026-10-15", { do: "2026-10-20" });
    expect(parseTaskLine(out, opts)).toMatchObject({ due: "2026-10-15", scheduled_for: "2026-10-20" });
  });

  it("keeps the user's own spacing, marker, indentation and trailing whitespace byte for byte", () => {
    expect(defer("\t+ [ ]  Two  spaces   inside due friday ^mt-abcdefgh", { do: "2026-10-01" })).toBe("\t+ [ ]  Two  spaces   inside due friday do 2026-10-01 ^mt-abcdefgh");
    expect(defer("  * [ ] Nested   ", { do: "2026-10-01" })).toBe("  * [ ] Nested do 2026-10-01   ");
  });

  it("gives a text-less box its separator", () => {
    expect(defer("- [ ]", { do: "2026-10-01" })).toBe("- [ ] do 2026-10-01");
  });

  it("throws on a day that is not one — the route validates first, so this is a programming error", () => {
    expect(() => setTaskScheduled("- [ ] x", { do: "2026-02-30" }, opts)).toThrow(RangeError);
    expect(() => setTaskScheduled("- [ ] x", { do: "tomorrow" }, opts)).toThrow(RangeError);
  });
});

describe("setTaskScheduled — to someday", () => {
  it("writes the bare word `someday` at the end of the run and takes every `do` off", () => {
    expect(defer("- [ ] Learn the cello p3 ^mt-abcdefgh", { someday: true })).toBe("- [ ] Learn the cello p3 someday ^mt-abcdefgh");
    expect(defer("- [ ] Learn the cello do 2026-09-30 p3 ^mt-abcdefgh", { someday: true })).toBe("- [ ] Learn the cello p3 someday ^mt-abcdefgh");
    expect(defer("- [ ] Learn the cello do 2026-09-30", { someday: true })).toBe("- [ ] Learn the cello someday");
  });

  it("keeps a `someday` already there and only takes the day off", () => {
    expect(defer("- [ ] Learn the cello someday do 2026-09-30", { someday: true })).toBe("- [ ] Learn the cello someday");
  });
});

describe("round-trips through the parser", () => {
  const lines = [
    "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s ^mt-7f3k2a",
    "- [ ] Water the fern @Jim +home size m",
    "- [ ] Learn the cello someday",
    "- [ ] Pay rent do 2026-09-29 p1 linear:ABC-123 work:418 ^mt-abcdefgh",
    "  - [ ] Nested, with a comma: and a colon",
    "- [ ] Ask @Jim about the pricing deck",
    "- [ ] Book flights start 2026-10-01 type errand source meeting:Journal/2026-09-28.md",
  ];
  for (const line of lines) {
    for (const when of [{ do: "2026-10-02" }, { someday: true }] as TaskDeferral[]) {
      it(`${JSON.stringify(when)} on ${line}`, () => {
        const r = setTaskScheduled(line, when, opts);
        if (!r.ok) {
          expect(r.reason).toBe("already"); // only the someday line deferred to someday again
          return;
        }
        const before = parseTaskLine(line, opts)!;
        const after = parseTaskLine(r.line, opts)!;
        // every field the parser reads, as it was, but the day
        expect({ ...after, scheduled_for: null, someday: false }).toEqual({ ...before, scheduled_for: null, someday: false });
        expect(after.scheduled_for).toBe("do" in when ? when.do : null);
        expect(after.someday).toBe(!("do" in when));
        // and the written line is a fixed point of the canonical form's field set
        expect(parseTaskLine(formatTaskLine(after), opts)).toEqual(after);
      });
    }
  }
});

describe("no emoji is ever written", () => {
  // Lines carrying every Tasks-plugin glyph the reader knows, and plain ones.
  const corpus = [
    "- [ ] Pay rent 📅 2026-10-01 ^mt-abcdefgh",
    "- [ ] Pay rent ⏫ 🔁 every month",
    "- [ ] Pay rent 🛫 2026-09-29",
    "- [ ] Pay rent ➕ 2026-09-01 🆔 abc123",
    "- [ ] Pay rent 🔺",
    "- [ ] Pay rent ⏳ 2026-09-30",
    "- [ ] Pay rent ⌛ 2026-09-30",
    "- [ ] Pay rent [scheduled:: 2026-09-30]",
    "- [ ] Plain",
    "- [ ] Plain do 2026-09-29",
    "- [ ] Plain someday",
    "- [ ] 🎉 Party planning due friday",
  ];
  for (const line of corpus) {
    it(`adds no glyph to: ${line}`, () => {
      for (const when of [{ do: "2026-10-02" }, { someday: true }] as TaskDeferral[]) {
        const r = setTaskScheduled(line, when, opts);
        if (!r.ok) continue; // a refusal writes nothing at all
        // the glyphs after are exactly the glyphs before — none added, none moved
        expect(emoji(r.line)).toEqual(emoji(line));
        // and everything the door added is plain ASCII
        expect(/^[\x20-\x7e]*$/.test(byteDiff(line, r.line).added)).toBe(true);
      }
    });
  }

  it("refuses a line whose day is a Tasks-plugin `⏳`/`⌛` or a Dataview `scheduled::` — it will not write a second day beside it", () => {
    for (const line of ["- [ ] Pay rent ⏳ 2026-09-30", "- [ ] Pay rent ⌛ 2026-09-30 p1", "- [ ] Pay rent [scheduled:: 2026-09-30]", "- [ ] Pay rent (scheduled:: 2026-09-30)"]) {
      for (const when of [{ do: "2026-10-02" }, { someday: true }] as TaskDeferral[]) {
        const r = setTaskScheduled(line, when, opts);
        expect(r.ok, `${line} ${JSON.stringify(when)}`).toBe(false);
        if (!r.ok) expect(r.reason).toBe("compat");
      }
    }
  });

  it("the canonical form has no code path to a glyph: a someday line with every field formats as English", () => {
    const p = parseTaskLine("- [ ] Pay rent 📅 2026-10-01 ⏫ 🔁 every month someday", opts)!;
    expect(emoji(formatTaskLine({ ...p, someday: true, scheduled_for: "2026-10-02" }))).toEqual([]);
  });
});

describe("setTaskScheduled refuses rather than approximates", () => {
  const refusal = (line: string, when: TaskDeferral = { do: "2026-10-02" }) => {
    const r = setTaskScheduled(line, when, opts);
    return r.ok ? `wrote: ${r.line}` : r.reason;
  };

  it("a line that is not a task", () => {
    expect(refusal("Just prose")).toBe("not_a_task");
    expect(refusal("- a bullet")).toBe("not_a_task");
  });

  it("a ticked line — done, not waiting for a day", () => {
    expect(refusal("- [x] Pay rent done 2026-09-27")).toBe("done");
  });

  it("a dropped line", () => {
    expect(refusal("- [-] Pay rent")).toBe("dropped");
  });

  it("a recurrence rule, which is never itself a task", () => {
    expect(refusal("- [ ] Water the plants every week")).toBe("rule");
  });

  it("a line already deferred exactly so", () => {
    expect(refusal("- [ ] Pay rent do 2026-10-02")).toBe("already");
    expect(refusal("- [ ] Pay rent someday", { someday: true })).toBe("already");
  });

  it("a `do` clause it cannot read — it would drop the owner's words, so the line is deferred in the note instead", () => {
    expect(refusal("- [ ] Pay rent do nextweek")).toBe("unsafe");
  });
});
