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

describe("manifest schema", () => {
  it("accepts a valid TCC bridge", () => {
    const r = validateManifest(eventkit);
    expect(r.ok).toBe(true);
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
    expect(
      validateManifest({
        name: "cloud-worker",
        type: "target",
        transport: "mcp",
        submit: { tool: "run_task" },
        result: { via: "report_queue" },
        data_policy: "no_personal_comms",
      }).ok,
    ).toBe(true);
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
