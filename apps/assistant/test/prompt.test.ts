// The system prompt is templated from identity.yaml — the assistant's name
// never appears in code (CLAUDE.md naming rule) — over the seed prompt file,
// with a D4 overlay for both. Degrades absent.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDecisionBlock } from "@foldedspacelabs/metistry-core";
import { loadSystemPrompt, parseIdentity, readOverlay, renderPrompt } from "../src/prompt.js";

const seedIdentity = readFileSync(new URL("../../../seed/identity.yaml", import.meta.url), "utf8");
const seedPrompt = readFileSync(new URL("../../../seed/assistant-prompt.md", import.meta.url), "utf8");

describe("identity + prompt", () => {
  it("parses the seed identity and renders the seed prompt with the name from it, never a hardcoded one", () => {
    const id = parseIdentity(seedIdentity);
    expect(id.name.length).toBeGreaterThan(0);
    const out = renderPrompt(seedPrompt, id);
    expect(out.startsWith(`You are ${id.name},`)).toBe(true);
    expect(out).not.toContain("{{");
    // the tools section names every brain tool family and the rules the prompt is FOR: one writer, settled-vs-proposed, CAS before overwrite, reads are logged
    for (const t of ["capture", "requests_create", "tasks_list", "tasks_claim", "tasks_renew", "knowledge_search", "knowledge_read", "knowledge_write", "nudge:"]) expect(out).toContain(t);
    expect(out).toMatch(/You are the one writer/);
    expect(out).toMatch(/settled/);
    expect(out).toMatch(/expected_sha256/);
    expect(out).toMatch(/cannot delete or rename/);
    expect(out).toMatch(/Every read is logged/);
    // the seed prompt file itself carries no name: a renamed instance is a clone, not a rewrite
    expect(seedPrompt).not.toContain(id.name);
  });

  it("every decision block the seed prompt teaches is one the parser accepts — v1's one question and v2's several (T2-3)", () => {
    const blocks = [...seedPrompt.matchAll(/```decision\n[\s\S]*?\n```/g)].map((m) => m[0]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => parseDecisionBlock(`the reply\n\n${b}`)?.questions.length)).toEqual([1, 2]);
  });

  it("templating: known keys fill (voice may be empty), unknown keys stay visible, name is required", () => {
    expect(renderPrompt("Hi {{ name }} / {{voice}} / {{nope}}", { name: "Ada" })).toBe("Hi Ada /  / {{nope}}");
    expect(() => parseIdentity("mention: x")).toThrow(/name/);
    expect(() => parseIdentity("")).toThrow(/name/);
  });

  it("overlay: the last existing file wins; none → undefined (the engine runs without a system prompt)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-prompt-"));
    await writeFile(join(dir, "identity.yaml"), "name: Ada\nvoice: Terse.\n");
    await writeFile(join(dir, "prompt.md"), "I am {{name}}. {{voice}}");
    await writeFile(join(dir, "override.md"), "Override for {{name}}.");
    expect(await readOverlay(`${dir}/missing.md:${dir}/prompt.md:${dir}/also-missing.md`)).toBe("I am {{name}}. {{voice}}");
    expect(await readOverlay(`${dir}/missing.md`)).toBeNull();

    const one = await loadSystemPrompt({ METISTRY_IDENTITY_FILES: `${dir}/identity.yaml`, METISTRY_PROMPT_FILES: `${dir}/prompt.md:${dir}/override.md` });
    expect(one).toEqual({
      prompt: "Override for Ada.",
      identity: { name: "Ada", voice: "Terse.", mention: undefined, icon: undefined },
      // which file won, so a caller can say so (and notice when the product's seed did)
      identityPath: `${dir}/identity.yaml`,
      promptPath: `${dir}/override.md`,
    });
    expect(await loadSystemPrompt({ METISTRY_IDENTITY_FILES: `${dir}/nope.yaml`, METISTRY_PROMPT_FILES: `${dir}/prompt.md` })).toBeUndefined();
    expect(await loadSystemPrompt({ METISTRY_IDENTITY_FILES: `${dir}/identity.yaml`, METISTRY_PROMPT_FILES: `${dir}/nope.md` })).toBeUndefined();
  });

  // Prompt hygiene (cost-optimisation §"stable prefix"): a date, or anything
  // else volatile, entering the system prompt breaks the cache on every
  // turn — the SDK re-caches the whole prefix at 1.25x the read cost. Nothing
  // here reads the clock, so the prompt built on two different days must be
  // byte-for-byte identical; a future change that slips a volatile value in
  // (`now.md`, a count, a timestamp) breaks this test before it breaks a cache.
  describe("system prompt is byte-stable across turns regardless of the date", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("the seed prompt built on two different fake dates is byte-identical", async () => {
      // the seed files by name: this used to call loadSystemPrompt() with no
      // environment at all, which resolved nothing relative to the test
      // runner's cwd and compared undefined to undefined
      const seed = {
        METISTRY_IDENTITY_FILES: fileURLToPath(new URL("../../../seed/identity.yaml", import.meta.url)),
        METISTRY_PROMPT_FILES: fileURLToPath(new URL("../../../seed/assistant-prompt.md", import.meta.url)),
      };
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const first = await loadSystemPrompt(seed);
      vi.setSystemTime(new Date("2027-06-15T23:59:59Z"));
      const second = await loadSystemPrompt(seed);
      expect(first?.prompt.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      expect(second?.prompt).toBe(first?.prompt);
    });
  });
});
