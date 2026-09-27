// `metistry vault settings` (design-build-plan §2.2 M18, §2.21, T10-2): the
// vault's git sync policy — when the reconciler pushes to the instance repo's
// remote and pulls from it. The policy is the `vault:` block of
// `.metistry/deployment.yaml`; core owns its schema (vault-sync.ts), this file
// owns reading it for a person and writing it back.
//
// The write is the same §4.7 protected write as every other deployment.yaml
// change (`writeProtected`: through the reconciler as `user` with the owner
// bearer). No route can make it — history and the remote are the owner's
// hand. The reconciler re-reads the file when it changes, so a new policy is
// in force within one scheduler tick, with no restart.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  DEPLOYMENT_FILENAME,
  PUSH_SCHEDULE_ENV,
  describeVaultSync,
  instanceFile,
  overlayVaultSync,
  parseDeployment,
  pushOverrideNote,
  resolveVaultSync,
  type DeploymentShape,
  type ResolvedVaultSync,
  type VaultPull,
  type VaultPush,
  type VaultSyncBlock,
  type VaultSyncPolicy,
} from "@foldedspacelabs/metistry-core";
import { consoleTarget } from "./console-client.js";
import { deploymentPaths, loadDeployment } from "./deployment.js";
import { hostLocal } from "./doctor.js";
import { realExec, type Exec } from "./exec.js";
import { OWNER_BRIDGE_TOKEN, protectedRel, writeProtected } from "./protected-write.js";
import { StepRunner } from "./steps.js";

export const VAULT_VERBS = ["settings", "rollback"] as const;

export interface VaultSettings {
  /** The policy in force: the block over the defaults, then the old variable over `push`. */
  policy: ResolvedVaultSync;
  /** Where each key's answer came from: the instance's file, the product's seed, or the default. */
  from: { push: string; pull: string };
  /** The instance's deployment.yaml — the file `--yes` writes. */
  file?: string | undefined;
}

async function readParsed(path: string | undefined, label: string): Promise<VaultSyncBlock | undefined> {
  if (!path || !existsSync(path)) return undefined;
  return parseDeployment(parseYaml(await readFile(path, "utf8")), label).vault;
}

/** The policy as the reconciler will read it — the same overlay, the same override. */
export async function loadVaultSettings(productDir: string, env: NodeJS.ProcessEnv): Promise<VaultSettings> {
  const paths = deploymentPaths(productDir, env);
  const seed = await readParsed(paths.seed, `seed/${DEPLOYMENT_FILENAME}`);
  const inst = await readParsed(paths.instance, paths.instance ?? DEPLOYMENT_FILENAME);
  const block = overlayVaultSync(seed, inst);
  const fromOf = (k: keyof VaultSyncBlock) => (inst?.[k] !== undefined ? paths.instance! : seed?.[k] !== undefined ? `seed/${DEPLOYMENT_FILENAME}` : "the default");
  const policy = resolveVaultSync(block, env);
  return {
    policy,
    from: { push: policy.push_override !== undefined ? `${PUSH_SCHEDULE_ENV} (overriding ${fromOf("push")})` : fromOf("push"), pull: fromOf("pull") },
    ...(paths.instance ? { file: paths.instance } : {}),
  };
}

function pushWords(p: VaultPush): string {
  return typeof p === "object" ? `every ${p.every}` : p;
}

export function renderVaultSettings(s: VaultSettings): string {
  const lines = [
    "vault sync (deployment.yaml, M18):",
    `  push  ${pushWords(s.policy.push).padEnd(14)} from ${s.from.push}`,
    `  pull  ${`every ${s.policy.pull.every}`.padEnd(14)} from ${s.from.pull}`,
  ];
  if (s.policy.push_override !== undefined) lines.push("", pushOverrideNote(s.policy.push_override));
  lines.push("", "Change it: metistry vault settings --push <after_commit|manual|15m> --pull <5m> --yes");
  return lines.join("\n");
}

// ---- the file ------------------------------------------------------------------

/** The block as YAML lines — both keys, always: the file states the policy rather than leaning on a default. */
export function renderVaultBlock(v: VaultSyncPolicy): string[] {
  return [
    "vault:",
    ...(typeof v.push === "object" ? ["  push:", `    every: ${v.push.every}`] : [`  push: ${v.push}`]),
    "  pull:",
    `    every: ${v.pull.every}`,
  ];
}

const VAULT_HEADER = [
  "# vault — when the reconciler pushes the instance repo to its remote and",
  "# pulls from it (docs/ops/reconciler.md). `metistry vault settings` writes it.",
];

/**
 * Put the block into a deployment.yaml a person may also hand-edit: an
 * existing top-level `vault:` block is replaced in place (its key line and
 * every indented line under it); otherwise the block is appended. Every
 * other line — comments, `shape:`, `keep_awake:`, `services:` — is left
 * byte for byte.
 *
 * Creating the file from nothing needs the shape as well, and it is the
 * caller's job to pass the shape ALREADY IN EFFECT (the D4 overlay's answer):
 * a deployment.yaml carrying only `vault` would parse with `shape` defaulted
 * to compose and silently move a launchd install.
 */
export function applyVaultToYaml(existing: string | undefined, v: VaultSyncPolicy, shape: DeploymentShape): string {
  const block = renderVaultBlock(v);
  if (existing === undefined) {
    return [
      "# deployment.yaml — this instance's deployment shape and sync policy",
      "# (docs/ops/deployment-shapes.md).",
      "# `metistry vault settings` wrote this file. The shape below is the one this",
      "# install already had; change it with `metistry deployment set-shape`.",
      `shape: ${shape}`,
      "",
      ...VAULT_HEADER,
      ...block,
      "",
      "services: {}",
      "",
    ].join("\n");
  }
  const lines = existing.split("\n");
  const at = lines.findIndex((l) => /^vault:/.test(l));
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
  return `${body}${body === "" ? "" : "\n"}${[...VAULT_HEADER, ...block].join("\n")}\n`;
}

// ---- the verb --------------------------------------------------------------------

export interface SetVaultOptions {
  productDir: string;
  instanceDir: string;
  push?: VaultPush | undefined;
  pull?: VaultPull | undefined;
  yes?: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn: typeof fetch;
  exec?: Exec;
  out: (line: string) => void;
}

export interface SetVaultResult {
  policy: VaultSyncPolicy;
  applied: boolean;
  detail: string;
}

/**
 * Preview without `--yes`, write with it. The new block is the policy in
 * force with the named keys changed — so `--pull 10m` alone keeps whatever
 * push the owner already had, and the file ends up stating both.
 */
export async function setVaultSettings(opts: SetVaultOptions): Promise<SetVaultResult> {
  const r = new StepRunner({ dryRun: opts.yes !== true, out: opts.out, exec: opts.exec ?? realExec, env: opts.env });
  // the file's answer, not the variable's: writing the override's value into
  // the file would make a deprecated setting permanent behind the owner's back
  const fileEnv = { ...opts.env, [PUSH_SCHEDULE_ENV]: undefined };
  const current = await loadVaultSettings(opts.productDir, fileEnv);
  const next: VaultSyncPolicy = { push: opts.push ?? current.policy.push, pull: opts.pull ?? current.policy.pull };
  const words = describeVaultSync(next);
  const override = opts.env[PUSH_SCHEDULE_ENV]?.trim();

  const path = instanceFile(opts.instanceDir, "deployment");
  const existing = existsSync(path) ? await readFile(path, "utf8") : undefined;
  const alreadyWritten = existing !== undefined && current.from.push === path && current.from.pull === path;
  if (alreadyWritten && describeVaultSync(current.policy) === words) {
    const detail = `already ${words} (from ${path}) — nothing to change`;
    r.note(detail);
    if (override) r.note(pushOverrideNote(override));
    return { policy: next, applied: false, detail };
  }

  const shape = (await loadDeployment(opts.productDir, opts.env)).deployment.shape;
  const content = applyVaultToYaml(existing, next, shape);
  // what is written must be what the reconciler will accept — checked here,
  // before anything leaves this process
  const check = parseDeployment(parseYaml(content), path).vault;
  if (JSON.stringify(check) !== JSON.stringify(next)) throw new Error(`internal: the rewritten ${path} does not read back as ${words}`);

  r.note(`vault sync: ${words}`);
  if (override) r.note(`${pushOverrideNote(override)} Until then push stays ${pushWords(resolveVaultSync(next, opts.env).push)}.`);
  const delivery = await writeProtected(r, protectedRel(opts.instanceDir, "deployment"), content, `metistry vault settings → ${words}`, {
    env: opts.env,
    platform: opts.platform,
    uid: opts.uid,
    fetchFn: opts.fetchFn,
    instanceDir: opts.instanceDir,
  });
  r.note("the reconciler re-reads deployment.yaml when it changes: the new policy is in force within a few seconds, no restart");
  return { policy: next, applied: !r.dryRun && delivery.how !== "none", detail: delivery.detail };
}

// ---- `metistry vault rollback` (M18, §2.21, T10-6) ----------------------------------
//
// A rollback is never made here on the owner's say-so alone: every one waits
// for Approve in Needs You. This verb asks the console (`POST
// /api/vault/rollback`, reach `local` — the local owner token this Mac holds)
// to preview it and raise the request, and prints the preview.
//
// Without `--include-config` that is all it does: the console's Approve runs
// the revert, and the console's bearer can never change configuration — every
// `.metistry/` path, `CLAUDE.md` and `README.md` is left as it is and named.
//
// With `--include-config` the request says so, and Approve on the console
// reverts nothing: THIS process waits for the answer and, on Approve, runs the
// reconciler's `POST /vault/revert` itself with the owner-class bearer
// (`METISTRY_BRIDGE_TOKEN_RECONCILER_USER`) — the same protected-write door
// as every other configuration change — pinned to the previewed history and
// held to the previewed change set. `--request <id>` picks up a request whose
// wait ended before its answer came.

/** What to roll back: one commit, the vault to a moment, or one file (before its last change, or to a moment). */
export type VaultRollbackTarget = { commit: string } | { to: string } | { file: string; to?: string };

const DAY_ARG = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `--to 2026-09-26` means the vault as that day LEFT it on this Mac's clock:
 * sent as the end of the day with this machine's offset, so a reconciler in a
 * UTC container reads the same moment the owner meant. A full timestamp is
 * sent as given.
 */
export function momentArg(v: string): string {
  if (!DAY_ARG.test(v)) return v;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const end = new Date(y, m - 1, d, 23, 59, 59);
  if (end.getFullYear() !== y || end.getMonth() !== m - 1 || end.getDate() !== d) return v; // not a calendar day: the console refuses it by name
  const off = -end.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${v}T23:59:59${sign}${hh}:${mm}`;
}

export interface VaultRollbackOptions {
  /** absent with `request` */
  target?: VaultRollbackTarget | undefined;
  includeConfig: boolean;
  /** resume an --include-config request by its id */
  request?: string | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  instanceDir?: string | undefined;
  instanceId?: string | undefined;
  fetchFn: typeof fetch;
  exec?: Exec | undefined;
  out: (line: string) => void;
  /** how long an --include-config rollback waits for its answer (default 30 minutes) */
  waitMs?: number | undefined;
  pollMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface VaultRollbackResult {
  proposal_id: string;
  /** `waiting`: in Needs You; `rolled_back`: this process made the commit; `declined`/`answered`: the owner said otherwise; `timed_out`: still waiting. */
  state: "waiting" | "rolled_back" | "declined" | "answered" | "timed_out";
  preview?: Record<string, unknown>;
  sha?: string;
}

interface ProposalRow {
  id: string;
  ts: string;
  kind: string;
  source_agent: string;
  decision: string;
  payload: Record<string, unknown>;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}
function why(body: Record<string, unknown>, status: number): string {
  const e = body.error as { code?: string; message?: string } | undefined;
  return e ? `${e.code ?? status}: ${e.message ?? ""}`.trim() : `HTTP ${status}`;
}

/** The preview, as the owner reads it in a terminal. */
export function renderRollbackPreview(p: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const commits = (p.commits as Array<{ sha: string; subject: string; author: string; date: string }> | undefined) ?? [];
  const count = Number(p.revert_count ?? commits.length);
  lines.push(`undoes ${count} commit${count === 1 ? "" : "s"}:`);
  for (const c of commits.slice(0, 20)) lines.push(`  ${c.sha.slice(0, 7)} ${c.subject} — ${c.author}, ${c.date.slice(0, 10)}`);
  if (count > Math.min(commits.length, 20)) lines.push(`  … and ${count - Math.min(commits.length, 20)} more`);
  const changes = (p.changes as Array<{ path: string; change: string }> | undefined) ?? ((p.files as string[] | undefined) ?? []).map((path) => ({ path, change: "modified" }));
  const config = new Set((p.config as string[] | undefined) ?? []);
  lines.push(`puts back ${changes.length} file${changes.length === 1 ? "" : "s"}:`);
  for (const f of changes) lines.push(`  ${f.change.padEnd(8)} ${f.path}${config.has(f.path) ? "   (configuration)" : ""}`);
  const skipped = (p.skipped_config as string[] | undefined) ?? [];
  if (skipped.length) lines.push(`leaves configuration as it is: ${skipped.join(", ")}${p.include_config ? "" : "  (--include-config changes it too)"}`);
  return lines;
}

/**
 * Find one request by id through `GET /api/proposals?since=` — the changes
 * feed, which carries answered rows too. `ts` narrows where it starts.
 */
async function findProposal(base: string, token: string, fetchFn: typeof fetch, id: string, ts?: string): Promise<ProposalRow | null> {
  let since = `${ts ?? "1970-01-01T00:00:00Z"}|${Math.max(0, Number(id) - 1)}`;
  for (let page = 0; page < 1000; page++) {
    const res = await fetchFn(`${base}/api/proposals?since=${encodeURIComponent(since)}&limit=200`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const body = await jsonOf(res);
    if (!res.ok) throw new Error(`the console refused to list requests (${why(body, res.status)})`);
    const hit = ((body.proposals as ProposalRow[] | undefined) ?? []).find((r) => String(r.id) === String(id));
    if (hit) return hit;
    if (body.more !== true || typeof body.cursor !== "string") return null;
    since = body.cursor;
  }
  return null;
}

/** The rollback an --include-config request carries, checked as the console's own `rollbackOf` checks it (the reconciler decides again). */
function cliRollbackOf(row: ProposalRow): { target: VaultRollbackTarget; head: string; files: string[]; reverts: string[]; skipped_config: string[] } | null {
  if (row.kind !== "improvement" || row.source_agent !== "console") return null;
  const r = row.payload?.rollback as Record<string, unknown> | undefined;
  if (!r || r.include_config !== true || typeof r.head !== "string" || !/^[0-9a-f]{40,64}$/.test(r.head)) return null;
  const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!strs(r.files) || !strs(r.reverts) || !strs(r.skipped_config) || typeof r.target !== "object" || r.target === null) return null;
  return { target: r.target as VaultRollbackTarget, head: r.head, files: r.files, reverts: r.reverts, skipped_config: r.skipped_config };
}

export async function rollbackVault(opts: VaultRollbackOptions): Promise<VaultRollbackResult> {
  const target = await consoleTarget({ env: opts.env, instanceDir: opts.instanceDir, instanceId: opts.instanceId, exec: opts.exec, platform: opts.platform });
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let id: string;
  let ts: string | undefined;
  let preview: Record<string, unknown> | undefined;

  if (opts.request === undefined) {
    if (!opts.target) throw new Error("name what to roll back: <commit> | --to <date> | --file <path> [--to <date>]");
    const body = { ...opts.target, ...("to" in opts.target && opts.target.to ? { to: momentArg(opts.target.to) } : {}), ...(opts.includeConfig ? { include_config: true } : {}) };
    let res: Response;
    try {
      res = await opts.fetchFn(`${target.url}/api/vault/rollback`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw new Error(`console unreachable at ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const answer = await jsonOf(res);
    if (res.status !== 202) throw new Error(`the console did not raise the rollback (${why(answer, res.status)}) — nothing was changed`);
    id = String(answer.proposal_id);
    preview = (answer.preview ?? {}) as Record<string, unknown>;
    ts = typeof (answer.proposal as { ts?: unknown } | undefined)?.ts === "string" ? ((answer.proposal as { ts: string }).ts) : undefined;
    opts.out(`${answer.raised === false ? "already waiting" : "raised"} in Needs You as request #${id}:`);
    for (const l of renderRollbackPreview(preview)) opts.out(`  ${l}`);
    if (!opts.includeConfig) {
      opts.out("Nothing has changed yet. Approve it in Needs You (the app, or the phone) and the reconciler makes one new commit, as you — undo is rolling back that commit.");
      return { proposal_id: id, state: "waiting", preview };
    }
  } else {
    if (!/^\d{1,12}$/.test(opts.request)) throw new Error("--request takes the request's number, as this verb printed it");
    id = opts.request;
  }

  // --include-config: wait for the owner's answer, then carry it out as the owner class.
  const reconcilerUrl = opts.env.METISTRY_RECONCILER_URL;
  const ownerToken = opts.env[OWNER_BRIDGE_TOKEN];
  if (!reconcilerUrl || !ownerToken) {
    throw new Error(`reverting configuration needs the reconciler's owner-class bearer: METISTRY_RECONCILER_URL and ${OWNER_BRIDGE_TOKEN} (\`metistry secrets sync --to env\`) — request #${id} stays in Needs You; rerun with --request ${id} once they are set`);
  }
  opts.out(`waiting for your answer in Needs You (request #${id}) — Approve there, and this terminal makes the change as your own hand; Ctrl-C stops waiting (resume with --request ${id})`);
  const deadline = Date.now() + (opts.waitMs ?? 30 * 60_000);
  let row: ProposalRow | null = null;
  for (;;) {
    row = await findProposal(target.url, target.token, opts.fetchFn, id, ts);
    if (!row) throw new Error(`request #${id} is not in Needs You`);
    if (row.decision !== "pending") break;
    if (Date.now() >= deadline) {
      opts.out(`still waiting — nothing has changed. Once you Approve: metistry vault rollback --request ${id}`);
      return { proposal_id: id, state: "timed_out", ...(preview ? { preview } : {}) };
    }
    await sleep(opts.pollMs ?? 2_000);
  }
  if (row.decision === "deny") {
    opts.out(`request #${id} was declined — nothing changed`);
    return { proposal_id: id, state: "declined" };
  }
  if (row.decision !== "allow") {
    opts.out(`request #${id} was answered ${row.decision} — nothing changed`);
    return { proposal_id: id, state: "answered" };
  }
  const edit = cliRollbackOf(row);
  if (!edit) throw new Error(`request #${id} is not a configuration rollback this console raised — nothing changed`);
  const base = hostLocal(reconcilerUrl);
  let res: Response;
  try {
    res = await opts.fetchFn(`${base}/vault/revert`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        intent: { principal: "user", message: `Approved in Needs You (request #${id}), made by metistry vault rollback --include-config.` },
        ...edit.target,
        include_config: true,
        head: edit.head,
        expect: { files: edit.files, reverts: edit.reverts, skipped_config: edit.skipped_config },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new Error(`reconciler bridge at ${base} did not answer (${err instanceof Error ? err.message : String(err)}) — nothing changed; rerun with --request ${id}`);
  }
  const done = await jsonOf(res);
  if (res.status !== 201) throw new Error(`the reconciler refused the rollback (${why(done, res.status)}) — nothing changed`);
  const sha = String(done.sha ?? "");
  opts.out(`rolled back as you: ${sha.slice(0, 12)} — undo it with: metistry vault rollback ${sha.slice(0, 12)}${((done.config as string[] | undefined) ?? []).length ? " --include-config" : ""}`);
  return { proposal_id: id, state: "rolled_back", sha };
}
