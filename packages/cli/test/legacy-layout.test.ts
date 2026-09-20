// Every READER, against an instance directory in the pre-2026-09-17 layout.
//
// #193 moved the whole layout under `.metistry/` and db/migrations/0021
// recorded that "a legacy instance keeps working unchanged until the verb
// runs". It did not: every reader spelled the flat path, so the config half
// of a not-yet-migrated instance went silently unread — `compute show`
// reported no providers, `identity` exited 1, `version` omitted the pin,
// and `up` would have pointed Postgres at a data directory that does not
// exist. This file is the regression test for that sentence.
//
// The same assertion is made twice, once per shape, from one fixture
// builder: a reader that resolves one layout and not the other fails here.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLayout, isProtectedPath } from "@foldedspacelabs/metistry-core";
import { instanceComputeFile } from "../src/compute.js";
import { deploymentPaths, loadDeployment } from "../src/deployment.js";
import { computeForDoctor, layoutRow } from "../src/doctor.js";
import { envPaths, identityPath, instanceEnvFile, instanceStateDir, readInstanceId } from "../src/instance.js";
import { instancesFile } from "../src/instances.js";
import { instanceLockPath } from "../src/lock.js";
import { modelsDir, relativeModelPath } from "../src/local-models.js";
import { loadNamespace, portsFile } from "../src/namespace.js";
import { pgDataDir, pgSocketDir } from "../src/postgres.js";
import { protectedRel } from "../src/protected-write.js";
import { assistantStateDir } from "../src/sandbox.js";
import { supervisorBinPath, supervisorConfigPath, supervisorSocketPath } from "../src/supervisor.js";
import { collectVersionInfo } from "../src/version.js";

const INSTANCE_ID = "5bebed51-6cf8-4334-83b2-e78f00dadeb1";

const LOCK = `product:
  version: "0.7.0"
  commit: "c9dc4d19349fb51bb2bcb19472002a2e5c8c90cf"
  source: release
updated_at: "2026-09-10T19:06:44.434Z"
migrations_applied:
  - "0001_init.sql"
`;

const COMPUTE = `providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
`;

const PORTS = `label_suffix: 5bebed51
base: 8180
ports: { console: 8180, db: 8181, reconciler: 8182, eventkit: 8183, apple-fm: 8184 }
`;

/**
 * One instance directory in either shape, carrying the same content. `legacy`
 * is docs/ops/instance-layout.md's "The legacy layout, for reference" — the
 * vault in `Knowledge/`, the config half at the root, `state/` beside it —
 * plus what the owner's own instance actually has: `Artifacts/` at the root
 * and a `state/.env` that only the install itself reads.
 */
async function instanceDir(shape: "flat" | "legacy"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `metistry-${shape}-`));
  const cfg = shape === "legacy" ? dir : join(dir, ".metistry");
  const state = join(cfg, "state");
  const vault = shape === "legacy" ? join(dir, "Knowledge") : dir;

  await mkdir(join(vault, "Journal"), { recursive: true });
  await mkdir(join(vault, "Inbox"), { recursive: true });
  await writeFile(join(vault, "now.md"), "# Now\n");
  await mkdir(join(dir, "Artifacts"), { recursive: true });
  await mkdir(state, { recursive: true });

  await writeFile(join(cfg, "identity.yaml"), `name: X\ninstance_id: "${INSTANCE_ID}"\n`);
  await writeFile(join(cfg, "rules.yaml"), "tiers: {}\n");
  await writeFile(join(cfg, "compute.yaml"), COMPUTE);
  await writeFile(join(cfg, "deployment.yaml"), "shape: launchd\nservices: {}\n");
  await writeFile(join(cfg, "instances.yaml"), "instances: []\nresources: []\n");
  await writeFile(join(cfg, "metistry.lock"), LOCK);
  await writeFile(join(state, ".env"), "METISTRY_DB_NAME=metistry\n");
  await writeFile(join(state, "ports.yaml"), PORTS);
  return dir;
}

/** Where this shape keeps its config and its derived state, spelled out so the expectations read as paths rather than as calls. */
const where = (shape: "flat" | "legacy", dir: string) => ({
  cfg: (name: string) => (shape === "legacy" ? join(dir, name) : join(dir, ".metistry", name)),
  state: (...rest: string[]) => (shape === "legacy" ? join(dir, "state", ...rest) : join(dir, ".metistry", "state", ...rest)),
});

describe.each(["flat", "legacy"] as const)("the readers on a %s instance", (shape) => {
  it("detects the shape", async () => {
    expect(detectLayout(await instanceDir(shape))).toBe(shape);
  });

  it("finds identity.yaml, and the instance_id in it", async () => {
    const dir = await instanceDir(shape);
    expect(identityPath(dir)).toBe(where(shape, dir).cfg("identity.yaml"));
    expect(await readInstanceId(dir)).toBe(INSTANCE_ID);
  });

  it("finds compute.yaml — so `compute show` and the engine see this instance's providers", async () => {
    const dir = await instanceDir(shape);
    expect(instanceComputeFile(dir)).toBe(where(shape, dir).cfg("compute.yaml"));
    const compute = await computeForDoctor({ METISTRY_INSTANCE_DIR: dir }, "/nonexistent-product");
    expect(Object.keys(compute?.providers ?? {})).toEqual(["lmstudio"]);
  });

  it("finds deployment.yaml — so every remediation is written for the shape this install actually runs", async () => {
    const dir = await instanceDir(shape);
    expect(deploymentPaths("/p", { METISTRY_INSTANCE_DIR: dir }).instance).toBe(where(shape, dir).cfg("deployment.yaml"));
    expect((await loadDeployment("/nonexistent-product", { METISTRY_INSTANCE_DIR: dir })).deployment.shape).toBe("launchd");
  });

  it("finds metistry.lock — so `version` reports the pin", async () => {
    const dir = await instanceDir(shape);
    expect(instanceLockPath({ METISTRY_INSTANCE_DIR: dir })).toBe(where(shape, dir).cfg("metistry.lock"));
    expect((await collectVersionInfo({ instanceDir: dir })).lock).toEqual({ version: "0.7.0", channel: "release" });
  });

  it("finds instances.yaml — the peer registry", async () => {
    const dir = await instanceDir(shape);
    expect(instancesFile(dir)).toBe(where(shape, dir).cfg("instances.yaml"));
  });

  it("finds the derived state: .env, the Postgres cluster, the supervisor's socket, the port block", async () => {
    const dir = await instanceDir(shape);
    const w = where(shape, dir);
    expect(instanceStateDir(dir)).toBe(w.state());
    expect(instanceEnvFile(dir)).toBe(w.state(".env"));
    expect(envPaths({ instanceDir: dir, productDir: "/nonexistent-product" })?.read).toEqual([w.state(".env")]);
    expect(pgDataDir(dir)).toBe(w.state("pg"));
    expect(pgSocketDir(dir)).toBe(w.state("run"));
    expect(supervisorConfigPath(dir)).toBe(w.state("supervisor.json"));
    expect(supervisorSocketPath(dir)).toBe(w.state("run", "supervisor.sock"));
    expect(supervisorBinPath(dir)).toBe(w.state("bin", "Metistry"));
    expect(assistantStateDir({ instanceDir: dir, productDir: "/p" })).toBe(w.state("assistant"));
    expect(modelsDir(dir)).toBe(w.state("models"));
    expect(relativeModelPath("o/r", "m.gguf", dir)).toBe(shape === "legacy" ? "state/models/o/r/m.gguf" : ".metistry/state/models/o/r/m.gguf");
  });

  it("finds the port block — so a namespaced instance keeps its labels and ports across an `up`", async () => {
    const dir = await instanceDir(shape);
    expect(portsFile(dir)).toBe(where(shape, dir).state("ports.yaml"));
    expect((await loadNamespace(dir))?.labelSuffix).toBe("5bebed51");
  });
});

describe("doctor's instance layout row", () => {
  it("is ok on a flat instance and degraded — never failed — on a legacy one, naming the verb", async () => {
    expect((await layoutRow(await instanceDir("flat"))).status).toBe("ok");
    const legacy = await layoutRow(await instanceDir("legacy"));
    expect(legacy.status).toBe("degraded");
    expect(legacy.meta).toEqual({ layout: "legacy" });
    expect(legacy.remediation).toContain("metistry migrate-layout");
  });
});

describe("protectedRel — the writers must agree with the readers", () => {
  // A protected write posts an instance-RELATIVE path to the reconciler. The
  // flat spelling on a legacy instance would land a second
  // `.metistry/identity.yaml` beside the live root one; the reader would go
  // on reading the old file, so `compute assign`, `instances add`,
  // `deployment set-shape`, the minted `instance_id` and `update`'s lock
  // write would all report success and change nothing.
  it("posts the spelling this instance reads back", async () => {
    const legacy = await instanceDir("legacy");
    expect(protectedRel(legacy, "identity")).toBe("identity.yaml");
    expect(protectedRel(legacy, "compute")).toBe("compute.yaml");
    expect(protectedRel(legacy, "deployment")).toBe("deployment.yaml");
    expect(protectedRel(legacy, "instances")).toBe("instances.yaml");
    expect(protectedRel(legacy, "lock")).toBe("metistry.lock");

    const flat = await instanceDir("flat");
    expect(protectedRel(flat, "identity")).toBe(".metistry/identity.yaml");
    expect(protectedRel(flat, "lock")).toBe(".metistry/metistry.lock");

    // no instance directory: nothing to detect, and flat is the only answer
    expect(protectedRel(undefined, "lock")).toBe(".metistry/metistry.lock");
  });

  it("names a path the reconciler's own protected set covers, in both shapes", async () => {
    for (const shape of ["flat", "legacy"] as const) {
      const dir = await instanceDir(shape);
      for (const key of ["identity", "rules", "compute", "deployment", "instances", "lock"] as const) {
        expect(isProtectedPath(protectedRel(dir, key)), `${shape} ${key}`).toBe(true);
      }
    }
  });
});
