// How the CONFINED reconciler authenticates a push.
//
// The problem, measured (2026-09-19, macOS 26.4, git 2.50.1): git runs every
// credential helper through `/bin/sh` — including the built-in `osxkeychain`
// that `metistry connect-repo` configures — and the reconciler's profile has
// no shell, by design. Under confinement a push died with
//   fatal: cannot exec 'git credential-osxkeychain get': Operation not permitted
//   fatal: could not read Username for 'https://…': terminal prompts disabled
//
// The way out, also measured: **`GIT_ASKPASS` is exec'd directly, by
// absolute path, with no shell.** The exec allowlist is the only gate. So
// the confined reconciler runs git with the helper list reset
// (`-c credential.helper=`, git's documented reset) and an askpass of our
// own — a `#!<node>` shim `metistry up` generates, granted exec by literal
// in ops/sandbox/reconciler.sb — which prints one of two values from its own
// environment and can read nothing else.
//
// WHERE THE CREDENTIAL COMES FROM, and why it is the supervisor that fetches
// it. `connect-repo` deliberately puts the token in the login Keychain and
// NOWHERE else: *"No token in `.env`, no token in a URL, none on a command
// line"*. Inventing a second home for it would undo that decision and put a
// push token in plaintext beside the db password. So the credential is read
// where it already lives, by the one process that can: the SUPERVISOR is
// unconfined, is the parent, and hands the value to the child in its
// environment — the same channel that already carries the provider API key
// to the engine and the db password to the console.
//
// That read is promptless because `Keychain.setGitCredential` writes the
// item with `-A` ("any application may read it"), a trade already made and
// already documented in packages/cli/src/keychain.ts: per-binary trust is
// invalidated by every git update, which would turn an unattended push into
// a silent failure behind a GUI prompt nobody is there to click.

import { z } from "zod";

/** The askpass shim's path, handed to git as `GIT_ASKPASS`. Set by `metistry up` on the confined reconciler only. */
export const GIT_ASKPASS_PATH_VAR = "METISTRY_GIT_ASKPASS";
/** The username the askpass shim answers a `Username for …` prompt with. */
export const GIT_ASKPASS_USER_VAR = "METISTRY_GIT_ASKPASS_USER";
/** The token it answers every other prompt with. Injected by the supervisor at spawn; never written to disk, never in argv. */
export const GIT_ASKPASS_TOKEN_VAR = "METISTRY_GIT_ASKPASS_TOKEN";

/** The account `connect-repo` files a credential under when it can learn nothing better — and the fallback here, for the same reason. */
export const DEFAULT_GIT_ACCOUNT = "x-access-token";

/**
 * One keychain lookup the supervisor performs before it spawns a child.
 *
 * Deliberately not a credential: this says WHERE to look, and the value
 * never touches `supervisor.json` (which is 0600 but still a file, and a
 * file is a thing that gets copied into a bug report).
 */
export const gitCredentialSchema = z
  .object({
    /** the child whose environment receives the answer */
    child: z.string().min(1),
    /** the internet-password `server` attribute — the git remote's host, exactly as `connect-repo` filed it */
    host: z.string().min(1),
  })
  .strict();

export type GitCredentialLookup = z.infer<typeof gitCredentialSchema>;

/**
 * The account from `security find-internet-password`'s **stdout**.
 *
 * The watchdog asks with neither `-g` nor `-w` — attributes only, so the
 * item's data is never read and its access list is never consulted (a `-g`
 * is a data read, and an item whose ACL refuses a background read refuses
 * it too). Even with `-g`, `security` prints the attributes on stdout and
 * `password: "…"` on **stderr**, so a caller that reads only stdout cannot
 * log the token. The value itself is fetched separately with `-w`.
 */
export function accountFromKeychainAttributes(stdout: string): string | undefined {
  const m = /^\s*"acct"<blob>="((?:[^"\\]|\\.)*)"/m.exec(stdout);
  if (!m) return undefined;
  const acct = m[1]!.replace(/\\(.)/g, "$1");
  return acct === "" ? undefined : acct;
}

/**
 * `-c credential.helper=` — git's documented way to RESET the helper list to
 * empty. Command-line config is read last, so this clears every helper the
 * system, global and repo config accumulated, which is the whole point: the
 * repo's own `credential.helper=osxkeychain` cannot run here, and left in
 * place it fails first and loudly before askpass is ever reached (measured).
 */
export const CREDENTIAL_HELPER_RESET = "credential.helper=";
