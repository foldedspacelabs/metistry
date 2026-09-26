// The walk and the Tick door must key a note's task lines identically
// (design-build-plan §2.11, T2-4). The walk keys them here (`extractTasks`);
// the console finds a line to tick with core's `taskLinesOf`, because an app
// never imports another app. Two implementations of one identity are one
// drift away from a tick that cannot find its line — or finds the wrong one —
// so this holds them to the same answers over the cases the key turns on.
import { describe, expect, it } from "vitest";
import { taskLinesOf } from "@foldedspacelabs/metistry-core";
import { extractTasks } from "../src/notes.js";

const opts = { now: new Date("2026-09-28T15:00:00Z"), timeZone: "UTC" };

const NOTES: Record<string, string> = {
  plain: "# Day\n- [ ] One\n- [x] Two done 2026-09-27\n",
  crlf: "# Day\r\n- [ ] One\r\n- [ ] One\r\n",
  frontmatter: "---\ntitle: Day\ntags:\n  - [ ] not a task\n---\n- [ ] After the fence\n",
  unclosedFrontmatter: "---\n- [ ] Is this a task\n",
  fences: "- [ ] Before\n```\n- [ ] Inside\n~~~\n- [ ] Still inside\n```\n- [ ] After\n~~~md\n- [ ] Tilde inside\n~~~\n",
  duplicates: "- [ ] Call the dentist\n- [ ] Call the dentist ^mt-abcdefgh\n- [ ] call the DENTIST!\n",
  repeatedAnchor: "- [ ] First ^mt-abcdefgh\n- [ ] Second ^mt-abcdefgh\n- [ ] Third ^MT-ABCDEFGH\n",
  markers: "* [ ] Star\n+ [X] Plus\n  - [-] Dropped nested\n\t- [ ] Tab nested\n",
  empty: "",
};

describe("the walk's task keys and the Tick door's are the same keys", () => {
  for (const [name, text] of Object.entries(NOTES)) {
    it(name, () => {
      const walk = extractTasks(text, opts).map((t) => [t.task_key, t.line_no, t.parsed.text]);
      const door = taskLinesOf(text, opts).map((t) => [t.task_key, t.line_no, t.parsed.text]);
      expect(door).toEqual(walk);
    });
  }
});
