// The manifest walk over the REAL checkout: everything currently shipped
// must validate, and every http bridge/service must map onto a probe. This
// is the test that keeps doctor generic — a new component either validates
// or breaks CI here.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    for (const n of ["inbox-drain", "morning-brief", "github-issues", "watchdog"]) expect(rows[n]?.status, n).toBe("ok");
    // bridges with an env-configured URL are absent until configured, and the
    // assistant is absent until this install has an engine credential (W1)
    for (const n of ["apple-fm", "eventkit", "reconciler", "assistant"]) expect(rows[n]?.status, n).toBe("absent");
    expect(rows["apple-fm"]?.remediation).toMatch(/set METISTRY_AFM_URL .*7810.* and METISTRY_BRIDGE_TOKEN_APPLE_FM/);
    expect(rows.eventkit?.remediation).toMatch(/METISTRY_EK_URL .*7811/);
    expect(rows.reconciler?.remediation).toMatch(/METISTRY_RECONCILER_URL .*7812/);
    // the console and brain default to loopback:8080 and are genuinely down here
    expect(rows.console?.status).toBe("failed");
    expect(rows.brain?.status).toBe("failed");
    expect(rows.db?.status).toBe("absent");
    expect(rows.compose?.status).toBe("absent");
  });

  // C2/C3: an engine is `assignments.default` in compute.yaml PLUS the key
  // its provider names, read through the SAME seam `up` reads — so doctor's
  // row and the supervisor's child list can never disagree.
  it("the assistant row: absent when compute.yaml assigns no default, absent when the assigned provider's key is unset, ok once both hold — never a failure", async () => {
    const deps = {
      productDir: repoRoot,
      fetchFn: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
      db: null,
      exec: async () => ({ code: 127, stdout: "", stderr: "" }),
      platform: "linux" as const,
    };
    const dir = await mkdtemp(join(tmpdir(), "metistry-doctor-compute-"));
    const file = join(dir, ".metistry", "compute.yaml");
    await mkdir(join(dir, ".metistry"), { recursive: true });
    await writeFile(
      file,
      `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    data_policy: { allow: [Knowledge/Projects], deny_sources: [comms], max_brief_bytes: 65536 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`,
    );
    const rowFor = async (env: NodeJS.ProcessEnv) => (await doctor({ ...deps, env })).rows.find((r) => r.name === "assistant")!;

    // the seed assigns nothing, so a bare checkout has no engine
    const unassigned = await rowFor({});
    expect(unassigned.status).toBe("absent");
    expect(unassigned.probe).toContain("compute.yaml assigns a default");
    expect(unassigned.remediation).toMatch(/no assignments\.default in compute\.yaml/);
    expect(unassigned.remediation).toContain("metistry compute assign default <provider/model>");
    // an operator has to be able to tell "no model" from "broken"
    expect(unassigned.remediation).toMatch(/captures, tasks, search and the console run, and fold turns wait/);

    // assigned, but nobody has pasted the key: the row names THAT variable
    const noKey = await rowFor({ METISTRY_COMPUTE_FILES: file });
    expect(noKey.status).toBe("absent");
    expect(noKey.remediation).toMatch(/providers\.openrouter\.auth\.secret names METISTRY_OPENROUTER_API_KEY/);

    // a blank value is not a key — .env keeps the commented-out line
    expect((await rowFor({ METISTRY_COMPUTE_FILES: file, METISTRY_OPENROUTER_API_KEY: "  " })).status).toBe("absent");

    expect((await rowFor({ METISTRY_COMPUTE_FILES: file, METISTRY_OPENROUTER_API_KEY: "sk-or-x" })).status).toBe("ok");
  });
});
