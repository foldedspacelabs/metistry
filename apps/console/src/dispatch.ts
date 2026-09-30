// Compute-target dispatch (plan §4.18.B, Phase 5). A target is a directory
// with a manifest; this is the ONE tool through which a brief leaves the
// machine for one of them. The manifest's data_policy is enforced HERE —
// "comms-derived content never leaves the machine" is a refusal with a
// machine-readable reason, not a sentence in a prompt (CLAUDE.md: enforce
// at the tool, never by prompting).
//
// Every dispatch — refused or sent — is a two-phase `runs` row (CRIT-8)
// carrying the target's cost profile, so per-target spend is one query.
// Two transports dispatch today. `github`: an issue in the configured repo is
// the external work queue (§6 decision 4); github-state reconciles its status
// back onto the same work row by `gh:owner/repo#n`. `http` + `submit.kind:
// devin-session`: a Devin session (W6), bound as `devin:<session_id>` and
// polled home by `collectors/devin-sessions` — Devin publishes no completion
// webhook, so the return is a poll, and the answer lands as a `report`
// proposal rather than as a status change.
//
// **Targets as connections (plan §2.6, §2.7; T4-11).** A target is now also
// an `agent` connection — `.metistry/connections/<name>.yaml` whose type
// (`seed/connection-types/devin`, `…/github-issues`) carries the dispatcher,
// the data policy and the purposes. This file's adapter reads the instance's
// agent connections afresh on every listing and dispatch and presents each
// as the target `dispatch()` already knows: dispatch is unchanged. What
// changes is where the key comes from: a connection's request goes through
// its door (packages/connections `openAgentHttp`) — the key is a
// `{{ secret.x }}` reference filled by core's `guardedFetch` for the hosts
// its *Sent only to* list names, granted to `connection:<name>`, and never
// put on a request here; what comes back is redacted. The `targets/`
// manifests and their `env:` keys still load, for one release, beside them;
// a connection of the same name wins (D4), except the crews' `local-crew`.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EgressRefused,
  finishRun,
  loadKind,
  loadRegistry,
  manifestKind,
  runCheck,
  startRun,
  validateManifest,
  type AgentPurpose,
  type CheckResult,
  type ConnectionTypeManifest,
  type RegistrySkip,
  type RegistrySource,
  type DataPolicy,
  type ErrorCode,
  type SecretSource,
  type TargetManifest,
} from "@foldedspacelabs/metistry-core";
import { ConnectionRefused, agentConnections, openAgentHttp, type AgentHttp, type ConnectionCatalog } from "@foldedspacelabs/metistry-connections";
import { DEVIN_API, devinRef, type DevinWorkMeta } from "@metistry-apps/collectors";
import {
  DEFAULT_PURPOSE,
  DEVIN_ANSWER_SCHEMA,
  devinSessionBody,
  resolveMaxAcu,
  schemaIssues,
  type DevinPurpose,
} from "./devin.js";

export interface Db {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

// --- data policy ------------------------------------------------------------

export type PolicyViolation =
  | { kind: "brief_too_large"; bytes: number; max_brief_bytes: number }
  | { kind: "denied_source"; sources: string[] }
  | { kind: "path_outside_allow"; paths: string[]; allow: string[] };

// A vault reference is any TitleCase-rooted path token (plain, in a
// wikilink, in backticks, in a markdown link) — since the vault root became
// the instance directory there is no `Knowledge/` to anchor on, so the
// anchor is the casing rule: an uppercase first segment followed by at least
// one `/segment`. Terminators are the characters that end one in prose or
// markup; trailing sentence punctuation is stripped after.
//
// This scanner only ever ADDS refusals (a token outside `allow` blocks the
// brief), so a false positive is strict and a false negative is the danger.
// Erring wide is the right direction here.
const VAULT_PATH = /\b[A-Z][A-Za-z0-9_.'-]*(?:\/[^\s"'`()[\]<>|,;]+)+/g;
// Provenance markers as they occur in frontmatter (`source: comms`,
// `sources: [comms, x]`) or an inline stamp (`<!-- source: comms -->`).
const SOURCE_MARKER = /\bsources?\s*:\s*(\[[^\]\n]*\]|[A-Za-z][A-Za-z0-9_-]*)/g;

function pathAllowed(allow: string[], path: string): boolean {
  const segs = path.split("/");
  if (segs.includes("..") || segs.includes(".") || segs.includes("")) return false; // no traversal, no `//`
  return allow.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Pure policy check. Returns every violation found (empty = the brief may
 * go). `declaredSources` is the caller's own provenance claim for the
 * brief; the text is scanned for markers regardless, so an honest caller
 * and a sloppy one get the same answer.
 */
export function checkBrief(policy: DataPolicy, brief: string, declaredSources: string[] = []): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const bytes = Buffer.byteLength(brief, "utf8");
  if (bytes > policy.max_brief_bytes) {
    // too big to scan honestly — the size verdict alone is the answer
    return [{ kind: "brief_too_large", bytes, max_brief_bytes: policy.max_brief_bytes }];
  }

  const denied = new Set(policy.deny_sources);
  const hits = new Set<string>();
  const consider = (raw: string) => {
    const s = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (denied.has(s)) hits.add(s);
  };
  for (const s of declaredSources) consider(s);
  for (const m of brief.matchAll(SOURCE_MARKER)) {
    const raw = m[1]!;
    if (raw.startsWith("[")) for (const n of raw.slice(1, -1).split(",")) consider(n);
    else consider(raw);
  }
  if (hits.size > 0) out.push({ kind: "denied_source", sources: [...hits].sort() });

  const outside = new Set<string>();
  for (const m of brief.matchAll(VAULT_PATH)) {
    const p = m[0].replace(/[.,:;!?]+$/, "");
    if (!pathAllowed(policy.allow, p)) outside.add(p);
  }
  if (outside.size > 0) out.push({ kind: "path_outside_allow", paths: [...outside].sort(), allow: policy.allow });
  return out;
}

// --- registry -----------------------------------------------------------------

/** Where the instance's agent connections come from (T4-11): its catalog, read afresh per call, and the values the console holds. */
export interface AgentConnectionSource {
  catalog(): Promise<Pick<ConnectionCatalog, "entries" | "secrets"> & { types: { units(): readonly { name: string; manifest: ConnectionTypeManifest }[] } }>;
  /** the delivered `METISTRY_SECRET_*` values (`envSecretSource`) — filled at the door, never read here */
  secrets: SecretSource;
}

export interface TargetRegistryOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** the instance's agent connections; absent = the `targets/` manifests only */
  connections?: AgentConnectionSource | undefined;
  /** the product's `seed/`, for the shipped Devin type's purposes when no instance catalog is read. Default: the checkout's `seed/`, else `./seed` */
  seedDir?: string | undefined;
}

export interface TargetDescription {
  name: string;
  description?: string;
  transport: TargetManifest["transport"];
  submit: Record<string, unknown>;
  result: Record<string, unknown>;
  auth?: string;
  cost?: TargetManifest["cost"];
  data_policy: DataPolicy;
  check: CheckResult;
  /** the agent connection this target is (T4-11); absent for a `targets/` manifest */
  connection?: string;
}

/** `env:VAR` → the variable's value (undefined when unset/empty); anything else is literal. */
export function resolveRef(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (!value.startsWith("env:")) return value;
  const v = env[value.slice(4)];
  return v === undefined || v === "" ? undefined : v;
}

const GITHUB_API = "https://api.github.com";
/** `submit.kind` of the one http target this console implements (targets/devin-sessions). */
export const DEVIN_SUBMIT_KIND = "devin-session";
/** The target crews are checked against (crews.ts) — a connection never takes its name. */
const CREW_TARGET = "local-crew";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ORG_RE = /^[A-Za-z0-9_-]+$/;
/** A `{{ secret.… }}` or `{{ variable.… }}` reference: the door fills the first wherever it finds one, so a brief never carries one to a connection. */
const REFERENCE = /\{\{\s*(?:secret|variable)\.[^{}]*\}\}/;

/** The purposes a devin-session dispatch may name, with the default a dispatch that names none gets. */
export interface PurposeSet {
  purposes: Readonly<Record<string, AgentPurpose>>;
  default_purpose?: string | undefined;
}

export interface DevinSubmitInput {
  brief: string;
  title: string;
  taskId: number;
  purpose: DevinPurpose;
  /** Per-dispatch ACU ceiling; falls back to the manifest's `submit.max_acu`, then to the small default. */
  maxAcu?: number | undefined;
}

export interface DevinSubmission {
  ref: string;
  url: string;
  session_id: string;
  org: string;
  max_acu: number;
}

/** Why a dispatch was refused before it was sent, with the envelope code — thrown by a submit, mapped by `dispatch()`. */
export class DispatchRefused extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DispatchRefused";
  }
}

/** The checkout's `seed/` (apps/console/{src,dist} → ../../../seed), else `./seed` — both shapes run the console beside it. */
function defaultSeedDir(): string {
  const beside = fileURLToPath(new URL("../../../seed", import.meta.url));
  return existsSync(`${beside}/connection-types`) ? beside : resolvePath("seed");
}

/** How a request reaches a target: through a connection's door with its sign-in as a reference, or (a `targets/` manifest) with the env key. */
interface Access {
  fetch: typeof fetch;
  authorization: string;
  /** the connection it goes through, when it does */
  agent?: AgentHttp | undefined;
}

export class TargetRegistry {
  private readonly targets = new Map<string, TargetManifest>();
  /** agent connections presented as targets, by connection name — replaced on every refresh */
  private bound = new Map<string, { manifest: TargetManifest; agent: AgentHttp }>();
  /** agent connections that could not be presented, with why */
  private unbound = new Map<string, { status: "absent" | "failed"; why: string }>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private connections: AgentConnectionSource | undefined;
  private readonly seedDir: string | undefined;
  private types: readonly ConnectionTypeManifest[] | undefined;
  private shipped: Promise<readonly ConnectionTypeManifest[]> | undefined;

  constructor(opts: TargetRegistryOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.connections = opts.connections;
    this.seedDir = opts.seedDir;
  }

  /**
   * Validate and register one manifest inline; a later add with the same
   * name replaces. Throws on an invalid manifest. For a caller that already
   * holds the manifest (tests, fixtures) — a deployment loads through
   * `load()`, which is the registry's rules.
   */
  add(input: unknown, where = "(inline)"): TargetManifest {
    const r = validateManifest(input);
    if (!r.ok) throw new Error(`${where}: invalid manifest: ${r.errors.join("; ")}`);
    if (r.manifest.type !== "target") throw new Error(`${where}: not a target (type ${r.manifest.type})`);
    this.targets.set(r.manifest.name, r.manifest);
    return r.manifest;
  }

  /** Every target manifest `load()` refused, with why — skipped, never fatal (plan §2.7). */
  readonly skipped: RegistrySkip[] = [];

  /**
   * Load targets through core's `Registry` (plan §2.7): the product's
   * `targets/`, then the owner's — the legacy `.metistry/targets/` overlay and
   * `.metistry/extensions/` — overlaid by name, origin deciding (D4). A
   * manifest that fails, or lacks `schema: 1`, is skipped with its reason in
   * `skipped` rather than taking the console down. Returns the names in force.
   */
  async load(sources: readonly RegistrySource[]): Promise<string[]> {
    const reg = await loadRegistry(manifestKind("target"), sources);
    for (const u of reg.units()) this.targets.set(u.name, u.manifest);
    this.skipped.push(...reg.skipped);
    return reg.names();
  }

  /** `load()` of one product directory: `<dir>/<name>/manifest.yaml`, each named for its directory. A missing dir loads nothing. */
  async loadDir(dir: string): Promise<string[]> {
    return this.load([{ dir, origin: "product" }]);
  }

  /** Read the instance's agent connections from now on (main.ts, once the instance's catalog is known). */
  bindConnections(source: AgentConnectionSource): void {
    this.connections = source;
  }

  /**
   * Re-read the instance's agent connections (T4-11) and present each as a
   * target. Called before every listing and dispatch, so an edit to a
   * connection, `secrets.yaml` or an overlaid type lands with no restart.
   * No connection source: nothing to read.
   */
  async refresh(): Promise<void> {
    if (!this.connections) return;
    const catalog = await this.connections.catalog();
    this.types = catalog.types.units().map((u) => u.manifest);
    const bound = new Map<string, { manifest: TargetManifest; agent: AgentHttp }>();
    const unbound = new Map<string, { status: "absent" | "failed"; why: string }>();
    for (const e of agentConnections(catalog)) {
      if (this.targets.get(e.name)?.transport === "local") {
        unbound.set(e.name, { status: "failed", why: `${e.name} is the crews' target — rename the connection` });
        continue;
      }
      const dispatcher = e.provider?.manifest.dispatch?.dispatcher;
      const opened = openAgentHttp({
        catalog,
        connection: e.name,
        // GitHub is one service at one address: the write token goes nowhere else, whatever the file says
        ...(dispatcher === "github-issue" ? { origin: GITHUB_API } : {}),
        secrets: this.connections.secrets,
        fetch: this.fetchFn,
      });
      if (!opened.ok) {
        unbound.set(e.name, { status: opened.status, why: opened.why });
        continue;
      }
      const manifest = targetOf(opened.agent);
      if (typeof manifest === "string") {
        unbound.set(e.name, { status: "failed", why: manifest });
        continue;
      }
      bound.set(e.name, { manifest, agent: opened.agent });
    }
    this.bound = bound;
    this.unbound = unbound;
  }

  names(): string[] {
    return [...new Set([...this.targets.keys(), ...this.bound.keys()])].sort();
  }

  get(name: string): TargetManifest | undefined {
    return this.bound.get(name)?.manifest ?? this.targets.get(name);
  }

  /** The agent connection `name` is, when it is one (after the last refresh). */
  connectionOf(name: string): AgentHttp | undefined {
    return this.bound.get(name)?.agent;
  }

  /** Why the agent connection `name` cannot be dispatched to, when it is one that cannot (after the last refresh). */
  unavailableConnection(name: string): { status: "absent" | "failed"; why: string } | undefined {
    return this.bound.has(name) ? undefined : this.unbound.get(name);
  }

  /** The shipped connection types, read once — the purposes a `targets/` Devin manifest dispatches with when no instance catalog is read. */
  private async typesInForce(): Promise<readonly ConnectionTypeManifest[]> {
    if (this.types) return this.types;
    this.shipped ??= loadKind("connection-type", { seedDir: this.seedDir ?? defaultSeedDir() }).then((r) => r.units().map((u) => u.manifest));
    return this.shipped;
  }

  /**
   * The purposes a target takes (plan §2.7: `DEVIN_PURPOSES` → the Devin
   * connection type). An agent connection's are its type's; a `targets/`
   * Devin manifest dispatches with the Devin type's (`devin`, or the owner's
   * overlay of it); anything else takes none, and records `work`.
   */
  async purposesOf(m: TargetManifest): Promise<PurposeSet> {
    const bound = this.bound.get(m.name);
    if (bound && bound.manifest === m) return bound.agent.dispatch;
    if (!TargetRegistry.isDevin(m)) return { purposes: {} };
    const types = await this.typesInForce();
    const devin = types.find((t) => t.name === "devin" && t.dispatch?.dispatcher === DEVIN_SUBMIT_KIND) ?? types.find((t) => t.dispatch?.dispatcher === DEVIN_SUBMIT_KIND);
    return devin?.dispatch ?? { purposes: {} };
  }

  /** Every purpose any target in force takes, sorted — what the dispatch route accepts before it knows the target. */
  async purposes(): Promise<string[]> {
    await this.refresh();
    const out = new Set<string>();
    for (const name of this.names()) for (const p of Object.keys((await this.purposesOf(this.get(name)!)).purposes)) out.add(p);
    return [...out].sort();
  }

  /** Resolved github config, or the reason it is unavailable. */
  private github(m: TargetManifest): { ok: true; access: Access; repo: string } | { ok: false; remediation: string } {
    const bound = this.bound.get(m.name);
    if (bound && bound.manifest === m) return { ok: true, access: { fetch: bound.agent.fetch, authorization: bound.agent.headers.authorization ?? "", agent: bound.agent }, repo: String(m.submit.repo) };
    const token = resolveRef(m.auth, this.env);
    const repo = resolveRef(m.submit.repo, this.env);
    if (!token) {
      return {
        ok: false,
        remediation: `set ${String(m.auth)} (fine-grained PAT: Issues read/write + Metadata on the target repo only — docs/ops/targets.md)`,
      };
    }
    if (!repo) return { ok: false, remediation: `set ${String(m.submit.repo)} to owner/repo` };
    return { ok: true, access: { fetch: this.fetchFn, authorization: `Bearer ${token}` }, repo };
  }

  private ghHeaders(access: Access): Record<string, string> {
    return {
      authorization: access.authorization,
      accept: "application/vnd.github+json",
      "user-agent": "metistry-dispatch",
    };
  }

  /**
   * Resolved Devin config, or the reason it is unavailable. `submit.org` is
   * REQUIRED here even though collectors/devin-knowledge can resolve an org
   * from `GET /v3/self`: a session is a spend, and which organization it is
   * charged to is not something to infer.
   */
  private devin(m: TargetManifest): { ok: true; access: Access; org: string; base: string } | { ok: false; remediation: string } {
    const bound = this.bound.get(m.name);
    if (bound && bound.manifest === m) {
      return { ok: true, access: { fetch: bound.agent.fetch, authorization: bound.agent.headers.authorization ?? "", agent: bound.agent }, org: String(m.submit.org), base: String(m.submit.url) };
    }
    const token = resolveRef(m.auth, this.env);
    const org = resolveRef(m.submit.org, this.env);
    if (!token) return { ok: false, remediation: `set ${String(m.auth)} (the same \`cog_\` key collectors/devin-knowledge reads — docs/ops/devin.md)` };
    if (!org) return { ok: false, remediation: `set ${String(m.submit.org)} to the organization id the session should be charged to (\`org-…\`; GET /v3/self reports it for an org-scoped key)` };
    return { ok: true, access: { fetch: this.fetchFn, authorization: `Bearer ${token}` }, org, base: resolveRef(m.submit.url, this.env) ?? DEVIN_API };
  }

  /** `http` targets this console implements. An http target with another `submit.kind` validates and lists, and dispatch refuses it by name. */
  static isDevin(m: TargetManifest): boolean {
    return m.transport === "http" && m.submit.kind === DEVIN_SUBMIT_KIND;
  }

  /** Behavioral probe (Phase 0 rule 3): unset config → absent; set → the repo is actually readable with the write token. */
  async check(name: string): Promise<CheckResult> {
    const gone = this.unavailableConnection(name);
    if (gone) return runCheck(name, "read the agent connection", async () => ({ status: gone.status, remediation: gone.why }));
    const m = this.get(name);
    if (!m) return { name, status: "absent", latency_ms: 0, probe: "registry lookup", remediation: "no such target" };
    if (m.transport === "local") {
      // crews (docs/ops/crews.md): dispatched by the assistant's agents_delegate tool, run by the assistant
      // container's drain loop. Loaded + policy-checkable here; the runner itself is not probed from the console.
      return runCheck(name, "manifest loaded; dispatch is the assistant's agents_delegate tool (runner in the assistant container, not probed here)", async () => ({
        meta: { via: "agents_delegate", submit: m.submit, result: m.result },
      }));
    }
    if (TargetRegistry.isDevin(m)) {
      const dv = this.devin(m);
      if (!dv.ok) return runCheck(name, "resolve auth + submit.org from environment", async () => ({ status: "absent", remediation: dv.remediation }));
      return runCheck(name, `GET /v3/self with the Devin key${dv.access.agent ? ` of connection ${name}, filled at its door` : ""} (session creation itself is not probed — it spends)`, async () =>
        doorVerdict(async () => {
          const res = await dv.access.fetch(`${dv.base}/v3/self`, {
            headers: this.devinHeaders(dv.access),
            signal: AbortSignal.timeout(10_000),
          });
          if (res.status === 429) return { status: "degraded" as const, remediation: "Devin answered 429 — the key works but the API is rate limiting; dispatch retries on the next attempt" };
          if (!res.ok) throw new Error(`devin HTTP ${res.status} — check the key (legacy apk_ keys are dead; use a cog_ service-user key or PAT)`);
          return { meta: { org: dv.org, base: dv.base } };
        }),
      );
    }
    if (m.transport !== "github") {
      return runCheck(name, `dispatcher for transport ${m.transport}`, async () => ({
        status: "absent",
        remediation: `transport ${m.transport}${m.transport === "http" ? ` with submit.kind ${JSON.stringify(m.submit.kind ?? null)}` : ""} has no dispatcher in this console yet`,
      }));
    }
    const gh = this.github(m);
    if (!gh.ok) {
      return runCheck(name, "resolve auth + submit.repo from environment", async () => ({ status: "absent", remediation: gh.remediation }));
    }
    return runCheck(name, `GET /repos/${gh.repo} with the write token${gh.access.agent ? ` of connection ${name}, filled at its door` : ""} (issue creation itself is not probed)`, async () =>
      doorVerdict(async () => {
        const res = await gh.access.fetch(`${GITHUB_API}/repos/${gh.repo}`, {
          headers: this.ghHeaders(gh.access),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`github HTTP ${res.status} — check the token's repository access and Metadata permission`);
        return { meta: { repo: gh.repo } };
      }),
    );
  }

  /** Every target with its live check — the GET /api/targets payload. Agent connections that cannot be dispatched to are left out (their check says why on `metistry connections`). */
  async describe(): Promise<TargetDescription[]> {
    await this.refresh();
    const out: TargetDescription[] = [];
    for (const name of this.names()) {
      const m = this.get(name)!;
      out.push({
        name: m.name,
        ...(m.description !== undefined ? { description: m.description } : {}),
        transport: m.transport,
        submit: m.submit,
        result: m.result,
        ...(m.auth !== undefined ? { auth: m.auth } : {}),
        ...(m.cost !== undefined ? { cost: m.cost } : {}),
        data_policy: m.data_policy,
        check: await this.check(name),
        ...(this.bound.has(name) ? { connection: name } : {}),
      });
    }
    return out;
  }

  /** Open the issue. Exposed for the dispatcher only. */
  async submitGithub(m: TargetManifest, title: string, body: string): Promise<{ ref: string; url: string }> {
    const gh = this.github(m);
    if (!gh.ok) throw new Error(`target ${m.name} unavailable: ${gh.remediation}`);
    const payload = JSON.stringify({ title, body });
    if (gh.access.agent) refuseReferences(payload);
    const res = await gh.access.fetch(`${GITHUB_API}/repos/${gh.repo}/issues`, {
      method: "POST",
      headers: { ...this.ghHeaders(gh.access), "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`github ${gh.repo} issues: HTTP ${res.status}`);
    const issue = (await res.json()) as { number: number; html_url: string };
    return { ref: `gh:${gh.repo}#${issue.number}`, url: issue.html_url };
  }

  private devinHeaders(access: Access): Record<string, string> {
    return {
      authorization: access.authorization,
      accept: "application/json",
      "user-agent": "metistry-dispatch",
    };
  }

  /**
   * Create the session. Exposed for the dispatcher only. The structured-output
   * contract is validated BEFORE the request goes out: `structured_output_required`
   * defaults to true at Devin, so a malformed schema would turn the whole
   * dispatch into an unvalidated blob, and that is a refusal, not a warning.
   */
  async submitDevin(m: TargetManifest, input: DevinSubmitInput): Promise<DevinSubmission> {
    const dv = this.devin(m);
    if (!dv.ok) throw new Error(`target ${m.name} unavailable: ${dv.remediation}`);
    const issues = schemaIssues(DEVIN_ANSWER_SCHEMA);
    if (issues.length > 0) throw new Error(`structured_output_schema is not Draft 7: ${issues.join("; ")}`);
    const set = await this.purposesOf(m);
    const spec = set.purposes[input.purpose];
    if (!spec) throw new DispatchRefused("invalid_request", `purpose ${input.purpose} is not one ${m.name} takes — one of ${Object.keys(set.purposes).join(" | ") || "(none)"}`);
    const maxAcu = resolveMaxAcu(input.maxAcu, m.submit.max_acu);
    const body = devinSessionBody({ ...input, preamble: spec.preamble, target: m.name, maxAcu });
    const payload = JSON.stringify(body);
    if (dv.access.agent) refuseReferences(payload);
    const res = await dv.access.fetch(`${dv.base}/v3/organizations/${encodeURIComponent(dv.org)}/sessions`, {
      method: "POST",
      headers: { ...this.devinHeaders(dv.access), "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`devin sessions (org ${dv.org}): HTTP ${res.status}`);
    const session = (await res.json()) as { session_id?: string; url?: string };
    if (!session.session_id) throw new Error("devin sessions: response carried no session_id");
    const url = session.url ?? `${dv.base}/sessions/${session.session_id}`;
    return { ref: devinRef(session.session_id), url, session_id: session.session_id, org: dv.org, max_acu: maxAcu };
  }

  available(m: TargetManifest): boolean {
    if (TargetRegistry.isDevin(m)) return this.devin(m).ok;
    return m.transport === "github" && this.github(m).ok;
  }
}

/**
 * An agent connection as the target `dispatch()` knows, or why it is not
 * one: the type's dispatch block, the connection's URL, its sign-in as a
 * reference, and its config — a repository or an organization, which go in
 * a URL path, so each is held to its shape and can never be a reference.
 */
function targetOf(a: AgentHttp): TargetManifest | string {
  const d = a.dispatch;
  const common = {
    schema: 1 as const,
    name: a.connection,
    type: "target" as const,
    ...(a.description !== undefined ? { description: a.description } : {}),
    result: d.result,
    ...(a.headers.authorization !== undefined ? { auth: a.headers.authorization.replace(/^Bearer /, "") } : {}),
    ...(d.cost ? { cost: d.cost } : {}),
    data_policy: d.data_policy,
  };
  if (d.dispatcher === "github-issue") {
    const repo = a.config.repo?.trim() ?? "";
    if (!REPO_RE.test(repo)) return `connection ${a.connection}: config.repo must be owner/repo — got ${JSON.stringify(repo)}`;
    return { ...common, transport: "github", submit: { repo } } as TargetManifest;
  }
  const org = a.config.org?.trim() ?? "";
  if (!ORG_RE.test(org)) return `connection ${a.connection}: config.org must be the organization id (org-…) — got ${JSON.stringify(org)}`;
  return {
    ...common,
    transport: "http",
    submit: { kind: DEVIN_SUBMIT_KIND, url: a.url.replace(/\/+$/, ""), org, ...(d.max_acu !== undefined ? { max_acu: d.max_acu } : {}) },
  } as TargetManifest;
}

/** A request bound for a connection carries no `{{ secret.… }}` or `{{ variable.… }}` — the door would fill the first and send it (the pool's `secret_reference`, T4-10). */
function refuseReferences(payload: string): void {
  if (REFERENCE.test(payload)) {
    throw new DispatchRefused("invalid_request", "the brief or the task's title carries a {{ secret.… }} or {{ variable.… }} reference — the door fills references, so a brief never carries one; nothing was sent");
  }
}

/** A door's refusal as a check verdict: a missing item is absent, anything else failed — names, never values. */
async function doorVerdict<T>(probe: () => Promise<T>): Promise<T | { status: "absent" | "failed"; remediation: string }> {
  try {
    return await probe();
  } catch (err) {
    if (err instanceof EgressRefused) return { status: err.code === "missing_secret" ? "absent" : "failed", remediation: err.message };
    if (err instanceof ConnectionRefused) return { status: "failed", remediation: err.message };
    throw err;
  }
}

// --- dispatch ------------------------------------------------------------------

export type DispatchResult =
  | { ok: true; ref: string; url: string; run_id: number }
  | { ok: false; code: ErrorCode; message: string; violations?: PolicyViolation[]; check?: CheckResult };

/** The trailer every dispatched brief carries: who sent it, and how the result gets home. Names no assistant. */
export function returnFooter(taskId: number, target: string): string {
  return [
    "---",
    `_Dispatched from metistry — task #${taskId} via target \`${target}\`._`,
    `_Return path: closing this issue closes task #${taskId} on the next \`github-state\` reconcile. A closing comment is not read back yet (see \`targets/${target}/manifest.yaml\`, \`result:\`)._`,
  ].join("\n");
}

export interface DispatchOptions {
  /**
   * Why the brief is going. `knowledge_research` is the W6 brief kind: a
   * question the assistant cannot answer, whose whole output is the answer.
   * A `purpose` rather than a new `work.kind` on purpose — `packages/tasks`
   * owns two claimable kinds and github-state owns the rest, so a third
   * would ripple for no gain (apps/console/src/devin.ts).
   */
  purpose?: DevinPurpose | undefined;
  /** Per-dispatch budget ceiling, in Devin ACUs; overrides the manifest's `submit.max_acu`. */
  max_acu?: number | undefined;
}

/**
 * Send a task's brief to a target. `principal` is the SERVER-SIDE identity
 * the adapter derived from the credential (§4.19) — it is written to the
 * task's history, never read from the request. `sources` is the caller's
 * declared provenance for the brief (checked on top of the text scan).
 */
export async function dispatch(
  db: Db,
  registry: TargetRegistry,
  taskId: number,
  targetName: string,
  brief: string,
  principal: string,
  sources: string[] = [],
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  await registry.refresh(); // an agent connection edited since the last call is read as it is now
  const gone = registry.unavailableConnection(targetName);
  if (gone) {
    const check: CheckResult = { name: targetName, status: gone.status, latency_ms: 0, probe: "read the agent connection", remediation: gone.why };
    return { ok: false, code: "conflict", message: "target unavailable", check };
  }
  const target = registry.get(targetName);
  if (!target) return { ok: false, code: "not_found", message: "unknown target" };
  const agent = registry.connectionOf(target.name);
  if (!Number.isInteger(taskId) || taskId <= 0) return { ok: false, code: "not_found", message: "no such task" };

  const { rows } = await db.query(`SELECT id, title, status, external_ref FROM work WHERE id = $1`, [taskId]);
  const task = rows[0] as { id: string | number; title: string; status: string; external_ref: string | null } | undefined;
  if (!task) return { ok: false, code: "not_found", message: "no such task" };
  if (task.external_ref) return { ok: false, code: "conflict", message: `task already bound to ${task.external_ref}` };
  if (task.status === "closed") return { ok: false, code: "conflict", message: "task is closed" };

  // Refusals are runs rows too: the safety mechanism must be visible, not silent.
  // The purposes are the target's connection type's (plan §2.7, T4-11); a
  // target that takes none records `work`, as it always did.
  const purposeSet = await registry.purposesOf(target);
  const purpose: DevinPurpose = opts.purpose ?? purposeSet.default_purpose ?? DEFAULT_PURPOSE;
  const runId = await startRun(db, {
    component: "console",
    kind: "dispatch",
    tool: target.name,
    meta: { target: target.name, task: taskId, principal, purpose, brief_bytes: Buffer.byteLength(brief, "utf8"), ...(agent ? { connection: agent.connection } : {}) },
  });

  const violations = checkBrief(target.data_policy, brief, sources);
  if (violations.length > 0) {
    await finishRun(db, runId, { ok: false, error: `data_policy: ${violations.map((v) => v.kind).join(",")}`, meta: { violations } });
    return { ok: false, code: "invalid_request", message: "brief violates the target's data policy", violations };
  }

  const isDevin = TargetRegistry.isDevin(target);
  if (target.transport !== "github" && !isDevin) {
    await finishRun(db, runId, { ok: false, error: `transport ${target.transport} not dispatchable` });
    // a local target is a crew's: it is dispatched by the assistant's agents_delegate tool (apps/console/src/crews.ts), never by this route
    const message =
      target.transport === "local"
        ? `transport local is dispatched by the assistant's agents_delegate tool, not by this route (docs/ops/crews.md)`
        : `transport ${target.transport}${target.transport === "http" ? ` with submit.kind ${JSON.stringify(target.submit.kind ?? null)}` : ""} has no dispatcher in this console yet`;
    return { ok: false, code: "invalid_request", message };
  }

  if (!registry.available(target)) {
    const check = await registry.check(target.name); // degrades absent: the check carries the remediation
    await finishRun(db, runId, { ok: false, error: "target unavailable", meta: { check } });
    return { ok: false, code: "conflict", message: "target unavailable", check };
  }

  const takes = Object.keys(purposeSet.purposes);
  if (takes.length > 0 && !takes.includes(purpose)) {
    await finishRun(db, runId, { ok: false, error: `purpose ${purpose} is not one ${target.name} takes` });
    return { ok: false, code: "invalid_request", message: `purpose must be one of ${takes.join(" | ")} for ${target.name}` };
  }

  let submitted: { ref: string; url: string };
  let devinMeta: DevinWorkMeta | null = null;
  try {
    if (isDevin) {
      const session = await registry.submitDevin(target, { brief, title: task.title, taskId, purpose, maxAcu: opts.max_acu });
      submitted = { ref: session.ref, url: session.url };
      // Everything the poller needs, frozen onto the row: it must not have to
      // re-derive the organization from the environment to read an answer back.
      devinMeta = {
        session_id: session.session_id,
        org: session.org,
        url: session.url,
        max_acu: session.max_acu,
        purpose,
        target: target.name,
        dispatch_run_id: runId,
        // which connection's key polls it home (collectors/devin-sessions): a `targets/` dispatch names none
        ...(agent ? { connection: agent.connection } : {}),
      };
    } else {
      submitted = await registry.submitGithub(target, task.title, `${brief.trimEnd()}\n\n${returnFooter(taskId, target.name)}\n`);
    }
  } catch (err) {
    const secrets = agent ? { meta: { secrets: agent.secretsUsed() } } : {};
    await finishRun(db, runId, { ok: false, error: err instanceof Error ? err.message : String(err), ...secrets });
    // refused before anything was sent (a reference in the brief), or at the connection's door (a key not granted, a host not listed): the owner's to fix, said by name
    if (err instanceof DispatchRefused) return { ok: false, code: err.code, message: err.message };
    if (err instanceof EgressRefused || err instanceof ConnectionRefused) return { ok: false, code: "conflict", message: `target unavailable: ${err.message}` };
    return { ok: false, code: "internal", message: "target submission failed" };
  }

  // Bind the ref (github-state upserts onto this row from now on) and hold
  // the task for the target: claimed with no lease = held until the source
  // closes it (packages/tasks treats a NULL lease as never expiring).
  const entry = JSON.stringify([{ ts: new Date().toISOString(), agent: principal, op: "dispatch", note: `${target.name} → ${submitted.ref}` }]);
  let bound = 0;
  try {
    const upd = await db.query(
      `UPDATE work SET external_ref = $2, status = 'in_progress', claimed_by = $3, lease_expires_at = NULL,
         history = history || $4::jsonb, meta = meta || $5::jsonb, updated_at = now()
       WHERE id = $1 AND external_ref IS NULL RETURNING id`,
      [taskId, submitted.ref, `target:${target.name}`, entry, JSON.stringify(devinMeta ? { devin: devinMeta } : {})],
    );
    bound = upd.rows.length;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err; // unique_violation on external_ref: the ref landed elsewhere first
  }
  if (bound !== 1) {
    await finishRun(db, runId, { ok: false, error: "task changed during dispatch", meta: submitted });
    return { ok: false, code: "conflict", message: `task changed during dispatch; ${submitted.ref} was created` };
  }

  await finishRun(db, runId, {
    ok: true,
    ...(target.cost ? { cost_usd: target.cost.per_run_estimate_usd } : {}),
    // The ACU cap IS the budget for a Devin dispatch; the spend Devin
    // actually reports lands on this same row when the poller sees the
    // session finish (collectors/devin-sessions).
    meta: {
      ref: submitted.ref,
      url: submitted.url,
      ...(devinMeta ? { session_id: devinMeta.session_id, org: devinMeta.org, max_acu: devinMeta.max_acu } : {}),
      // the NAMES the connection's door filled (`secret_last_used` reads them) — never a value
      ...(agent ? { secrets: agent.secretsUsed() } : {}),
    },
  });
  return { ok: true, ...submitted, run_id: runId };
}
