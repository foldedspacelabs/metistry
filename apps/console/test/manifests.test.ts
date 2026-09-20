// Every shipped collector/routine manifest must load through the runner —
// CI gates that every one of them parses, and one slipped through unit tests
// once (aws-costs "0 */6 * * *") and crash-looped the deployed console.
// loadSchedules itself is defensive on top of that CI gate: a manifest it
// cannot load or schedule (shipped or instance-authored) is skipped and
// logged rather than taking the runner down — see "an unparseable schedule
// is skipped, not fatal" below.
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { collectorProviderIssue, providerSchema, validateManifest } from "@foldedspacelabs/metistry-core";
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

// THE COLLECTOR MONEY RULE, as a check rather than a habit.
//
// "Collectors never call a billable model" was a rule to remember until the
// compute refresh made Apple FM and the bundled `llama-server` ordinary
// providers. A collector now DECLARES the one model it may call —
// `uses_model: <provider>/<model-id>` — and this resolves that provider
// against `seed/compute-templates/<name>.yaml`, the product's own statement
// of what a provider by that name is, because `seed/compute.yaml`
// deliberately declares nothing and an instance's file is not in this repo.
//
// That is the SMALLEST HONEST version, and its limit is worth stating: an
// instance can rename a provider or point `applefm` at something billable,
// and CI would never see it. The other half of the check is `completeJson()`
// in the collectors package, which resolves the same name against the
// `compute.yaml` actually in force and THROWS before building a request
// (collectors/inbox-drain/fm-tier.test.ts). CI catches the shipped default;
// the runtime catches the live one.
describe("no collector names a provider that costs money", () => {
  const providerTemplate = async (name: string): Promise<unknown> => {
    const text = await readFile(`${root}seed/compute-templates/${name}.yaml`, "utf8").catch(() => undefined);
    return text === undefined ? undefined : Object.values((parseYaml(text) ?? {}) as Record<string, unknown>)[0];
  };

  const named = async (): Promise<Array<{ name: string; ref: string }>> => {
    const out: Array<{ name: string; ref: string }> = [];
    for (const { file } of (await shippedManifests()).filter((f) => f.type === "collectors")) {
      const m = parseYaml(await readFile(`${root}${file}`, "utf8")) as { name: string; uses_model?: unknown };
      if (typeof m.uses_model === "string") out.push({ name: m.name, ref: m.uses_model });
    }
    return out;
  };

  it("every declared uses_model resolves to a shipped template that is on_machine", async () => {
    for (const { name, ref } of await named()) {
      const provider = ref.slice(0, ref.indexOf("/"));
      const block = await providerTemplate(provider);
      expect(block, `${name} pins ${ref}, but there is no seed/compute-templates/${provider}.yaml saying what that provider is`).toBeDefined();
      const parsed = providerSchema.safeParse(block);
      expect(parsed.success, `seed/compute-templates/${provider}.yaml is not a valid provider block`).toBe(true);
      if (parsed.success) expect(collectorProviderIssue(name, provider, parsed.data)).toBeUndefined();
    }
  });

  it("inbox-drain is the only one, and it names the free on-device tier", async () => {
    expect((await named()).map((c) => `${c.name} -> ${c.ref}`)).toEqual(["inbox-drain -> applefm/foundation-model"]);
  });

  it("has teeth: the same check refuses openrouter", async () => {
    const parsed = providerSchema.safeParse(await providerTemplate("openrouter"));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(collectorProviderIssue("inbox-drain", "openrouter", parsed.data)).toContain("locality: off_machine");
  });
});

describe("shipped manifests schedule through the runner", () => {
  it("every registered collector and routine loads", async () => {
    const c = await loadSchedules(collectors, `${root}collectors`);
    const r = await loadSchedules(routines, `${root}routines`);
    expect(c.map((x) => x.name)).toEqual(collectors.map((x) => x.name));
    expect(r.map((x) => x.name)).toEqual(routines.map((x) => x.name));
    for (const s of [...c, ...r]) expect(s.intervalSec).toBeGreaterThan(0);
    // the manifest's pin reaches the collector through the runner, so the
    // manifest stays the single statement of what a component may call
    expect(c.find((x) => x.name === "inbox-drain")?.usesModel).toBe("applefm/foundation-model");
    expect(c.filter((x) => x.usesModel !== undefined).map((x) => x.name)).toEqual(["inbox-drain"]);
  });

  it("cron subset", () => {
    expect(scheduleToSeconds("*/15 * * * *")).toBe(900);
    expect(scheduleToSeconds("0 */6 * * *")).toBe(21600);
    expect(scheduleToSeconds("@hourly")).toBe(3600);
    expect(scheduleToSeconds("@monthly")).toBe(2592000);
    expect(() => scheduleToSeconds("0 9 * * 1-5")).toThrow(/cannot schedule/);
  });
});

describe("an unparseable schedule is skipped, not fatal", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A collectors/ directory of one component, whose manifest.yaml is `body`. */
  async function checkout(name: string, body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "metistry-loadSchedules-"));
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "manifest.yaml"), body);
    return dir;
  }

  it("@monthly — the schedule the manifest regex admits and the old parser rejected — now schedules", async () => {
    const dir = await checkout("m", "name: m\ntype: collector\nschedule: '@monthly'\nwrites: [work]\n");
    const [s] = await loadSchedules([{ name: "m", run: async () => 0 }], dir);
    expect(s?.intervalSec).toBe(2592000);
  });

  it("a manifest whose schedule cannot be parsed is skipped and logged, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await checkout("bad", "name: bad\ntype: collector\nschedule: '0 9 * * 1-5'\nwrites: [work]\n");
    const good = { name: "bad", run: async () => 0 };
    await expect(loadSchedules([good], dir)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bad");
    expect(warn.mock.calls[0]?.[0]).toContain("cannot schedule");
    expect(warn.mock.calls[0]?.[0]).toContain(`${dir}/bad/manifest.yaml`);
  });

  it("one bad manifest does not take the others down with it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await checkout("bad", "name: bad\ntype: collector\nschedule: '0 9 * * 1-5'\nwrites: [work]\n");
    await mkdir(join(dir, "good"), { recursive: true });
    await writeFile(join(dir, "good", "manifest.yaml"), "name: good\ntype: collector\nschedule: '@hourly'\nwrites: [work]\n");
    const loaded = await loadSchedules(
      [
        { name: "bad", run: async () => 0 },
        { name: "good", run: async () => 0 },
      ],
      dir,
    );
    expect(loaded.map((s) => s.name)).toEqual(["good"]);
  });

  it("a manifest that fails schema validation (missing required fields) is skipped the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = await checkout("invalid", "name: invalid\ntype: collector\nwrites: []\n"); // schedule missing, writes empty
    const loaded = await loadSchedules([{ name: "invalid", run: async () => 0 }], dir);
    expect(loaded).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
