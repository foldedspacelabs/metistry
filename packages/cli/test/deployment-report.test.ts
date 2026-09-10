// `metistry deployment` / `metistry deployment set-shape` against the same
// synthetic checkout fixtures.ts builds for up/service-control: the cheap
// running check reuses doctor.ts's own launchd/compose probes (no network),
// and set-shape writes deployment.yaml through the reconciler exactly like
// metistry.lock/identity.yaml already do.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyShapeToYaml } from "../src/deployment.js";
import { buildDeploymentReport, deploymentServiceRows, renderDeploymentReport, setDeploymentShape } from "../src/deployment-report.js";
import { main } from "../src/main.js";
import { checkout, fakeExec, put, RECONCILER, WATCHDOG } from "./fixtures.js";

/** `launchctl print` for RECONCILER/WATCHDOG says running; anything else (HELPER) is not bootstrapped. */
function launchctlHandler(running: string[]) {
  return (args: string[]) => {
    if (args[0] !== "print") return { code: 1, stdout: "", stderr: "unexpected" };
    const label = String(args[1]).split("/").pop();
    return running.includes(label ?? "") ? { stdout: "\tstate = running\n\tpid = 111\n" } : { code: 3, stdout: "", stderr: "Could not find service" };
  };
}

/** `docker compose ps --all --format json` naming which of db/console/assistant are up. */
function composePsHandler(up: string[]) {
  return (args: string[]) => {
    if (args[0] !== "compose" || !args.includes("ps")) return { code: 1, stdout: "", stderr: "unexpected" };
    return { stdout: JSON.stringify(up.map((s) => ({ Service: s, State: "running" }))) };
  };
}

async function composeCheckout(): Promise<string> {
  const P = await checkout();
  await put(P, "docker-compose.yml", "services:\n  db: {}\n  console: {}\n  assistant: {}\n");
  return P;
}

describe("deploymentServiceRows / buildDeploymentReport", () => {
  it("compose shape: db/console/assistant checked via docker compose ps, reconciler/watchdog via launchctl", async () => {
    const P = await composeCheckout();
    const exec = fakeExec({ launchctl: launchctlHandler([RECONCILER, WATCHDOG]), docker: composePsHandler(["db"]) });
    const report = await buildDeploymentReport({ productDir: P, env: {}, exec, platform: "darwin", uid: 501 });
    expect(report.shape).toBe("compose");
    expect(report.services).toEqual([
      { name: "db", shape: "compose", enabled: true, running: true },
      { name: "console", shape: "compose", enabled: true, running: false },
      { name: "assistant", shape: "compose", enabled: true, running: false },
      { name: "reconciler", shape: "launchd", enabled: true, running: true },
      { name: "watchdog", shape: "launchd", enabled: true, running: true },
    ]);
    const table = renderDeploymentReport(report);
    expect(table).toContain("shape: compose (from no deployment.yaml — the built-in default)");
    expect(table).toContain("db");
  });

  it("not darwin: launchd-shaped services are not checked at all (running omitted, not false)", async () => {
    const P = await composeCheckout();
    const rows = await deploymentServiceRows(P, { shape: "compose", services: {} }, { exec: fakeExec(), uid: 0, platform: "linux" });
    const reconciler = rows.find((r) => r.name === "reconciler")!;
    expect(reconciler.running).toBeUndefined();
  });
});

describe("metistry deployment (main)", () => {
  it("--json prints the report", async () => {
    const P = await composeCheckout();
    const exec = fakeExec({ launchctl: launchctlHandler([]), docker: composePsHandler([]) });
    const out: string[] = [];
    const code = await main(["deployment", "--json", "--product-dir", P], { out: (l) => out.push(l), exec, platform: "darwin", uid: 501 });
    expect(code).toBe(0);
    const report = JSON.parse(out.join("\n"));
    expect(report.shape).toBe("compose");
    expect(report.services.map((s: { name: string }) => s.name)).toEqual(["db", "console", "assistant", "reconciler", "watchdog"]);
  });
});

describe("applyShapeToYaml", () => {
  it("writes a fresh, commented file when the instance has none yet", () => {
    const text = applyShapeToYaml(undefined, "launchd");
    expect(text).toMatch(/^shape: launchd$/m);
    expect(text).toMatch(/services: \{\}/);
  });

  it("rewrites only the shape: line, keeping comments and per-service overrides", () => {
    const existing = "# my own notes\nshape: compose\nservices:\n  db:\n    enabled: false\n";
    const text = applyShapeToYaml(existing, "launchd");
    expect(text).toBe("# my own notes\nshape: launchd\nservices:\n  db:\n    enabled: false\n");
  });
});

describe("setDeploymentShape", () => {
  it("already this shape: a no-op, nothing written", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    const lines: string[] = [];
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "compose",
      yes: true,
      env: {},
      platform: "darwin",
      uid: 501,
      fetchFn: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
      exec: fakeExec(),
      out: (l) => lines.push(l),
    });
    expect(r).toEqual({ shape: "compose", applied: false, refused: false, detail: expect.stringContaining("already shape: compose") });
  });

  it("refuses when a shaped service is still running under the current shape, without --force", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    const exec = fakeExec({ launchctl: launchctlHandler([RECONCILER, WATCHDOG]), docker: composePsHandler(["db", "console", "assistant"]) });
    const lines: string[] = [];
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "launchd",
      yes: true,
      env: {},
      platform: "darwin",
      uid: 501,
      fetchFn: (() => {
        throw new Error("must not fetch — refused before any write");
      }) as unknown as typeof fetch,
      exec,
      out: (l) => lines.push(l),
    });
    expect(r.refused).toBe(true);
    expect(r.applied).toBe(false);
    expect(r.detail).toContain("db");
    expect(r.detail).toContain("metistry stop");
    // reconciler/watchdog running is NOT a reason to refuse — they run under either shape (invariant 6)
    expect(r.detail).not.toContain("reconciler");
  });

  it("--force writes anyway even with services running", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    const exec = fakeExec({ launchctl: launchctlHandler([]), docker: composePsHandler(["db"]) });
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "launchd",
      yes: true,
      force: true,
      env: {},
      platform: "darwin",
      uid: 501,
      fetchFn: async () => new Response("{}", { status: 201 }),
      exec,
      out: () => {},
    });
    expect(r.refused).toBe(false);
    expect(r.applied).toBe(true);
    expect(await readFile(join(I, "deployment.yaml"), "utf8")).toMatch(/^shape: launchd$/m);
  });

  it("preview (no --yes): prints the plan, writes nothing, no fetch", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    const exec = fakeExec({ launchctl: launchctlHandler([]), docker: composePsHandler([]) });
    const lines: string[] = [];
    let fetched = false;
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "launchd",
      env: { METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" },
      platform: "darwin",
      uid: 501,
      fetchFn: (async () => {
        fetched = true;
        return new Response("{}", { status: 201 });
      }) as unknown as typeof fetch,
      exec,
      out: (l) => lines.push(l),
    });
    expect(r.applied).toBe(false);
    expect(r.refused).toBe(false);
    expect(fetched).toBe(false);
    expect(lines.join("\n")).toContain("[dry-run]");
    await expect(readFile(join(I, "deployment.yaml"), "utf8")).rejects.toThrow();
  });

  it("no reconciler configured: writes directly, refusing only if a reconciler job is actually running", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    const exec = fakeExec({ launchctl: launchctlHandler([]), docker: composePsHandler([]) });
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "launchd",
      yes: true,
      env: {},
      platform: "darwin",
      uid: 501,
      fetchFn: (() => {
        throw new Error("no bridge configured — must not fetch");
      }) as unknown as typeof fetch,
      exec,
      out: () => {},
    });
    expect(r.applied).toBe(true);
    expect(await readFile(join(I, "deployment.yaml"), "utf8")).toMatch(/^shape: launchd$/m);
  });

  it("through the reconciler bridge as user, exactly like metistry.lock/identity.yaml", async () => {
    const P = await composeCheckout();
    const I = await mkdtemp(join(tmpdir(), "metistry-dep-inst-"));
    await writeFile(join(I, "deployment.yaml"), "shape: compose\nservices: {}\n");
    const exec = fakeExec({ launchctl: launchctlHandler([]), docker: composePsHandler([]) });
    const calls: { url: string; init: RequestInit }[] = [];
    const r = await setDeploymentShape({
      productDir: P,
      instanceDir: I,
      targetShape: "launchd",
      yes: true,
      env: { METISTRY_RECONCILER_URL: "http://host.docker.internal:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "tok" },
      platform: "darwin",
      uid: 501,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ queued: true }), { status: 201 });
      }) as unknown as typeof fetch,
      exec,
      out: () => {},
    });
    expect(r.applied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:7812/vault/write");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ path: "deployment.yaml", content: "shape: launchd\nservices: {}\n", intent: { principal: "user", message: "metistry deployment set-shape → launchd" } });
    // it went through the bridge, not straight to disk — the reconciler commits it on its next flush
    await expect(readFile(join(I, "deployment.yaml"), "utf8")).resolves.toBe("shape: compose\nservices: {}\n");
  });
});

describe("metistry deployment set-shape (main)", () => {
  it("refuses without an instance dir", async () => {
    const P = await composeCheckout();
    const err: string[] = [];
    const code = await main(["deployment", "set-shape", "launchd", "--product-dir", P], { err: (l) => err.push(l), out: () => {} });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--instance");
  });

  it("rejects an unknown shape", async () => {
    const P = await composeCheckout();
    const err: string[] = [];
    const code = await main(["deployment", "set-shape", "podman", "--instance", await mkdtemp(join(tmpdir(), "metistry-dep-inst-")), "--product-dir", P], {
      err: (l) => err.push(l),
      out: () => {},
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  });
});
