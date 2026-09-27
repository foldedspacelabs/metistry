// What `GET /api/identity` serves: the instance's identity.yaml, read once
// at startup through the same overlay rule the assistant uses for its
// prompt (METISTRY_IDENTITY_FILES, last existing file wins). The console
// never names the assistant itself (CLAUDE.md) — it repeats what the file
// says, so a fork or a second instance answers with its own name.
//
// Only the public fields cross the wire: the display name and icon are on
// the login page already, and `instance_id` is the phone's key for "the
// same instance after its origin moved" (research 2026-09-11). `voice` and
// `mention` stay server-side.
//
// S1 adds `capabilities` to the same response: coarse tool-GROUP names,
// derived from what this console actually has wired, so a phone switcher
// or a peer instance can name what an instance offers before sign-in.
// Invariant 8 permits this one unauthenticated read because it carries no
// state and no inventory — no tool names, no counts, no origins. The full
// `tools/list` stays behind an agent token at `/mcp`, which is SAM's own
// discipline that discovery is itself grantable
// (docs/research/2026-09-13-google-sam-review.md ADOPT 1).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { CAPABILITIES, type AssistantIdentity, type Capability } from "@foldedspacelabs/metistry-core";

export interface PublicIdentity {
  instance_id: string;
  name: string;
  icon: string | null;
}

/**
 * What the console has to be holding for a group to be advertised. Each
 * predicate reads the SAME wiring the surface itself reads, so an instance
 * cannot advertise something it would then answer `not_available` for:
 *
 *   knowledge  a vault to read (the reconciler's bridge, D5)
 *   capture    the inbox door — always wired; `/capture` needs nothing else
 *   tasks      the tasks service — always wired (packages/tasks over the db)
 *   artifacts  the vault client the artifacts module stores through (§4.21)
 *   queries    at least one named query loaded (invariant 3's read path)
 *   dispatch   at least one compute target configured (§4.18)
 *   events     the live-changes stream is served (GET /api/events, §2.20)
 */
export interface CapabilitySources {
  hasKnowledge: boolean;
  hasArtifacts: boolean;
  queryCount: number;
  targetCount: number;
  /** `GET /api/events` is served (the client API table's row, §2.20). Absent = false: nothing to subscribe to. */
  hasEvents?: boolean;
}

/**
 * The advertised groups, in CAPABILITIES order. Deliberately a pure
 * function of booleans and two counts that are thrown away here — a count
 * is inventory, and inventory is not public.
 */
export function capabilitiesOf(s: CapabilitySources): Capability[] {
  const on: Record<Capability, boolean> = {
    artifacts: s.hasArtifacts,
    capture: true,
    dispatch: s.targetCount > 0,
    events: s.hasEvents === true,
    knowledge: s.hasKnowledge,
    queries: s.queryCount > 0,
    tasks: true,
  };
  return CAPABILITIES.filter((c) => on[c]);
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

/**
 * The assistant's identity as its DEFINITION names it (core's
 * `AssistantIdentity`, T4-6) — an owner read, so `mention` is here where the
 * public identity above leaves it out. `mark` reads the `icon:` key until
 * T2-16 decides the key's name (docs/ops/actors.md, open question 3).
 * Undefined when the file names no assistant.
 */
export function parseAssistantIdentity(text: string): AssistantIdentity | undefined {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const name = str(r, "name");
  if (!name) return undefined;
  return { name, mention: str(r, "mention") ?? null, mark: str(r, "icon") ?? null };
}
