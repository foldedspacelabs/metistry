// The OpenCode plugin's note rendering and `packages/core`'s must never drift.
//
// The three plugins' `scripts/lib.mjs` are NOT identical — OpenCode hands a
// plugin its SDK client where Cursor hands it a payload and Claude Code a
// JSONL file, so there is no summariser to share. What must not drift is the
// part the server sees. So every plugin is held to the same single anchor,
// `packages/core`, which locks them to each other transitively without either
// importing the other or a package being invented for three functions.
//
// The mechanism: the plugin's `renderSessionNote`, `renderSessionBody`,
// `sessionTitle` and `idempotencyKey` default to CORE's source and label, so
// calling them with nothing supplied must produce core's bytes exactly. The
// plugin always supplies `{ source: "opencode", label: "OpenCode" }`.
// Core is a devDependency for this test only; nothing under scripts/ or
// plugin.js imports it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "@foldedspacelabs/metistry-core";
import * as plugin from "../scripts/lib.mjs";

// The same fixture packages/core/test/session-summary.test.ts and the other
// two plugins' parity tests read.
const FIXTURE = join(import.meta.dirname, "..", "..", "..", "packages", "core", "test", "fixtures", "claude-code-session.jsonl");
const summary = core.summarizeTranscript(readFileSync(FIXTURE, "utf8"))!;
const at = { host: "studio", capturedAt: "2026-09-16T00:00:00.000Z" };

describe("note rendering parity (plugin .mjs vs packages/core)", () => {
  it("renders the same note, byte for byte", () => {
    expect(plugin.renderSessionNote(summary, at)).toBe(core.renderSessionNote(summary, at));
  });

  it("renders the same body and the same title", () => {
    expect(plugin.renderSessionBody(summary)).toBe(core.renderSessionBody(summary));
    expect(plugin.sessionTitle(summary)).toBe(core.sessionTitle(summary));
  });

  it("computes the same idempotency_key — on core's default source and on OpenCode's", () => {
    expect(plugin.idempotencyKey(summary)).toBe(core.idempotencyKey(summary));
    expect(plugin.idempotencyKey(summary, plugin.SOURCE)).toBe(core.idempotencyKey(summary, "opencode"));
    expect(plugin.idempotencyKey(summary, plugin.SOURCE)).toMatch(/^opencode:[^:]+:[0-9a-f]{16}$/);
  });

  it("formats durations identically, including the unknown case", () => {
    for (const ms of [null, 0, 59_999, 60_000, 3_540_000, 3_600_000, 7_980_000]) {
      expect(plugin.formatDuration(ms)).toBe(core.formatDuration(ms as number | null));
    }
  });

  it("shares the caps and derives repo names the same way", () => {
    expect(plugin.MAX_FILES).toBe(core.MAX_FILES);
    expect(plugin.FIRST_PROMPT_CHARS).toBe(core.FIRST_PROMPT_CHARS);
    expect(plugin.LAST_MESSAGE_CHARS).toBe(core.LAST_MESSAGE_CHARS);
    for (const p of [null, "", "/Users/x/Development/metistry", "/Users/x/.claude/projects", "relative/dir"]) {
      expect(plugin.repoNameFromPath(p)).toBe(core.repoNameFromPath(p));
    }
  });
});

describe("what OpenCode adds is additive only", () => {
  // Every OpenCode-only fact is appended after the shared ones and every
  // OpenCode-only section after the shared ones, so a core-shaped summary is
  // untouched. This asserts the other direction: with the extras present the
  // note still starts with core's bytes.
  it("keeps core's frontmatter keys, in core's order", () => {
    const keys = (note: string) => /^---\n([\s\S]*?)\n---\n/.exec(note)![1]!.split("\n").map((l) => l.split(":")[0]);
    const ocNote = plugin.renderSessionNote({ ...summary, agent: "build", notCaptured: "x" }, { ...at, source: "opencode", label: "OpenCode" });
    expect(keys(ocNote)).toEqual(keys(core.renderSessionNote(summary, at)));
  });

  it("titles and labels with the tool's own name, and nowhere hardcodes the assistant's", () => {
    const note = plugin.renderSessionNote(summary, { ...at, source: plugin.SOURCE, label: plugin.LABEL });
    expect(note).toContain(`# OpenCode session — ${summary.repo} —`);
    expect(note).toContain(`source: "opencode"`);
    expect(note).not.toContain("Claude Code");
  });
});
