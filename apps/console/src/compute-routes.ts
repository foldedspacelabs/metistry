// `/api/compute*` — the Compute pane's server side (docs/product/app-ux-plan.md
// §6 phase D). Until this shipped, providers, assignments and budgets were
// reachable only from `metistry compute` on the Mac that holds the instance
// repo, so P6 ("every client can do everything") was violated by
// construction: the phone could see what a turn cost and could not move it
// to a cheaper model.
//
// Three things this file exists to hold.
//
//   * **One implementation.** Every verb here calls the SAME exported
//     function `metistry compute` calls (`packages/cli/src/compute.ts`):
//     the file is edited as a YAML document so comments and hand-written
//     blocks survive, the RESULT is re-validated through core's schema
//     before anything is written, and the write goes through the
//     reconciler as the `user` principal (invariant 2, D5). There is no
//     second editor and no second validator.
//   * **Owner-only configuration, not an "action".** Invariant 10 closes
//     the console's *action* surface — an enumerated set of doors onto
//     audited services, each one a product change to add. These routes are
//     not on that list and are not meant to be: they are the owner's own
//     configuration, gated on the `user` principal, and no agent, no
//     prompt and no proposal can reach them. `runAction` has no compute
//     kind, which is that statement in code.
//   * **A secret never crosses this boundary.** `providers add` and
//     `providers remove` are absent on purpose: adding a provider takes a
//     key, and a key belongs on stdin into the login Keychain, from the
//     hand of the person at the machine. What the read route reports is
//     the NAME of the secret a provider authenticates with and whether an
//     item of that name exists — presence, never a value, and nothing
//     here can print one.
//
// It degrades absent, like every other optional surface: with no
// `METISTRY_INSTANCE_DIR` the console cannot see the file these verbs edit,
// and every route answers `503 not_available` naming the variable.

import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BUDGET_ACTIONS,
  EFFORTS,
  resolveInstanceLayout,
  SPEND_QUERY,
  computePaths,
  errorEnvelope,
  spentFrom,
  statusFor,
  type Effort,
  type Spent,
  type SpendRow,
} from "@foldedspacelabs/metistry-core";
import {
  assign,
  computeFiles,
  computeReport,
  instanceComputeFile,
  modelsList,
  parseAssignmentTarget,
  parseBudgetTarget,
  providerTest,
  setBudget,
  StepFailed,
  type AssignmentTarget,
  type BudgetTarget,
  type ComputeOptions,
} from "@foldedspacelabs/metistry-cli";
import type { QueryStore } from "@foldedspacelabs/metistry-queries";
import { readJson, sendError, sendJson, sendUnrouted } from "./http-util.js";

/**
 * What the console needs to drive the verbs: where the instance repo is, and
 * the environment a provider's `auth.secret` resolves in. `platform` decides
 * whether there is a login Keychain to ask about secret PRESENCE at all — in
 * a container there is not, and `secret_present` is honestly `false` there
 * rather than silently omitted.
 *
 * Absent from `ConsoleConfig` = this deployment has no instance directory the
 * console can see (the compose shape gives it no mount, by design), and every
 * route below answers `not_available`.
 */
export interface ComputeAdmin {
  /** the instance repo — `<instanceDir>/.metistry/compute.yaml` is the file every write lands in */
  instanceDir: string;
  /** the product's `seed/`, for the overlay's first entry */
  seedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  fetchFn?: typeof fetch | undefined;
}

/** Everything under this prefix is owner-only configuration. Used by server.ts's management gate so a non-`user` credential gets the canonical 403, never a 404 that would say whether compute is configured. */
export function isComputeRoute(pathname: string): boolean {
  return pathname === "/api/compute" || pathname.startsWith("/api/compute/");
}

const ROUTES = new Set([
  "GET /api/compute",
  "GET /api/compute/models",
  "POST /api/compute/assign",
  "POST /api/compute/budget",
  "POST /api/compute/providers/test",
]);

const NOT_AVAILABLE =
  "compute configuration is not reachable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance repo it should read `.metistry/compute.yaml` from " +
  "(the compose shape deliberately gives the console no instance mount; the launchd/native shape has one — docs/ops/deployment-shapes.md). " +
  "`metistry compute show` works either way.";

function options(admin: ComputeAdmin, out: string[]): ComputeOptions {
  return {
    instanceDir: admin.instanceDir,
    seedDir: admin.seedDir,
    env: admin.env,
    platform: admin.platform,
    uid: admin.uid,
    ...(admin.fetchFn ? { fetchFn: admin.fetchFn } : {}),
    out: (line) => out.push(line),
  };
}

/**
 * The console will not write a `compute.yaml` it is not reading.
 *
 * Every write verb opens the instance's own file, edits the document and
 * writes the whole thing back. If the overlay in force ends somewhere other
 * than `<instanceDir>/.metistry/compute.yaml` — an operator's
 * `METISTRY_COMPUTE_FILES` naming a path this process resolves differently —
 * the verb would open a file that is not there, start from a bare header and
 * deliver a FOUR-LINE file over the real one. So the mismatch is a refusal
 * naming the variable, checked before anything is opened.
 */
export function writeTargetIssue(opts: ComputeOptions): string | undefined {
  const paths = computePaths(computeFiles(opts));
  const last = paths.at(-1);
  const target = instanceComputeFile(opts.instanceDir);
  if (last !== undefined && resolve(last) === resolve(target)) return undefined;
  return (
    `refusing to write ${resolveInstanceLayout(opts.instanceDir).layout.compute}: the overlay in force is ${paths.join(" → ") || "(empty)"}, whose last entry is ` +
    `${last ?? "(none)"}, not ${target}. This console would edit a file it cannot read and overwrite the one you have — ` +
    `point METISTRY_COMPUTE_FILES at ${target} last, or use \`metistry compute\` on the machine that holds the instance repo.`
  );
}

/** Both budget windows, per scope, from the ONE spend read path (invariant 3). Absent query = null, never a guessed zero. */
async function spend(queries: QueryStore, providers: string[]): Promise<{ instance: Spent; providers: Record<string, Spent> } | null> {
  if (!queries.names().includes(SPEND_QUERY)) return null;
  const { rows } = await queries.run(SPEND_QUERY);
  const spendRows = rows as SpendRow[];
  return {
    instance: spentFrom(spendRows),
    providers: Object.fromEntries(providers.map((name) => [name, spentFrom(spendRows, name)])),
  };
}

/** `{tier}` or `{crew}` → the CLI's target spelling. Exactly one, never both: two targets in one body is a request nobody can mean. */
export function assignTargetOf(body: Record<string, unknown>): { ok: true; target: AssignmentTarget } | { ok: false; message: string } {
  const tier = body.tier;
  const crew = body.crew;
  const named = [tier !== undefined ? "tier" : null, crew !== undefined ? "crew" : null].filter(Boolean);
  if (named.length !== 1) {
    return { ok: false, message: `give exactly one of tier or crew (you gave ${named.length === 0 ? "neither" : named.join(" and ")}) — tier is a name from rules.yaml's tiers: block or "default", crew is a crew name` };
  }
  const raw = tier ?? crew;
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, message: `${named[0]} must be a non-empty string` };
  try {
    return { ok: true, target: parseAssignmentTarget(crew !== undefined ? `crew:${raw.trim()}` : raw.trim()) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** `{scope}` → `instance` or `provider:<name>`, through the CLI's own parser so a typo is refused identically on both doors. */
export function budgetTargetOf(body: Record<string, unknown>): { ok: true; target: BudgetTarget } | { ok: false; message: string } {
  if (typeof body.scope !== "string" || body.scope.trim() === "") {
    return { ok: false, message: 'scope must be "instance" or "provider:<name>" — whose budget this is' };
  }
  try {
    return { ok: true, target: parseBudgetTarget(body.scope.trim()) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** A USD amount: a finite non-negative number, or null to leave it as it stands. Strings are refused — a budget parsed out of "60 " is not a limit anyone set. */
function money(body: Record<string, unknown>, field: string): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const v = body[field];
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, message: `${field} must be a non-negative number of US dollars, or omitted to keep the current one` };
  return { ok: true, value: v };
}

type Audit = (kind: string, tool: string, ok: boolean, meta: Record<string, unknown>) => Promise<void>;

/**
 * GET /api/compute · GET /api/compute/models · POST /api/compute/assign ·
 * POST /api/compute/budget · POST /api/compute/providers/test
 *
 * server.ts has already established the `user` principal. One `runs` row per
 * request records the door (`component: console`, `kind: compute_admin`);
 * the reconciler records the commit.
 */
export async function computeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  url: URL,
  deps: { admin: ComputeAdmin | undefined; queries: QueryStore; audit: Audit },
): Promise<void> {
  if (!ROUTES.has(key)) return sendUnrouted(res);
  const { admin } = deps;
  if (!admin) return sendError(res, "not_available", NOT_AVAILABLE);
  const notes: string[] = [];
  const opts = options(admin, notes);

  try {
    if (key === "GET /api/compute") {
      const report = await computeReport(opts);
      return sendJson(res, 200, {
        ...report,
        spend: await spend(deps.queries, report.providers.map((p) => p.name)),
        // What the WRITE verbs will refuse, reported with the read so a
        // client can grey the controls instead of discovering it on submit.
        writable: writeTargetIssue(opts) === undefined,
        as_of: new Date().toISOString(),
      });
    }

    if (key === "GET /api/compute/models") {
      const provider = url.searchParams.get("provider");
      if (provider !== null && provider.trim() === "") return sendError(res, "invalid_request", "provider must be a declared provider name, or omitted for every one");
      const r = await modelsList({ ...opts, ...(provider ? { provider: provider.trim() } : {}) });
      return sendJson(res, 200, { ...r, as_of: new Date().toISOString() });
    }

    if (key === "POST /api/compute/providers/test") {
      const body = (await readJson(req)) as Record<string, unknown>;
      if (typeof body.name !== "string" || body.name.trim() === "") return sendError(res, "invalid_request", "name must be a provider declared in compute.yaml (GET /api/compute lists them)");
      if (body.complete !== undefined && typeof body.complete !== "boolean") return sendError(res, "invalid_request", "complete must be a boolean — true adds a real one-token completion on an assigned model");
      const r = await providerTest({ ...opts, name: body.name.trim(), ...(body.complete === true ? { complete: true } : {}) });
      await deps.audit("compute_admin", "provider_test", r.ok, { provider: r.name, complete: body.complete === true });
      return sendJson(res, 200, { ...r, notes, as_of: new Date().toISOString() });
    }

    // ----- the two writes -----
    const issue = writeTargetIssue(opts);
    if (issue) {
      await deps.audit("compute_admin", key.endsWith("/assign") ? "assign" : "budget", false, { refused: "write_target" });
      return sendError(res, "invalid_request", issue);
    }

    if (key === "POST /api/compute/assign") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const target = assignTargetOf(body);
      if (!target.ok) return sendError(res, "invalid_request", target.message);
      if (typeof body.model !== "string" || body.model.trim() === "") return sendError(res, "invalid_request", "model must be `<provider>/<model>` — the provider name from compute.yaml and the id that provider serves (GET /api/compute/models)");
      if (body.effort !== undefined && !(EFFORTS as readonly string[]).includes(String(body.effort))) {
        return sendError(res, "invalid_request", `effort must be one of ${EFFORTS.join(" | ")} — omit it to keep the effort already on this assignment (medium for a new one)`);
      }
      const r = await assign({
        ...opts,
        target: target.target,
        model: body.model.trim(),
        ...(body.effort === undefined ? {} : { effort: body.effort as Effort }),
      });
      await deps.audit("compute_admin", "assign", true, { target: r.target, provider: r.provider, model: r.model, effort: r.effort, warn_non_zdr: r.warn_non_zdr });
      return sendJson(res, 200, { ok: true, ...r, notes });
    }

    // POST /api/compute/budget
    const body = (await readJson(req)) as Record<string, unknown>;
    const target = budgetTargetOf(body);
    if (!target.ok) return sendError(res, "invalid_request", target.message);
    const daily = money(body, "daily");
    if (!daily.ok) return sendError(res, "invalid_request", daily.message);
    const monthly = money(body, "monthly");
    if (!monthly.ok) return sendError(res, "invalid_request", monthly.message);
    if (typeof body.action !== "string" || !(BUDGET_ACTIONS as readonly string[]).includes(body.action)) {
      return sendError(res, "invalid_request", `action must be one of ${BUDGET_ACTIONS.join(" | ")} — what happens when the limit is reached; a typo must never silently weaken a budget`);
    }
    const r = await setBudget({
      ...opts,
      target: target.target,
      ...(daily.value === undefined ? {} : { daily: daily.value }),
      ...(monthly.value === undefined ? {} : { monthly: monthly.value }),
      action: body.action as (typeof BUDGET_ACTIONS)[number],
    });
    await deps.audit("compute_admin", "budget", true, { target: r.target, daily_usd: r.daily_usd ?? null, monthly_usd: r.monthly_usd ?? null, action: r.action });
    return sendJson(res, 200, { ok: true, ...r, notes });
  } catch (err) {
    // A verb's own refusal already names the field (`assignments.default is
    // not set yet …`, `providers.x is not declared in …`); passing it
    // through is the whole of R3 on this surface.
    if (err instanceof StepFailed) {
      await deps.audit("compute_admin", key, false, { refused: "step_failed" });
      return sendError(res, "invalid_request", err.message);
    }
    if (err instanceof SyntaxError) return sendError(res, "invalid_request", "request body is not JSON");
    // A `compute.yaml` that does not parse reaches here as a plain Error out
    // of core's schema. It is the file's fault, not the caller's, but the
    // caller is the only one who can fix it — so it comes back named.
    if (err instanceof Error && /compute\.yaml|providers\.|assignments\.|budgets\./.test(err.message)) {
      await deps.audit("compute_admin", key, false, { refused: "invalid_file" });
      return sendJson(res, statusFor("invalid_request"), errorEnvelope("invalid_request", `compute.yaml does not validate: ${err.message}`));
    }
    throw err;
  }
}
