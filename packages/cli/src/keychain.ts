// The macOS login Keychain as a secret store, driven through `security`
// with argument arrays only (exec.ts — never a shell). Two item kinds:
//
//   generic  service `metistry:<VAR>`   — the canonical home of every
//            secret-shaped `.env` variable (`metistry secrets`).
//   internet server <host>, protocol htps — a git credential, in exactly
//            the shape `git-credential-osxkeychain` looks for, so the
//            reconciler pushes unattended with no plaintext anywhere
//            (`metistry connect-repo`).
//
// Values NEVER travel in argv: `security ... -w` given as the last option
// prompts, and the prompt reads stdin when there is no tty, so the secret
// goes down the child's stdin and is invisible to `ps`. Reading back uses
// `-w`, whose output is the value — so a caller must never log it. Nothing
// in this module writes a value to `out`.

import type { Exec, ExecResult } from "./exec.js";

/** Service prefix for the generic-password items `metistry secrets` owns. */
export const SERVICE_PREFIX = "metistry:";
/** The USER-scoped account: what belongs to the person rather than to any one instance. */
export const DEFAULT_ACCOUNT = "metistry";

export function serviceFor(name: string): string {
  return `${SERVICE_PREFIX}${name}`;
}

/**
 * The user-scoped account. `METISTRY_KEYCHAIN_ACCOUNT` overrides it (two
 * people on one login, or a test fixture). What keeps several instances on
 * one Mac apart is no longer this variable but the per-instance account —
 * every instance-scoped secret is filed under the instance's `instance_id`
 * (secrets.ts `SECRET_SCOPES`).
 */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  return env.METISTRY_KEYCHAIN_ACCOUNT || DEFAULT_ACCOUNT;
}

/**
 * `security`'s prompt asks twice ("retype"), so the value is written twice.
 * A value carrying a newline cannot survive that round trip — refuse it
 * here rather than silently store its first line.
 */
export function promptStdin(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("a secret containing a newline cannot be stored in the Keychain (`security` reads it a line at a time)");
  return `${value}\n${value}\n`;
}

export class Keychain {
  constructor(
    private readonly exec: Exec,
    /** Which account's items this handle reads and writes: the user's, or one instance's id. */
    readonly account: string = DEFAULT_ACCOUNT,
  ) {}

  private run(args: string[], stdin?: string): Promise<ExecResult> {
    return this.exec("security", args, { ...(stdin === undefined ? {} : { stdin }), timeoutMs: 20_000 });
  }

  /** Store (or replace) `metistry:<name>`. */
  async setSecret(name: string, value: string): Promise<void> {
    const r = await this.run(["add-generic-password", "-U", "-a", this.account, "-s", serviceFor(name), "-w"], promptStdin(value));
    if (r.code !== 0) throw new Error(`security add-generic-password ${serviceFor(name)} failed (${r.code}): ${lastLine(r)}`);
  }

  /** The stored value, or undefined when there is no such item. */
  async getSecret(name: string): Promise<string | undefined> {
    const r = await this.run(["find-generic-password", "-a", this.account, "-s", serviceFor(name), "-w"]);
    if (r.code !== 0) return undefined;
    return r.stdout.replace(/\n$/, "");
  }

  /** Presence only — never asks for the value, so nothing sensitive can leak into a listing. */
  async hasSecret(name: string): Promise<boolean> {
    const r = await this.run(["find-generic-password", "-a", this.account, "-s", serviceFor(name)]);
    return r.code === 0;
  }

  /**
   * Delete this account's `metistry:<name>`. True when an item went away,
   * false when there was none. Only ever called for one instance's own
   * account (`metistry secrets purge`) — the user-scoped items outlive any
   * instance, and nothing here can reach them.
   */
  async deleteSecret(name: string): Promise<boolean> {
    const r = await this.run(["delete-generic-password", "-a", this.account, "-s", serviceFor(name)]);
    return r.code === 0;
  }

  /**
   * A git credential for `host`, in `git-credential-osxkeychain`'s shape.
   * `-A` (any application may read it) is deliberate: the helper is a
   * different binary from `security`, and per-binary trust is invalidated
   * by every Xcode/Homebrew git update — which would turn an unattended
   * reconciler push into a silent failure behind a GUI prompt. The item is
   * still gated by the login keychain being unlocked, and anyone running
   * as this user already holds `.env` (docs/ops/cli.md records the trade).
   */
  async setGitCredential(host: string, account: string, token: string): Promise<void> {
    const r = await this.run(["add-internet-password", "-U", "-a", account, "-s", host, "-r", "htps", "-A", "-w"], promptStdin(token));
    if (r.code !== 0) throw new Error(`security add-internet-password ${host} failed (${r.code}): ${lastLine(r)}`);
  }

  async hasGitCredential(host: string, account: string): Promise<boolean> {
    const r = await this.run(["find-internet-password", "-a", account, "-s", host, "-r", "htps"]);
    return r.code === 0;
  }
}

function lastLine(r: ExecResult): string {
  return (r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? "";
}
