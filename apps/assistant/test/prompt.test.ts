// The system prompt is templated from identity.yaml — the assistant's name
// never appears in code (CLAUDE.md naming rule) — over the seed prompt file,
// with a D4 overlay for both. Degrades absent.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    expect(one).toEqual({ prompt: "Override for Ada.", identity: { name: "Ada", voice: "Terse.", mention: undefined, icon: undefined } });
    expect(await loadSystemPrompt({ METISTRY_IDENTITY_FILES: `${dir}/nope.yaml`, METISTRY_PROMPT_FILES: `${dir}/prompt.md` })).toBeUndefined();
    expect(await loadSystemPrompt({ METISTRY_IDENTITY_FILES: `${dir}/identity.yaml`, METISTRY_PROMPT_FILES: `${dir}/nope.md` })).toBeUndefined();
  });
});
