// The allowlist is DERIVED. These tests pin where each entry comes from,
// because "who may this install talk to?" must be answerable from
// `compute.yaml` and `.git/config` rather than from a list someone
// remembered to update.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EGRESS_PROXY_DEFAULT_PORT, egressAllows, egressEntryFor, isLoopbackHost, parseEgressEntry } from "@foldedspacelabs/metistry-core";
import { credentialHelpersFromGitConfig, egressPlan, egressProxyPort, instanceRemotes, isSshRemote, remoteHostEntry, remoteUrlsFromGitConfig } from "../src/egress.js";
import { BLOCK_SIZE, type Namespace } from "../src/namespace.js";

const ns = (base: number): Namespace => ({ labelSuffix: "a1b2c3d4", base, ports: { console: base, db: base + 1, reconciler: base + 2, eventkit: base + 3, "apple-fm": base + 4 }, from: "ports.yaml" });

describe("where the proxy listens", () => {
  it("the block's LAST slot for a namespaced instance, so no existing ports.yaml has to change", () => {
    expect(egressProxyPort(undefined)).toBe(EGRESS_PROXY_DEFAULT_PORT);
    expect(egressProxyPort(ns(8400))).toBe(8400 + BLOCK_SIZE - 1);
    // it does not collide with anything PORTED_SERVICES allocates today, or
    // with the two spare slots a sixth and seventh service would take
    expect(egressProxyPort(ns(8400))).toBeGreaterThan(8400 + 4);
    // …and an operator may still say so explicitly
    expect(egressProxyPort(ns(8400), { METISTRY_EGRESS_PROXY_PORT: "9999" })).toBe(9999);
    expect(egressProxyPort(undefined, { METISTRY_EGRESS_PROXY_PORT: "nonsense" })).toBe(EGRESS_PROXY_DEFAULT_PORT);
  });

  it("the default is not llama-server's 7813, which continues the same loopback block", () => {
    expect(EGRESS_PROXY_DEFAULT_PORT).toBe(7814);
  });
});

describe("remotes, without running git", () => {
  const config = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/owner/instance.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "backup"]
\turl = git@git.example.test:owner/instance.git
\tpushurl = ssh://git@push.example.test/owner/instance.git
[branch "main"]
\tremote = origin
[credential]
\thelper = osxkeychain
[credential "https://github.com"]
\thelper =
\thelper = !/opt/homebrew/bin/gh auth git-credential
`;

  it("reads every url and pushurl, and nothing outside a remote section", () => {
    expect(remoteUrlsFromGitConfig(config)).toEqual([
      "https://github.com/owner/instance.git",
      "git@git.example.test:owner/instance.git",
      "ssh://git@push.example.test/owner/instance.git",
    ]);
  });

  it("turns each of git's three spellings into the host an allowlist would have to name", () => {
    expect(remoteHostEntry("https://github.com/owner/r.git")).toBe("github.com");
    expect(remoteHostEntry("https://git.example.test:8443/owner/r.git")).toBe("git.example.test:8443");
    expect(remoteHostEntry("ssh://git@push.example.test/owner/r.git")).toBe("push.example.test");
    expect(remoteHostEntry("git@github.com:owner/r.git")).toBe("github.com");
    // a local path has no host to allow
    expect(remoteHostEntry("/srv/mirrors/instance.git")).toBeUndefined();
    expect(remoteHostEntry("file:///srv/mirrors/instance.git")).toBeUndefined();
    expect(remoteHostEntry("../sibling.git")).toBeUndefined();
  });

  it("names the SSH remotes, which a CONFINED reconciler cannot push to", () => {
    expect(isSshRemote("git@github.com:owner/r.git")).toBe(true);
    expect(isSshRemote("ssh://git@host/owner/r.git")).toBe(true);
    expect(isSshRemote("https://github.com/owner/r.git")).toBe(false);
    expect(isSshRemote("/srv/mirror.git")).toBe(false);
  });

  it("reads them off disk, and shrugs at an instance that is not a repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-eg-"));
    expect(await instanceRemotes(dir)).toEqual({ urls: [], entries: [], ssh: [], credentialHelpers: [] });
    expect(await instanceRemotes(undefined)).toEqual({ urls: [], entries: [], ssh: [], credentialHelpers: [] });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), config);
    const r = await instanceRemotes(dir);
    expect(r.entries).toEqual(["git.example.test", "github.com", "push.example.test"]);
    expect(r.ssh).toEqual(["git@git.example.test:owner/instance.git", "ssh://git@push.example.test/owner/instance.git"]);
    expect(r.credentialHelpers).toEqual(["osxkeychain", "!/opt/homebrew/bin/gh auth git-credential"]);
  });

  it("names every credential.helper, and reads git's empty-value RESET as a reset rather than a helper", () => {
    // measured 2026-09-19: git runs EVERY helper through /bin/sh — even the
    // built-in osxkeychain `metistry connect-repo` configures — so a
    // confined reconciler can use none of them
    expect(credentialHelpersFromGitConfig(config)).toEqual(["osxkeychain", "!/opt/homebrew/bin/gh auth git-credential"]);
    expect(credentialHelpersFromGitConfig('[credential]\n\thelper =\n')).toEqual([]);
    expect(credentialHelpersFromGitConfig('[core]\n\thelper = notthisone\n')).toEqual([]);
  });
});

describe("the plan `up` writes into supervisor.json", () => {
  it("merges the three derived sources, sorts, deduplicates, and drops loopback", () => {
    const plan = egressPlan({
      port: 7814,
      engineHosts: ["openrouter.ai", "127.0.0.1"],
      remotes: ["https://github.com/owner/r.git", "git@github.com:owner/other.git"],
      urls: ["http://127.0.0.1:8080", "https://bridge.example.test/mcp", "not a url"],
      children: ["assistant", "reconciler"],
      mint: () => "t".repeat(64),
    });
    // loopback is a PROFILE rule, never egress — the console and Postgres
    // are reached directly or not at all
    expect(plan.allow).toEqual(["bridge.example.test", "github.com", "openrouter.ai"]);
    expect(plan.port).toBe(7814);
    expect(Object.keys(plan.tokens!).sort()).toEqual(["assistant", "reconciler"]);
  });

  it("keeps a token a previous `up` minted: a rotation would break a running child's egress mid-flight", () => {
    const kept = { assistant: "k".repeat(64) };
    const plan = egressPlan({ port: 1, engineHosts: [], remotes: [], urls: [], children: ["assistant", "reconciler"], existingTokens: kept, mint: () => "n".repeat(64) });
    expect(plan.tokens!.assistant).toBe(kept.assistant);
    expect(plan.tokens!.reconciler).toBe("n".repeat(64));
  });

  it("an install with no provider and no remote gets an EMPTY list, which refuses everything — and is correct", () => {
    const plan = egressPlan({ port: 1, engineHosts: [], remotes: [], urls: [], children: [], mint: () => "x".repeat(64) });
    expect(plan.allow).toEqual([]);
    expect(egressAllows(plan.allow!, { host: "anything.test", port: 443 })).toBe(false);
  });
});

describe("matching is exact", () => {
  it("no wildcards, no suffix rules, and a port that must match", () => {
    const allow = ["openrouter.ai", "git.example.test:8443"];
    expect(egressAllows(allow, { host: "openrouter.ai", port: 443 })).toBe(true);
    expect(egressAllows(allow, { host: "OpenRouter.AI", port: 443 })).toBe(true);
    expect(egressAllows(allow, { host: "git.example.test", port: 8443 })).toBe(true);
    // the near misses a suffix rule would have admitted
    expect(egressAllows(allow, { host: "evil-openrouter.ai", port: 443 })).toBe(false);
    expect(egressAllows(allow, { host: "openrouter.ai.evil.test", port: 443 })).toBe(false);
    expect(egressAllows(allow, { host: "api.openrouter.ai", port: 443 })).toBe(false);
    // …and the port
    expect(egressAllows(allow, { host: "openrouter.ai", port: 80 })).toBe(false);
    expect(egressAllows(allow, { host: "git.example.test", port: 443 })).toBe(false);
  });

  it("a URL contributes its host, and its port only when that is not 443", () => {
    expect(egressEntryFor("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(egressEntryFor("https://x.test:8443/v1")).toBe("x.test:8443");
    expect(egressEntryFor("http://x.test/v1")).toBe("x.test:80");
    expect(egressEntryFor("http://127.0.0.1:8080")).toBeUndefined();
    expect(egressEntryFor("http://localhost:8080")).toBeUndefined();
    expect(egressEntryFor("nonsense")).toBeUndefined();
    expect(isLoopbackHost("127.0.0.53")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(parseEgressEntry("*.example.com")).toBeUndefined();
  });
});
