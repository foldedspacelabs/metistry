// The system prompt: identity.yaml (the ONLY place the assistant is named —
// CLAUDE.md naming rule) templated into a seed prompt file. D4 overlay for
// both: colon-separated candidate paths, the last existing file wins, so an
// instance repo's identity.yaml / assistant-prompt.md override the product
// seed. Degrades absent: no identity or no prompt file → no system prompt,
// which is how the engine ran before.
//
// This is a seed, not a control: nothing in the prompt is relied on for
// safety (the tool surface is enforced in brain.ts). Its tools section says
// what each tool is FOR; the operating instructions proper still live at
// Knowledge/CLAUDE.md, written later (CLAUDE.md).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

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

/** Last existing file in a colon-separated list wins (D4 overlay); null when none exists. */
export async function readOverlay(paths: string): Promise<string | null> {
  let found: string | null = null;
  for (const p of paths.split(":").map((s) => s.trim()).filter(Boolean)) {
    try {
      found = await readFile(p, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  return found;
}

/** Resolve the system prompt from the environment's overlay lists; undefined = run without one. */
export async function loadSystemPrompt(env: NodeJS.ProcessEnv = process.env): Promise<{ prompt: string; identity: Identity } | undefined> {
  const identityText = await readOverlay(env.METISTRY_IDENTITY_FILES ?? "seed/identity.yaml:identity.yaml");
  const template = await readOverlay(env.METISTRY_PROMPT_FILES ?? "seed/assistant-prompt.md:assistant-prompt.md");
  if (identityText === null || template === null) return undefined;
  const identity = parseIdentity(identityText);
  return { prompt: renderPrompt(template, identity), identity };
}
