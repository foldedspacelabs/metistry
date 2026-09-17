// Crews, no database: manifest parsing (good/bad — the misuse tests for the
// schema at the file level), the vault-bridge loader against an in-memory
// vault, the policy intersection, and the dispatcher against fakes — a brief
// citing a path outside scope is refused with violations and NO work row.
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { memoryVault } from "@foldedspacelabs/metistry-artifacts";
import type { AgentPrincipal } from "@foldedspacelabs/metistry-mcp-brain";
import type { TasksService } from "@foldedspacelabs/metistry-tasks";
import { TargetRegistry } from "../src/dispatch.js";
import { emptyCompute, parseCompute, type Compute } from "@foldedspacelabs/metistry-core";
import { CrewRegistry, crewPolicy, dispatchCrew, intersectAllow, loadCrews, LOCAL_CREW_TARGET, parseCrewFile, readCrewVault, snapshotOf } from "../src/crews.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const seed = readFileSync(`${root}seed/agents/example/researcher.md`, "utf8");

function withFrontmatter(patch: Record<string, unknown>, body = "Do the thing.\n"): string {
  const base = { name: "researcher", type: "agent", area: "example", model: "haiku", uses: ["brain-read", "brain-report"], scope: ["Projects"] };
  const fm = Object.entries({ ...base, ...patch })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}`;
}

describe("crew manifest files", () => {
  it("every shipped seed/agents/<area>/<name>.md parses (CI gate, invariant 5)", async () => {
    const dir = `${root}seed/agents`;
    let n = 0;
    for (const area of await readdir(dir)) {
      for (const file of await readdir(`${dir}/${area}`)) {
        const def = parseCrewFile(readFileSync(`${dir}/${area}/${file}`, "utf8"), `seed/agents/${area}/${file}`, { area, name: file.replace(/\.md$/, "") });
        expect(def.manifest.name).toBe(file.replace(/\.md$/, ""));
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("parses the seed researcher: frontmatter → manifest, body → prompt, scope → an external-shaped grant, sha over the file", () => {
    const def = parseCrewFile(seed, "seed/agents/example/researcher.md", { area: "example", name: "researcher" });
    expect(def.manifest).toMatchObject({ name: "researcher", area: "example", model: "haiku", uses: ["knowledge", "requests"], scope: ["Projects", "Resources"], max_turns: 10, budget_usd_per_run: 0.25 });
    expect(def.grants).toEqual({ tier: "areas", areas: ["Projects", "Resources"] });
    expect(def.prompt.startsWith("You are a researcher working for {{name}}")).toBe(true); // templated later, in the runner, from identity.yaml
    expect(def.prompt).not.toContain("---");
    expect(def.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seed).not.toMatch(/Metis/); // CLAUDE.md naming rule: the seed never names the assistant
  });

  it("autonomy: the §4.21 block round-trips through the same normalizer PUT /autonomy uses; absent → {}", () => {
    const withBlock = parseCrewFile(withFrontmatter({ autonomy: { may_dispatch_to: ["scout"], accept_from: ["user"], max_open_bundles: 2 } }), "x");
    expect(withBlock.autonomy).toEqual({ may_dispatch_to: ["scout"], accept_from: ["user"], max_open_bundles: 2 });
    const absent = parseCrewFile(withFrontmatter({}), "x");
    expect(absent.autonomy).toEqual({});
  });

  it("area is filled from the directory when absent, and must agree when present; the name must be the filename", () => {
    const noArea = parseCrewFile(withFrontmatter({ area: undefined }), "x", { area: "ops", name: "researcher" });
    expect(noArea.manifest.area).toBe("ops");
    expect(() => parseCrewFile(withFrontmatter({ area: "other" }), "x", { area: "ops", name: "researcher" })).toThrow(/area "other" must match the directory "ops"/);
    expect(() => parseCrewFile(withFrontmatter({}), "x", { area: "example", name: "scout" })).toThrow(/name "researcher" must match the filename "scout"/);
  });

  it("refuses: no frontmatter, non-YAML, non-agent type, a write tool in uses, a lowercase or bare scope, an empty prompt", () => {
    expect(() => parseCrewFile("just prose", "x")).toThrow(/frontmatter/);
    expect(() => parseCrewFile("---\n: : :\n---\nbody", "x")).toThrow(/not YAML|invalid manifest/);
    expect(() => parseCrewFile("---\n- a\n---\nbody", "x")).toThrow(/mapping/);
    expect(() => parseCrewFile(withFrontmatter({ type: "collector", schedule: "@daily", writes: ["x"] }), "x")).toThrow(/type must be agent/);
    expect(() => parseCrewFile(withFrontmatter({ uses: ["knowledge_write"] }), "x")).toThrow(/never available to a crew/);
    expect(() => parseCrewFile(withFrontmatter({ uses: ["agents_delegate"] }), "x")).toThrow(/never available to a crew/);
    expect(() => parseCrewFile(withFrontmatter({ uses: ["knowledge_read"] }), "x")).toThrow(/unknown tool group/);
    expect(() => parseCrewFile(withFrontmatter({ scope: ["projects"] }), "x")).toThrow(/scope\.0: .*TitleCase first segment/); // the casing rule, at the vault root
    expect(() => parseCrewFile(withFrontmatter({ scope: ["/"] }), "x")).toThrow(/scope/); // the bare vault is not a crew scope
    expect(() => parseCrewFile(withFrontmatter({ model: "gpt" }), "x")).toThrow(/model/);
    expect(() => parseCrewFile(withFrontmatter({}, "\n\n"), "x")).toThrow(/operating prompt and may not be empty/);
    expect(() => parseCrewFile(withFrontmatter({ bogus_field: true }), "x")).toThrow(/invalid manifest/); // strict: an unknown top-level key is refused, not stripped
    expect(() => parseCrewFile(withFrontmatter({ autonomy: { max_open_bundles: 0 } }), "x")).toThrow(/invalid manifest/); // ≥1
  });

  it("loads through the vault bridge when a dir is not on disk: agents/<area>/<name>.md only, later dirs win, bad files are refused not fatal", async () => {
    const vault = memoryVault();
    const intent = { principal: "user", message: "seed" };
    await vault.write("agents/example/researcher.md", Buffer.from(withFrontmatter({ model: "sonnet", description: "instance override" })), intent);
    await vault.write("agents/example/README.md", Buffer.from("not a crew"), intent);
    await vault.write("agents/ops/broken.md", Buffer.from(withFrontmatter({ name: "broken", uses: ["knowledge_write"] })), intent);
    await vault.write("agents/ops/scout.md", Buffer.from(withFrontmatter({ name: "scout", area: "ops", scope: [] })), intent);
    await vault.write("agents/deep/nested/too.md", Buffer.from(withFrontmatter({ name: "too" })), intent);
    expect((await readCrewVault(vault, "agents")).map((f) => f.rel)).toEqual(["example/researcher.md", "ops/broken.md", "ops/scout.md"]);

    const load = await loadCrews([`${root}seed/agents`, "agents", "missing-dir"], vault);
    expect(load.sources).toEqual({ [`${root}seed/agents`]: "disk", agents: "vault", "missing-dir": "vault" }); // a vault-listed prefix that does not exist is simply empty
    expect([...load.crews.keys()].sort()).toEqual(["researcher", "scout"]);
    expect(load.crews.get("researcher")!.manifest).toMatchObject({ model: "sonnet", description: "instance override" }); // D4: the instance file won
    expect(load.crews.get("scout")!.grants).toEqual({ tier: "none", areas: [] });
    expect(load.errors).toHaveLength(1);
    expect(load.errors[0]).toMatch(/agents\/ops\/broken\.md: invalid manifest: .*never available to a crew/);

    // without a vault, an absent dir is absent; the seed still loads from disk
    const disk = await loadCrews([`${root}seed/agents`, "agents"]);
    expect(disk.sources.agents).toBe("absent");
    expect([...disk.crews.keys()]).toEqual(["researcher"]);
  });
});

describe("policy: crew scope ∩ target allow", () => {
  it("keeps the narrower prefix of each overlapping pair, nothing for disjoint ones, empty scope → nothing", () => {
    expect(intersectAllow(["Projects/Ios", "Areas"], ["Projects", "Areas/Fsl", "Resources"])).toEqual(["Areas/Fsl", "Projects/Ios"]);
    expect(intersectAllow(["Me"], ["Projects"])).toEqual([]);
    expect(intersectAllow([], ["Projects"])).toEqual([]);
    expect(intersectAllow(["Projectsx"], ["Projects"])).toEqual([]); // per segment, not by string
  });

  it("the shipped local-crew target narrows the seed researcher to its own scope and keeps the target's sources + cap", async () => {
    const reg = new TargetRegistry({ env: {} });
    await reg.loadDir(`${root}targets`);
    const target = reg.get(LOCAL_CREW_TARGET)!;
    expect(target).toMatchObject({ transport: "local", result: { via: "report_queue" } });
    const def = parseCrewFile(seed, "seed", { area: "example", name: "researcher" });
    expect(crewPolicy(def.manifest, target)).toEqual({ allow: ["Projects", "Resources"], deny_sources: ["comms"], max_brief_bytes: 65536 });
    // a crew scoped to a personal root gets nothing from the product default: widen per instance, never here
    expect(crewPolicy({ ...def.manifest, scope: ["Me", "Journal"] }, target).allow).toEqual([]);
  });
});

// --- dispatch against fakes -----------------------------------------------------

function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  let runId = 500;
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("INSERT INTO runs")) return { rows: [{ id: ++runId }] };
      return { rows: [] };
    },
    finishes() {
      return q.filter((x) => x.text.startsWith("UPDATE runs")).map((x) => x.values);
    },
  };
}

function fakeTasks(): TasksService & { created: unknown[] } {
  const created: unknown[] = [];
  let nextId = 70;
  return {
    created,
    async create(input: unknown, agent: string) {
      created.push({ input, agent });
      const meta = (input as { meta?: Record<string, unknown> }).meta ?? {};
      return { id: nextId++, meta, ...(input as object) } as never;
    },
  } as unknown as TasksService & { created: unknown[] };
}

async function registryWith(text: string): Promise<CrewRegistry> {
  const vault = memoryVault();
  await vault.write("agents/example/researcher.md", Buffer.from(text), { principal: "user", message: "t" });
  const db = fakeDb();
  // SELECT for the sync returns no rows → one INSERT; the fake swallows it
  const reg = new CrewRegistry(db, ["agents"], vault);
  await reg.refresh();
  return reg;
}

const assistant: AgentPrincipal = { id: "assistant", kind: "internal", grants: { tier: "areas", areas: ["/"] }, projects: [] };

describe("dispatchCrew (fakes)", () => {
  it("refuses a brief citing a path outside scope ∩ allow with the violations, logs the refusal, creates NO work row", async () => {
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    const reg = await registryWith(seed);
    const db = fakeDb();
    const tasks = fakeTasks();
    const r = await dispatchCrew(db, tasks, reg, targets, { crew: "researcher", brief: "Summarize Me/profile.md and Projects/Ios.md" }, assistant);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_request");
    expect(r.violations).toEqual([{ kind: "path_outside_allow", paths: ["Me/profile.md"], allow: ["Projects", "Resources"] }]);
    expect(tasks.created).toHaveLength(0);
    const start = db.q.find((x) => x.text.startsWith("INSERT INTO runs"))!;
    expect(start.values.slice(0, 4)).toEqual(["console", "dispatch", null, "local-crew"]);
    expect(JSON.parse(String(start.values[6]))).toMatchObject({ crew: "researcher", principal: "assistant", target: "local-crew" });
    const [finish] = db.finishes();
    expect(finish![1]).toBe(false);
    expect(String(finish![2])).toBe("data_policy: path_outside_allow");
    expect(JSON.parse(String(finish![6])).violations).toHaveLength(1);
  });

  it("a denied source and an oversized brief are refused the same way (the existing checkBrief, reused)", async () => {
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    const reg = await registryWith(seed);
    const comms = await dispatchCrew(fakeDb(), fakeTasks(), reg, targets, { crew: "researcher", brief: "<!-- source: comms -->\nsummarize" }, assistant);
    expect(comms).toMatchObject({ ok: false, code: "invalid_request", violations: [{ kind: "denied_source", sources: ["comms"] }] });
    const big = await dispatchCrew(fakeDb(), fakeTasks(), reg, targets, { crew: "researcher", brief: "x".repeat(65537) }, assistant);
    expect(big).toMatchObject({ ok: false, violations: [{ kind: "brief_too_large" }] });
  });

  it("queues a clean brief: work row kind task, owner crew:<name>, meta = brief + sha + crew snapshot (prompt included) + effective allow; runs row ok", async () => {
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    const reg = await registryWith(seed);
    const db = fakeDb();
    const tasks = fakeTasks();
    const brief = "# Compare the two iOS plans\n\nRead Projects/Ios.md and [[Resources/Swift.md]]; report the differences.";
    const r = await dispatchCrew(db, tasks, reg, targets, { crew: "researcher", brief, task_id: 9, idempotency_key: "k1" }, assistant);
    expect(r).toEqual({ ok: true, work_id: 70, run_id: 501, crew: "researcher", allow: ["Projects", "Resources"], deduplicated: false });
    const [{ input, agent }] = tasks.created as [{ input: any; agent: string }];
    expect(agent).toBe("assistant"); // server-side identity, from the principal
    expect(input).toMatchObject({ title: "[crew:researcher] Compare the two iOS plans", kind: "task", owner: "crew:researcher", idempotency_key: "k1" });
    expect(input.meta).toMatchObject({ target: "local-crew", brief, task_id: 9, dispatch_run_id: 501, allow: ["Projects", "Resources"] });
    expect(input.meta.brief_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(input.meta.crew).toEqual(snapshotOf(reg.get("researcher")!));
    expect(input.meta.crew.prompt).toContain("{{name}}");
    expect("type" in input.meta.crew).toBe(false);
    const [finish] = db.finishes();
    expect(finish![1]).toBe(true);
    expect(JSON.parse(String(finish![6]))).toMatchObject({ work_id: 70, crew: "researcher", deduplicated: false });
  });

  it("unknown crew → not_found naming the registered ones; no local-crew target → not_available; nothing logged or queued either way", async () => {
    const reg = await registryWith(seed);
    const db = fakeDb();
    const tasks = fakeTasks();
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    expect(await dispatchCrew(db, tasks, reg, targets, { crew: "nobody", brief: "x" }, assistant)).toMatchObject({ ok: false, code: "not_found", message: expect.stringContaining("registered: researcher") });
    expect(await dispatchCrew(db, tasks, reg, undefined, { crew: "researcher", brief: "x" }, assistant)).toMatchObject({ ok: false, code: "not_available" });
    expect(db.q.filter((x) => x.text.startsWith("INSERT INTO runs"))).toHaveLength(0);
    expect(tasks.created).toHaveLength(0);
  });
});

// --- the collaboration rule (C7, owner decision 2026-09-11) ----------------------

// A valid `compute.yaml` can only name `openai-compatible` providers today
// (core's PROVIDER_KINDS, C2 — the SDK's `anthropic` kind left with the
// scrub), so a second kind has to be built by hand here. That is the point of
// the guard: it is what makes the rule hold the day a native Messages adapter
// or a bundled llama-server kind lands, rather than a thing someone has to
// remember to add then.
const FUTURE_KIND = "native-messages";
const withKinds = (callerKind: string, crewKind: string): Compute => {
  const cfg = parseCompute(`
providers:
  a: { kind: openai-compatible, base_url: "http://127.0.0.1:1/v1", locality: on_machine }
  b: { kind: openai-compatible, base_url: "http://127.0.0.1:2/v1", locality: on_machine }
assignments:
  default: { model: a/one }
  crews: { researcher: { model: b/two } }
`);
  (cfg.providers.a as { kind: string }).kind = callerKind;
  (cfg.providers.b as { kind: string }).kind = crewKind;
  return cfg;
};

describe("cross-kind delegation (collaboration rule 4)", () => {
  it("refuses a DIRECTED push to a crew whose engine kind differs, with invalid_request, a runs row, and the field to edit", async () => {
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    const reg = await registryWith(seed);
    const db = fakeDb();
    const tasks = fakeTasks();
    const r = await dispatchCrew(db, tasks, reg, targets, { crew: "researcher", brief: "Summarize Projects/Ios.md" }, assistant, withKinds(FUTURE_KIND, "openai-compatible"));
    expect(r).toMatchObject({ ok: false, code: "invalid_request" });
    if (r.ok) return;
    expect(r.message).toContain("assignments.crews.researcher");
    expect(r.message).toContain("Create the work unassigned instead");
    expect(tasks.created).toHaveLength(0); // nothing queued
    const [finish] = db.finishes();
    expect(String(finish![2])).toMatch(/^collaboration_rule: /);
    expect(JSON.parse(String(db.q[0]!.values[6]))).toMatchObject({ from_kind: FUTURE_KIND, to_kind: "openai-compatible" });
  });

  it("allows it when both sides are the same kind — which is every valid compute.yaml today, and an install with none", async () => {
    const targets = new TargetRegistry({ env: {} });
    await targets.loadDir(`${root}targets`);
    const reg = await registryWith(seed);
    const brief = { crew: "researcher", brief: "Summarize Projects/Ios.md" };
    expect(await dispatchCrew(fakeDb(), fakeTasks(), reg, targets, brief, assistant, withKinds("openai-compatible", "openai-compatible"))).toMatchObject({ ok: true });
    expect(await dispatchCrew(fakeDb(), fakeTasks(), reg, targets, brief, assistant, emptyCompute())).toMatchObject({ ok: true });
  });
});
