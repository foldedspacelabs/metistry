// The remote-access provider adapter (plan §2.23, X-105): one interface, one
// module per provider, the CLI the only implementation — the Mac app drives
// these over the CLI transport (§2.2, M20) and never talks to a provider
// itself.
//
// Four verbs, and what each may and may not do:
//
//   detect     read-only. Is the tool here, is it signed in, what would
//              `configure` change. Never writes, never prompts.
//   configure  idempotent. Fetch the tool (X-112), sign in or hand the owner
//              the provider's own sign-in, expose the PROXY listener (never
//              the main port — docs/ops/auth.md, "The proxy listener"),
//              return the stable origin and the non-secret settings worth
//              recording. **Writes nothing on failure**: a throw leaves the
//              provider as it was found, and the caller writes no record.
//   status     doctor rows, kind `remote`, in the product's voice: reported
//              state, each absence its own sentence naming the fix.
//   revoke     undo exactly what `configure` created; name what only the
//              owner can undo at the provider (a node in an admin console, an
//              account).
//
// A credential never reaches this interface as a value in a record or a
// return: a token arrives through `ctx.readToken` (stdin or a hidden prompt —
// stdin-value.ts) and lives where the adapter's own table says (the Keychain,
// a state directory); `settings` carries names and ids only.
//
// This file names no provider's tool and assumes nothing about how one is
// run — a bundled daemon, the owner's own app, an in-process client are each
// an adapter's business (X-106 onwards), not the interface's.

import type { CheckResult, RemoteProviderId, RemoteRecord } from "@foldedspacelabs/metistry-core";
import type { Exec } from "../exec.js";

/** A doctor row a provider reports: core's CheckResult, kind `remote`, with the one button doctor can offer for it (the same shape as doctor.ts's `DoctorAction`). */
export interface RemoteRow extends CheckResult {
  kind: "remote";
  action?: { kind: "run_verb"; command: string[]; label: string } | { kind: "open_secrets"; label: string } | { kind: "open_system_settings"; label: string };
}

export interface RemoteContext {
  productDir: string;
  instanceDir: string;
  /** the install's environment, already loaded */
  env: NodeJS.ProcessEnv;
  /** this instance's `instance_id`, when it has one — what `answers from this Mac` compares `/api/identity` against */
  instanceId?: string | undefined;
  /** the record as it stands — for `status` and `revoke`, the provider's own; for `configure`, the one being replaced */
  record: RemoteRecord;
  /** the console's MAIN port — the one a provider must never forward to */
  consolePort: number;
  /** the console's proxy listener: the loopback TCP port and the Unix socket. `configure` points the provider at one of these. */
  proxyPort: number;
  proxySocket: string;
  exec: Exec;
  fetchFn: typeof fetch;
  platform: NodeJS.Platform;
  uid: number;
  /** a pasted token, when the provider needs one — stdin or a hidden prompt, never argv (stdin-value.ts) */
  readToken: (what: string) => Promise<string>;
  /** a line of explanation for the owner (dimmed by the caller) */
  note: (line: string) => void;
  /** print the plan, change nothing — the adapter honours it in `configure` and `revoke` */
  dryRun: boolean;
  /** how long a probe may take */
  timeoutMs: number;
}

/** What `detect` found — read-only facts for the chooser and the preview. */
export interface Detection {
  tool: {
    present: boolean;
    /** the pack's version, or the owner's install's */
    version?: string | undefined;
    /** where it came from: Metistry's pack, the owner's own install, or in-process code */
    from?: "pack" | "owner" | "in-process" | undefined;
  };
  /** null when the provider has no notion of being signed in (None, port forwarding) */
  signed_in: boolean | null;
  /** the origin the provider already yields, when it is already configured */
  origin?: string | undefined;
  /** what `configure` would change, one line each; empty when nothing would */
  would_change: string[];
}

/** The provider flags `metistry remote set <provider> [flags]` took (plan §2.23, "Provider flags"), as parsed; each adapter reads its own. */
export interface ProviderOptions {
  /** `--mode funnel|tailnet` (Tailscale) */
  mode?: string | undefined;
  flags: Record<string, string | boolean>;
}

export interface Configured {
  /** the stable origin the provider yields — null for a provider that exposes nothing (None) */
  origin: string | null;
  mode?: string | undefined;
  /** non-secret settings to record: `upstream` (where the provider forwards to — the proxy listener's port or socket), node names, tunnel ids, hostnames */
  settings: Record<string, string>;
}

export interface Revoked {
  /** what this run undid, one line each */
  undone: string[];
  /** what only the owner can undo at the provider, one line each */
  left_for_owner: string[];
}

export interface AuthorizeOptions {
  noBrowser: boolean;
  timeoutMs: number;
}

export interface RemoteProvider {
  id: RemoteProviderId;
  /** the chooser's label (`None`, `Tailscale — Any browser (Funnel)`) */
  label: string;
  /** Read-only: is the tool here (pack or owner install), signed in, and what would configure change? */
  detect(ctx: RemoteContext): Promise<Detection>;
  /** Idempotent. Fetch the tool (X-112), sign in or hand the owner the provider's sign-in, expose the proxy listener, return the stable origin. Writes nothing on failure. */
  configure(ctx: RemoteContext, opts: ProviderOptions): Promise<Configured>;
  /** Doctor rows: core CheckResult, kind "remote", each with a remediation and, where it can name one, an action. */
  status(ctx: RemoteContext): Promise<RemoteRow[]>;
  /** Undo exactly what configure created; name what only the owner can undo at the provider. */
  revoke(ctx: RemoteContext): Promise<Revoked>;
  /** The provider's own browser sign-in (`metistry remote authorize`), where one exists. */
  authorize?(ctx: RemoteContext, opts: AuthorizeOptions): Promise<{ signed_in: boolean; detail: string }>;
}

/**
 * One row of the chooser (plan §2.23, "The choices"), in its words. The facts
 * are the plan's; an adapter that ships later fills `available`.
 */
export interface RemoteChoice {
  id: RemoteProviderId;
  label: string;
  /** the plan's qualifier: `default`, `recommended` */
  tag?: "default" | "recommended" | undefined;
  reachable_from: string;
  /** who can read the traffic — where TLS ends */
  tls_ends_at: string;
  cost: string;
  /** what the owner needs: an account, a domain, a router */
  needs: string;
  /** whether this release has an adapter for it */
  available: boolean;
}
