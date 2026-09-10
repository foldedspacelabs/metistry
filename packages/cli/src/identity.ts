// `metistry identity` — the instance's identity.yaml as the CLI already
// understands it (secrets.ts's SECRET_SCOPES and instance.ts's instance_id
// both key off the same file), so the Mac app can stop hand-rolling a YAML
// subset reader for it (apps/macos/sources/kit/instance-files.swift) and
// front this verb instead — the same rule as everywhere else in this
// package: a behaviour the app needs is a CLI change first.
//
// identity.yaml is real YAML (not the hand-rolled seed-generated subset the
// Swift reader restricts itself to for a `voice: >` block scalar), so this
// is a thin wrapper over the `yaml` package already a dependency here —
// there is no new parser to maintain.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { identityPath } from "./instance.js";

export interface Identity {
  name?: string;
  mention?: string;
  voice?: string;
  icon?: string;
  instance_id?: string;
}

function str(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return typeof v === "string" && v.trim() !== "" ? (key === "voice" ? v.trim() : v) : undefined;
}

/** Parse identity.yaml's scalar fields — everything `metistry init`/`applyName`/`withInstanceId` write. */
export function parseIdentity(text: string): Identity {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Identity = {};
  const name = str(r, "name");
  const mention = str(r, "mention");
  const voice = str(r, "voice");
  const icon = str(r, "icon");
  const instanceId = str(r, "instance_id");
  if (name !== undefined) out.name = name;
  if (mention !== undefined) out.mention = mention;
  if (voice !== undefined) out.voice = voice;
  if (icon !== undefined) out.icon = icon;
  if (instanceId !== undefined) out.instance_id = instanceId;
  return out;
}

/** undefined when the instance directory has no identity.yaml at all — not an instance directory, or a typo'd path. */
export async function readIdentity(instanceDir: string): Promise<Identity | undefined> {
  const file = identityPath(instanceDir);
  if (!existsSync(file)) return undefined;
  return parseIdentity(await readFile(file, "utf8"));
}

const FIELD_ORDER: (keyof Identity)[] = ["name", "mention", "icon", "instance_id", "voice"];
const FIELD_LABEL: Record<keyof Identity, string> = { name: "name", mention: "mention", icon: "icon", instance_id: "instance_id", voice: "voice" };

/** A short table — one field per line, in the order a person reads them: what it's called, then the fine print. */
export function renderIdentity(identity: Identity): string {
  const rows = FIELD_ORDER.filter((k) => identity[k] !== undefined);
  if (rows.length === 0) return "identity.yaml has none of name/mention/icon/instance_id/voice set";
  const width = Math.max(...rows.map((k) => FIELD_LABEL[k].length));
  return rows.map((k) => `${FIELD_LABEL[k].padEnd(width)}  ${identity[k]}`).join("\n");
}
