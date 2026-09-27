// `metistry identity` — the instance's identity.yaml as the CLI already
// understands it (secrets.ts's SECRET_SCOPES and instance.ts's instance_id
// both key off the same file), so the Mac app can stop hand-rolling a YAML
// subset reader for it (apps/macos/sources/kit/instance-files.swift) and
// front this verb instead — the same rule as everywhere else in this
// package: a behaviour the app needs is a CLI change first.
//
// `metistry identity set` (M10, T2-16) is the one way to change it: the
// owner's hand, through the same protected write every other §4.7 file
// takes — the reconciler as `user` with the owner bearer — so the bridge
// records a `config_write` run and Activity shows the rename. Every field is
// validated before anything is written; a refusal writes nothing.
//
// **The mark is `icon:`.** The design calls the assistant's glyph its *mark*
// (C123) and the Settings pane labels it so; the file keeps the key it has
// always had, because the console's `GET /api/identity`, the login page and
// every existing instance already read `icon:`. Renaming a key in the one
// file every instance carries would be a migration for a word — so `--mark`
// is the verb's name for it and `icon:` stays the record (F-2's open
// question, decided here; docs/ops/actors.md).
//
// identity.yaml is real YAML (not the hand-rolled seed-generated subset the
// Swift reader restricts itself to for a `voice: >` block scalar), so this
// is a thin wrapper over the `yaml` package already a dependency here —
// there is no new parser to maintain.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml, parseDocument } from "yaml";
import type { Exec } from "./exec.js";
import { mentionFor } from "./init.js";
import { identityPath } from "./instance.js";
import { protectedRel, writeProtected, type ProtectedWrite } from "./protected-write.js";
import { StepFailed, StepRunner } from "./steps.js";

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

// ---- `metistry identity set` (M10) -------------------------------------------

/** What `set` may change — the three the Settings pane edits (C123). `voice` and `instance_id` are not the owner's to set here. */
export const IDENTITY_SET_FIELDS = ["name", "mention", "mark"] as const;
export type IdentitySetField = (typeof IDENTITY_SET_FIELDS)[number];

/** The file's key for each field: the mark is `icon:` (see the header). */
const FILE_KEY: Record<IdentitySetField, "name" | "mention" | "icon"> = { name: "name", mention: "mention", mark: "icon" };

export type IdentityChange = Partial<Record<IdentitySetField, string>>;

/** The longest name: a label in a title bar, a menu and a notification, not prose. */
export const MAX_NAME_GRAPHEMES = 40; // limit: fixed — a validation rule of the identity contract, not a tunable
/** The longest mention: `@` plus the slug a mention is matched on. */
export const MAX_MENTION_LENGTH = 41; // limit: fixed — `@` + the 40 a name may have
/** `@` then lowercase kebab-case — the shape `metistry init` derives from a name. */
export const MENTION_RE = /^@[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Control characters (line breaks included) never belong in a one-line label.
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

function graphemes(s: string): string[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
}

/**
 * Every problem with a requested change, or none. Pure: this is the whole
 * of what "an invalid identity" means, and `identitySet` runs it before it
 * reads a byte of the file, so a refusal can have written nothing.
 */
export function identityProblems(change: IdentityChange): string[] {
  const problems: string[] = [];
  if (change.name !== undefined) {
    const n = change.name;
    if (n.trim() === "") problems.push("--name must not be empty");
    else if (n !== n.trim()) problems.push("--name must not start or end with whitespace");
    else if (CONTROL.test(n)) problems.push("--name must be one line with no control characters");
    else if (graphemes(n).length > MAX_NAME_GRAPHEMES) problems.push(`--name is at most ${MAX_NAME_GRAPHEMES} characters`);
    // the prompt templates `{{name}}` (apps/assistant/src/prompt.ts): a name that is itself a placeholder would render as one
    else if (n.includes("{{") || n.includes("}}")) problems.push("--name must not contain {{ or }} — the prompt templates are written in them");
  }
  if (change.mention !== undefined) {
    const m = change.mention;
    if (!MENTION_RE.test(m)) problems.push(`--mention must be @ followed by lowercase letters, digits and single hyphens (like ${mentionFor("Ada Lovelace")}), not ${JSON.stringify(m)}`);
    else if (m.length > MAX_MENTION_LENGTH) problems.push(`--mention is at most ${MAX_MENTION_LENGTH} characters`);
  }
  if (change.mark !== undefined) {
    const k = change.mark;
    if (graphemes(k).length !== 1 || k.trim() !== k || CONTROL.test(k)) problems.push(`--mark is exactly one character or emoji (like 🦉), not ${JSON.stringify(k)}`);
  }
  return problems;
}

/**
 * Set one top-level scalar in identity.yaml's text, keeping every comment
 * and every other line byte for byte — `metistry init`'s `applyName` rule.
 * A key written on one line is replaced on that line; a missing key is
 * appended. Anything else (a block scalar, a flow map) goes through the
 * YAML document instead, which keeps the meaning if not every byte.
 */
export function withIdentityField(text: string, key: "name" | "mention" | "icon", value: string): string {
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const m = line.exec(text);
  const quoted = JSON.stringify(value); // a YAML double-quoted scalar
  if (m && !/^[>|]/.test(m[1]!.trim()) && !/^[[{]/.test(m[1]!.trim())) return text.replace(line, `${key}: ${quoted}`);
  if (!m) return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${key}: ${quoted}\n`;
  const doc = parseDocument(text);
  doc.set(key, value);
  return String(doc);
}

export interface IdentitySetOptions {
  instanceDir: string;
  change: IdentityChange;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  exec?: Exec | undefined;
  fetchFn?: typeof fetch | undefined;
  /** print the plan and change nothing */
  dryRun?: boolean | undefined;
  out: (line: string) => void;
}

export interface IdentitySetResult {
  /** the fields that change, as the file names them: `icon` is the mark */
  changes: { field: IdentitySetField; from: string | null; to: string }[];
  /** the mention a new name brought with it, when the old one was derived from the old name */
  mention_followed_name: boolean;
  /** the identity as it reads after the write (or would, on a dry run) */
  identity: Identity;
  /** undefined when nothing changed and nothing was written */
  delivery?: ProtectedWrite;
}

/**
 * `metistry identity set` — validate, then write identity.yaml through the
 * protected door. The order is the control: every field is checked first,
 * the edited text is re-read and compared with what was asked for, and only
 * then does anything reach `writeProtected`. A change that would leave the
 * file saying something else — a lost `instance_id`, a name that did not
 * land — is refused rather than written.
 */
export async function identitySet(opts: IdentitySetOptions): Promise<IdentitySetResult> {
  const change: IdentityChange = {};
  for (const f of IDENTITY_SET_FIELDS) if (opts.change[f] !== undefined) change[f] = opts.change[f];
  if (Object.keys(change).length === 0) throw new StepFailed("nothing to set — pass --name, --mention and/or --mark", 2);
  const problems = identityProblems(change);
  if (problems.length > 0) throw new StepFailed(`refused: ${problems.join("; ")} — identity.yaml was NOT written`);

  const file = identityPath(opts.instanceDir);
  if (!existsSync(file)) throw new StepFailed(`${opts.instanceDir} has no identity.yaml — is this an instance directory? (\`metistry init\` creates one)`);
  const text = await readFile(file, "utf8");
  let current: Identity;
  try {
    current = parseIdentity(text);
  } catch (err) {
    throw new StepFailed(`${file} is not YAML (${(err as Error).message.split("\n")[0]}) — fix it by hand first; identity.yaml was NOT written`);
  }

  // A new name brings its mention along when the mention was only ever the
  // one `init` derived from the old name — "@metis" for "Metis". A mention
  // the owner chose on its own is theirs, and only --mention moves it.
  let mentionFollowed = false;
  if (change.name !== undefined && change.mention === undefined) {
    const derived = current.name !== undefined ? mentionFor(current.name) : undefined;
    if (current.mention === undefined || current.mention === derived) {
      const next = mentionFor(change.name);
      if (!MENTION_RE.test(next)) {
        throw new StepFailed(`refused: ${JSON.stringify(change.name)} gives no usable mention (${JSON.stringify(next)}) — pass --mention too — identity.yaml was NOT written`);
      }
      if (next !== current.mention) {
        change.mention = next;
        mentionFollowed = true;
      }
    }
  }

  const changes: IdentitySetResult["changes"] = [];
  let next = text;
  for (const f of IDENTITY_SET_FIELDS) {
    const to = change[f];
    if (to === undefined) continue;
    const from = current[FILE_KEY[f]] ?? null;
    if (from === to) continue;
    changes.push({ field: f, from, to });
    next = withIdentityField(next, FILE_KEY[f], to);
  }

  // Read back what is about to be written: what was asked for landed, and
  // nothing else moved.
  const after = parseIdentity(next);
  for (const f of IDENTITY_SET_FIELDS) {
    const want = change[f] ?? current[FILE_KEY[f]];
    if (after[FILE_KEY[f]] !== want) throw new StepFailed(`refused: the edited identity.yaml would read ${FILE_KEY[f]} ${JSON.stringify(after[FILE_KEY[f]] ?? null)}, not ${JSON.stringify(want ?? null)} — identity.yaml was NOT written`);
  }
  if (after.instance_id !== current.instance_id || after.voice !== current.voice) {
    throw new StepFailed("refused: the edit would change instance_id or voice, which `identity set` never touches — identity.yaml was NOT written");
  }

  if (changes.length === 0) return { changes, mention_followed_name: false, identity: current };

  const r = new StepRunner({ dryRun: opts.dryRun === true, out: opts.out, ...(opts.exec ? { exec: opts.exec } : {}), env: opts.env });
  const message = `metistry identity set: ${changes.map((c) => `${FILE_KEY[c.field]} ${c.from ?? "(unset)"} → ${c.to}`).join(", ")}`;
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "identity"), next, message, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn ?? fetch,
    instanceDir: opts.instanceDir,
  });
  if (delivery.how === "none") throw new StepFailed(`${opts.instanceDir} is not a local instance directory and no reconciler is configured — identity.yaml was NOT written`);
  return { changes, mention_followed_name: mentionFollowed, identity: after, delivery };
}

/** The lines a person reads after `set`: each change, then where it went, then when it takes effect. */
export function renderIdentitySet(r: IdentitySetResult, dryRun: boolean): string {
  if (r.changes.length === 0) return "identity.yaml already says that — nothing written";
  const lines = r.changes.map((c) => `${dryRun ? "would set" : "set"} ${c.field.padEnd(7)} ${c.from ?? "(unset)"} → ${c.to}${c.field === "mention" && r.mention_followed_name ? "  (follows the name)" : ""}`);
  if (r.delivery) lines.push(r.delivery.detail);
  // The console and the assistant read identity.yaml when they start
  // (apps/console/src/identity.ts, apps/assistant/src/main.ts).
  if (!dryRun) lines.push("the console and the assistant read identity.yaml at start — `metistry restart` to show the new identity");
  return lines.join("\n");
}
