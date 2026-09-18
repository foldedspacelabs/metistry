// The compute routes' own validation, and the one guard that is not about a
// caller's mistake at all.
//
// `writeTargetIssue` exists because every write verb OPENS the instance's
// `compute.yaml`, edits it as a document and writes the whole thing back. In
// the compose shape the console has no instance mount but the overlay still
// NAMES `.metistry/compute.yaml` (relative, resolved against `/app`), so an
// unguarded `assign` would find nothing there, start from a bare header and
// deliver a four-line file over the operator's real one through the bridge.
// That is data loss, not a refusal, so the mismatch is checked before
// anything is opened.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instanceComputeFile, type ComputeOptions } from "@foldedspacelabs/metistry-cli";
import { assignTargetOf, budgetTargetOf, writeTargetIssue } from "../src/compute-routes.js";

const opts = (env: NodeJS.ProcessEnv, instanceDir = "/tmp/instance"): ComputeOptions => ({
  instanceDir,
  seedDir: "seed",
  env,
  platform: "linux",
  uid: 501,
  out: () => {},
});

describe("writeTargetIssue: the console will not write a compute.yaml it is not reading", () => {
  it("permits the default overlay, whose last entry IS the instance's own file", () => {
    expect(writeTargetIssue(opts({}))).toBeUndefined();
  });

  it("permits an explicit overlay that ends at the same absolute file", () => {
    expect(writeTargetIssue(opts({ METISTRY_COMPUTE_FILES: `seed/compute.yaml:${instanceComputeFile("/tmp/instance")}` }))).toBeUndefined();
  });

  it("refuses the compose shape's relative overlay, naming the variable and both paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-compute-"));
    const issue = writeTargetIssue(opts({ METISTRY_COMPUTE_FILES: "seed/compute.yaml:.metistry/compute.yaml" }, dir));
    expect(issue).toBeDefined();
    expect(issue).toContain("METISTRY_COMPUTE_FILES");
    expect(issue).toContain(instanceComputeFile(dir));
    expect(issue).toContain("overwrite the one you have");
  });

  it("refuses an overlay that ends somewhere else entirely, and an empty one", () => {
    expect(writeTargetIssue(opts({ METISTRY_COMPUTE_FILES: "/etc/metistry/compute.yaml" }))).toContain("refusing to write");
    expect(writeTargetIssue(opts({ METISTRY_COMPUTE_FILES: "" }))).toContain("refusing to write"); // falls back to the default, which matches
  });
});

describe("assignTargetOf: exactly one of tier or crew", () => {
  it("takes a tier name, `default`, and a crew", () => {
    expect(assignTargetOf({ tier: "deep" })).toEqual({ ok: true, target: { kind: "tier", name: "deep" } });
    expect(assignTargetOf({ tier: "default" })).toEqual({ ok: true, target: { kind: "default" } });
    expect(assignTargetOf({ crew: "writer" })).toEqual({ ok: true, target: { kind: "crew", name: "writer" } });
    expect(assignTargetOf({ tier: "  deep  " })).toEqual({ ok: true, target: { kind: "tier", name: "deep" } });
  });

  it("refuses neither, both, and a non-string", () => {
    expect(assignTargetOf({})).toMatchObject({ ok: false });
    expect(assignTargetOf({})).toMatchObject({ message: expect.stringContaining("neither") });
    expect(assignTargetOf({ tier: "deep", crew: "writer" })).toMatchObject({ message: expect.stringContaining("tier and crew") });
    expect(assignTargetOf({ tier: 7 })).toMatchObject({ ok: false });
    expect(assignTargetOf({ tier: "" })).toMatchObject({ ok: false });
  });

  it("passes a bad name through the CLI's own parser, so the refusal reads the same on both doors", () => {
    expect(assignTargetOf({ tier: "Deep Tier" })).toMatchObject({ message: expect.stringContaining("lowercase kebab-case") });
    expect(assignTargetOf({ crew: "Writer" })).toMatchObject({ message: expect.stringContaining("kebab-case") });
  });

  // `crew:x` in the `tier` field would be a second spelling of the same
  // target; `parseAssignmentTarget` treats the prefix as the crew form, so a
  // caller cannot reach a crew through `tier` by accident. Pinned because the
  // route's contract is "tier OR crew", not "tier, which may be a crew".
  it("does not let `tier` carry the crew prefix as a smuggled spelling", () => {
    expect(assignTargetOf({ tier: "crew:writer" })).toEqual({ ok: true, target: { kind: "crew", name: "writer" } });
  });
});

describe("budgetTargetOf", () => {
  it("takes instance and provider:<name>", () => {
    expect(budgetTargetOf({ scope: "instance" })).toEqual({ ok: true, target: { kind: "instance" } });
    expect(budgetTargetOf({ scope: "provider:openrouter" })).toEqual({ ok: true, target: { kind: "provider", name: "openrouter" } });
  });

  it("refuses a missing scope, a bare provider name, and a bad one", () => {
    expect(budgetTargetOf({})).toMatchObject({ message: expect.stringContaining('"instance"') });
    expect(budgetTargetOf({ scope: "openrouter" })).toMatchObject({ ok: false });
    expect(budgetTargetOf({ scope: "provider:OpenRouter" })).toMatchObject({ message: expect.stringContaining("kebab-case") });
  });
});
