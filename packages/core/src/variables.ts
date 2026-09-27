// Variables, per instance (design-build-plan §2.14, T4-4; screen 19 §2).
//
// A variable is an owner-chosen lowercase NAME and a plain VALUE in
// `.metistry/variables.yaml`, referenced as `{{ variable.name }}` anywhere a
// value is typed — a connection file, an agent's instructions. It is text
// agents READ, which is the whole reason for what this module refuses:
//
//   * **A secret.** A value that looks like a key — a known provider prefix,
//     a JWT, a private key block, an Authorization header, a URL carrying
//     credentials or a token parameter, a long random-looking run — is
//     refused with *Store as Secret* (`variableValueIssue`). So is a name a
//     secret would have (`api_key`, `github_token`): redact.ts would blank
//     its value anyway, and the name says what it is. The CLI adds the one
//     check a heuristic cannot make: a value equal to (or containing) one of
//     this instance's own secret values is refused (`secretHeldIn`).
//   * **A template.** A value never contains `{{` or `}}`, so a variable
//     cannot smuggle `{{ secret.x }}` into instructions for a later egress
//     fill to expand, and the resolver below is one pass besides.
//   * **A schedule or a time** (ruling 2, K8). `standup_time`, `timezone`, a
//     clock time, a cron line, a weekday list: a routine's timing is its
//     schedule (Scheduled, §2.5) and facts about the owner are
//     `Me/profile.md`. Refused by name and by value.
//
// Every refusal is enforced at the PARSE, not only at `metistry variables
// set`: a hand-edited file that carries a key-shaped value does not load,
// so neither `GET /api/variables` nor the resolver can serve it — and the
// error names the variable and the reason, never the value.
//
// Like the rest of core: no Postgres, no vault, no subprocess. Reading the
// file and walking `.metistry/` for *used in* is the host's (the CLI's
// `variables.ts`, the console's variables route).

import { z } from "zod";
import { parseDocument } from "yaml";
import { isSecretKeyName } from "./redact.js";
import type { SecretSource } from "./secrets.js";

// ---- names ---------------------------------------------------------------------

/** A variable's name: lowercase snake_case, at most 64 characters — the shape connections.ts gives a `variable` field, and a secret's. */
export const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A name that says the value is a credential, beyond redact.ts's list: `private_key`, `ssh_key`, … (a bare `key` stays legal — a Linear *team key* is an identifier). */
const SECRET_NAME_EXTRA_RE = /(?:^|_)(?:private|ssh|access|signing|encryption|license|secret)_key(?:_|$)|(?:^|_)(?:pat|pin|otp|totp)(?:_|$)/;

/** A name that says the value is a schedule or a time (ruling 2): split on `_`, any one of these words. */
const SCHEDULE_WORDS: ReadonlySet<string> = new Set([
  "time", "times", "timezone", "tz", "schedule", "scheduled", "cron", "day", "days", "weekday", "weekdays",
  "hour", "hours", "minute", "minutes", "interval", "cadence", "frequency",
]);

export type VariableRefusal = "name" | "secret_name" | "schedule_name" | "empty" | "too_long" | "multiline" | "template" | "key_shaped" | "schedule_value" | "not_text";

/** The one sentence every key-shaped refusal carries — screen 19 §2's copy, and the verb that does the right thing. */
export const STORE_AS_SECRET = "This looks like a key. Variables can be read by agents — Store as Secret: `metistry secrets set <name>` (the value on stdin)";

/** Where a schedule or a time lives instead (ruling 2, K8). */
export const NO_SCHEDULE_IN_VARIABLES =
  "no schedule or time lives in a variable — a routine's timing is its own schedule (Scheduled; `metistry scheduled`), and facts about you such as your timezone and working days are Me/profile.md";

export interface VariableIssue {
  code: VariableRefusal;
  /** names the variable and the reason — never the value */
  message: string;
}

/** Why `name` cannot be a variable's name, or undefined when it can. */
export function variableNameIssue(name: unknown): VariableIssue | undefined {
  if (typeof name !== "string" || !VARIABLE_NAME_RE.test(name)) {
    return { code: "name", message: `${JSON.stringify(name)} is not a variable name — lowercase snake_case: a letter, then letters, digits and _ (at most 64), e.g. team_name` };
  }
  if (isSecretKeyName(name) || SECRET_NAME_EXTRA_RE.test(name)) {
    return { code: "secret_name", message: `${name} is a secret's name, not a variable's — whatever it held would be read by agents. ${STORE_AS_SECRET.replace("<name>", name)}` };
  }
  if (name.split("_").some((w) => SCHEDULE_WORDS.has(w))) {
    return { code: "schedule_name", message: `${name}: ${NO_SCHEDULE_IN_VARIABLES}` };
  }
  return undefined;
}

// ---- values: plain text, never a key, never a time ------------------------------------

/** A value is one line of at most this many characters: a plain shared value, not a document. */
export const VARIABLE_VALUE_MAX = 1024;

/**
 * Credential shapes that are unambiguous wherever they appear in a value.
 * Each is a published prefix or a structural form; the entropy test below
 * catches what no prefix names.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic (sk-ant-), OpenRouter (sk-or-)
  /(?:^|[^A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/, // GitLab
  /(?:^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/, // AWS access key id
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/, // Google API key
  /(?:^|[^A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access token
  /(?:^|[^A-Za-z0-9])lin_(?:api|oauth)_[A-Za-z0-9]{20,}/, // Linear
  /(?:^|[^A-Za-z0-9])apk_[A-Za-z0-9_]{16,}/, // Devin
  /(?:^|[^A-Za-z0-9])hf_[A-Za-z0-9]{20,}/, // Hugging Face
  /(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{30,}/, // npm
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/,
  /^\s*(?:bearer|basic|token)\s+\S{8,}/i, // an Authorization header's value
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i, // a URL with a password in it
  /[?&#][A-Za-z_]*(?:token|key|secret|sig|signature|password|passwd|auth|credential)[A-Za-z_]*=[^&#\s]{6,}/i, // a URL carrying a token parameter
];

/** A canonical UUID is an identifier (a calendar, an org, a project), not a key. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function charClass(c: string): number {
  if (c >= "a" && c <= "z") return 0;
  if (c >= "A" && c <= "Z") return 1;
  if (c >= "0" && c <= "9") return 2;
  return 3;
}

/**
 * One run of token characters, judged on its letters and digits alone
 * (separators dropped, so `platform-team-2026` is the word it reads as).
 * Random text changes character class on most characters — about 0.6 of
 * them for base62 — while words and slugs change a handful of times; hex
 * is judged by length, because it has only two classes to change between.
 */
function looksRandom(run: string): boolean {
  if (UUID_RE.test(run)) return false;
  const alnum = run.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 20) return false;
  if (!/[0-9]/.test(alnum) || !/[A-Za-z]/.test(alnum)) return false;
  if (alnum.length >= 32 && /^[0-9a-f]+$/i.test(alnum)) return true;
  let changes = 0;
  for (let i = 1; i < alnum.length; i++) if (charClass(alnum[i]!) !== charClass(alnum[i - 1]!)) changes++;
  return changes / (alnum.length - 1) >= 0.3;
}

/**
 * Whether `value` looks like a key, a token or a password — anywhere in it.
 * Deliberately biased to refuse: a variable is read by agents, and the cost
 * of a false refusal is `metistry secrets set` instead.
 */
export function looksLikeKey(value: string): boolean {
  if (KEY_PATTERNS.some((re) => re.test(value))) return true;
  // runs of the characters keys are spelled in (base64, base64url, hex); `/`
  // splits a URL's path into its segments, so a random segment is judged alone
  for (const run of value.match(/[A-Za-z0-9+=_-]{20,}/g) ?? []) if (looksRandom(run)) return true;
  return false;
}

const WEEKDAY_RE = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?$/i;
const CRON_FIELD_RE = /^(?:\*|\?|[0-9]+(?:-[0-9]+)?)(?:\/[0-9]+)?(?:,(?:\*|[0-9]+(?:-[0-9]+)?)(?:\/[0-9]+)?)*$/;

/** Whether `value` is an IANA time zone name this runtime knows, or UTC/GMT. */
function isTimeZone(value: string): boolean {
  if (/^(?:UTC|GMT|Z|Etc\/[A-Za-z0-9+-]+)$/i.test(value)) return true;
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `value` is a schedule or a time (ruling 2): a clock time or a
 * range of them, a cron line or `@daily`, a time zone, a list of weekdays.
 * Dates are not refused — a date is a fact, not a timing.
 */
export function looksLikeSchedule(value: string): boolean {
  const v = value.trim();
  if (/^\d{1,2}(?::\d{2}){1,2}\s*(?:[ap]\.?m\.?)?$/i.test(v)) return true; // 09:15, 9:15 am
  if (/^\d{1,2}\s*[ap]\.?m\.?$/i.test(v)) return true; // 9am
  if (/^\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?$/i.test(v) && /:|[ap]\.?m/i.test(v)) return true; // 09:00-17:30
  if (/^@(?:yearly|annually|monthly|weekly|daily|midnight|hourly|reboot)$/i.test(v)) return true;
  const fields = v.split(/\s+/);
  if ((fields.length === 5 || fields.length === 6) && fields.every((f) => CRON_FIELD_RE.test(f))) return true;
  if (isTimeZone(v)) return true;
  const words = v.split(/[\s,;/]+/).filter(Boolean);
  if (words.length > 0 && words.every((w) => WEEKDAY_RE.test(w) || /^(?:weekdays|weekends)$/i.test(w))) return true;
  return false;
}

/** Why `value` cannot be the value of variable `name`, or undefined when it can. The message never contains the value. */
export function variableValueIssue(name: string, value: unknown): VariableIssue | undefined {
  if (typeof value !== "string") {
    return { code: "not_text", message: `${name}: a variable's value is text — quote it in variables.yaml ("…")` };
  }
  if (value.trim() === "") return { code: "empty", message: `${name}: a variable's value cannot be empty — \`metistry variables unset ${name}\` removes it` };
  if (value.length > VARIABLE_VALUE_MAX) return { code: "too_long", message: `${name}: a variable's value is at most ${VARIABLE_VALUE_MAX} characters — it is a plain shared value, not a document` };
  if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return { code: "multiline", message: `${name}: a variable's value is one line of text, with no control characters` };
  if (value.includes("{{") || value.includes("}}")) {
    return { code: "template", message: `${name}: a variable's value is plain text — it cannot template another variable or a secret ({{ … }}), so nothing a variable holds is ever expanded again` };
  }
  if (looksLikeKey(value)) return { code: "key_shaped", message: `${name}: ${STORE_AS_SECRET.replace("<name>", name)}` };
  if (looksLikeSchedule(value)) return { code: "schedule_value", message: `${name}: ${NO_SCHEDULE_IN_VARIABLES}` };
  return undefined;
}

/**
 * The name of one of this instance's secrets whose value `value` equals or
 * contains — the check no shape heuristic can make (a short PIN, a password
 * of plain words). Contains only for values of eight characters or more, so
 * a four-digit secret does not refuse every variable with a year in it.
 * Returns a NAME, never the value; compares in memory and keeps nothing.
 */
export async function secretHeldIn(value: string, names: readonly string[], source: SecretSource): Promise<string | undefined> {
  for (const name of names) {
    const secret = await source.value(name);
    if (!secret) continue;
    if (value === secret || (secret.length >= 8 && value.includes(secret))) return name;
  }
  return undefined;
}

// ---- the file: .metistry/variables.yaml -------------------------------------------------

export interface VariablesFile {
  /** name → value, in the file's order */
  variables: Record<string, string>;
}

/**
 * Parse `.metistry/variables.yaml` — `variables:` mapping names to values.
 * Empty text is the empty file. Every name and every value is checked; any
 * refusal throws naming the variable and the reason. A YAML error is
 * reported by its code and line only — never the parser's snippet of the
 * source, which would echo a value into whatever shows the error.
 */
export function parseVariablesFile(text: string): VariablesFile {
  const doc = parseDocument(text);
  const bad = doc.errors[0];
  if (bad) throw new Error(`variables.yaml is not valid YAML — ${bad.code}${bad.linePos?.[0] ? ` at line ${bad.linePos[0].line}` : ""}`);
  const raw = text.trim() === "" ? {} : ((doc.toJS() as unknown) ?? {});
  const shape = z.object({ variables: z.record(z.string(), z.unknown()).nullish() }).strict().safeParse(raw);
  if (!shape.success) {
    const issues = shape.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.code === "unrecognized_keys" ? "only `variables:` belongs here" : "`variables:` maps names to values"}`);
    throw new Error(`variables.yaml does not validate — ${issues.join("; ")}`);
  }
  const variables: Record<string, string> = {};
  const issues: string[] = [];
  for (const [name, value] of Object.entries(shape.data.variables ?? {})) {
    const issue = variableNameIssue(name) ?? variableValueIssue(name, value);
    if (issue) issues.push(issue.message);
    else variables[name] = value as string;
  }
  if (issues.length > 0) throw new Error(`variables.yaml does not validate — ${issues.join("; ")}`);
  return { variables };
}

// ---- references: {{ variable.name }} -------------------------------------------------

/** One well-formed reference. Global: use with `matchAll`/`replace`, never `test`. */
export const VARIABLE_REF_RE = /\{\{\s*variable\.([a-z][a-z0-9_]{0,63})\s*\}\}/g;
const VARIABLE_REF_EXACT_RE = new RegExp(`^${VARIABLE_REF_RE.source}$`);
/** Anything trying to be a variable reference, any case — so a typo is refused rather than left as braces an agent reads. */
const VARIABLE_REF_LOOSE_RE = /\{\{\s*variables?\b[^}]*\}\}/gi;

export interface VariableRefs {
  /** the names referenced, first occurrence order, each once */
  names: string[];
  /** `{{ variable… }}` spellings that are not a well-formed reference */
  malformed: string[];
}

/** Every variable a piece of text references, and every attempt at one that does not parse. */
export function variableRefsIn(text: string): VariableRefs {
  const names: string[] = [];
  for (const m of text.matchAll(VARIABLE_REF_RE)) if (m[1] && !names.includes(m[1])) names.push(m[1]);
  const malformed: string[] = [];
  for (const m of text.matchAll(VARIABLE_REF_LOOSE_RE)) {
    if (!VARIABLE_REF_EXACT_RE.test(m[0]) && !malformed.includes(m[0])) malformed.push(m[0]);
  }
  return { names, malformed };
}

export type VariableFillResult =
  | { ok: true; text: string; /** names filled */ used: string[] }
  | { ok: false; missing: string[]; malformed: string[]; message: string };

/**
 * Fill every `{{ variable.name }}` in `template` from `file`, or refuse.
 *
 * All or nothing, like `fillSecretRefs`: a missing name or a malformed
 * reference fills nothing. One pass: a value is inserted as it is, never
 * expanded again. `{{ secret.x }}` is left untouched for the egress fill —
 * and because a value can hold no braces, filling variables can never
 * introduce a secret reference that was not in the template. Each value is
 * checked again here, so a `VariablesFile` built by hand rather than parsed
 * still cannot carry a key into the text.
 */
export function fillVariableRefs(template: string, file: VariablesFile): VariableFillResult {
  const { names, malformed } = variableRefsIn(template);
  const missing: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    if (!Object.hasOwn(file.variables, name)) missing.push(name);
    else if (variableNameIssue(name) ?? variableValueIssue(name, file.variables[name])) refused.push(name);
  }
  if (missing.length > 0 || malformed.length > 0 || refused.length > 0) {
    const parts = [
      ...(missing.length ? [`no variable ${missing.map((n) => `{{ variable.${n} }}`).join(", ")} in this instance — \`metistry variables set <name> <value>\` adds one`] : []),
      ...(malformed.length ? [`not a variable reference: ${malformed.join(", ")} — the form is {{ variable.name }}, name in lowercase snake_case`] : []),
      ...(refused.length ? [`refused to fill ${refused.join(", ")}: the value is not one a variable may hold`] : []),
    ];
    return { ok: false, missing: [...missing, ...refused], malformed, message: parts.join("; ") };
  }
  const text = template.replace(VARIABLE_REF_RE, (_whole, name: string) => file.variables[name]!);
  return { ok: true, text, used: names };
}

// ---- the listing: GET /api/variables and `metistry variables list` ----------------------

/** One row of the listing. */
export interface VariableRow {
  name: string;
  value: string;
  /** who reads it: `agent:<id>` for an agent definition, `connection:<name>` for a connection file */
  read_by: string[];
  /** every file under `.metistry/` that references it, instance-relative — screen 19's *used in* */
  used_in: string[];
}

/**
 * Who a file under `.metistry/` stands for, when it is an agent's definition
 * (`agents/<area>/<id>.md`) or a connection (`connections/<name>.yaml`) —
 * undefined for anything else. `rel` is relative to `.metistry/`.
 */
export function readerOf(rel: string): string | undefined {
  const a = /^agents\/(?:[^/]+\/)*([a-z][a-z0-9-]*)\.md$/.exec(rel);
  if (a?.[1]) return `agent:${a[1]}`;
  const c = /^connections\/([a-z][a-z0-9-]*)\.ya?ml$/.exec(rel);
  if (c?.[1]) return `connection:${c[1]}`;
  return undefined;
}

/** The listing, sorted by name, from the file and name → [instance-relative paths that reference it]. */
export function describeVariables(file: VariablesFile, usage: ReadonlyMap<string, readonly string[]> = new Map(), metistryPrefix = ".metistry/"): VariableRow[] {
  return Object.keys(file.variables)
    .sort()
    .map((name) => {
      const used = [...(usage.get(name) ?? [])].sort();
      const readers: string[] = [];
      for (const p of used) {
        const r = p.startsWith(metistryPrefix) ? readerOf(p.slice(metistryPrefix.length)) : undefined;
        if (r && !readers.includes(r)) readers.push(r);
      }
      return { name, value: file.variables[name]!, read_by: readers, used_in: used };
    });
}
