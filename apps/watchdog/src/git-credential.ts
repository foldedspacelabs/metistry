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
//   * **The account lookup never sees the token.** It asks for attributes
//     only (no `-g`, no `-w`), so `security` never reads the item's data at
//     all; stdout is the attributes and nothing else. Asserted by a test.
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
 * Why a lookup came back empty — and the log line that says so. The two
 * causes need telling apart because only one of them is "run connect-repo":
 * an item that is THERE but whose access list refuses a read without a
 * session (one `git-credential-osxkeychain` created, trusting only itself)
 * looked, to this log, exactly like no item at all (2026-09-29).
 */
export type GitCredentialMiss = "missing" | "refused" | "empty";

export type GitCredentialLookupResult = { found: GitCredential } | { miss: GitCredentialMiss };

/**
 * The internet-password `connect-repo` filed for this host, in
 * `git-credential-osxkeychain`'s shape.
 *
 * Two calls on purpose. The first has NO `-g` and no `-w`: `security`
 * then prints the item's attributes on stdout and never touches its data,
 * so it answers "is there an item, and which account?" without an
 * access-list check — `-g` (which also prints the password, on stderr) is a
 * data read like `-w`, and is refused by the same ACL. `-w` answers "what
 * is it?" and its stdout is the only place a secret appears. A present item
 * whose `-w` is refused is therefore an ACL (or locked-keychain) refusal,
 * not a missing item.
 *
 * No `-a`: `connect-repo` files the account it learned from GitHub and
 * records it nowhere else, so the host is the only key this process has.
 * That is also what git itself does with a remote URL carrying no username.
 */
export async function findGitCredential(host: string, run: Runner = execFileRunner): Promise<GitCredentialLookupResult> {
  const attrs = await run(SECURITY_BIN, ["find-internet-password", "-s", host, "-r", "htps"]);
  if (attrs.code !== 0) return { miss: "missing" };
  const user = accountFromKeychainAttributes(attrs.stdout) ?? DEFAULT_GIT_ACCOUNT;
  const secret = await run(SECURITY_BIN, ["find-internet-password", "-s", host, "-r", "htps", "-w"]);
  if (secret.code !== 0) return { miss: "refused" };
  const token = secret.stdout.replace(/\n$/, "");
  return token === "" ? { miss: "empty" } : { found: { user, token } };
}

/** `findGitCredential`, as the credential or nothing. */
export async function lookupGitCredential(host: string, run: Runner = execFileRunner): Promise<GitCredential | undefined> {
  const r = await findGitCredential(host, run);
  return "found" in r ? r.found : undefined;
}

/** The supervisor's log line for a miss — host and cause, never an account or a value. */
export function missNote(host: string, child: string, miss: GitCredentialMiss): string {
  switch (miss) {
    case "refused":
      return `[credential] ${host}: item exists but its access list refuses a background read — run \`metistry connect-repo <url> --force\` to re-create it (${child}'s push will fail with "could not read Username" until then; a locked login keychain at spawn reads the same way)`;
    case "empty":
      return `[credential] ${host}: the login Keychain item has an empty password — ${child}'s push will fail with "could not read Username". Run \`metistry connect-repo <url> --force\` to re-create it.`;
    case "missing":
      return `[credential] ${host}: no login Keychain item — ${child}'s push will fail with "could not read Username". \`metistry connect-repo <url>\` files one.`;
  }
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
    const r = await findGitCredential(lookup.host, opts.run);
    if (!("found" in r)) {
      notes.push(missNote(lookup.host, lookup.child, r.miss));
      continue;
    }
    const found = r.found;
    child.env = { ...child.env, [GIT_ASKPASS_USER_VAR]: found.user, [GIT_ASKPASS_TOKEN_VAR]: found.token };
    notes.push(`[credential] ${lookup.host}: found, handed to ${lookup.child} in its environment (never written to disk, never in argv)`);
  }
  return notes;
}
