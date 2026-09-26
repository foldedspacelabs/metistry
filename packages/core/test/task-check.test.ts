// The Tick door's one edit (design-build-plan §2.11, T2-4). `setTaskChecked`
// is the whole of what the console may do to a line the owner typed, so the
// cases that matter are the ones where it must write NOTHING: a line it cannot
// prove it changed by exactly the box and one `done` clause is refused, never
// approximated.
import { describe, expect, it } from "vitest";
import { locateTaskLine, parseTaskLine, replaceLine, setTaskChecked, taskHashKey, taskLinesOf, TASK_KEY_RE } from "../src/task-line.js";

const opts = { now: new Date("2026-09-28T15:00:00Z"), timeZone: "America/New_York" };
const TODAY = "2026-09-28";

/** The bytes that differ between two strings, as the removed and added runs — what a reviewer's diff would show. */
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

function tick(line: string, checked = true) {
  const r = setTaskChecked(line, checked, TODAY, opts);
  if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
  return r.line;
}

describe("setTaskChecked — tick", () => {
  it("writes exactly `[x]` and `done <date>` before the anchor, and nothing else", () => {
    const line = "- [ ] Send Dana the fixture format due 2026-09-28 p2 size s ^mt-7f3k2a";
    const out = tick(line);
    expect(out).toBe("- [x] Send Dana the fixture format due 2026-09-28 p2 size s done 2026-09-28 ^mt-7f3k2a");
    // the only changes: the box character, and one inserted clause
    const box = byteDiff(line.slice(0, 6), out.slice(0, 6));
    expect(box).toEqual({ removed: " ", added: "x" });
    const rest = byteDiff(line.slice(6), out.slice(6));
    expect(rest.removed).toBe("");
    expect(rest.added.trim()).toBe("done 2026-09-28");
    expect(out.slice(6).replace(" done 2026-09-28", "")).toBe(line.slice(6));
  });

  it("appends at the end of a line with no anchor, and keeps trailing whitespace where it was", () => {
    expect(tick("- [ ] Call the dentist")).toBe("- [x] Call the dentist done 2026-09-28");
    expect(tick("  * [ ] Nested   ")).toBe("  * [x] Nested done 2026-09-28   ");
  });

  it("keeps the user's own spacing, marker and indentation byte for byte", () => {
    const line = "\t+ [ ]  Two  spaces   inside due friday ^mt-abcdefgh";
    const out = tick(line);
    expect(out).toBe("\t+ [x]  Two  spaces   inside due friday done 2026-09-28 ^mt-abcdefgh");
  });

  it("re-dates a `done` already on an unticked line in place rather than adding a second", () => {
    expect(tick("- [ ] Pay rent done 2026-09-01 ^mt-abcdefgh")).toBe("- [x] Pay rent done 2026-09-28 ^mt-abcdefgh");
  });

  it("does not mistake `done` inside the text for a field", () => {
    const out = tick("- [ ] Get it done by friday");
    expect(out).toBe("- [x] Get it done by friday done 2026-09-28");
    expect(parseTaskLine(out, opts)!.text).toBe("Get it done by friday");
  });
});

describe("setTaskChecked — Undo is the same door, the reverse", () => {
  it("round-trips: tick then untick gives back the exact bytes", () => {
    for (const line of [
      "- [ ] Send Dana the fixture format due 2026-09-28 ^mt-7f3k2a",
      "- [ ] Call the dentist",
      "  - [ ] Water the fern @Jim +home size m",
      "* [ ] Trailing spaces   ",
    ]) {
      expect(tick(tick(line), false)).toBe(line);
    }
  });

  it("removes only the `done` clause and flips `[x]`, uppercase included", () => {
    expect(tick("- [X] Ship it p1 done 2026-09-27 ^mt-abcdefgh", false)).toBe("- [ ] Ship it p1 ^mt-abcdefgh");
    expect(tick("- [x] Ship it done 2026-09-27 p1", false)).toBe("- [ ] Ship it p1");
  });

  it("unticks a line ticked in Obsidian with no `done` by flipping the box alone", () => {
    expect(tick("- [x] Ticked by hand", false)).toBe("- [ ] Ticked by hand");
  });
});

describe("setTaskChecked — refusals", () => {
  const refuse = (line: string, checked = true) => {
    const r = setTaskChecked(line, checked, TODAY, opts);
    expect(r.ok, line).toBe(false);
    return r.ok ? null : r.reason;
  };

  it("refuses a line already in the state asked for", () => {
    expect(refuse("- [x] Done already done 2026-09-27")).toBe("already");
    expect(refuse("- [ ] Open", false)).toBe("already");
  });

  it("refuses what is not a task, a dropped line and a recurrence rule", () => {
    expect(refuse("Just prose")).toBe("not_a_task");
    expect(refuse("- a bullet")).toBe("not_a_task");
    expect(refuse("- [-] Dropped")).toBe("dropped");
    expect(refuse("- [ ] Water the plants every week")).toBe("rule");
  });

  it("refuses a line whose `done` it did not write and cannot remove (a compatibility marker)", () => {
    expect(refuse("- [x] Tasks-plugin done ✅ 2026-09-20", false)).toBe("unsafe");
  });

  it("refuses a line with a line ending in it rather than splice across lines", () => {
    expect(refuse("- [ ] One\r")).toBe("not_a_task");
  });

  it("rejects a date that is not a calendar date", () => {
    expect(() => setTaskChecked("- [ ] x", true, "2026-02-30", opts)).toThrow(RangeError);
    expect(() => setTaskChecked("- [ ] x", true, "friday", opts)).toThrow(RangeError);
  });
});

describe("locating a line by the index's key", () => {
  const note = [
    "---",
    "title: Day",
    "tags:",
    "  - [ ] not a task, frontmatter",
    "---",
    "# 2026-09-28",
    "- [ ] Call the dentist",
    "```",
    "- [ ] Call the dentist",
    "```",
    "- [ ] Call the dentist ^mt-abcdefgh",
    "- [ ] Call the dentist",
    "- [ ] Other ^mt-abcdefgh",
  ].join("\r\n");

  it("keys lines the way the walk does: frontmatter and fences skipped, ordinals over every identical line, a repeated anchor hashed", () => {
    const lines = taskLinesOf(note, opts);
    const h = (o: number, text = "call the dentist") => taskHashKey(text, o);
    expect(lines.map((l) => [l.task_key, l.line_no])).toEqual([
      [h(0), 7],
      ["mt-abcdefgh", 11],
      [h(2), 12],
      [h(0, "other"), 13],
    ]);
    for (const l of lines) expect(TASK_KEY_RE.test(l.task_key), l.task_key).toBe(true);
  });

  it("finds a line wherever it moved, and nothing when it is gone", () => {
    const moved = `# new heading\n${note.replaceAll("\r\n", "\n")}`;
    expect(locateTaskLine(moved, "mt-abcdefgh", opts)?.line_no).toBe(12);
    expect(locateTaskLine(note, "mt-zzzzzzzz", opts)).toBeNull();
  });

  it("replaces one line and keeps every other byte, CRLF included", () => {
    const out = replaceLine(note, 7, "- [x] Call the dentist done 2026-09-28");
    expect(byteDiff(note, out)).toEqual({ removed: " ] Call the dentist", added: "x] Call the dentist done 2026-09-28" });
    const a = note.split("\r\n");
    const b = out.split("\r\n");
    expect(b.length).toBe(a.length);
    expect(b.filter((l, i) => l !== a[i])).toEqual(["- [x] Call the dentist done 2026-09-28"]);
    expect(() => replaceLine(note, 99, "x")).toThrow(RangeError);
  });
});
