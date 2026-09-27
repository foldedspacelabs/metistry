// Why a connection call was refused. A closed set: each code is a code path
// with a test (U3), and every one of them is decided BEFORE anything is
// dialled — no child is spawned and no request leaves the machine for a
// call this list refuses.
//
// Refusals at the egress door itself (a secret bound for an unlisted host, a
// secret in a URL, a grant the owner did not give) are core's
// `EgressRefused`, thrown by `guardedFetch` before a byte is sent; this
// package passes them through unchanged rather than re-wording them.

export const CONNECTION_REFUSAL_CODES = [
  /** no `.metistry/connections/<name>.yaml` */
  "unknown_connection",
  /** the file does not validate, or its provider is not installed — the issues are named */
  "not_ready",
  /** the tool is not in the file's `tools:` — the allowlist is the file, so an unnamed tool does not exist */
  "tool_not_listed",
  /** the tool's mode is Never (`off`) */
  "tool_off",
  /** the tool's mode is Ask First (`ask`) and the caller holds no approval of this call */
  "needs_approval",
  /** the caller's own bearer is in the arguments — it is never forwarded upstream */
  "caller_credential",
  /** an HTTP connection's request to another origin, or a redirect — it goes to its own URL and nowhere else */
  "other_host",
  /** `runs_on` names a place this process is not (a host command from a containerised console) */
  "runs_elsewhere",
  /** something this release does not dial: a non-MCP type, an auth scheme or reach that arrives later */
  "not_built",
  /** a `{{ variable.x }}` that does not fill */
  "variable",
  /** a secret a command's environment needs: not granted to the connection, or no item in this instance */
  "secret",
] as const;
export type ConnectionRefusalCode = (typeof CONNECTION_REFUSAL_CODES)[number];

/**
 * A refusal. The message names connections, tools, secrets and variables —
 * never a value — so it is safe to show, log and record as it is.
 */
export class ConnectionRefused extends Error {
  override readonly name = "ConnectionRefused";
  constructor(
    readonly code: ConnectionRefusalCode,
    readonly connection: string,
    message: string,
    readonly tool?: string | undefined,
  ) {
    super(`connection ${connection} refused (${code}): ${message}`);
  }
}
