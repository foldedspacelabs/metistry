// The deterministic session summariser (stash review item 2). The fixture
// under test/fixtures is the SAME file the Claude Code plugin's parity test
// reads, so both doors are held to one expected summary.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_PROMPT_CHARS,
  LAST_MESSAGE_CHARS,
  MAX_FILES,
  decodeProjectDir,
  formatDuration,
  idempotencyKey,
  renderSessionBody,
  renderSessionNote,
  repoNameFromPath,
  sessionTitle,
  summarizeTranscript,
} from "../src/session-summary.js";

export const FIXTURE = join(import.meta.dirname, "fixtures", "claude-code-session.jsonl");
const raw = readFileSync(FIXTURE, "utf8");

describe("summarizeTranscript", () => {
  const s = summarizeTranscript(raw)!;

  it("reads the session's identity from the records", () => {
    expect(s.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(s.project).toBe("/Users/example/Development/demo");
    expect(s.repo).toBe("demo");
    expect(s.branch).toBe("claude/demo");
    expect(s.version).toBe("2.1.251");
  });

  it("counts only the owner's turns — sidechain and meta records are not turns", () => {
    expect(s.turns).toBe(2);
    expect(s.assistantMessages).toBe(4);
  });

  it("spans first to last timestamp, including non-message records", () => {
    expect(s.started).toBe("2026-09-08T10:00:00.000Z");
    expect(s.ended).toBe("2026-09-08T10:37:00.000Z");
    expect(s.durationMs).toBe(37 * 60_000);
    expect(formatDuration(s.durationMs)).toBe("37m");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(null)).toBe("unknown");
  });

  it("collects file paths from tool inputs, deduped and in first-seen order", () => {
    expect(s.files).toEqual(["/Users/example/Development/demo/src/loader.ts", "/Users/example/Development/demo/src/loader.test.ts"]);
    expect(s.filesTruncated).toBe(false);
  });

  it("counts tools, most-used first", () => {
    expect(s.tools).toEqual([
      { name: "Bash", count: 1 },
      { name: "Edit", count: 1 },
      { name: "Read", count: 1 },
      { name: "Write", count: 1 },
    ]);
  });

  it("records every model and sums tokens", () => {
    expect(s.models).toEqual(["claude-fable-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]);
    expect(s.inputTokens).toBe(1320);
    expect(s.outputTokens).toBe(405);
  });

  it("carries no cost when the transcript carries none", () => {
    expect(s.costUsd).toBeNull();
  });

  it("clips the first prompt and the last response", () => {
    expect(s.firstPrompt.length).toBe(FIRST_PROMPT_CHARS);
    expect(s.firstPrompt.startsWith("Please refactor the widget loader.")).toBe(true);
    expect(s.firstPrompt.endsWith("…")).toBe(true);
    expect(s.lastAssistant.length).toBe(LAST_MESSAGE_CHARS);
    expect(s.lastAssistant.startsWith("Done — tests pass.")).toBe(true);
  });

  it("never carries thinking blocks into the summary", () => {
    expect(renderSessionBody(s)).not.toContain("secret reasoning");
  });

  it("is deterministic — same bytes in, same bytes out", () => {
    expect(renderSessionBody(summarizeTranscript(raw)!)).toBe(renderSessionBody(s));
  });

  it("tolerates a half-written line, an unknown record type and a string content", () => {
    expect(summarizeTranscript(`${raw}{"type":"assistant","mess`)).toEqual(s);
  });

  it("returns null when there is no conversation to summarise", () => {
    expect(summarizeTranscript("")).toBeNull();
    expect(summarizeTranscript(`{"type":"mode","mode":"normal"}\n`)).toBeNull();
  });

  it("caps the file list", () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ type: "tool_use", name: "Read", input: { file_path: `/tmp/f${i}.ts` } }));
    const line = JSON.stringify({ type: "assistant", timestamp: "2026-09-08T10:00:00.000Z", message: { role: "assistant", content: many } });
    const user = JSON.stringify({ type: "user", timestamp: "2026-09-08T10:00:00.000Z", message: { role: "user", content: "go" } });
    const capped = summarizeTranscript(`${user}\n${line}\n`)!;
    expect(capped.files).toHaveLength(MAX_FILES);
    expect(capped.filesTruncated).toBe(true);
    expect(renderSessionBody(capped)).toContain(`capped at ${MAX_FILES}`);
  });
});

describe("paths", () => {
  it("names the checkout, seeing through a worktree", () => {
    expect(repoNameFromPath("/Users/x/Development/Metistry")).toBe("Metistry");
    expect(repoNameFromPath("/Users/x/Development/Metistry/.claude/worktrees/agent-abc")).toBe("Metistry");
    expect(repoNameFromPath(null)).toBeNull();
  });

  it("decodes a project directory name as the lossy fallback it is", () => {
    expect(decodeProjectDir("-Users-x-Development-Metistry")).toBe("/Users/x/Development/Metistry");
    expect(decodeProjectDir("plain")).toBe("plain");
  });
});

describe("renderSessionNote", () => {
  const s = summarizeTranscript(raw)!;
  const note = renderSessionNote(s, { host: "studio", capturedAt: "2026-09-09T00:00:00.000Z" });

  it("emits the frontmatter shape both capture doors promise (docs/ops/cli.md)", () => {
    const fm = note.slice(0, note.indexOf("\n---", 4));
    expect(fm).toContain(`kind: "session"`);
    expect(fm).toContain(`source: "claude-code"`);
    expect(fm).toContain(`session_id: "11111111-2222-3333-4444-555555555555"`);
    expect(fm).toContain(`project: "/Users/example/Development/demo"`);
    expect(fm).toContain(`started: "2026-09-08T10:00:00.000Z"`);
    expect(fm).toContain(`ended: "2026-09-08T10:37:00.000Z"`);
    expect(fm).toContain(`captured_at: "2026-09-09T00:00:00.000Z"`);
    expect(fm).toContain(`idempotency_key: "${idempotencyKey(s)}"`);
    expect(note).toContain(`# ${sessionTitle(s)}`);
  });

  it("titles by repo and start day", () => {
    expect(sessionTitle(s)).toBe("Claude Code session — demo — 2026-09-08");
  });

  it("keys on the transcript's state, not on the clock or the file's mtime", () => {
    expect(idempotencyKey(s)).toBe(idempotencyKey(summarizeTranscript(raw)!));
    expect(idempotencyKey(s)).toMatch(/^claude-code:11111111-2222-3333-4444-555555555555:[0-9a-f]{16}$/);
    const shorter = summarizeTranscript(raw.split("\n").slice(0, 6).join("\n"))!;
    expect(idempotencyKey(shorter)).not.toBe(idempotencyKey(s));
  });
});
