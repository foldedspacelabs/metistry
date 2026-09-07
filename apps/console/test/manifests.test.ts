// Every shipped collector/routine manifest must load through the runner —
// the console refuses to start on an unparseable schedule, and one slipped
// through unit tests once (aws-costs "0 */6 * * *") and crash-looped the
// deployed console. This is the CI gate for that.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { validateManifest } from "@foldedspacelabs/metistry-core";
import { collectors } from "@metistry-apps/collectors";
import { routines } from "@metistry-apps/routines";
import { loadSchedules, scheduleToSeconds } from "../src/runner.js";
import { TargetRegistry } from "../src/dispatch.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Invariant 5: everything is a directory with a manifest, and CI validates
// every one of them — collectors, routines, targets, bridges, services.
const MANIFEST_DIRS = ["collectors", "routines", "targets", "apps", "packages"];

async function shippedManifests(): Promise<{ file: string; type: string }[]> {
  const out: { file: string; type: string }[] = [];
  for (const dir of MANIFEST_DIRS) {
    for (const entry of await readdir(`${root}${dir}`, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = `${dir}/${entry.name}/manifest.yaml`;
      try {
        await readFile(`${root}${file}`, "utf8");
      } catch {
        continue; // not a component directory
      }
      out.push({ file, type: dir });
    }
  }
  return out;
}

describe("every shipped manifest validates (invariant 5)", () => {
  it("enumerates collectors/*, routines/*, targets/*, apps/*, packages/* and each conforms to the schema", async () => {
    const files = await shippedManifests();
    expect(files.map((f) => f.file)).toContain("targets/github-issues/manifest.yaml");
    const failures: string[] = [];
    for (const { file, type } of files) {
      const r = validateManifest(parseYaml(await readFile(`${root}${file}`, "utf8")));
      if (!r.ok) failures.push(`${file}: ${r.errors.join("; ")}`);
      else if (type === "targets" && r.manifest.type !== "target") failures.push(`${file}: type ${r.manifest.type} under targets/`);
    }
    expect(failures).toEqual([]);
  });

  it("every targets/* manifest loads through the registry and names its directory", async () => {
    const reg = new TargetRegistry({ env: {} });
    const loaded = await reg.loadDir(`${root}targets`);
    expect(loaded).toContain("github-issues");
    expect(loaded).toContain("local-crew");
    expect(reg.names()).toEqual(loaded);
  });
});

describe("shipped manifests schedule through the runner", () => {
  it("every registered collector and routine loads", async () => {
    const c = await loadSchedules(collectors, `${root}collectors`);
    const r = await loadSchedules(routines, `${root}routines`);
    expect(c.map((x) => x.name)).toEqual(collectors.map((x) => x.name));
    expect(r.map((x) => x.name)).toEqual(routines.map((x) => x.name));
    for (const s of [...c, ...r]) expect(s.intervalSec).toBeGreaterThan(0);
  });

  it("cron subset", () => {
    expect(scheduleToSeconds("*/15 * * * *")).toBe(900);
    expect(scheduleToSeconds("0 */6 * * *")).toBe(21600);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow(/cannot schedule/);
  });
});
