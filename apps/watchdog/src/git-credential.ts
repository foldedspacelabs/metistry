// The supervisor's keychain read, performed once per child, at spawn.
//
// The confined reconciler cannot run a git credential helper (git runs every
// helper through a shell, and its profile has none), so somebody unconfined
// has to fetch the token `metistry connect-repo` put in the login Keychain
// and hand it over. That somebody is this process: it is the parent, it is
// unconfined, and a child's environment is the channel this product already
// uses for the provider API key and the db password.
//
// Three rules the implementation exists to keep:
//
//   * **The value never travels in argv.** `security … -w` prints it on
//     stdout; nothing here puts a secret on a command line, where `ps` would
//     show it to every process on the Mac.
//   * **The account lookup never sees the token.** `security … -g` prints
//     attributes on stdout and `password: "…"` on stderr; this reads stdout
//     and discards stderr, so the one call that gets logged on failure
//     cannot carry a credential. Asserted by a test.
//   * **A miss is a log line, not a crash.** An install with no remote, a
//     locked keychain, a Linux host: the child starts without the variables
//     and its push fails the way it did before, loudly, in its own log.

import { execFile } from "node:child_process";
import { accountFromKeychainAttributes, DEFAULT_GIT_ACCOUNT, GIT_ASKPASS_TOKEN_VAR, GIT_ASKPASS_USER_VAR, type GitCredentialLookup } from "@foldedspacelabs/metistry-core";

/** `/usr/bin/security`, by absolute path — the same rule the CLI's Keychain follows. */
export const SECURITY_BIN = "/usr/bin/security";
/** A keychain read that has not answered in this is a locked keychain or a prompt nobody is there to click. */
export const KEYCHAIN_TIMEOUT_MS = 10_000;  // limit: fixed — a local IPC call to securityd; anything slower is a dialog, not latency

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (bin: string, args: string[]) => Promise<RunResult>;

/** Argument arrays only, never a shell — and stderr is captured so it can be DISCARDED deliberately rather than leaked. */
export const execFileRunner: Runner = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface GitCredential {
  user: string;
  token: string;
}

/**
 * The internet-password `connect-repo` filed for this host, in
 * `git-credential-osxkeychain`'s shape.
 *
 * Two calls on purpose. `-g` answers "which account?" from stdout, and its
 * stderr — which carries the password — is thrown away unread. `-w` answers
 * "what is it?" and its stdout is the only place a secret appears.
 *
 * No `-a`: `connect-repo` files the account it learned from GitHub and
 * records it nowhere else, so the host is the only key this process has.
 * That is also what git itself does with a remote URL carrying no username.
 */
export async function lookupGitCredential(host: string, run: Runner = execFileRunner): Promise<GitCredential | undefined> {
  const attrs = await run(SECURITY_BIN, ["find-internet-password", "-s", host, "-r", "htps", "-g"]);
  if (attrs.code !== 0) return undefined;
  const user = accountFromKeychainAttributes(attrs.stdout) ?? DEFAULT_GIT_ACCOUNT;
  const secret = await run(SECURITY_BIN, ["find-internet-password", "-s", host, "-r", "htps", "-w"]);
  if (secret.code !== 0) return undefined;
  const token = secret.stdout.replace(/\n$/, "");
  return token === "" ? undefined : { user, token };
}

/**
 * Resolve every lookup and merge the answers into the children that asked
 * for them, BEFORE any of them is spawned.
 *
 * Returns one line per lookup for the supervisor's log — the host and
 * whether it was found, never the account and never the value.
 */
export async function injectGitCredentials(
  /** the parsed config's children, mutated in place — `ChildSpec` satisfies this */
  children: Array<{ name: string; env: Record<string, string> }>,
  lookups: readonly GitCredentialLookup[],
  opts: { platform?: NodeJS.Platform; run?: Runner } = {},
): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const notes: string[] = [];
  if (lookups.length === 0) return notes;
  if (platform !== "darwin") {
    notes.push(`[credential] ${lookups.length} keychain lookup(s) skipped on ${platform}: there is no login Keychain here, so a confined child pushes with whatever git finds`);
    return notes;
  }
  for (const lookup of lookups) {
    const child = children.find((c) => c.name === lookup.child);
    if (!child) {
      notes.push(`[credential] ${lookup.host}: no child named ${lookup.child} in this config — nothing to hand it to`);
      continue;
    }
    const found = await lookupGitCredential(lookup.host, opts.run);
    if (!found) {
      notes.push(`[credential] ${lookup.host}: no login Keychain item — ${lookup.child}'s push will fail with "could not read Username". \`metistry connect-repo <url>\` files one.`);
      continue;
    }
    child.env = { ...child.env, [GIT_ASKPASS_USER_VAR]: found.user, [GIT_ASKPASS_TOKEN_VAR]: found.token };
    notes.push(`[credential] ${lookup.host}: found, handed to ${lookup.child} in its environment (never written to disk, never in argv)`);
  }
  return notes;
}
