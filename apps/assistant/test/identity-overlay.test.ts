// The chain #198 found broken, tested end to end: `metistry up` renders the
// assistant's environment, the engine resolves its overlay from THAT
// environment, and the rendered system prompt carries this install's name.
//
// It reaches across into packages/cli for the generator on purpose. "The
// engine reads METISTRY_INSTANCE_DIR" and "`up` sets METISTRY_INSTANCE_DIR"
// each passed on their own for months while the engine still answered as the
// product's seed assistant, because nothing asserted the two halves MEET.
// apps/ → packages/ is the direction the arrow points (CLAUDE.md), and this
// is a test, not a runtime dependency.
//
// Both layouts, from one fixture: an instance that has not run
// `metistry migrate-layout` keeps its identity.yaml at the vault root, and a
// reader that resolves only the flat spelling fails here.
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instanceFile, LEGACY_VAULT_DIR } from "@foldedspacelabs/metistry-core";
import { assistantEnv } from "../../../packages/cli/src/deployment.js";
import { engineConfigParams } from "../../../packages/cli/src/sandbox.js";
import { loadSystemPrompt } from "../src/prompt.js";

/** The name the PRODUCT ships. If it ever reaches a rendered prompt here, the overlay lost. */
const SEED_NAME = "Seedname";
/** The name this scratch instance's identity.yaml declares — the one a user would have chosen. */
const INSTANCE_NAME = "Testname";

/** A product checkout: just the two seed files the engine overlays. */
async function product(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-product-"));
  await mkdir(join(dir, "seed"), { recursive: true });
  await writeFile(join(dir, "seed", "identity.yaml"), `name: ${SEED_NAME}\n`);
  await writeFile(join(dir, "seed", "assistant-prompt.md"), "You are {{name}}, from the product's seed template.\n");
  return dir;
}

/** A scratch instance in either shape, with identity.yaml where THAT shape keeps it. */
async function instance(shape: "flat" | "legacy"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-inst-"));
  const config = shape === "flat" ? join(dir, ".metistry") : dir;
  await mkdir(config, { recursive: true });
  // the legacy shape's vault: what `detectLayout` reads, and what a
  // directory grant on the config location would have exposed
  if (shape === "legacy") await mkdir(join(dir, LEGACY_VAULT_DIR), { recursive: true });
  await writeFile(join(config, "identity.yaml"), `name: ${INSTANCE_NAME}\nvoice: Plainly.\n`);
  return dir;
}

/** Exactly what `metistry up` puts in the assistant job's EnvironmentVariables dict (plistValuesFor → assistantEnv). */
function upRendersEnv(productDir: string, instanceDir: string): Record<string, string> {
  return assistantEnv({
    productDir,
    instanceDir,
    env: { METISTRY_DB_PASSWORD: "scratch" },
    shape: "launchd",
    stateDir: join(instanceDir, ".metistry", "state", "assistant"),
  });
}

describe.each(["flat", "legacy"] as const)("a %s instance's identity reaches the engine", (shape) => {
  it("the environment `up` renders names the instance, and the prompt comes out in the instance's name", async () => {
    const P = await product();
    const I = await instance(shape);

    const env = upRendersEnv(P, I);
    // the two variables every overlay default resolves against — neither was
    // in the assistant's environment before, which is why the cwd-relative
    // default silently named the PRODUCT's directory
    expect(env.METISTRY_INSTANCE_DIR).toBe(I);
    expect(env.METISTRY_SEED_DIR).toBe(join(P, "seed"));
    // no cwd is involved: nothing in the list is a relative path
    expect(Object.values(env).filter((v) => v.includes("identity.yaml"))).toEqual([]);

    const loaded = await loadSystemPrompt(env);
    expect(loaded?.identity.name).toBe(INSTANCE_NAME);
    expect(loaded?.identity.voice).toBe("Plainly.");
    expect(loaded?.prompt).toBe(`You are ${INSTANCE_NAME}, from the product's seed template.`);
    expect(loaded?.prompt).not.toContain(SEED_NAME);
    // …read from the file THIS shape keeps it in
    expect(loaded?.identityPath).toBe(instanceFile(I, "identity"));
    // the template is still the product's: this instance overrides the
    // identity and not the prompt, which is the common case
    expect(loaded?.promptPath).toBe(join(P, "seed", "assistant-prompt.md"));

    // and the confinement allows exactly that file: without the grant the
    // read the assertions above just made would be an EPERM on the host
    expect(engineConfigParams({ instanceDir: I, productDir: P }).CONFIG_IDENTITY).toBe(realpathSync(instanceFile(I, "identity")));
  });

  it("an instance that ships its own prompt template overrides the seed's too", async () => {
    const P = await product();
    const I = await instance(shape);
    const template = instanceFile(I, "assistantPrompt");
    await writeFile(template, "{{name}} here. {{voice}}");

    const loaded = await loadSystemPrompt(upRendersEnv(P, I));
    expect(loaded?.prompt).toBe(`${INSTANCE_NAME} here. Plainly.`);
    expect(loaded?.promptPath).toBe(template);
    expect(engineConfigParams({ instanceDir: I, productDir: P }).CONFIG_ASSISTANT_PROMPT).toBe(realpathSync(template));
  });
});

describe("the engine will not answer as the seed by accident", () => {
  it("refuses to start when nothing says where the instance is", async () => {
    await expect(loadSystemPrompt({})).rejects.toThrow(/refusing to start on the seed identity/);
    await expect(loadSystemPrompt({ METISTRY_INSTANCE_DIR: "  " })).rejects.toThrow(/METISTRY_INSTANCE_DIR/);
    // …and the message says how to fix it, in both directions
    await expect(loadSystemPrompt({})).rejects.toThrow(/METISTRY_IDENTITY_FILES/);
  });

  it("an explicitly named overlay IS allowed to be the seed — that is the compose shape saying so out loud", async () => {
    const P = await product();
    const loaded = await loadSystemPrompt({
      METISTRY_IDENTITY_FILES: join(P, "seed", "identity.yaml"),
      METISTRY_PROMPT_FILES: join(P, "seed", "assistant-prompt.md"),
    });
    expect(loaded?.identity.name).toBe(SEED_NAME);
  });

  it("an instance directory with no identity.yaml in it falls back to the seed — and the path says which file won", async () => {
    const P = await product();
    const I = await mkdtemp(join(tmpdir(), "metistry-empty-"));
    const loaded = await loadSystemPrompt(upRendersEnv(P, I));
    expect(loaded?.identity.name).toBe(SEED_NAME);
    // main.ts warns on exactly this comparison, so a broken install is
    // visible in the log instead of quietly wearing the wrong name
    expect(loaded?.identityPath.startsWith(`${I}/`)).toBe(false);
  });
});
