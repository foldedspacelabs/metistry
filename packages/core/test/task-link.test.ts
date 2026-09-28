// The Link door's one edit (design-build-plan §2.1, T4-25). `setTaskRef` adds
// one `linear:` or `gh:` ref to one task line and nothing else: the ref and
// the one space before it, at the end of the trailing run, before the anchor.
// A line it cannot prove it changed by exactly that is refused, never
// approximated.
import { describe, expect, it } from "vitest";
import { formatTaskLine, parseTaskLine, setTaskRef, TASK_REF_RE } from "../src/task-line.js";

const opts = { now: new Date("2026-09-28T15:00:00Z"), timeZone: "America/New_York" };

function link(line: string, ref: string) {
  const r = setTaskRef(line, ref, opts);
  if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
  return r.line;
}

describe("TASK_REF_RE — the two shapes the door writes", () => {
  it("admits a Linear key and a GitHub issue or PR, and nothing else", () => {
    for (const ok of ["linear:ENG-12", "linear:MET-1", "gh:foldedspacelabs/metistry#418", "gh:a/b.c_d-e#1"]) expect(TASK_REF_RE.test(ok), ok).toBe(true);
    for (const bad of ["linear:eng-12", "linear:ENG-0", "linear:ENG12", "linear:ENG-12 x", "linear:ENG-12\n", "gh:owner/repo", "gh:owner#1", "gh:-x/y#1", "work:418", "ENG-12", "linear: ENG-1", ""]) {
      expect(TASK_REF_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a ref outside the shape is a caller's bug, thrown — never written", () => {
    expect(() => setTaskRef("- [ ] Send it", "linear:eng-1", opts)).toThrow(RangeError);
    expect(() => setTaskRef("- [ ] Send it", "linear:ENG-1 p1", opts)).toThrow(RangeError);
  });
});

describe("setTaskRef — the bytes it adds", () => {
  it("appends the ref at the end of the trailing run, before the anchor: one space and the ref, nothing else", () => {
    const line = "- [ ] Send Dana the fixture format due 2026-09-28 p2 ^mt-7f3k2a";
    const out = link(line, "linear:MET-42");
    expect(out).toBe("- [ ] Send Dana the fixture format due 2026-09-28 p2 linear:MET-42 ^mt-7f3k2a");
    const before = parseTaskLine(line, opts)!;
    const after = parseTaskLine(out, opts)!;
    expect(after.ext_refs).toEqual(["linear:MET-42"]);
    expect({ ...after, ext_refs: [] }).toEqual({ ...before, ext_refs: [] });
    // the task's text — and so its hash key — is unchanged by a link
    expect(after.text).toBe(before.text);
  });

  it("with no fields and no anchor, the ref becomes the run", () => {
    expect(link("- [ ] Ask about the pricing deck", "gh:foldedspacelabs/metistry#418")).toBe("- [ ] Ask about the pricing deck gh:foldedspacelabs/metistry#418");
    expect(link("  * [ ] indented", "linear:ENG-1")).toBe("  * [ ] indented linear:ENG-1");
  });

  it("keeps whatever follows the anchor, and a ref of the other scheme", () => {
    expect(link("- [ ] Ship it gh:o/r#1 ^mt-abcdefgh  ", "linear:ENG-9")).toBe("- [ ] Ship it gh:o/r#1 linear:ENG-9 ^mt-abcdefgh  ");
  });

  it("a ticked or dropped line may be linked — a ref is a pointer, not a state", () => {
    expect(link("- [x] Done thing done 2026-09-27", "linear:ENG-2")).toBe("- [x] Done thing done 2026-09-27 linear:ENG-2");
    expect(link("- [-] Dropped thing", "linear:ENG-3")).toBe("- [-] Dropped thing linear:ENG-3");
  });

  it("round-trips through formatTaskLine as the same line", () => {
    const out = link("- [ ] Draft the Q4 plan due 2026-10-01 p1 ^mt-4q8r2d", "linear:MET-7");
    expect(formatTaskLine(parseTaskLine(out, opts)!)).toBe(out);
  });
});

describe("setTaskRef — refused, nothing written", () => {
  const refused = (line: string, ref: string) => {
    const r = setTaskRef(line, ref, opts);
    return r.ok ? "ok" : r.reason;
  };

  it("not a task line", () => {
    expect(refused("Just prose", "linear:ENG-1")).toBe("not_a_task");
    expect(refused("- [ ] two\nlines", "linear:ENG-1")).toBe("not_a_task");
  });

  it("a recurrence rule — never itself a task", () => {
    expect(refused("- [ ] Water the plants every week due friday", "linear:ENG-1")).toBe("rule");
  });

  it("the same ref already there is `already`; another of the same scheme is `linked`", () => {
    expect(refused("- [ ] Ship it linear:ENG-1", "linear:ENG-1")).toBe("already");
    expect(refused("- [ ] Ship it linear:ENG-1", "linear:ENG-2")).toBe("linked");
    expect(refused("- [ ] Ship it gh:o/r#1", "gh:o/r#2")).toBe("linked");
  });
});
