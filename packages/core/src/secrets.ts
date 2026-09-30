// Secrets, per instance (design-build-plan §2.14; the owner's Q3 of
// 2026-09-26: "no bleed between instances… simpler and easier to test").
//
// A secret is an owner-chosen lowercase NAME, a VALUE in the login Keychain
// and a POLICY in `.metistry/secrets.yaml`:
//
//   the item     service `metistry:secret:<name>`, account `<instance_id>` —
//                one instance, one account, no shared scope
//   the policy   *Sent only to* hosts, *Who may use it* (On · Ask · Off per
//                connection, actor and compute provider), and an expiry where the service
//                reports one. Never a value: the schema is strict, so a
//                file that tries to carry one does not load.
//   a reference  `{{ secret.name }}` in connection files, compute providers
//                and manifests (`env:NAME` accepted for one release).
//
// What this module makes impossible rather than discouraged:
//
//   * **One instance reading another's item.** `InstanceSecrets` is bound to
//     ONE `instance_id` when it is made, and nothing on it takes an account:
//     every method takes a secret name, and a name is `^[a-z][a-z0-9_]*$`,
//     so it cannot spell a separator, another prefix or another account. The
//     Keychain itself does not separate the accounts — every item is
//     readable by the same macOS user — so this binding IS the boundary, and
//     the tests hold it (packages/core/test/secrets.test.ts).
//   * **A listing that can read a value.** `describeSecrets` is handed a
//     `SecretPresence` — `has(name)` and nothing else — so the one function
//     both `GET /api/secrets` and `metistry secrets list --named` render from
//     has no path to a value to leak.
//   * **A half-filled template.** `fillSecretRefs` fills every reference or
//     none: a name that is missing, or a `{{ secret… }}` that does not parse,
//     is a refusal naming it, never an empty string or the literal braces
//     sent to a server.
//
// Where the value goes is not decided here. Filling at egress against the
// host list is `egress.ts`'s (T4-2); a model never receives a value. This file
// is the store, the names, the file and the resolver.
//
// Like the rest of core it imports no Postgres, no vault and no project
// config, and runs no subprocess: the Keychain is a `KeychainBackend` the
// host hands in (`packages/cli/src/keychain.ts` drives `security`; tests use
// `memoryKeychain()` and never the real login Keychain).

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseDocument } from "yaml";
import { TOOL_MODES, type ToolMode } from "./connections.js";
import { parseEgressEntry } from "./egress.js";
import { GITHUB_WRITE_SECRET } from "./github-pulls.js";
import { AGENT_NAME_RE, INSTANCE_ID_RE } from "./instances.js";
import { instanceFile, instanceStatePath } from "./instance-layout.js";
import { PROVIDER_NAME_RE } from "./model-ref.js";
import { INSTANCE_SECRET_NAME_RE, SECRET_DELIVERY_PREFIX, SECRET_REF_EXACT_RE, SECRET_REF_RE, parseSecretReference, secretDeliveryVar, type SecretReference } from "./secret-ref.js";

// The spelling of a reference lives in a leaf module (compute.ts reads it too,
// and cannot import this file without a load-time cycle); re-exported here so
// every caller keeps one import.
export { INSTANCE_SECRET_NAME_RE, SECRET_DELIVERY_PREFIX, SECRET_REF_RE, parseSecretReference, secretDeliveryVar, type SecretReference };

// ---- names ---------------------------------------------------------------------

export function isSecretName(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_SECRET_NAME_RE.test(value);
}

/** Why `value` is not a secret name, or undefined when it is. */
export function secretNameIssue(value: unknown): string | undefined {
  if (isSecretName(value)) return undefined;
  return `${JSON.stringify(value)} is not a secret name — lowercase snake_case: a letter, then letters, digits and _ (at most 64), e.g. github_write`;
}

function requireName(name: string): string {
  const issue = secretNameIssue(name);
  if (issue) throw new Error(issue);
  return name;
}

/**
 * The Keychain service prefix for a named secret. Disjoint from the install's
 * own `metistry:<VAR>` items (`packages/cli/src/keychain.ts`): those are
 * UPPER_SNAKE and carry no `secret:` segment, so no name here can collide
 * with one.
 */
export const SECRET_SERVICE_PREFIX = "metistry:secret:";

/** `github_write` → `metistry:secret:github_write`. Throws on anything that is not a secret name. */
export function secretService(name: string): string {
  return `${SECRET_SERVICE_PREFIX}${requireName(name)}`;
}

/** The Keychain account an instance's secrets are filed under: its `instance_id`, and only ever that. Throws on anything that is not one. */
export function secretAccount(instanceId: string): string {
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(`${JSON.stringify(instanceId)} is not an instance_id (a lowercase v4 UUID; \`metistry init\` mints it into identity.yaml) — a secret belongs to exactly one instance, so there is no account without one`);
  }
  return instanceId;
}

/** The environment variable a local agent granted `name` receives it as (screen-19 §1.1: `GITHUB_READ`). */
export function secretEnvName(name: string): string {
  return requireName(name).toUpperCase();
}

// ---- who may use it -------------------------------------------------------------

/** On · Ask · Off — the owner's per-grantee policy, the same three words a connection tool's mode uses (C114). */
export const SECRET_GRANT_MODES = TOOL_MODES;
export type SecretGrantMode = ToolMode;

/** A grantee the file does not name may not use the secret. Least privilege: a grant is something the owner wrote down. */
export const DEFAULT_SECRET_GRANT: SecretGrantMode = "off";

/**
 * Who a grant is to: a connection (`connection:<name>`, kebab-case like every
 * connection name), an actor (`agent:<id>`, the registry's id shape — the
 * assistant, a crew or an external agent, §2.4), or a compute provider
 * (`provider:<name>`, `compute.yaml`'s provider name — ruling 2 of the W2
 * checkpoint, 2026-09-27). A provider key is filled in for its provider's
 * calls only when the owner granted it to that provider (`egress.ts`'s
 * `computeFetch`).
 */
export const SECRET_GRANTEE_RE = /^(?:connection:[a-z][a-z0-9-]{0,63}|agent:[a-z][a-z0-9-]{0,39}|provider:[a-z][a-z0-9_-]{0,63})$/;

export const SECRET_GRANTEE_KINDS = ["connection", "agent", "provider"] as const;
export type SecretGrantee = { kind: (typeof SECRET_GRANTEE_KINDS)[number]; name: string };

/** What every refusal of a grantee says it should have been. */
export const SECRET_GRANTEE_FORMS = "connection:<name>, agent:<id> or provider:<name>";

export function parseSecretGrantee(value: string): SecretGrantee | undefined {
  if (!SECRET_GRANTEE_RE.test(value)) return undefined;
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon) as SecretGrantee["kind"];
  const name = value.slice(colon + 1);
  if (kind === "agent" && !AGENT_NAME_RE.test(name)) return undefined;
  if (kind === "provider" && !PROVIDER_NAME_RE.test(name)) return undefined;
  return { kind, name };
}

/** `openrouter` → `provider:openrouter`: the grantee a compute provider's calls are made as. Throws on anything that is not a provider name. */
export function providerGrantee(providerName: string): string {
  const g = `provider:${providerName}`;
  if (parseSecretGrantee(g)?.kind !== "provider") throw new Error(`${JSON.stringify(providerName)} is not a provider name that can be a grantee (lowercase, digits, - and _, starting with a letter, at most 64)`);
  return g;
}

// ---- owner doors: a secret with no *Who may use it* line to check -----------------------

/**
 * The secret names an owner door reads directly, never through a
 * `connection:`, `agent:` or `provider:` grant (X-41; T2-13's
 * `github_write`). Exact names, not a prefix — a test's
 * `github_write_${suffix}` fixture (a unique name for Keychain isolation,
 * unrelated to the real door) is not one. The one list either check below
 * reads, so X-42 (an `owner-door:<name>` grantee kind) has one place to
 * extend rather than a scattered convention.
 */
const OWNER_DOOR_SECRETS: ReadonlySet<string> = new Set([GITHUB_WRITE_SECRET]);

/**
 * Whether `name` is an owner door's secret: read only through its own door
 * (apps/console's `github-write.ts` for `github_write`), because the door
 * IS the grant — there is no *Who may use it* line to widen it with. A
 * `connection:`, `agent:` or `provider:` grant for one is refused wherever a grant could
 * take effect: parsing `secrets.yaml` (below), `metistry secrets grant`
 * (packages/cli), and `secretGrant` itself, so no delivery path can hand one
 * out even if a file that predates this check still names one.
 */
export function isOwnerDoorSecret(name: string): boolean {
  return OWNER_DOOR_SECRETS.has(name);
}

// ---- where it may go --------------------------------------------------------------

/**
 * One *Sent only to* entry: a host name, or `host:port` when it is not 443 —
 * exactly an egress allowlist entry (egress.ts), so the list the owner writes
 * and the list the egress guard (T4-2) checks are spelled one way. No scheme,
 * no path, no wildcard. Normalised to lowercase.
 */
export function normalizeSecretHost(entry: string): string | undefined {
  const t = parseEgressEntry(entry);
  if (!t) return undefined;
  return entry.trim().toLowerCase();
}

// ---- the file: .metistry/secrets.yaml ---------------------------------------------------

const hostEntry = z.string().refine((s) => normalizeSecretHost(s) === s, {
  message: "a host is a lowercase host name, or host:port when the port is not 443 — no scheme, no path, no wildcard",
});

const isoDate = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !Number.isNaN(Date.parse(s)), {
  message: "expires is an ISO date (2026-12-31) or date-time",
});

/** A record whose every key must pass `ok` — refused key by key with `message`, which zod's own "Invalid key in record" does not say. */
function keyedRecord<T extends z.ZodType>(value: T, ok: (key: string) => boolean, message: (key: string) => string) {
  return z.record(z.string(), value).superRefine((rec, ctx) => {
    for (const key of Object.keys(rec)) if (!ok(key)) ctx.addIssue({ code: "custom", path: [key], message: message(key) });
  });
}

const policySchema = z
  .object({
    /** *Sent only to*: the hosts a value may be filled in for. Empty = sent nowhere; a local agent granted it still gets it as an environment variable. */
    hosts: z.array(hostEntry).default([]),
    /** *Who may use it*: grantee → On · Ask · Off. A grantee not listed is Off. */
    grants: keyedRecord(z.enum(SECRET_GRANT_MODES), (k) => parseSecretGrantee(k) !== undefined, (k) => `${JSON.stringify(k)} is not a grantee — ${SECRET_GRANTEE_FORMS}`).default({}),
    /** When the value stops working, where the service says. */
    expires: isoDate.optional(),
  })
  .strict();

export const secretsFileSchema = z
  .object({
    secrets: keyedRecord(policySchema, isSecretName, (k) => secretNameIssue(k)!).default({}),
  })
  .strict()
  .superRefine((file, ctx) => {
    // An owner-door secret (X-41, modelled on X-7's `provider:` grantee
    // check) has no *Who may use it* line to widen: the door itself is the
    // grant. A hand-written file that grants one to a connection or an
    // agent does not load — it names the offending grantee and the fix.
    for (const [name, policy] of Object.entries(file.secrets)) {
      if (!isOwnerDoorSecret(name)) continue;
      for (const grantee of Object.keys(policy.grants)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", name, "grants", grantee],
          message: `${name} is an owner-door secret — it is read only through its own door, never granted to a connection, an agent or a provider; remove \`grants: { ${JSON.stringify(grantee)}: … }\` (its *Sent only to* hosts still apply)`,
        });
      }
    }
  });

export type SecretPolicy = z.infer<typeof policySchema>;
export type SecretsFile = z.infer<typeof secretsFileSchema>;

/**
 * Parse `.metistry/secrets.yaml`. Empty text is the empty file; anything the
 * schema refuses throws, naming the field. A YAML error is reported by its
 * code and line only — never the parser's quoted snippet of the source, which
 * would echo a value pasted in the wrong place into whatever shows the error.
 */
export function parseSecretsFile(text: string): SecretsFile {
  const doc = parseDocument(text);
  const bad = doc.errors[0];
  if (bad) throw new Error(`secrets.yaml is not valid YAML — ${bad.code}${bad.linePos?.[0] ? ` at line ${bad.linePos[0].line}` : ""}`);
  const raw = text.trim() === "" ? {} : (doc.toJS() as unknown);
  const r = secretsFileSchema.safeParse(raw ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`secrets.yaml does not validate — ${issues.join("; ")}`);
  }
  return r.data;
}

/** `secrets.yaml` as a door reads it: the file, or why there is none to go by. */
export type SecretsPolicyRead = { ok: true; file: SecretsFile } | { ok: false; why: string };

/**
 * Read and parse `secrets.yaml` at `path` for a door that checks a grant
 * (`computeFetch`). A file that does not exist is the EMPTY policy — every
 * grantee Off — never an error: an install with no named secrets has
 * nothing granted, which is exactly what the door should find. A file that
 * cannot be read (a sandbox that was not given it: EPERM) or does not
 * validate is `ok: false`, and the door refuses on it rather than guessing.
 * The reason names the code or the field, never the file's text.
 */
export async function readSecretsPolicy(path: string, readFileFn: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<SecretsPolicyRead> {
  let text: string;
  try {
    text = await readFileFn(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { ok: true, file: parseSecretsFile("") };
    return { ok: false, why: `${path} could not be read (${code ?? (e instanceof Error ? e.message : String(e))})` };
  }
  try {
    return { ok: true, file: parseSecretsFile(text) };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `METISTRY_SECRETS_FILE`: an explicit path to the `secrets.yaml` a process
 * reads grants from. The compose shape sets it (docker-compose.yml): the
 * containers mount no instance directory (D5), so the instance's
 * `.metistry/secrets.yaml` — policy, never a value — is bind-mounted
 * read-only at `COMPOSE_SECRETS_TARGET` and this names it. Set but EMPTY is
 * compose saying "nothing was mounted" (`METISTRY_SECRETS_YAML` unset).
 */
export const SECRETS_FILE_VAR = "METISTRY_SECRETS_FILE";
/** Where docker-compose.yml mounts the policy DIRECTORY, read-only, in the assistant and console containers. */
export const COMPOSE_POLICY_TARGET_DIR = "/run/metistry/policy";
/** …and so where the mirrored `secrets.yaml` is read from inside them. */
export const COMPOSE_SECRETS_TARGET = `${COMPOSE_POLICY_TARGET_DIR}/secrets.yaml`;
/** The host-side compose variable naming the directory to mount — `metistry up` sets it to the instance's `secretsMirrorDir`. */
export const COMPOSE_SECRETS_SOURCE_VAR = "METISTRY_SECRETS_POLICY_DIR";

// ---- the policy mirror: what a container can see, and see CHANGE ---------------------
//
// A single-file bind mount pins the inode it was given, and every writer of
// `secrets.yaml` (the reconciler, git, an editor) replaces the file by
// rename — so a container mounting the file itself would keep reading the
// grant it started with, and a REVOKE would not reach it until a restart.
// That is not enforcement at the tool. A DIRECTORY bind sees a
// rename-replaced entry, but the directory holding `secrets.yaml` is
// `.metistry/`, which also holds `state/.env` with values — never mounted.
//
// So the policy is mirrored into a directory that holds nothing else,
// `<instance>/.metistry/state/policy/`, and THAT directory is mounted. The
// mirror is derived state (gitignored, like all of `state/`): the reconciler
// refreshes it every `SECRETS_MIRROR_INTERVAL_MS` and at start, so a CLI
// verb, a hand edit and a pull all reach it; `metistry up` writes it before
// compose starts. A missing canonical file removes the mirror — a deleted
// policy must never linger as a grant.

/** The directory the mirror lives in (and compose mounts): `<instance>/.metistry/state/policy`. Nothing else is ever written here. */
export function secretsMirrorDir(instanceDir: string): string {
  return instanceStatePath(instanceDir, "policy");
}

/** How often the reconciler refreshes the mirror: the most a hand-edited revoke waits to reach a compose container. */
export const SECRETS_MIRROR_INTERVAL_MS = 1000; // limit: fixed — a revoke's worst-case latency under compose; a read of one small file, and a knob here would only widen the window

export type MirrorOutcome = "written" | "unchanged" | "removed" | "absent";

/**
 * Bring `<instance>/.metistry/state/policy/secrets.yaml` in line with the
 * instance's `secrets.yaml`, byte for byte: written by tmp + rename in the
 * same directory (so a reader never sees half a file, and a directory mount
 * sees the new entry), removed when the canonical file is gone. The bytes
 * are copied as they are — a file that does not validate is mirrored, and
 * the reader refuses on it, rather than the mirror keeping an older grant.
 */
export async function mirrorSecretsPolicy(instanceDir: string): Promise<MirrorOutcome> {
  const src = instanceFile(instanceDir, "secrets");
  const dir = secretsMirrorDir(instanceDir);
  const dst = join(dir, "secrets.yaml");
  const read = async (p: string): Promise<string | undefined> => {
    try {
      return await readFile(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };
  const [want, have] = await Promise.all([read(src), read(dst)]);
  if (want === undefined) {
    if (have === undefined) return "absent";
    await rm(dst, { force: true });
    return "removed";
  }
  if (want === have) return "unchanged";
  await mkdir(dirname(dst), { recursive: true });
  const tmp = join(dir, `.secrets.yaml.${process.pid}.tmp`);
  await writeFile(tmp, want, { mode: 0o600 });
  await rename(tmp, dst);
  return "written";
}

/**
 * Where a process reads `secrets.yaml` for a grant, from its environment —
 * read afresh at each call, so a changed grant is seen on the next request:
 *
 *   1. `METISTRY_SECRETS_FILE`, when set and non-empty (the compose mount);
 *   2. set but empty: compose mounted nothing — refused, naming the mount;
 *   3. else `<METISTRY_INSTANCE_DIR>/.metistry/secrets.yaml` (launchd; the
 *      engine's sandbox grants that one file by name, CONFIG_SECRETS);
 *   4. else no file at all — refused, naming the cause.
 *
 * Every refusal is fail-closed: a `{{ secret.x }}` provider key is never
 * sent on a guess.
 */
export function secretsPolicyFromEnv(env: NodeJS.ProcessEnv): () => Promise<SecretsPolicyRead> {
  const explicit = env[SECRETS_FILE_VAR];
  if (explicit !== undefined && explicit.trim() !== "") {
    const path = explicit.trim();
    return () => readSecretsPolicy(path);
  }
  if (explicit !== undefined) {
    const why =
      `no secrets.yaml is mounted into this container (${SECRETS_FILE_VAR} is empty because ${COMPOSE_SECRETS_SOURCE_VAR} was unset when compose created it) — ` +
      `docker-compose.yml mounts the instance's policy mirror (.metistry/state/policy/, which holds only a copy of secrets.yaml) read-only at ${COMPOSE_POLICY_TARGET_DIR}: \`metistry up\` sets ${COMPOSE_SECRETS_SOURCE_VAR} and recreates the containers with the mount`;
    return async () => ({ ok: false, why });
  }
  const dir = env.METISTRY_INSTANCE_DIR?.trim();
  if (!dir) {
    const why = `METISTRY_INSTANCE_DIR and ${SECRETS_FILE_VAR} are both unset, so this process has no secrets.yaml to read the grant from — \`metistry up\` sets one of them for every service`;
    return async () => ({ ok: false, why });
  }
  const path = instanceFile(dir, "secrets");
  return () => readSecretsPolicy(path);
}

/**
 * The mode `grantee` has for `name`: what the file says, else Off. An unknown
 * secret is Off for everyone. An owner-door secret is Off for every
 * `connection:`, `agent:` or `provider:` grantee no matter what the file says — the
 * schema already refuses writing such a grant, but this is the one function
 * every delivery path (a command connection's environment, `guardedFetch`)
 * calls to decide, so it holds even for a file from before that check.
 */
export function secretGrant(file: SecretsFile, name: string, grantee: string): SecretGrantMode {
  if (isOwnerDoorSecret(name)) return DEFAULT_SECRET_GRANT;
  const policy = Object.hasOwn(file.secrets, name) ? file.secrets[name] : undefined;
  if (!policy || !Object.hasOwn(policy.grants, grantee)) return DEFAULT_SECRET_GRANT;
  return policy.grants[grantee] ?? DEFAULT_SECRET_GRANT;
}

// ---- references: {{ secret.name }} ---------------------------------------------------

/** Anything that is trying to be a secret reference, in any case — what a well-formed one is checked against, so a typo is refused rather than sent. */
const SECRET_REF_LOOSE_RE = /\{\{\s*secrets?\b[^}]*\}\}/gi;

export interface SecretRefs {
  /** the names referenced, first occurrence order, each once */
  names: string[];
  /** `{{ secret… }}` spellings that are not a well-formed reference */
  malformed: string[];
}

/** Every secret a piece of text references, and every attempt at one that does not parse. */
export function secretRefsIn(text: string): SecretRefs {
  const names: string[] = [];
  for (const m of text.matchAll(SECRET_REF_RE)) if (m[1] && !names.includes(m[1])) names.push(m[1]);
  const malformed: string[] = [];
  for (const m of text.matchAll(SECRET_REF_LOOSE_RE)) {
    const whole = m[0];
    if (!SECRET_REF_EXACT_RE.test(whole) && !malformed.includes(whole)) malformed.push(whole);
  }
  return { names, malformed };
}

/** What fills a reference: one instance's store (`InstanceSecrets`), or a fake. */
export interface SecretSource {
  value(name: string): Promise<string | undefined>;
}

export type FillResult =
  | { ok: true; text: string; /** names filled, never values */ used: string[] }
  | { ok: false; /** referenced, and this instance has no such item */ missing: string[]; malformed: string[]; message: string };

/**
 * Fill every `{{ secret.name }}` in `template` from `source`, or refuse.
 *
 * All or nothing: one missing name or one malformed reference and nothing is
 * filled — the caller gets names, never a partly-filled string it might send.
 * One pass: a value that itself contains `{{ secret.x }}` is inserted as it
 * is, never expanded again. `{{ variable.x }}` and every other brace are left
 * for their own resolvers.
 *
 * This is the primitive. Filling is legitimate only at egress, against the
 * secret's *Sent only to* list (`egress.ts`, T4-2) — never into anything a
 * model reads.
 */
export async function fillSecretRefs(template: string, source: SecretSource): Promise<FillResult> {
  const { names, malformed } = secretRefsIn(template);
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const name of names) {
    const v = await source.value(name);
    if (v === undefined || v === "") missing.push(name);
    else values.set(name, v);
  }
  if (missing.length > 0 || malformed.length > 0) {
    const parts = [
      ...(missing.length ? [`no item in this instance for ${missing.map((n) => `{{ secret.${n} }}`).join(", ")} — \`metistry secrets set <name>\` stores one`] : []),
      ...(malformed.length ? [`not a secret reference: ${malformed.join(", ")} — the form is {{ secret.name }}, name in lowercase snake_case`] : []),
    ];
    return { ok: false, missing, malformed, message: parts.join("; ") };
  }
  const text = template.replace(SECRET_REF_RE, (_whole, name: string) => values.get(name)!);
  return { ok: true, text, used: names };
}

// ---- the store: one instance's items, and nothing else ---------------------------------

/**
 * The Keychain, as the store needs it: generic-password items addressed by
 * (service, account). The seam — `packages/cli/src/keychain.ts` implements it
 * over `security`, and `memoryKeychain()` implements it for tests. A backend
 * is SHARED by every instance on a Mac, exactly as the login Keychain is; the
 * separation is `InstanceSecrets`', not the backend's.
 */
export interface KeychainBackend {
  get(service: string, account: string): Promise<string | undefined>;
  /** presence only — must never read the value */
  has(service: string, account: string): Promise<boolean>;
  set(service: string, account: string, value: string): Promise<void>;
  /** true when an item went away, false when there was none */
  delete(service: string, account: string): Promise<boolean>;
}

/** Whether this instance holds an item for a name. The whole of what a listing may ask. */
export interface SecretPresence {
  has(name: string): Promise<boolean>;
}

/**
 * A presence probe bound to one instance, built from a probe that can only
 * answer yes or no. The console is handed one of these and nothing else, so
 * the process that serves `GET /api/secrets` holds no call that returns a
 * value.
 */
export function instancePresence(probe: (service: string, account: string) => Promise<boolean>, instanceId: string): SecretPresence {
  const account = secretAccount(instanceId);
  return { has: (name) => probe(secretService(name), account) };
}

/** A value the Keychain can hold through `security`'s prompt: non-empty, one line. */
export function secretValueIssue(value: string): string | undefined {
  if (value === "") return "a secret value cannot be empty";
  if (/[\r\n]/.test(value)) return "a secret value cannot contain a newline (the Keychain's `security` prompt reads one line)";
  return undefined;
}

/**
 * **One instance's secrets.** Made with the instance's `instance_id`, which
 * becomes the only account it ever addresses; every method takes a secret
 * NAME, validated, and nothing takes an account. So a holder of this object
 * for instance A has no way to name instance B's item — not by argument,
 * not by a crafted name — and the tests prove it on one shared backend.
 */
export class InstanceSecrets implements SecretSource, SecretPresence {
  readonly account: string;
  readonly #backend: KeychainBackend;

  constructor(backend: KeychainBackend, instanceId: string) {
    this.account = secretAccount(instanceId);
    this.#backend = backend;
  }

  /** The value, or undefined when this instance has no such item. For the egress fill and a local agent's environment — never for display. */
  async value(name: string): Promise<string | undefined> {
    return this.#backend.get(secretService(name), this.account);
  }

  async has(name: string): Promise<boolean> {
    return this.#backend.has(secretService(name), this.account);
  }

  /**
   * Store (or overwrite) this instance's item, then read it back: a value the
   * Keychain did not keep whole is removed and refused, rather than left to
   * fail at egress weeks later.
   */
  async set(name: string, value: string): Promise<void> {
    const service = secretService(name);
    const issue = secretValueIssue(value);
    if (issue) throw new Error(issue);
    await this.#backend.set(service, this.account, value);
    const back = await this.#backend.get(service, this.account);
    if (back !== value) {
      await this.#backend.delete(service, this.account);
      throw new Error(`the Keychain did not keep the value of ${name} whole (it read back different), so the item was removed — nothing is stored`);
    }
  }

  /** Delete this instance's item. True when one went away. */
  async remove(name: string): Promise<boolean> {
    return this.#backend.delete(secretService(name), this.account);
  }

  /** The presence-only view of the same instance, for a listing. */
  presence(): SecretPresence {
    const backend = this.#backend;
    return instancePresence((service, account) => backend.has(service, account), this.account);
  }
}

/**
 * A Keychain in memory: the fake every test uses instead of the login
 * Keychain. Items are keyed by (account, service), exactly as the real one
 * files them, so several instances can share one and the separation under
 * test is `InstanceSecrets`', not this map's.
 */
export function memoryKeychain(seed: ReadonlyArray<{ service: string; account: string; value: string }> = []): KeychainBackend & {
  /** (account, service) pairs, never values — what a test asserts on */
  items(): Array<{ service: string; account: string }>;
} {
  const store = new Map<string, { service: string; account: string; value: string }>();
  const key = (service: string, account: string) => JSON.stringify([account, service]);
  for (const s of seed) store.set(key(s.service, s.account), { ...s });
  return {
    async get(service, account) {
      return store.get(key(service, account))?.value;
    },
    async has(service, account) {
      return store.has(key(service, account));
    },
    async set(service, account, value) {
      store.set(key(service, account), { service, account, value });
    },
    async delete(service, account) {
      return store.delete(key(service, account));
    },
    items() {
      return [...store.values()].map(({ service, account }) => ({ service, account }));
    },
  };
}

// ---- the listing: GET /api/secrets and `metistry secrets list --named` ------------------

/**
 * `runs.meta[SECRET_USE_META_KEY]` — the NAMES a run filled in (never a
 * value). The egress fill (T4-2) stamps it; the `secret_last_used` named
 * query reads it back as *last used*. Postgres is derived (invariant 1): lose
 * it and *last used* reads "never" until the next use.
 */
export const SECRET_USE_META_KEY = "secrets";

/** The named query *last used* comes from (seed/queries/secret_last_used.yaml) — the one read path into state (invariant 3). */
export const SECRET_LAST_USED_QUERY = "secret_last_used";

/** One row of the listing. A value has no field to go in. */
export interface SecretRow {
  name: string;
  /** *Sent only to* */
  hosts: string[];
  /** *Who may use it*, in the file's order */
  grants: Array<{ to: string; mode: SecretGrantMode }>;
  /** when the service says the value stops working, or null */
  expires: string | null;
  /** whether THIS instance's Keychain account holds an item — null where there is no Keychain to ask (a container, Linux) */
  present: boolean | null;
  /** the last run that filled it in (ISO), or null for never / unknown */
  last_used: string | null;
}

/**
 * The listing, from the policy file, a presence probe and the last-used map.
 * Takes a `SecretPresence` — `has` only — so it cannot read a value; and it
 * builds each row field by field from the policy, so nothing the file might
 * carry passes through unexamined.
 */
export async function describeSecrets(file: SecretsFile, presence: SecretPresence | undefined, lastUsed: ReadonlyMap<string, string> = new Map()): Promise<SecretRow[]> {
  const rows: SecretRow[] = [];
  for (const name of Object.keys(file.secrets).sort()) {
    const p = file.secrets[name]!;
    rows.push({
      name,
      hosts: [...p.hosts],
      grants: Object.entries(p.grants).map(([to, mode]) => ({ to, mode })),
      expires: p.expires ?? null,
      present: presence ? await presence.has(name) : null,
      last_used: lastUsed.get(name) ?? null,
    });
  }
  return rows;
}
