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
  data_policy: { allow: ["Projects"], deny_sources: ["comms"], max_brief_bytes: 16384 },
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

  it("rejects allow entries that are not vault prefixes or that traverse", () => {
    // lowercase root (the casing rule), traversal, trailing slash, absolute,
    // the machinery, and Artifacts/ — which is content but not knowledge
    for (const bad of ["areas/Fsl", "Areas/../secrets", "Projects/", "/etc", ".metistry/queries", "Artifacts/bundle-1"]) {
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

  // §2.15 (T8-1, Q6): the enum stays closed at seven values, and a bridge
  // declaring the live-capture grants is held to the same PoC-1 rule as
  // every other TCC bridge.
  it("accepts the live-capture TCC grants, held to PoC-1 like any other", () => {
    const liveCapture = {
      ...eventkit,
      name: "live-capture",
      requires_tcc: ["screen_recording", "microphone", "audio_capture"],
    };
    expect(validateManifest(liveCapture).ok).toBe(true);
    expect(validateManifest({ ...liveCapture, transport: "stdio", port: undefined }).ok).toBe(false);
    expect(validateManifest({ ...liveCapture, runs_on: "container" }).ok).toBe(false);
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

  // `uses_model:` — the ONE model a collector may call (PR 4). The manifest
  // states it; CI and `completeJson()` are what refuse a billable one.
  it("a collector may pin one `<provider>/<model-id>`, and nothing else", () => {
    const drain = { name: "inbox-drain", type: "collector", schedule: "*/5 * * * *", writes: ["proposals"] };
    expect(validateManifest({ ...drain, uses_model: "applefm/foundation-model" }).ok).toBe(true);
    expect(validateManifest(drain).ok).toBe(true); // absent is the normal case

    for (const bad of ["applefm", "applefm/auto", "openrouter/anthropic/claude-sonnet-5:auto", "", "  spaced/model "]) {
      const r = validateManifest({ ...drain, uses_model: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toContain("uses_model");
    }
    // a list of fallbacks is the thing invariant 4 exists to refuse
    expect(validateManifest({ ...drain, uses_model: ["applefm/foundation-model", "openrouter/x"] }).ok).toBe(false);
  });

  it("rejects an unparseable cron schedule", () => {
    expect(
      validateManifest({ name: "x", type: "collector", schedule: "whenever", writes: ["metrics"] }).ok,
    ).toBe(false);
  });

  // §2.5 (T3-1): a manifest carries its default schedule in the closed shape
  // — the time of day the runner fires it at — and is held to the same closed
  // set scheduled.yaml is. A missing schedule is still refused.
  it("accepts §2.5's closed shape as a schedule, refuses what the closed set refuses, and still requires one", () => {
    const fold = { name: "knowledge-fold", type: "routine" };
    expect(validateManifest({ ...fold, schedule: { days: "working_days", at: ["07:00"] } }).ok).toBe(true);
    expect(validateManifest({ ...fold, schedule: { days: ["sun"], at: ["18:00"], tz: "Europe/London" } }).ok).toBe(true);
    expect(validateManifest({ name: "inbox-drain", type: "collector", schedule: { every: "5m" }, writes: ["proposals"] }).ok).toBe(true);

    const every10 = validateManifest({ ...fold, schedule: { every: "10m" } });
    expect(every10.ok).toBe(false);
    if (!every10.ok) expect(every10.errors.join(" ")).toContain("schedule.every: every must be one of 5m, 15m, 1h, 6h");
    expect(validateManifest({ ...fold, schedule: { days: "working_days", at: ["7:00"] } }).ok).toBe(false);
    expect(validateManifest(fold).ok).toBe(false);
  });

  it("never throws on garbage", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest(42).ok).toBe(false);
    expect(validateManifest({ type: "spaceship" }).ok).toBe(false);
  });
});
