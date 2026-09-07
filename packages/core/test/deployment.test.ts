// deployment.yaml: the schema, the D4 overlay, and the one URL resolver
// every shape goes through.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOYMENT,
  enabled,
  overlayDeployment,
  parseDeployment,
  resolveUrl,
  servicePlan,
  shapeOf,
  usesCompose,
  type Deployment,
} from "../src/deployment.js";

describe("parseDeployment", () => {
  it("defaults to the shape today's installs have, and to no overrides", () => {
    expect(parseDeployment({})).toEqual({ shape: "compose", services: {} });
    expect(parseDeployment(null)).toEqual(DEFAULT_DEPLOYMENT);
    expect(parseDeployment(undefined)).toEqual(DEFAULT_DEPLOYMENT);
  });

  it("accepts the launchd shape with per-service overrides", () => {
    expect(parseDeployment({ shape: "launchd", services: { db: { shape: "compose" }, assistant: { enabled: false } } })).toEqual({
      shape: "launchd",
      services: { db: { shape: "compose" }, assistant: { enabled: false } },
    });
  });

  it("refuses a typo rather than silently falling back to compose", () => {
    expect(() => parseDeployment({ shape: "launchd " })).toThrow(/shape/);
    expect(() => parseDeployment({ shape: "systemd" })).toThrow(/shape/);
    expect(() => parseDeployment({ shape: "compose", srevices: {} })).toThrow(/srevices|Unrecognized/);
    expect(() => parseDeployment({ shape: "compose", services: { db: { shape: "docker" } } })).toThrow(/services\.db\.shape/);
    expect(() => parseDeployment({ shape: "compose" }, "my.yaml")).not.toThrow();
    expect(() => parseDeployment({ shape: "nope" }, "my.yaml")).toThrow(/^my\.yaml:/);
  });
});

describe("the D4 overlay", () => {
  const seed: Deployment = { shape: "compose", services: { db: { shape: "compose" } } };

  it("no instance file leaves the seeded default alone", () => {
    expect(overlayDeployment(seed, undefined)).toEqual(seed);
  });

  it("the instance's shape wins whole, and its per-service keys merge over the seeded ones", () => {
    const merged = overlayDeployment(seed, { shape: "launchd", services: { db: { enabled: false }, console: { shape: "compose" } } });
    expect(merged).toEqual({ shape: "launchd", services: { db: { shape: "compose", enabled: false }, console: { shape: "compose" } } });
    // a NEW seeded default appears without touching the user's file
    expect(overlayDeployment({ shape: "compose", services: { newthing: { enabled: false } } }, { shape: "launchd", services: {} })).toEqual({
      shape: "launchd",
      services: { newthing: { enabled: false } },
    });
  });
});

describe("what runs where", () => {
  it("a per-service override beats the install-wide shape", () => {
    const d = parseDeployment({ shape: "launchd", services: { db: { shape: "compose" } } });
    expect(shapeOf(d, "db")).toBe("compose");
    expect(shapeOf(d, "console")).toBe("launchd");
    expect(enabled(d, "console")).toBe(true);
  });

  it("reconciler and watchdog are host jobs in BOTH shapes (invariant 6)", () => {
    const plan = servicePlan(parseDeployment({ shape: "compose" }));
    expect(Object.fromEntries(plan.map((p) => [p.name, p.shape]))).toEqual({
      db: "compose",
      console: "compose",
      assistant: "compose",
      reconciler: "launchd",
      watchdog: "launchd",
    });
  });

  it("docker is consulted only when some service actually needs it", () => {
    expect(usesCompose(parseDeployment({ shape: "compose" }))).toBe(true);
    expect(usesCompose(parseDeployment({ shape: "launchd" }))).toBe(false);
    // one container left behind under a launchd install still needs docker
    expect(usesCompose(parseDeployment({ shape: "launchd", services: { db: { shape: "compose" } } }))).toBe(true);
    // …but not if it is switched off
    expect(usesCompose(parseDeployment({ shape: "launchd", services: { db: { shape: "compose", enabled: false } } }))).toBe(false);
  });
});

describe("resolveUrl — the one place a configured url is resolved", () => {
  it("from the host, a compose hostname becomes loopback in either shape", () => {
    expect(resolveUrl("http://host.docker.internal:7812/", { shape: "compose" })).toBe("http://127.0.0.1:7812");
    expect(resolveUrl("http://console:8080/mcp", { shape: "launchd" })).toBe("http://127.0.0.1:8080/mcp");
    expect(resolveUrl("http://db:5432", { shape: "launchd" })).toBe("http://127.0.0.1:5432");
  });

  it("leaves a real host alone", () => {
    expect(resolveUrl("http://10.0.0.5:7812", { shape: "compose" })).toBe("http://10.0.0.5:7812");
    expect(resolveUrl("https://mac-studio.tailee85c6.ts.net", { shape: "launchd" })).toBe("https://mac-studio.tailee85c6.ts.net");
  });

  it("inside a container under the compose shape the url is already right", () => {
    expect(resolveUrl("http://console:8080/mcp", { shape: "compose", vantage: "container" })).toBe("http://console:8080/mcp");
    // under launchd there is no container, so the vantage cannot save it
    expect(resolveUrl("http://console:8080/mcp", { shape: "launchd", vantage: "container" })).toBe("http://127.0.0.1:8080/mcp");
  });

  it("an unparseable url comes back untouched — reporting it is doctor's job", () => {
    expect(resolveUrl("not a url", { shape: "launchd" })).toBe("not a url");
    expect(resolveUrl("", { shape: "compose" })).toBe("");
  });
});
