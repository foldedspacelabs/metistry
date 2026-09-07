import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest.js";

const eventkit = {
  name: "eventkit",
  type: "bridge",
  transport: "http",
  port: 7801,
  runs_on: "host",
  requires_tcc: ["calendars", "reminders"],
  exposes: [{ name: "list_events" }, { name: "create_event", destructive: true }],
};

// §4.18.B: the plan's own example, with the data policy as a block (the
// dispatch tool enforces it, so it must be structured, not a slogan).
const cloudWorker = {
  name: "cloud-worker",
  type: "target",
  transport: "mcp",
  submit: { tool: "run_task" },
  result: { via: "report_queue" },
  auth: "env:CLOUD_WORKER_TOKEN",
  cost: { per_run_estimate_usd: 0.1 },
  data_policy: { allow: ["Knowledge/Projects"], deny_sources: ["comms"], max_brief_bytes: 16384 },
};

describe("target manifests (§4.18)", () => {
  it("accepts a github target with submit.repo as owner/repo or env:VAR", () => {
    const gh = { ...cloudWorker, name: "github-issues", transport: "github", submit: { repo: "env:METISTRY_GITHUB_DISPATCH_REPO" } };
    expect(validateManifest(gh).ok).toBe(true);
    expect(validateManifest({ ...gh, submit: { repo: "foldedspacelabs/metistry" } }).ok).toBe(true);
  });

  it("rejects a github target without submit.repo or auth", () => {
    const gh = { ...cloudWorker, transport: "github" };
    const r = validateManifest({ ...gh, submit: { tool: "x" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/submit\.repo/);
    const { auth: _a, ...noAuth } = { ...gh, submit: { repo: "o/r" } };
    expect(validateManifest(noAuth).ok).toBe(false);
  });

  it("rejects a missing or unstructured data_policy", () => {
    const { data_policy: _d, ...none } = cloudWorker;
    const r = validateManifest(none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/data_policy/);
    expect(validateManifest({ ...cloudWorker, data_policy: "no_personal_comms" }).ok).toBe(false);
    expect(validateManifest({ ...cloudWorker, data_policy: { allow: [] } }).ok).toBe(false); // every field is a declaration
  });

  it("rejects allow entries that are not Knowledge/ prefixes or that traverse", () => {
    for (const bad of ["Areas/fsl", "Knowledge/../secrets", "Knowledge/Projects/", "/etc"]) {
      expect(validateManifest({ ...cloudWorker, data_policy: { ...cloudWorker.data_policy, allow: [bad] } }).ok).toBe(false);
    }
    expect(validateManifest({ ...cloudWorker, data_policy: { ...cloudWorker.data_policy, allow: [] } }).ok).toBe(true);
  });

  it("rejects a literal secret in auth — env references only", () => {
    expect(validateManifest({ ...cloudWorker, auth: "ghp_abc123" }).ok).toBe(false);
  });

  it("rejects a non-positive max_brief_bytes and a result without via", () => {
    expect(validateManifest({ ...cloudWorker, data_policy: { ...cloudWorker.data_policy, max_brief_bytes: 0 } }).ok).toBe(false);
    expect(validateManifest({ ...cloudWorker, result: { channel: "x" } }).ok).toBe(false);
  });
});

describe("manifest schema", () => {
  it("accepts a valid TCC bridge", () => {
    const r = validateManifest(eventkit);
    expect(r.ok).toBe(true);
  });

  it("defaults discovery to eager (PoC-17)", () => {
    const r = validateManifest(eventkit);
    if (r.ok && r.manifest.type === "bridge") expect(r.manifest.discovery).toBe("eager");
    else expect.fail("expected bridge manifest");
  });

  // Misuse test — PoC-1 rule: TCC bridges may not be stdio or in-container.
  it("rejects a TCC bridge over stdio", () => {
    const r = validateManifest({ ...eventkit, transport: "stdio", port: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/PoC-1/);
  });

  it("rejects a TCC bridge in a container", () => {
    const r = validateManifest({ ...eventkit, runs_on: "container" });
    expect(r.ok).toBe(false);
  });

  it("rejects an http bridge without a port", () => {
    const { port: _p, ...noPort } = eventkit;
    expect(validateManifest(noPort).ok).toBe(false);
  });

  it("rejects TitleCase component names (casing boundary)", () => {
    expect(validateManifest({ ...eventkit, name: "EventKit" }).ok).toBe(false);
  });

  it("accepts collector, routine, target, service types", () => {
    expect(
      validateManifest({
        name: "aws-costs",
        type: "collector",
        schedule: "0 */6 * * *",
        writes: ["metrics"],
      }).ok,
    ).toBe(true);
    expect(validateManifest({ name: "evening-review", type: "routine", schedule: "@daily" }).ok).toBe(true);
    expect(validateManifest(cloudWorker).ok).toBe(true);
    expect(validateManifest({ name: "watchdog", type: "service", runs_on: "host" }).ok).toBe(true);
  });

  it("rejects an unparseable cron schedule", () => {
    expect(
      validateManifest({ name: "x", type: "collector", schedule: "whenever", writes: ["metrics"] }).ok,
    ).toBe(false);
  });

  it("never throws on garbage", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
    expect(validateManifest({ type: "spaceship" }).ok).toBe(false);
  });
});
