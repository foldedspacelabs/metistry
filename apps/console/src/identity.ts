// What `GET /api/identity` serves: the instance's identity.yaml, read once
// at startup through the same overlay rule the assistant uses for its
// prompt (METISTRY_IDENTITY_FILES, last existing file wins). The console
// never names the assistant itself (CLAUDE.md) — it repeats what the file
// says, so a fork or the work instance answers with its own name.
//
// Only the public fields cross the wire: the display name and icon are on
// the login page already, and `instance_id` is the phone's key for "the
// same instance after its origin moved" (research 2026-09-11). `voice` and
// `mention` stay server-side.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export interface PublicIdentity {
  instance_id: string;
  name: string;
  icon: string | null;
}

function str(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** undefined when the file names no instance_id — an instance `metistry init` has not stamped is not addressable by a phone. */
export function parsePublicIdentity(text: string): PublicIdentity | undefined {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const instanceId = str(r, "instance_id");
  const name = str(r, "name");
  if (!instanceId || !name) return undefined;
  return { instance_id: instanceId, name, icon: str(r, "icon") ?? null };
}

/** Last existing file in the colon-separated list wins (the D4 overlay rule); undefined when none exists or none is complete. */
export async function loadPublicIdentity(paths: string): Promise<PublicIdentity | undefined> {
  let found: string | null = null;
  for (const p of paths.split(":").map((s) => s.trim()).filter(Boolean)) {
    try {
      found = await readFile(p, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  }
  return found === null ? undefined : parsePublicIdentity(found);
}
