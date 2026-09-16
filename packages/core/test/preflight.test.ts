// Preflight before spend (docs/ops/automation.md). Two properties matter:
// a missing prerequisite is detected WITHOUT the component running, and the
// refusal names the environment variable that would fix it — a refusal that
// does not name its knob is a riddle (Rivet review).
import { describe, expect, it } from "vitest";
import { blockedConfigMessage, preflight, requirementsOf, NO_REQUIREMENTS } from "../src/preflight.js";
import { ENGINE_CREDENTIAL_VAR } from "../src/deployment.js";
import { validateManifest } from "../src/manifest.js";

const res = (status: number) => ({ status, ok: status < 400 }) as Response;
const never = (async () => {
  throw new Error("preflight must not make a network call when nothing declares `reachable`");
}) as unknown as typeof fetch;

describe("requirementsOf", () => {
  it("reads the structured form off a validated manifest", () => {
    const r = validateManifest({
      name: "x",
      type: "collector",
      schedule: "@hourly",
      writes: ["t"],
      requires: { env: ["METISTRY_X_TOKEN"], reachable: ["METISTRY_X_URL"], engine: true },
    });
    expect(r.ok).toBe(true);
    expect(requirementsOf(r.ok ? r.manifest : {})).toEqual({ env: ["METISTRY_X_TOKEN"], reachable: ["METISTRY_X_URL"], engine: true });
  });

  it("keeps the legacy label array valid and checkless — no manifest has to be rewritten", () => {
    const r = validateManifest({ name: "x", type: "collector", schedule: "@hourly", writes: ["t"], requires: ["aws-credentials"] });
    expect(r.ok).toBe(true);
    expect(requirementsOf(r.ok ? r.manifest : {})).toEqual(NO_REQUIREMENTS);
    expect(requirementsOf(undefined)).toEqual(NO_REQUIREMENTS);
  });

  it("refuses a lower-case environment name, which would silently never match", () => {
    const r = validateManifest({ name: "x", type: "collector", schedule: "@hourly", writes: ["t"], requires: { env: ["metistry_x"] } });
    expect(r.ok).toBe(false);
  });
});

describe("preflight", () => {
  it("passes when nothing is declared, without touching the network", async () => {
    expect(await preflight(NO_REQUIREMENTS, { env: {}, fetchFn: never })).toEqual({ ok: true, missing: [] });
  });

  it("names every missing variable, and treats empty as unset", async () => {
    const r = await preflight({ env: ["METISTRY_A", "METISTRY_B"], reachable: [], engine: false }, { env: { METISTRY_A: "   " }, fetchFn: never });
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.name)).toEqual(["METISTRY_A", "METISTRY_B"]);
    expect(r.missing[0]?.why).toContain("METISTRY_A is unset");
  });

  it("probes /check on a declared url and fails closed when it cannot be reached", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      throw new Error("connect ECONNREFUSED 127.0.0.1:7801");
    }) as unknown as typeof fetch;
    const r = await preflight({ env: [], reachable: ["METISTRY_EK_URL"], engine: false }, { env: { METISTRY_EK_URL: "http://127.0.0.1:7801/" }, fetchFn });
    expect(seen).toEqual(["http://127.0.0.1:7801/check"]);
    expect(r.ok).toBe(false);
    expect(r.missing[0]).toMatchObject({ name: "METISTRY_EK_URL" });
    expect(r.missing[0]?.why).toContain("unreachable");
  });

  it("counts 401 as reachable (up, wants a token) and 5xx as not", async () => {
    const ok = await preflight({ env: [], reachable: ["U"], engine: false }, { env: { U: "http://x" }, fetchFn: (async () => res(401)) as unknown as typeof fetch });
    expect(ok.ok).toBe(true);
    const bad = await preflight({ env: [], reachable: ["U"], engine: false }, { env: { U: "http://x" }, fetchFn: (async () => res(503)) as unknown as typeof fetch });
    expect(bad.missing[0]?.why).toContain("returned 503");
  });

  it("checks the engine credential through core's one seam for a run that would enqueue a turn", async () => {
    const req = { env: [], reachable: [], engine: true };
    const missing = await preflight(req, { env: {}, fetchFn: never });
    expect(missing.missing[0]?.name).toBe(ENGINE_CREDENTIAL_VAR);
    expect(missing.missing[0]?.why).toContain("nothing would answer");
    expect((await preflight(req, { env: { [ENGINE_CREDENTIAL_VAR]: "tok" }, fetchFn: never })).ok).toBe(true);
  });

  it("blockedConfigMessage names the variables, the file and that nothing was spent", async () => {
    const r = await preflight({ env: ["METISTRY_DEVIN_API_KEY"], reachable: [], engine: false }, { env: {}, fetchFn: never });
    const m = blockedConfigMessage("devin-knowledge", "collectors/devin-knowledge", r);
    expect(m).toContain("blocked_config");
    expect(m).toContain("METISTRY_DEVIN_API_KEY");
    expect(m).toContain("collectors/devin-knowledge/manifest.yaml");
    expect(m).toContain("nothing was spent");
  });
});
