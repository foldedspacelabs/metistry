// Preflight before spend (docs/ops/automation.md): the checks a scheduled
// component's manifest declares, run BEFORE the run row is opened. A
// collector whose token was never set should cost one cheap environment
// lookup per window, not an API call, a stack trace and a failed run row
// every hour forever — and a routine that would enqueue an assistant turn
// should not enqueue one on an install that has no engine to answer it.
//
// Every miss names the environment variable that would fix it: a refusal
// that does not tell you the knob is a riddle.

import { engineCredentialPresent, ENGINE_CREDENTIAL_VAR } from "./deployment.js";
import type { Requirements } from "./manifest.js";

export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 3_000;

/** The empty declaration: nothing to check, every run proceeds. */
export const NO_REQUIREMENTS: Requirements = { env: [], reachable: [], engine: false };

/**
 * Normalise both spellings of `requires` (manifest.ts): the legacy array of
 * labels declares nothing checkable and yields the empty requirement.
 */
export function requirementsOf(manifest: unknown): Requirements {
  const r = (manifest as { requires?: unknown } | null)?.requires;
  if (r === undefined || r === null || Array.isArray(r)) return NO_REQUIREMENTS;
  const o = r as Partial<Requirements>;
  return { env: o.env ?? [], reachable: o.reachable ?? [], engine: o.engine ?? false };
}

export interface PreflightMiss {
  /** the environment variable that would fix it — never a bare "misconfigured" */
  name: string;
  why: string;
}

export interface PreflightResult {
  ok: boolean;
  missing: PreflightMiss[];
}

export interface PreflightOptions {
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * Run the declared checks. `reachable` names variables holding a base URL,
 * probed at the one route every component on core's wire contract serves:
 * GET `<url>/check`. Any answer below 500 counts as reachable — a 401 means
 * the bridge is up and wants a token, which is a different finding and
 * doctor's to report; a refused connection or a 5xx means starting the run
 * would only burn the window.
 */
export async function preflight(req: Requirements, opts: PreflightOptions): Promise<PreflightResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const missing: PreflightMiss[] = [];

  for (const name of req.env) {
    if (trimmed(opts.env, name) === "") missing.push({ name, why: `${name} is unset` });
  }

  if (req.engine && !engineCredentialPresent(opts.env)) {
    missing.push({
      name: ENGINE_CREDENTIAL_VAR,
      why: `${ENGINE_CREDENTIAL_VAR} is unset, and this run would enqueue an assistant turn nothing would answer`,
    });
  }

  for (const name of req.reachable) {
    const base = trimmed(opts.env, name);
    if (base === "") {
      missing.push({ name, why: `${name} is unset` });
      continue;
    }
    const url = `${base.replace(/\/+$/, "")}/check`;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) missing.push({ name, why: `${name} → ${url} returned ${res.status}` });
    } catch (err) {
      missing.push({ name, why: `${name} → ${url} unreachable (${err instanceof Error ? err.message : String(err)})` });
    }
  }

  return { ok: missing.length === 0, missing };
}

/**
 * The one sentence a blocked window records and alerts with. Named after
 * Hermes's `blocked_config` because that is exactly the state: not a failure
 * of the component, a failure to configure it.
 */
export function blockedConfigMessage(component: string, dir: string, result: PreflightResult): string {
  const names = result.missing.map((m) => m.name).join(", ");
  return (
    `blocked_config: ${component} did not run — ${result.missing.map((m) => m.why).join("; ")}. ` +
    `Set ${names} in this install's .env (\`metistry secrets sync --to env\`), or drop ${names} from \`requires\` in ${dir}/manifest.yaml if it is no longer needed. ` +
    `No run was started, so nothing was spent.`
  );
}
