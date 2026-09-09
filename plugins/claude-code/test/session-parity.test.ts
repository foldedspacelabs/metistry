// The plugin's summariser and `packages/core`'s must never drift.
//
// They exist twice on purpose: the plugin ships as dependency-free `.mjs` a
// stranger runs out of `~/.claude/plugins`, so it cannot import a built
// workspace package; `metistry import-sessions` runs inside the monorepo and
// uses core's copy. Both post to the same `/capture`, so if their output ever
// differs the server sees two shapes for one kind — this test is the guard.
// Core is a devDependency here for the test only; nothing under scripts/
// imports it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "@foldedspacelabs/metistry-core";
import * as plugin from "../scripts/lib.mjs";

// One fixture, shared with packages/core/test/session-summary.test.ts.
const FIXTURE = join(import.meta.dirname, "..", "..", "..", "packages", "core", "test", "fixtures", "claude-code-session.jsonl");
const raw = readFileSync(FIXTURE, "utf8");
const at = { host: "studio", capturedAt: "2026-09-09T00:00:00.000Z" };

describe("session summariser parity (plugin .mjs vs packages/core)", () => {
  it("summarises a transcript identically", () => {
    expect(plugin.summarizeTranscript(raw)).toEqual(core.summarizeTranscript(raw));
  });

  it("honours the same fallbacks", () => {
    const fb = { sessionId: "given", project: "/tmp/given" };
    expect(plugin.summarizeTranscript(`{"type":"user","message":{"role":"user","content":"hi"}}`, fb)).toEqual(
      core.summarizeTranscript(`{"type":"user","message":{"role":"user","content":"hi"}}`, fb),
    );
  });

  it("agrees there is nothing to summarise", () => {
    expect(plugin.summarizeTranscript("")).toBeNull();
    expect(core.summarizeTranscript("")).toBeNull();
  });

  it("renders the same note, byte for byte", () => {
    const s = core.summarizeTranscript(raw)!;
    expect(plugin.renderSessionNote(s, at)).toBe(core.renderSessionNote(s, at));
  });

  it("computes the same idempotency_key", () => {
    const s = core.summarizeTranscript(raw)!;
    expect(plugin.idempotencyKey(s)).toBe(core.idempotencyKey(s));
  });

  it("shares the clipping limits and the file cap", () => {
    expect([plugin.FIRST_PROMPT_CHARS, plugin.LAST_MESSAGE_CHARS, plugin.MAX_FILES]).toEqual([
      core.FIRST_PROMPT_CHARS,
      core.LAST_MESSAGE_CHARS,
      core.MAX_FILES,
    ]);
  });
});
