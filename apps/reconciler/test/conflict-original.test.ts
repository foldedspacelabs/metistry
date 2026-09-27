// Which note a sync conflict copy is a copy of (T2-9): the review a copy
// raises shows both versions, so the name has to lead back to the original
// for every spelling the sync tools use — and to nothing for a path that is
// not a copy.
import { describe, expect, it } from "vitest";
import { conflictOriginal, isConflictFile } from "../src/notes.js";

describe("conflictOriginal", () => {
  it("names the original for Obsidian Sync, Syncthing and the other spellings, in the same folder", () => {
    expect(conflictOriginal("Areas/Health/Beta (conflict 2026-09-06 12-00-00).md")).toBe("Areas/Health/Beta.md");
    expect(conflictOriginal("Areas/Health/Beta.sync-conflict-20260906-120000-ABCDEFG.md")).toBe("Areas/Health/Beta.md");
    expect(conflictOriginal("Beta (sync-conflict 2026-09-06).md")).toBe("Beta.md");
    expect(conflictOriginal("Journal/2026-09-26 (Conflict 1).md")).toBe("Journal/2026-09-26.md");
  });

  it("is null for a path that is not a copy, and for a name that is nothing but the marker", () => {
    expect(conflictOriginal("Areas/Health/Beta.md")).toBeNull();
    expect(conflictOriginal("Areas/Conflicts/Beta.md")).toBeNull();
    expect(isConflictFile("Areas/(conflict 1).md")).toBe(true);
    expect(conflictOriginal("Areas/(conflict 1).md")).toBeNull();
  });
});
