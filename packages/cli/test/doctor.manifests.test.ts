// The manifest walk over the REAL checkout: everything currently shipped
// must validate, and every http bridge/service must map onto a probe. This
// is the test that keeps doctor generic — a new component either validates
// or breaks CI here.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { doctor, launchdLabels, walkManifests } from "../src/doctor.js";
import { isProductCheckout, resolveProductDir } from "../src/env.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("manifest walk over the checkout", () => {
  it("finds every shipped manifest and all of them validate", async () => {
    const found = await walkManifests(repoRoot);
    const invalid = found.filter((f) => !f.result.ok).map((f) => `${f.dir}: ${f.result.ok ? "" : f.result.errors.join("; ")}`);
    expect(invalid).toEqual([]);
    const dirs = found.map((f) => f.dir);
    for (const expected of ["collectors/inbox-drain", "routines/morning-brief", "packages/mcp-apple-fm", "packages/mcp-eventkit", "packages/mcp-brain", "apps/console", "apps/reconciler", "apps/watchdog", "apps/assistant", "targets/github-issues"]) {
      expect(dirs).toContain(expected);
    }
    // the name is what the row is keyed by; it must be the manifest's, not the directory's
    expect(found.find((f) => f.dir === "packages/mcp-apple-fm")?.name).toBe("apple-fm");
  });

  it("every launchd plist in ops/launchd carries a label doctor can query", async () => {
    const labels = await launchdLabels(repoRoot);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.label).toMatch(/^com\.foldedspacelabs\.metistry\.[a-z-]+$/);
  });

  it("this package resolves the checkout it sits in as the product dir", () => {
    expect(isProductCheckout(repoRoot)).toBe(true);
    expect(resolveProductDir(undefined, {}, "/")).toBe(repoRoot.replace(/\/$/, ""));
    expect(resolveProductDir(undefined, { METISTRY_PRODUCT_DIR: "/elsewhere" }, "/")).toBe("/elsewhere");
    expect(resolveProductDir("/explicit", { METISTRY_PRODUCT_DIR: "/elsewhere" }, "/")).toBe("/explicit");
  });

  it("with nothing configured, every shipped bridge/service row is absent or ok — never failed on manifests alone (no network, no db, no subprocess)", async () => {
    const report = await doctor({
      productDir: repoRoot,
      env: {},
      fetchFn: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux",
    });
    const rows = Object.fromEntries(report.rows.map((r) => [r.name, r]));
    // manifest-only kinds validate
    for (const n of ["inbox-drain", "morning-brief", "github-issues", "assistant", "watchdog"]) expect(rows[n]?.status, n).toBe("ok");
    // bridges with an env-configured URL are absent until configured
    for (const n of ["apple-fm", "eventkit", "reconciler"]) expect(rows[n]?.status, n).toBe("absent");
    expect(rows["apple-fm"]?.remediation).toMatch(/set METISTRY_AFM_URL .*7810.* and METISTRY_BRIDGE_TOKEN_APPLE_FM/);
    expect(rows.eventkit?.remediation).toMatch(/METISTRY_EK_URL .*7811/);
    expect(rows.reconciler?.remediation).toMatch(/METISTRY_RECONCILER_URL .*7812/);
    // the console and brain default to loopback:8080 and are genuinely down here
    expect(rows.console?.status).toBe("failed");
    expect(rows.brain?.status).toBe("failed");
    expect(rows.db?.status).toBe("absent");
    expect(rows.compose?.status).toBe("absent");
  });
});
