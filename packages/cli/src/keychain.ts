// The macOS login Keychain as a secret store, driven through `security`
// with argument arrays only (exec.ts — never a shell). Three item kinds:
//
//   generic  service `metistry:<VAR>`   — the canonical home of every
//            secret-shaped `.env` variable (`metistry secrets`).
//   generic  service `metistry:secret:<name>`, account `<instance_id>` — an
//            owner-named secret (plan §2.14; core's `InstanceSecrets` is the
//            only thing that addresses one, bound to one instance).
//   internet server <host>, protocol htps — a git credential, in exactly
//            the shape `git-credential-osxkeychain` looks for, so the
//            reconciler pushes unattended with no plaintext anywhere
//            (`metistry connect-repo`).
//
// Values NEVER travel in argv. A write is `security -i` — its interactive
// mode — with the one command line on the child's stdin, so the value is in
// no process's argv and invisible to `ps`. Reading back uses `-w`, whose
// output is the value — so a caller must never log it. Nothing in this module
// writes a value to `out`.
//
// Not `add-generic-password … -w` as the last option with the value piped in:
// that form reads the value with getpass(3), which opens /dev/tty FIRST and
// reads stdin only when there is no terminal. No test and no agent session
// has one, so it passed; the owner's `metistry update` in Terminal did —
// `security` printed "password data for new item:" on the terminal, waited on
// the keyboard while the value sat unread in the pipe, and was killed by the
// exec timeout (exit 1, nothing on stderr: the 0.12.0 → 0.14.0 upgrade,
// 2026-09-27). getpass(3) also keeps only the first 128 characters, so a
// longer secret was stored truncated without a word.

import type { KeychainBackend } from "@foldedspacelabs/metistry-core";
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
 * The longest command line `security -i` reads whole, newline included. Its
 * line buffer is SecurityTool's MAX_LINE_LEN (4096); a longer line is read in
 * two pieces and the SECOND runs as a command of its own, so the tail of a
 * secret would come back on stderr as `unknown command "…"` (measured against
 * a scratch keychain: a 4097-byte line stored whole, 4098 split).
 */
export const SECURITY_LINE_MAX = 4095; // limit: fixed — security(1)'s interactive line buffer, not a policy

/**
 * One argument the way `security -i`'s tokenizer reads it back: always
 * double-quoted, `\` and `"` backslash-escaped, everything else literal
 * (spaces, `'`, `$`, backticks, non-ASCII). A newline or NUL cannot be carried
 * at all — the tool reads a line at a time — so it is refused here rather
 * than letting the first line be stored and the rest run as a command.
 */
export function securityQuote(arg: string): string {
  if (/[\r\n\0]/.test(arg)) throw new Error("a secret containing a newline cannot be stored in the Keychain (`security` reads it a line at a time)");
  return `"${arg.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The stdin of a `security -i` write: one quoted command line. A line the
 * tool would split is refused, naming its length — never a byte of it.
 */
export function interactiveLine(args: readonly string[]): string {
  const line = `${args.map(securityQuote).join(" ")}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > SECURITY_LINE_MAX) {
    throw new Error(`this secret is too long for the Keychain's command line (${bytes} bytes with its command; \`security -i\` reads at most ${SECURITY_LINE_MAX})`);
  }
  return line;
}

function security(exec: Exec, args: string[], stdin?: string): Promise<ExecResult> {
  return exec("security", args, { ...(stdin === undefined ? {} : { stdin }), timeoutMs: 20_000 });
}

/**
 * Presence only: `find-generic-password` WITHOUT `-w`, which answers from the
 * item's attributes and never asks for its data. The whole of what a listing
 * gets — the console's `GET /api/secrets` is built on this and on nothing
 * that can return a value.
 */
export function securityPresence(exec: Exec): (service: string, account: string) => Promise<boolean> {
  return async (service, account) => (await security(exec, ["find-generic-password", "-a", account, "-s", service])).code === 0;
}

/**
 * The login Keychain as core's `KeychainBackend`: generic-password items by
 * (service, account), through `security` with argument arrays only and
 * values on stdin (`security -i`, above). Shared by every instance on this
 * Mac, exactly as the Keychain is — the per-instance binding is core's
 * `InstanceSecrets`.
 */
export function securityKeychain(exec: Exec): KeychainBackend {
  return {
    async set(service, account, value) {
      const r = await security(exec, ["-i"], interactiveLine(["add-generic-password", "-U", "-a", account, "-s", service, "-w", value]));
      if (r.code !== 0) throw new Error(`security add-generic-password ${service} failed (${r.code}): ${reason(r)}`);
    },
    async get(service, account) {
      const r = await security(exec, ["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (r.code !== 0) return undefined;
      return r.stdout.replace(/\n$/, "");
    },
    has: securityPresence(exec),
    async delete(service, account) {
      return (await security(exec, ["delete-generic-password", "-a", account, "-s", service])).code === 0;
    },
  };
}

export class Keychain {
  private readonly items: KeychainBackend;

  constructor(
    private readonly exec: Exec,
    /** Which account's items this handle reads and writes: the user's, or one instance's id. */
    readonly account: string = DEFAULT_ACCOUNT,
  ) {
    this.items = securityKeychain(exec);
  }

  private run(args: string[], stdin?: string): Promise<ExecResult> {
    return security(this.exec, args, stdin);
  }

  /** Store (or replace) `metistry:<name>`. */
  async setSecret(name: string, value: string): Promise<void> {
    await this.items.set(serviceFor(name), this.account, value);
  }

  /** The stored value, or undefined when there is no such item. */
  async getSecret(name: string): Promise<string | undefined> {
    return this.items.get(serviceFor(name), this.account);
  }

  /** Presence only — never asks for the value, so nothing sensitive can leak into a listing. */
  async hasSecret(name: string): Promise<boolean> {
    return this.items.has(serviceFor(name), this.account);
  }

  /**
   * Delete this account's `metistry:<name>`. True when an item went away,
   * false when there was none. Only ever called for one instance's own
   * account (`metistry secrets purge`) — the user-scoped items outlive any
   * instance, and nothing here can reach them.
   */
  async deleteSecret(name: string): Promise<boolean> {
    return this.items.delete(serviceFor(name), this.account);
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
    const r = await this.run(["-i"], interactiveLine(["add-internet-password", "-U", "-a", account, "-s", host, "-r", "htps", "-A", "-w", token]));
    if (r.code !== 0) throw new Error(`security add-internet-password ${host} failed (${r.code}): ${reason(r)}`);
  }

  async hasGitCredential(host: string, account: string): Promise<boolean> {
    const r = await this.run(["find-internet-password", "-a", account, "-s", host, "-r", "htps"]);
    return r.code === 0;
  }
}

/**
 * Why a write failed, in `security`'s own words. Interactive mode ends every
 * failure with `<command>: returned <status>`, which says less than the line
 * before it, so that one is preferred. A quoted, length-checked line never
 * echoes its value (interactiveLine), so neither line can carry one.
 */
function reason(r: ExecResult): string {
  const lines = (r.stderr || r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.filter((l) => !/: returned -?\d+$/.test(l));
  return (said.at(-1) ?? lines.at(-1) ?? "no message — a locked keychain, or a timeout").slice(0, 300);
}
