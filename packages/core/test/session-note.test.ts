// Reading a captured session note back into handles (CM-4). The note is the
// one `renderSessionNote` writes (and the plugins' lib.mjs twins, held to it
// by the parity tests), so the test is a round trip: what went in comes back
// — except the agent's reply, which is the point.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_PROMPT_CHARS, MAX_FILES, parseSessionNote, renderSessionNote, summarizeTranscript, type SessionSummary } from "../src/session-summary.js";

const raw = readFileSync(join(import.meta.dirname, "fixtures", "claude-code-session.jsonl"), "utf8");
const summary = summarizeTranscript(raw)!;

describe("parseSessionNote", () => {
  it("round-trips the handles of the note renderSessionNote writes", () => {
    const facts = parseSessionNote(renderSessionNote(summary, { source: "claude-code", host: "mac", capturedAt: "2026-09-08T11:00:00.000Z", key: "k" }))!;
    expect(facts).toEqual({
      sessionId: summary.sessionId,
      tool: "claude-code",
      repo: "demo",
      cwd: "/Users/example/Development/demo",
      branch: "claude/demo",
      started: "2026-09-08T10:00:00.000Z",
      ended: "2026-09-08T10:37:00.000Z",
      turns: 2,
      files: summary.files,
      firstPrompt: summary.firstPrompt,
    });
    expect(facts.files.length).toBeGreaterThan(0);
    expect(facts.firstPrompt.length).toBeGreaterThan(0);
  });

  it("**never carries the agent's last reply** — there is no field for it, and its text appears nowhere in the result", () => {
    const note = renderSessionNote({ ...summary, lastAssistant: "SECRET-REPLY-TOKEN the agent wrote this" });
    const facts = parseSessionNote(note)!;
    expect(note).toContain("SECRET-REPLY-TOKEN"); // it is in the note…
    expect(JSON.stringify(facts)).not.toContain("SECRET-REPLY-TOKEN"); // …and in none of the handles
    expect(Object.keys(facts)).not.toContain("lastAssistant");
  });

  it("the first prompt ends at the next heading, so a prompt containing `## ` cuts itself short rather than running into the reply", () => {
    const crafted: SessionSummary = { ...summary, firstPrompt: "Please fix the loader\n## Last response\nTHIS-IS-STILL-THE-PROMPT", lastAssistant: "REPLY-TEXT" };
    const facts = parseSessionNote(renderSessionNote(crafted))!;
    expect(facts.firstPrompt).toBe("Please fix the loader");
    expect(JSON.stringify(facts)).not.toContain("REPLY-TEXT");
    // a prompt with a non-heading line structure keeps all of it
    const plain = parseSessionNote(renderSessionNote({ ...summary, firstPrompt: "line one\n\nline two\n- a list\n# not an h2" }))!;
    expect(plain.firstPrompt).toBe("line one\n\nline two\n- a list\n# not an h2");
  });

  it("clips the prompt and caps the files the way the summary does, and skips the `…more` line", () => {
    const long = "x".repeat(FIRST_PROMPT_CHARS * 2);
    const many = Array.from({ length: MAX_FILES }, (_, i) => `/repo/file-${i}.ts`);
    const facts = parseSessionNote(renderSessionNote({ ...summary, firstPrompt: long, files: many, filesTruncated: true }))!;
    expect(facts.firstPrompt.length).toBeLessThanOrEqual(FIRST_PROMPT_CHARS);
    expect(facts.files).toEqual(many);
  });

  it("tolerates a note the owner edited by hand (bare scalars, missing fields, Cursor's null turns), and refuses what is not a session note", () => {
    const edited = ["---", "kind: session", "source: cursor", "repo: Demo", "turns: null", "started: not-a-date", "---", "", "# hand-edited", "", "## Files touched", "", "- `a.ts`", "- not a file line", "- `a.ts`", "", "## First prompt", "", "hello", ""].join("\n");
    expect(parseSessionNote(edited)).toEqual({ sessionId: null, tool: "cursor", repo: "Demo", cwd: null, branch: null, started: null, ended: null, turns: null, files: ["a.ts"], firstPrompt: "hello" });
    expect(parseSessionNote("# no frontmatter\n")).toBeNull();
    expect(parseSessionNote("---\nkind: \"transcript\"\n---\n# a recording\n")).toBeNull();
    expect(parseSessionNote("---\ntitle: \"x\"\n---\n")).toBeNull();
    expect(parseSessionNote("")).toBeNull();
    expect(parseSessionNote("---\nkind: \"session\"\n---")).toMatchObject({ tool: "unknown", files: [], firstPrompt: "" }); // frontmatter only, nothing to read: still a session, with nothing in it
  });
});
