// The system prompt: identity.yaml (the ONLY place the assistant is named —
// CLAUDE.md naming rule) templated into a seed prompt file. D4 overlay for
// both: colon-separated candidate paths, the last existing file wins, so an
// instance repo's identity.yaml / assistant-prompt.md override the product
// seed. Degrades absent: no identity or no prompt file → no system prompt,
// which is how the engine ran before.
//
// The instance half of each list is resolved against METISTRY_INSTANCE_DIR
// (core's `overlayFilesFromEnv`), never against the cwd — a launchd job's working
// directory is the product checkout, so a relative `.metistry/identity.yaml`
// named the product's own directory and the engine answered as the SEED.
// And with nothing in the environment saying where the instance is, this
// module REFUSES rather than quietly doing that.
//
// This is a seed, not a control: nothing in the prompt is relied on for
// safety (the tool surface is enforced in brain.ts). Its tools section says
// what each tool is FOR; the operating instructions proper still live at
// the instance's root CLAUDE.md, written later (CLAUDE.md).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { overlayFilesFromEnv } from "@foldedspacelabs/metistry-core";

export interface Identity {
  name: string;
  mention?: string | undefined;
  voice?: string | undefined;
  icon?: string | undefined;
}

/** Parse identity.yaml text; throws on a missing/blank name (the one required field). */
export function parseIdentity(text: string): Identity {
  const raw = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("identity.yaml: `name` is required");
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : undefined);
  return { name, mention: str("mention"), voice: str("voice"), icon: str("icon") };
}

/** `{{name}}`, `{{voice}}`, `{{mention}}` → identity fields; unknown keys are left as-is so a typo is visible, not silent. */
export function renderPrompt(template: string, identity: Identity): string {
  const fields: Record<string, string> = { name: identity.name, voice: identity.voice ?? "", mention: identity.mention ?? "" };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in fields ? (fields[k] ?? "") : m)).trim();
}

/** Last existing file in a colon-separated list wins (D4 overlay), with the file it came from; both null when none exists. */
export async function readOverlayFrom(paths: string): Promise<{ text: string; path: string } | null> {
  let found: { text: string; path: string } | null = null;
  for (const p of paths.split(":").map((s) => s.trim()).filter(Boolean)) {
    try {
      found = { text: await readFile(p, "utf8"), path: p };
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  return found;
}

/** Last existing file in a colon-separated list wins (D4 overlay); null when none exists. */
export async function readOverlay(paths: string): Promise<string | null> {
  return (await readOverlayFrom(paths))?.text ?? null;
}

export interface LoadedPrompt {
  prompt: string;
  identity: Identity;
  /** the identity.yaml the overlay actually read — the instance's, or the product's seed */
  identityPath: string;
  /** the prompt template the overlay actually read */
  promptPath: string;
}

/**
 * The overlay lists this process reads, resolved against the INSTANCE
 * directory rather than the cwd (core's `overlayFilesFromEnv`, the one
 * function every service resolves its config through). An explicit
 * `METISTRY_IDENTITY_FILES` / `METISTRY_PROMPT_FILES` still wins: it is how
 * the compose shape — whose containers mount no instance repo (D5) — names
 * the seed deliberately.
 */
export function promptOverlays(env: NodeJS.ProcessEnv): { identity: string; prompt: string } {
  return {
    identity: env.METISTRY_IDENTITY_FILES ?? overlayFilesFromEnv(env, "identity"),
    prompt: env.METISTRY_PROMPT_FILES ?? overlayFilesFromEnv(env, "assistantPrompt"),
  };
}

/**
 * Resolve the system prompt from the environment's overlay lists;
 * undefined = run without one.
 *
 * REFUSES rather than falling back to the seed when nothing in the
 * environment says where this install's identity is. Answering as the seed
 * assistant is the one failure a user cannot see from the outside — the
 * engine runs, the replies arrive, and they are not from their assistant —
 * so it is a startup error, enforced here rather than asked for in a
 * comment (CLAUDE.md: enforce at the tool).
 */
export async function loadSystemPrompt(env: NodeJS.ProcessEnv = process.env): Promise<LoadedPrompt | undefined> {
  if (!env.METISTRY_INSTANCE_DIR?.trim() && !env.METISTRY_IDENTITY_FILES?.trim()) {
    throw new Error(
      "refusing to start on the seed identity: neither METISTRY_INSTANCE_DIR nor METISTRY_IDENTITY_FILES is set, " +
        "so this process cannot find this install's identity.yaml and would answer as the product's seed assistant. " +
        "Set METISTRY_INSTANCE_DIR to the instance directory (`metistry up` does), or name the files to read in METISTRY_IDENTITY_FILES.",
    );
  }
  const paths = promptOverlays(env);
  const identity = await readOverlayFrom(paths.identity);
  const template = await readOverlayFrom(paths.prompt);
  if (identity === null || template === null) return undefined;
  const parsed = parseIdentity(identity.text);
  return { prompt: renderPrompt(template.text, parsed), identity: parsed, identityPath: identity.path, promptPath: template.path };
}
