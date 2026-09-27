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
import { deploymentPaths, loadDeployment } from "./deployment.js";
import { realExec, type Exec } from "./exec.js";
import { protectedRel, writeProtected } from "./protected-write.js";
import { StepRunner } from "./steps.js";

export const VAULT_VERBS = ["settings"] as const;

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
