// `metistry remote` — how the owner's phone reaches this Mac (plan §2.23,
// M20): the record, the verbs, and the one rule for changing provider.
//
//   remote [status] [--json]          the record, the origins it renders, the chooser, the doctor rows
//   remote set <provider> [flags]     preview; --yes configures, waits, writes, revokes the old
//   remote authorize <provider>       the provider's own browser sign-in
//   remote test [--json]              step 6 of the guided flow: the provider's state and "answers from this Mac"
//   remote off [--yes]                `set none`, with the old provider's revoke
//
// THE RECORD is the `remote:` block of `.metistry/deployment.yaml` — a §4.7
// protected path, written through the reconciler as `user` with
// preview-then-confirm, exactly as `deployment set-keep-awake` and `vault
// settings` write theirs. No credential is in it.
//
// SWITCHING configures the new provider first and revokes the old one only
// once the new origin answers from this Mac, so the phone is never left with
// nothing mid-change: configure → wait for `GET <origin>/health` → write the
// record → revoke the old. A configure that throws writes nothing; an origin
// that never answers writes nothing and revokes nothing — the old choice
// stays in force, and the message says so.
//
// A TOKEN never arrives in argv (the `secrets set` rule): `--token` is a
// switch meaning "read it from stdin", and a value given as an argument is
// refused without being repeated (stdin-value.ts).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { REMOTE_PROVIDERS, instanceFile, parseDeployment, remoteOf, type DeploymentShape, type RemoteProviderId, type RemoteRecord } from "@foldedspacelabs/metistry-core";
import { consoleOrigins, loadDeployment } from "../deployment.js";
import { realExec, type Exec } from "../exec.js";
import { readInstanceId } from "../instance.js";
import { checkOriginReachable } from "../origins.js";
import { protectedRel, writeProtected } from "../protected-write.js";
import { StepFailed, StepRunner } from "../steps.js";
import { defaultUi, statusName, type Ui } from "../ui.js";
import type { AuthorizeOptions, Detection, ProviderOptions, RemoteChoice, RemoteContext, RemoteProvider, RemoteRow, Revoked } from "./provider.js";
import { availableProviders, providerFor, remoteChoices, remoteContext, remoteRows, REMOTE_PROVIDERS_BUILT_IN, type RemoteRegistry } from "./rows.js";

export { REMOTE_PROVIDERS_BUILT_IN, availableProviders, classifyUpstream, droppedOriginsNote, mainPortRemediation, providerFor, proxySocketPath, remoteChoices, remoteContext, remoteRows, sharedRemoteRows, type RemoteRegistry } from "./rows.js";
export { none, NONE_ROW_INFO } from "./none.js";
export type { AuthorizeOptions, Configured, Detection, ProviderOptions, RemoteChoice, RemoteContext, RemoteProvider, RemoteRow, Revoked } from "./provider.js";

export const REMOTE_VERBS = ["status", "set", "authorize", "test", "off"] as const;
export type RemoteVerb = (typeof REMOTE_VERBS)[number];

/** `remote set <provider>` — one of the seven names, never a guess. */
export function parseRemoteProviderId(v: string | undefined): RemoteProviderId | undefined {
  return v !== undefined && (REMOTE_PROVIDERS as readonly string[]).includes(v) ? (v as RemoteProviderId) : undefined;
}

// ---- the record ------------------------------------------------------------------

export interface LoadedRemote {
  record: RemoteRecord;
  /** where the deployment came from (the D4 overlay's answer) */
  from: string;
  shape: DeploymentShape;
}

export async function loadRemote(productDir: string, env: NodeJS.ProcessEnv): Promise<LoadedRemote> {
  const loaded = await loadDeployment(productDir, env);
  return { record: remoteOf(loaded.deployment), from: loaded.from, shape: loaded.deployment.shape };
}

/** The block as YAML lines: the provider always; mode, origin and settings only when there are any — `none` is one line. */
export function renderRemoteBlock(r: RemoteRecord): string[] {
  const lines = ["remote:", `  provider: ${r.provider}`];
  if (r.mode !== undefined) lines.push(`  mode: ${r.mode}`);
  if (r.origin !== undefined) lines.push(`  origin: ${r.origin}`);
  const keys = Object.keys(r.settings).sort();
  if (keys.length > 0) {
    lines.push("  settings:");
    for (const k of keys) lines.push(`    ${k}: ${JSON.stringify(r.settings[k])}`);
  }
  return lines;
}

const REMOTE_HEADER = [
  "# remote — how your phone reaches this Mac (docs/ops/remote-access.md).",
  "# `metistry remote set <provider>` writes it; no credential is in this file.",
];

/**
 * Put the block into a deployment.yaml a person may also hand-edit: an
 * existing top-level `remote:` block is replaced in place (its key line and
 * every indented line under it); otherwise the block is appended. Every other
 * line — comments, `shape:`, `keep_awake:`, `vault:`, `services:` — is left
 * byte for byte. Creating the file from nothing needs the shape as well, and
 * the caller passes the shape ALREADY IN EFFECT (`vault.ts` says why).
 */
export function applyRemoteToYaml(existing: string | undefined, r: RemoteRecord, shape: DeploymentShape): string {
  const block = renderRemoteBlock(r);
  if (existing === undefined) {
    return [
      "# deployment.yaml — this instance's deployment shape and remote access",
      "# (docs/ops/deployment-shapes.md).",
      "# `metistry remote set` wrote this file. The shape below is the one this",
      "# install already had; change it with `metistry deployment set-shape`.",
      `shape: ${shape}`,
      "",
      ...REMOTE_HEADER,
      ...block,
      "",
      "services: {}",
      "",
    ].join("\n");
  }
  const lines = existing.split("\n");
  const at = lines.findIndex((l) => /^remote:/.test(l));
  if (at !== -1) {
    let end = at + 1;
    for (let j = at + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^[ \t]+\S/.test(l)) end = j + 1; // indented: still the block
      else if (l.trim() === "") continue; // a blank line: the block only if more indented lines follow
      else break;
    }
    return [...lines.slice(0, at), ...block, ...lines.slice(end)].join("\n");
  }
  const body = existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`;
  return `${body}${body === "" ? "" : "\n"}${[...REMOTE_HEADER, ...block].join("\n")}\n`;
}

// ---- the verbs' common ground --------------------------------------------------------

export interface RemoteVerbOptions {
  productDir: string;
  instanceDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  exec?: Exec | undefined;
  out: (line: string) => void;
  /** test seam: the adapters (default the ones this release ships) */
  providers?: RemoteRegistry | undefined;
  /** test seam: a pasted token (default stdin or the hidden prompt) */
  readToken?: ((what: string) => Promise<string>) | undefined;
  /** how long one probe may take (default 5 s) */
  timeoutMs?: number | undefined;
}

/** The record with its settings in one order, for a byte comparison — the file writes them sorted, zod reads them as written. */
function canonical(r: RemoteRecord): string {
  return JSON.stringify({ provider: r.provider, mode: r.mode ?? null, origin: r.origin ?? null, settings: Object.fromEntries(Object.entries(r.settings).sort(([a], [b]) => a.localeCompare(b))) });
}

function describe(r: RemoteRecord): string {
  return `${r.provider}${r.mode ? ` (${r.mode})` : ""}${r.origin ? ` → ${r.origin}` : ""}`;
}

async function contextFor(o: RemoteVerbOptions, record: RemoteRecord, extra: { dryRun?: boolean; note?: (line: string) => void } = {}): Promise<RemoteContext> {
  const instanceId = await readInstanceId(o.instanceDir).catch(() => undefined);
  return remoteContext({
    productDir: o.productDir,
    instanceDir: o.instanceDir,
    env: o.env,
    record,
    instanceId,
    exec: o.exec,
    fetchFn: o.fetchFn,
    platform: o.platform,
    uid: o.uid,
    readToken: o.readToken,
    note: extra.note,
    dryRun: extra.dryRun,
    timeoutMs: o.timeoutMs,
  });
}

/** The refusal for a provider this release cannot run — the ones it can, named. */
export function notAvailableMessage(id: RemoteProviderId, registry: RemoteRegistry): string {
  const have = availableProviders(registry);
  return `${id} isn't available in this version of Metistry — \`metistry update\` may bring it; the choices here today: ${have.join(", ")} (docs/ops/remote-access.md)`;
}

// ---- status ---------------------------------------------------------------------------

export interface RemoteStatus {
  provider: RemoteProviderId;
  mode: string | null;
  origin: string | null;
  settings: Record<string, string>;
  /** where the record was read from */
  from: string;
  /** `METISTRY_ORIGIN` as the console runs with it, derived from the record (origins.ts) */
  origins: string[];
  /** `.env` entries the renderer leaves behind */
  dropped_origins: string[];
  /** the ids this release has an adapter for */
  available: RemoteProviderId[];
  choices: RemoteChoice[];
  rows: RemoteRow[];
  ok: boolean;
}

/** `metistry remote [status]` — the pane's status: the record, the origins, the chooser and doctor's `remote` rows. */
export async function remoteStatus(o: RemoteVerbOptions): Promise<RemoteStatus> {
  const loaded = await loadDeployment(o.productDir, o.env);
  const record = remoteOf(loaded.deployment);
  const registry = o.providers ?? REMOTE_PROVIDERS_BUILT_IN;
  const origins = consoleOrigins({ env: o.env, remote: record });
  const rows = await remoteRows({ deployment: loaded.deployment, productDir: o.productDir, instanceDir: o.instanceDir, env: o.env, fetchFn: o.fetchFn, exec: o.exec, platform: o.platform, uid: o.uid, timeoutMs: o.timeoutMs, providers: registry });
  return {
    provider: record.provider,
    mode: record.mode ?? null,
    origin: record.origin ?? null,
    settings: record.settings,
    from: loaded.from,
    origins: origins.value ? origins.value.split(",") : [],
    dropped_origins: origins.dropped,
    available: availableProviders(registry),
    choices: remoteChoices(registry),
    rows,
    ok: !rows.some((r) => r.status === "failed"),
  };
}

export function renderRemoteStatus(s: RemoteStatus, ui: Ui = defaultUi()): string {
  const out: string[] = [];
  const choice = s.choices.find((c) => c.id === s.provider);
  out.push(ui.kv([
    ["remote access", `${choice?.label ?? s.provider}${s.mode ? ` (${s.mode})` : ""}  ${ui.dim(`(from ${s.from})`)}`],
    ["origin", s.origin ?? ui.dim("none — your phone can't reach this Mac")],
    ["METISTRY_ORIGIN", s.origins.length ? s.origins.join(", ") : ui.dim("not set")],
  ]));
  if (s.dropped_origins.length) out.push(ui.dim(`   .env also names ${s.dropped_origins.join(", ")} — not carried; \`metistry remote set <provider>\` is how a remote origin is configured`));
  out.push("");
  for (const r of s.rows) {
    const info = typeof r.meta?.["info"] === "string" ? (r.meta["info"] as string) : "";
    const detail = r.status === "ok" ? info : (r.remediation ?? r.probe);
    out.push(`  ${ui.statusIcon(r.status)} ${r.name}  ${ui.paint(statusName(r.status), r.status)}`);
    if (detail) out.push(ui.dim(`      ${ui.icon("arrow")} ${detail}`));
  }
  out.push("");
  out.push(ui.dim("Choices, in order — `metistry remote set <provider>`:"));
  for (const c of s.choices) {
    const tag = c.tag === "default" ? " (default)" : c.tag === "recommended" ? " (recommended)" : "";
    const avail = c.available ? "" : ui.dim("  — not in this version yet");
    out.push(`  ${c.id === s.provider ? ui.icon("on") : ui.icon("off")} ${c.id.padEnd(13)} ${c.label}${tag}${avail}`);
    out.push(ui.dim(`      needs ${c.needs}; reachable from ${c.reachable_from}; TLS ends at ${c.tls_ends_at}; ${c.cost}`));
  }
  return out.join("\n");
}

// ---- set / off ----------------------------------------------------------------------------

export interface RemoteSetOptions extends RemoteVerbOptions {
  provider: RemoteProviderId;
  options: ProviderOptions;
  /** without it nothing is configured, written or revoked — the preview is the whole command */
  yes?: boolean | undefined;
  /** how long the new origin has to answer from this Mac before the change is called off (default 2 minutes) */
  waitMs?: number | undefined;
  /** test seams for the wait */
  pollMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

export interface RemoteSetResult {
  from: RemoteProviderId;
  provider: RemoteProviderId;
  origin: string | null;
  applied: boolean;
  detail: string;
  /** the old provider's revoke, when one ran (or would run) */
  revoked?: Revoked | undefined;
  /** what `detect` found on the new provider */
  detection: Detection;
}

/** Said BEFORE anything changes: a passkey is bound to the host it was created on (plan §2.23, "How the origin flows"). */
export function strandingNote(oldOrigin: string, newOrigin: string | null): string {
  const to = newOrigin ? `${newOrigin}` : "no origin at all";
  return `phones added under ${oldOrigin} stop working once this changes to ${to}: a passkey is bound to the host it was created on. Add each phone again afterwards; Devices marks the ones to remove.`;
}

export const REMOTE_WAIT_DEFAULT_MS = 120_000; // limit: default — how long `remote set` waits for a new origin to answer from this Mac before calling the change off; `--timeout <s>` moves it
export const REMOTE_POLL_MS = 5_000; // limit: fixed — one probe every five seconds while waiting; a tunnel coming up is seconds, public DNS is minutes

/**
 * Wait until `GET <origin>/health` answers from this Mac and names this
 * instance, probing every `pollMs` until `waitMs` has passed. Returns the last
 * refusal when it never does.
 */
export async function waitForOrigin(origin: string, ctx: RemoteContext, o: { waitMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<{ answered: boolean; detail?: string }> {
  const url = new URL(origin);
  const deadline = o.now() + o.waitMs;
  let last: string | undefined;
  for (;;) {
    const refusal = await checkOriginReachable(url, { fetchFn: ctx.fetchFn, instanceId: ctx.instanceId, provider: ctx.record.provider, timeoutMs: ctx.timeoutMs });
    if (!refusal) return { answered: true };
    last = refusal.detail ?? refusal.message;
    if (o.now() >= deadline) return { answered: false, ...(last ? { detail: last } : {}) };
    await o.sleep(o.pollMs);
  }
}

/**
 * `metistry remote set <provider> [flags] [--yes]` — and `remote off`, which
 * is `set none`. Preview without `--yes`; with it: configure the new provider,
 * wait for its origin to answer from this Mac, write the record, then revoke
 * the old provider. Nothing is written when configure fails or the origin
 * never answers.
 */
export async function remoteSet(o: RemoteSetOptions): Promise<RemoteSetResult> {
  const registry = o.providers ?? REMOTE_PROVIDERS_BUILT_IN;
  const target = providerFor(o.provider, registry);
  if (!target) throw new StepFailed(notAvailableMessage(o.provider, registry), 2);
  const exec = o.exec ?? realExec;
  const r = new StepRunner({ dryRun: o.yes !== true, out: o.out, exec, env: o.env });
  const loaded = await loadRemote(o.productDir, o.env);
  const current = loaded.record;
  const old = providerFor(current.provider, registry);
  const switching = current.provider !== o.provider;

  // what the new provider sees, read-only, and what it would change
  const detectCtx = await contextFor(o, current, { dryRun: true, note: (l) => r.note(l) });
  const detection = await target.detect(detectCtx);
  r.note(`remote access: ${describe(current)} → ${o.provider}${o.options.mode ? ` (${o.options.mode})` : ""}`);
  const toolFrom = detection.tool.from === "pack" ? ", Metistry's pack" : detection.tool.from === "owner" ? ", your own install" : "";
  const toolVersion = detection.tool.version ? ` (${detection.tool.version}${toolFrom})` : "";
  const signedIn = detection.signed_in === null ? "" : detection.signed_in ? ", signed in" : ", not signed in";
  const toolLine = target.id === "none" ? "nothing to install" : detection.tool.present ? `tool present${toolVersion}${signedIn}` : "tool not here — configure fetches it";
  r.note(`${target.label}: ${toolLine}`);
  for (const line of detection.would_change) r.note(`would change: ${line}`);
  if (current.provider === o.provider && o.provider === "none") {
    const detail = "already none — nothing exposed, nothing to change";
    r.note(detail);
    return { from: current.provider, provider: o.provider, origin: null, applied: false, detail, detection };
  }

  // the informed half of informed consent: said before anything changes
  if (current.origin && switching) r.note(strandingNote(current.origin, detection.origin ?? null));
  if (switching && current.provider !== "none") {
    if (old) {
      const wouldRevoke = await old.revoke(await contextFor(o, current, { dryRun: true, note: (l) => r.note(l) }));
      for (const u of wouldRevoke.undone) r.note(`then undo at ${current.provider}: ${u}`);
      for (const l of wouldRevoke.left_for_owner) r.note(`left for you at ${current.provider}: ${l}`);
    } else {
      r.note(`${current.provider} has no adapter in this version, so what it set up is left for you to undo at the provider`);
    }
  }
  if (r.dryRun) {
    const steps = [
      `configure ${o.provider}`,
      ...(target.id === "none" ? [] : ["wait for its origin to answer from this Mac"]),
      `write remote: ${o.provider} to ${instanceFile(o.instanceDir, "deployment")} (through the reconciler as user)`,
      ...(switching && current.provider !== "none" ? [`revoke ${current.provider}`] : []),
    ];
    r.note(`would: ${steps.join("; ")}`);
    return { from: current.provider, provider: o.provider, origin: detection.origin ?? null, applied: false, detail: "preview only — nothing configured, written or revoked", detection };
  }

  // 1. configure the NEW provider; a throw changes nothing here
  const ctx = await contextFor(o, current, { dryRun: false, note: (l) => r.note(l) });
  let configured;
  try {
    configured = await target.configure(ctx, o.options);
  } catch (err) {
    throw new StepFailed(`${o.provider} could not be set up (${err instanceof Error ? err.message : String(err)}) — nothing was written and ${current.provider === "none" ? "remote access is still none" : `${current.provider} is still in place`}`);
  }
  const next: RemoteRecord = {
    provider: o.provider,
    ...(configured.mode !== undefined ? { mode: configured.mode } : {}),
    ...(configured.origin !== null ? { origin: configured.origin } : {}),
    settings: configured.settings,
  };

  // 2. the new origin must answer from this Mac before anything is given up
  if (configured.origin !== null) {
    const waitMs = o.waitMs ?? REMOTE_WAIT_DEFAULT_MS;
    r.note(`waiting for ${configured.origin} to answer from this Mac (up to ${Math.round(waitMs / 1000)} s)…`);
    const wait = await waitForOrigin(configured.origin, { ...ctx, record: next }, { waitMs, pollMs: o.pollMs ?? REMOTE_POLL_MS, sleep: o.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))), now: o.now ?? Date.now });
    if (!wait.answered) {
      throw new StepFailed(
        `${configured.origin} hasn't answered from this Mac within ${Math.round(waitMs / 1000)} s${wait.detail ? ` (${wait.detail})` : ""} — nothing was written and ${current.provider === "none" ? "remote access is still none" : `${current.provider} is still in place`}. Run \`metistry remote set ${o.provider}\` again once it is up (configure is idempotent), or \`--timeout <seconds>\` to wait longer.`,
      );
    }
    r.note(`${configured.origin} answers from this Mac`);
  }

  // 3. the record — a §4.7 protected write, preview-then-confirm (confirmed by --yes)
  const path = instanceFile(o.instanceDir, "deployment");
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const content = applyRemoteToYaml(existing, next, loaded.shape);
  const check = parseDeployment(parseYaml(content), path).remote;
  if (check === undefined || canonical(check) !== canonical(next)) throw new Error(`internal: the rewritten ${path} does not read back as remote: ${describe(next)}`);
  const delivery = await writeProtected(r, protectedRel(o.instanceDir, "deployment"), content, `metistry remote set → ${describe(next)}`, { env: o.env, platform: o.platform, uid: o.uid, fetchFn: o.fetchFn, instanceDir: o.instanceDir });

  // 4. only now: the old provider is undone
  let revoked: Revoked | undefined;
  if (switching && current.provider !== "none") {
    if (old) {
      try {
        revoked = await old.revoke(await contextFor(o, current, { dryRun: false, note: (l) => r.note(l) }));
        for (const u of revoked.undone) r.note(`undone at ${current.provider}: ${u}`);
        for (const l of revoked.left_for_owner) r.note(`left for you at ${current.provider}: ${l}`);
      } catch (err) {
        r.note(`${current.provider} could not be revoked (${err instanceof Error ? err.message : String(err)}) — ${o.provider} is recorded and in place; undo ${current.provider} by hand at the provider`);
      }
    } else {
      r.note(`${current.provider} has no adapter in this version — what it set up is left for you to undo at the provider`);
    }
  }
  r.note(`it takes effect at \`metistry up\`, which renders METISTRY_ORIGIN from the record${next.origin ? ` (${next.origin} first, the loopback origin second)` : " (the loopback origin alone)"} and restarts the console`);
  return { from: current.provider, provider: o.provider, origin: next.origin ?? null, applied: delivery.how !== "none", detail: delivery.detail, revoked, detection };
}

// ---- test -----------------------------------------------------------------------------------

export interface RemoteTestResult {
  provider: RemoteProviderId;
  origin: string | null;
  rows: RemoteRow[];
  ok: boolean;
}

/** `metistry remote test` — step 6 of the guided flow: the provider's own state, then `GET <origin>/health` from this Mac naming this instance. With None there is nothing to test, and the one row says so. */
export async function remoteTest(o: RemoteVerbOptions): Promise<RemoteTestResult> {
  const loaded = await loadDeployment(o.productDir, o.env);
  const record = remoteOf(loaded.deployment);
  const rows = await remoteRows({ deployment: loaded.deployment, productDir: o.productDir, instanceDir: o.instanceDir, env: o.env, fetchFn: o.fetchFn, exec: o.exec, platform: o.platform, uid: o.uid, timeoutMs: o.timeoutMs, providers: o.providers });
  return { provider: record.provider, origin: record.origin ?? null, rows, ok: !rows.some((r) => r.status === "failed") };
}

export function renderRemoteRows(rows: RemoteRow[], ui: Ui = defaultUi()): string {
  const out: string[] = [];
  for (const r of rows) {
    const info = typeof r.meta?.["info"] === "string" ? (r.meta["info"] as string) : "";
    const detail = r.status === "ok" ? info : (r.remediation ?? r.probe);
    out.push(`  ${ui.statusIcon(r.status)} ${r.name}  ${ui.paint(statusName(r.status), r.status)}  ${ui.dim(`${r.latency_ms}ms`)}`.trimEnd());
    if (detail) out.push(ui.dim(`      ${ui.icon("arrow")} ${detail}`));
  }
  return out.join("\n");
}

// ---- authorize ---------------------------------------------------------------------------------

export interface RemoteAuthorizeOptions extends RemoteVerbOptions {
  provider: RemoteProviderId;
  authorize: AuthorizeOptions;
}

/** `metistry remote authorize <provider>` — the provider's own browser sign-in, where it has one. */
export async function remoteAuthorize(o: RemoteAuthorizeOptions): Promise<{ provider: RemoteProviderId; signed_in: boolean; detail: string }> {
  const registry = o.providers ?? REMOTE_PROVIDERS_BUILT_IN;
  const target = providerFor(o.provider, registry);
  if (!target) throw new StepFailed(notAvailableMessage(o.provider, registry), 2);
  if (!target.authorize) throw new StepFailed(`${o.provider} has no sign-in of its own${o.provider === "none" ? " — none exposes nothing and needs no account" : ` — \`metistry remote set ${o.provider}\` takes what it needs`}`, 2);
  const loaded = await loadRemote(o.productDir, o.env);
  const ctx = await contextFor(o, loaded.record, { dryRun: false, note: (l) => o.out(defaultUi().dim(`   ${l}`)) });
  const r = await target.authorize(ctx, o.authorize);
  return { provider: o.provider, ...r };
}
