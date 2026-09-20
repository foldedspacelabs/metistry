// What `metistry up` has to know about the egress door: which port it binds,
// which host names it admits, and which secret each confined child presents.
//
// The allowlist is DERIVED, never written by hand — the same rule
// `engineHosts` has followed since it existed. Three sources, and no fourth:
//
//   1. every provider's `base_url` in this install's `compute.yaml`
//      (`engineHosts`), because that is the only off-machine call the
//      engine's loop can make;
//   2. every remote in the instance repo's `.git/config`, because that is
//      where the sole committer pushes;
//   3. any bridge URL that is not loopback, because a bridge somewhere else
//      is a destination the console legitimately dials.
//
// Read `.git/config` rather than run `git remote -v`: it is the same answer
// with no subprocess, it works in a dry run, and `up` is not a git caller
// (D5 says the reconciler is).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { EGRESS_PROXY_DEFAULT_PORT, egressEntryFor, type EgressInput } from "@foldedspacelabs/metistry-core";
import { BLOCK_SIZE, type Namespace } from "./namespace.js";

/**
 * The proxy's port: the LAST slot of a namespaced instance's block, or the
 * fixed default.
 *
 * The last slot rather than the next free one on purpose. `PORTED_SERVICES`
 * is documented as a list that "may only ever grow at the end", and an
 * existing `ports.yaml` records only the five it had when it was written —
 * so a sixth entry there would make every allocated instance's file fail to
 * parse. Taking the block's far end leaves room for two more ported services
 * before anything has to move, and needs no change to the file's schema.
 */
export function egressProxyPort(ns: Namespace | undefined, env: NodeJS.ProcessEnv = {}): number {
  const explicit = Number(env.METISTRY_EGRESS_PROXY_PORT);
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit;
  return ns ? ns.base + BLOCK_SIZE - 1 : EGRESS_PROXY_DEFAULT_PORT;
}

/**
 * Remote URLs from a git config file, without running git.
 *
 * A deliberately small INI reader for the one section shape that matters:
 * `[remote "origin"]` … `url = …`. `pushurl` counts too — it is the one git
 * actually dials on a push.
 */
export function remoteUrlsFromGitConfig(text: string): string[] {
  const out: string[] = [];
  let inRemote = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[\s*remote\b/i.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^(url|pushurl)\s*=\s*(.+?)\s*$/i.exec(line);
    if (m) out.push(m[2]!);
  }
  return out;
}

/**
 * Every `credential.helper` the instance repo's own config names.
 *
 * It matters because of a measurement (2026-09-19): git runs EVERY
 * credential helper through `/bin/sh` — including the built-in
 * `osxkeychain` that `metistry connect-repo` configures — and the confined
 * reconciler has no shell. A repo whose push depends on one cannot push
 * while confined, so `up` says so rather than letting the owner find out an
 * hour later in a log.
 */
export function credentialHelpersFromGitConfig(text: string): string[] {
  const out: string[] = [];
  let inCredential = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCredential = /^\[\s*credential\b/i.test(line);
      continue;
    }
    if (!inCredential) continue;
    const m = /^helper\s*=\s*(.*?)\s*$/i.exec(line);
    // `helper =` with an empty value is git's documented way of RESETTING
    // the list, not a helper
    if (m && m[1] !== "") out.push(m[1]!);
  }
  return out;
}

/**
 * The host an allowlist entry would have to name for this remote — or
 * undefined when there is nothing to allow.
 *
 * Handles the three spellings git accepts: a URL (`https://host/p`,
 * `ssh://git@host/p`), scp-like (`git@host:owner/repo`), and a local path
 * (no host at all, so nothing to allow).
 */
export function remoteHostEntry(remote: string): string | undefined {
  const s = remote.trim();
  if (s === "" || s.startsWith("/") || s.startsWith(".") || s.startsWith("file:")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return egressEntryFor(s);
  // scp-like: [user@]host:path — only when the part before the colon has no
  // slash, else it is a relative path with a colon in it
  const m = /^(?:[^@/]+@)?([^:/]+):(?!\/)/.exec(s);
  return m ? egressEntryFor(`https://${m[1]}`) : undefined;
}

/** The bare host name of a remote, with no port — the `server` attribute `connect-repo` files a keychain item under. */
export function hostOfRemote(remote: string): string | undefined {
  const entry = remoteHostEntry(remote);
  if (!entry) return undefined;
  const t = entry.startsWith("[") ? entry.slice(0, entry.indexOf("]") + 1) : entry.split(":")[0]!;
  return t === "" ? undefined : t;
}

/** True when this remote can only be reached over SSH — which a confined reconciler cannot do (ops/sandbox/reconciler.sb). */
export function isSshRemote(remote: string): boolean {
  const s = remote.trim();
  if (/^ssh:\/\//i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  return /^(?:[^@/]+@)?[^:/]+:(?!\/)/.test(s);
}

/**
 * The remote the committer will actually push to: `origin` when there is
 * one, else the first — the same choice `Committer.pushNow` makes, so the
 * credential `up` arranges for is the credential the push asks for.
 */
export function pushRemoteUrl(text: string): string | undefined {
  const named = remoteSectionsFromGitConfig(text);
  return (named.find((r) => r.name === "origin") ?? named[0])?.url;
}

/** `[remote "<name>"]` sections, with the url git would push to (`pushurl` when present). */
export function remoteSectionsFromGitConfig(text: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  let name: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[\s*remote\s+"([^"]+)"\s*\]/i.exec(line);
    if (line.startsWith("[")) {
      name = header ? header[1]! : undefined;
      continue;
    }
    if (!name) continue;
    const m = /^(url|pushurl)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const existing = out.find((r) => r.name === name);
    // pushurl wins: it is the one git dials on a push
    if (existing) {
      if (m[1]!.toLowerCase() === "pushurl") existing.url = m[2]!;
    } else out.push({ name, url: m[2]! });
  }
  return out;
}

export interface InstanceRemotes {
  /** every remote URL the instance repo names */
  urls: string[];
  /** the allowlist entries they imply, deduplicated */
  entries: string[];
  /** the ones a confined reconciler cannot push to */
  ssh: string[];
  /** `credential.helper` values this repo names — none of which can run confined (git runs every helper through a shell) */
  credentialHelpers: string[];
  /** the remote `Committer.pushNow` will choose (`origin`, else the first) */
  pushUrl?: string | undefined;
  /** its host, when it is an https remote — the login Keychain item the supervisor looks up for the confined reconciler */
  pushHost?: string | undefined;
}

/** `<instance>/.git/config`, parsed. An instance that is not a repo yet (or is not there) yields nothing rather than throwing. */
export async function instanceRemotes(instanceDir: string | undefined): Promise<InstanceRemotes> {
  const empty: InstanceRemotes = { urls: [], entries: [], ssh: [], credentialHelpers: [] };
  if (!instanceDir) return empty;
  const file = join(instanceDir, ".git", "config");
  if (!existsSync(file)) return empty;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return empty;
  }
  const urls = remoteUrlsFromGitConfig(text);
  const entries = [...new Set(urls.map(remoteHostEntry).filter((e): e is string => e !== undefined))].sort();
  const pushUrl = pushRemoteUrl(text);
  // an ssh remote has no keychain item to look up: its credential is a key,
  // and a confined reconciler cannot reach it at all
  const pushHost = pushUrl && !isSshRemote(pushUrl) ? hostOfRemote(pushUrl) : undefined;
  return {
    urls,
    entries,
    ssh: urls.filter(isSshRemote),
    credentialHelpers: credentialHelpersFromGitConfig(text),
    ...(pushUrl ? { pushUrl } : {}),
    ...(pushHost ? { pushHost } : {}),
  };
}

/** 256 bits of hex per confined child. Minted once per install and kept across `up` runs, exactly like the control token. */
export function mintEgressToken(): string {
  return randomBytes(32).toString("hex");
}

export interface EgressPlanInputs {
  port: number;
  /** `engineHosts(compute)` — provider host names */
  engineHosts: readonly string[];
  /** the instance repo's remotes */
  remotes: readonly string[];
  /** every `METISTRY_*_URL` this install configures; loopback ones contribute nothing */
  urls: readonly string[];
  /** the confined children that need a bearer */
  children: readonly string[];
  /** tokens from a previous `up`, kept so a re-run does not break a running child */
  existingTokens?: Record<string, string> | undefined;
  mint?: (() => string) | undefined;
}

/** The `egress` block `up` writes into `supervisor.json`. */
export function egressPlan(inputs: EgressPlanInputs): EgressInput {
  const mint = inputs.mint ?? mintEgressToken;
  const allow = new Set<string>();
  for (const h of inputs.engineHosts) {
    const e = egressEntryFor(`https://${h}`);
    if (e) allow.add(e);
  }
  for (const r of inputs.remotes) {
    const e = remoteHostEntry(r);
    if (e) allow.add(e);
  }
  for (const u of inputs.urls) {
    const e = egressEntryFor(u);
    if (e) allow.add(e);
  }
  const tokens: Record<string, string> = {};
  for (const c of inputs.children) tokens[c] = inputs.existingTokens?.[c] ?? mint();
  return { port: inputs.port, allow: [...allow].sort(), tokens };
}
