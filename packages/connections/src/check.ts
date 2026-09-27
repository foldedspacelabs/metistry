// `check()` for a connection (core's frozen shape; research §4.12): dial it,
// `initialize`, `tools/list`, and compare what the server offers with what
// the owner listed. The four verdicts are doctor's own, and each means one
// thing (screen 9's rule):
//
//   ok        it answered, and every tool the file lists is on offer
//   degraded  it answered, and a tool the file lists is gone — a real and
//             under-appreciated failure mode: a call to it will fail
//   absent    it is configured but something it needs is not here: the
//             provider's connection type, a secret's Keychain item, a
//             variable, the command itself — named, never spent
//   failed    the file is wrong, the credential is refused at the door, or
//             the server could not be reached at all — with the error
//             verbatim (redacted)
//
// A check is a dial like any other: through the pool, so it is bound by
// every rule the pool enforces — the egress door, the closed environment,
// the origin pin.

import { EgressRefused, runCheck, type CheckResult } from "@foldedspacelabs/metistry-core";
import type { ConnectionCatalog } from "./catalog.js";
import { ConnectionRefused } from "./errors.js";
import type { ConnectionPool, UpstreamTool } from "./pool.js";

/** What a check found, beside its verdict — the facts the Connections screen shows under *Last checked*. */
export interface ConnectionCheckMeta {
  /** tools the server offered */
  tools_seen: number;
  /** tools the file lists */
  listed: number;
  /** listed, and not on offer — each call to one will fail */
  missing: string[];
  /** on offer, and not listed — refused before dialling until the owner lists one */
  unlisted: string[];
  /** the server marks these read-only: a hint the owner may act on, never a control */
  read_only_hint: string[];
}

type Verdict = Pick<CheckResult, "status" | "remediation" | "meta">;

/** How a refusal reads as a verdict: missing-here is `absent`, everything else `failed`. */
function refusalVerdict(err: ConnectionRefused | EgressRefused): Verdict {
  if (err instanceof EgressRefused) {
    return { status: err.code === "missing_secret" ? "absent" : "failed", remediation: err.message };
  }
  const absent =
    err.code === "not_built" ||
    err.code === "runs_elsewhere" ||
    err.code === "variable" ||
    (err.code === "secret" && /no item in this instance/.test(err.message));
  return { status: absent ? "absent" : "failed", remediation: err.message };
}

function describeReach(catalog: ConnectionCatalog, name: string): string {
  const c = catalog.entries.find((e) => e.name === name)?.connection;
  if (!c) return "read the connection file";
  if (c.reach.http) return `initialize + tools/list over HTTP (${c.reach.http.url})`;
  if (c.reach.command) return `initialize + tools/list over stdio (${c.reach.command.command})`;
  return "read the connection file";
}

/**
 * Check one connection. Never throws: every outcome is a verdict. Reported to
 * the pool's host as a `connection_check` event, like every dial.
 */
export async function checkConnection(pool: ConnectionPool, catalog: ConnectionCatalog, name: string): Promise<CheckResult> {
  const entry = catalog.entries.find((e) => e.name === name);
  const probe = describeReach(catalog, name);
  const started = Date.now();
  let seen: UpstreamTool[] | undefined;
  const result = await runCheck(name, probe, async (): Promise<Verdict> => {
    if (!entry) return { status: "failed", remediation: `no connection named ${name} — \`metistry connections list\` names them` };
    if (entry.status !== "ok" || !entry.connection) {
      return { status: entry.status === "absent" ? "absent" : "failed", remediation: entry.issues.join("; ") };
    }
    try {
      seen = await pool.upstreamTools(name, { fresh: true });
    } catch (err) {
      if (err instanceof ConnectionRefused || err instanceof EgressRefused) return refusalVerdict(err);
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { status: "absent", remediation: `the command is not on this Mac (${entry.connection.reach.command?.command ?? "?"}) — install it, or give its full path in the connection` };
      }
      return { status: "failed", remediation: err instanceof Error ? err.message : String(err) };
    }
    const listed = Object.keys(entry.connection.tools).sort();
    const offered = new Set(seen.map((t) => t.name));
    const missing = listed.filter((t) => !offered.has(t));
    const meta: ConnectionCheckMeta = {
      tools_seen: seen.length,
      listed: listed.length,
      missing,
      unlisted: seen.map((t) => t.name).filter((t) => !Object.hasOwn(entry.connection!.tools, t)).sort(),
      read_only_hint: seen.filter((t) => t.readOnly).map((t) => t.name).sort(),
    };
    if (missing.length > 0) {
      return {
        status: "degraded",
        remediation: `the server no longer offers ${missing.join(", ")} — a call to ${missing.length === 1 ? "it" : "them"} will fail; \`metistry connections policy ${name} <tool> never\` to stop offering ${missing.length === 1 ? "it" : "them"}`,
        meta: { ...meta },
      };
    }
    return { status: "ok", meta: { ...meta } };
  });
  const out: CheckResult = seen ? { ...result, probe: `${probe}: ${seen.length} tool${seen.length === 1 ? "" : "s"} offered, ${Object.keys(entry?.connection?.tools ?? {}).length} listed` } : result;
  await pool.emit({
    kind: "connection_check",
    connection: name,
    ok: out.status === "ok" || out.status === "degraded",
    ...(out.status === "ok" ? {} : { error: out.remediation }),
    ms: Date.now() - started,
    secrets: [],
    meta: { status: out.status, ...(out.meta ?? {}) },
  });
  return out;
}
