// compute.yaml is the file that says where work runs and what it may cost,
// so the assertions that matter are the refusals: every rule the schema
// exists to enforce must fail with a message that NAMES THE FIELD (the
// rivet adopt, plan refresh §1 R3) rather than a generic type error, and a
// half-written save must never take a running install's assignments away.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_FILES_DEFAULT,
  ComputeStore,
  assignsNothing,
  computeTiers,
  emptyCompute,
  loadCompute,
  modelRefIssue,
  parseCompute,
  parseModelRef,
  parseTiers,
  resolveAssignment,
  resolveTier,
  startComputeWatch,
  validateCompute,
  type ReadFile,
} from "../src/index.js";

/** The sketch from the research note, minus the provider kinds C2 dropped. */
const SKETCH = `
providers:
  lmstudio:
    kind: openai-compatible
    base_url: http://127.0.0.1:1234/v1
    locality: on_machine
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    auth: { secret: METISTRY_OPENROUTER_API_KEY }
    locality: off_machine
    zdr: true
    request: { provider: { order: [anthropic], allow_fallbacks: false } }
    data_policy: { allow: [Knowledge/Projects], deny_sources: [comms], max_brief_bytes: 65536 }
    pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5, effort: medium }
  tiers:
    fast:    { model: lmstudio/google/gemma-3n-e4b, effort: low }
    routine: { model: lmstudio/google/gemma-3n-e4b, effort: low }
    deep:    { model: openrouter/anthropic/claude-sonnet-5, effort: high, critical: true }
  crews: { researcher: { model: lmstudio/google/gemma-3n-e4b } }
budgets:
  instance:  { daily_usd: 5, monthly_usd: 60, action: allow }
  providers: { openrouter: { monthly_usd: 20, action: stop } }
`;

/** Every issue as one string, so a test can assert on the field name and the reason together. */
function why(text: string): string {
  try {
    parseCompute(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected compute.yaml to be refused, but it parsed");
}

/** An in-memory disk: paths this map does not hold raise ENOENT, the way readFile does. */
function fakeFs(files: Record<string, string>): ReadFile {
  return async (p) => {
    const text = files[p];
    if (text === undefined) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file, open '${p}'`);
      err.code = "ENOENT";
      throw err;
    }
    return text;
  };
}

describe("compute.yaml schema", () => {
  it("parses the sketch from the research note", () => {
    const cfg = parseCompute(SKETCH);
    expect(Object.keys(cfg.providers)).toEqual(["lmstudio", "openrouter"]);
    expect(cfg.providers.openrouter?.request).toEqual({ provider: { order: ["anthropic"], allow_fallbacks: false } });
    expect(cfg.providers.openrouter?.pricing?.["anthropic/claude-sonnet-5"]).toEqual({ in_per_m: 3, out_per_m: 15 });
    expect(cfg.assignments?.tiers.fast).toEqual({ model: "lmstudio/google/gemma-3n-e4b", effort: "low" });
    expect(cfg.budgets?.providers.openrouter).toEqual({ monthly_usd: 20, action: "stop" });
  });

  it("a file of nothing but comments is valid and assigns nothing — the seed, and every install before this PR", () => {
    const seed = parseCompute(readFileSync(new URL("../../../seed/compute.yaml", import.meta.url), "utf8"));
    expect(seed).toEqual(emptyCompute());
    expect(assignsNothing(seed)).toBe(true);
    expect(computeTiers(seed)).toBeUndefined();
    expect(resolveAssignment(seed, "deep")).toBeUndefined();
  });

  it("every shipped provider template is a valid provider block", () => {
    for (const name of ["openrouter", "zen", "lmstudio", "ollama"]) {
      const text = readFileSync(new URL(`../../../seed/compute-templates/${name}.yaml`, import.meta.url), "utf8");
      const cfg = parseCompute(`providers:\n${text.split("\n").filter((l) => !l.startsWith("#")).map((l) => (l.trim() === "" ? l : `  ${l}`)).join("\n")}`);
      expect(Object.keys(cfg.providers)).toEqual([name]);
    }
  });

  it("effort defaults to medium and a budget action defaults to stop (C5)", () => {
    const cfg = parseCompute(`
providers: { local: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine } }
assignments: { default: { model: local/m } }
budgets: { instance: { daily_usd: 1 } }
`);
    expect(cfg.assignments?.default.effort).toBe("medium");
    expect(cfg.budgets?.instance?.action).toBe("stop");
  });

  // --- the refusals, one per rule ------------------------------------------

  const local = "providers: { local: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine } }";

  it("refuses a model that does not name a provider in this file", () => {
    const m = why(`${local}\nassignments: { default: { model: openrouter/anthropic/claude-sonnet-5 } }`);
    expect(m).toContain("assignments.default.model");
    expect(m).toContain('provider "openrouter" is not declared in this file');
  });

  it("refuses a bare model id with no provider — a reference says where it runs", () => {
    expect(why(`${local}\nassignments: { default: { model: claude-sonnet-5 } }`)).toContain("assignments.default.model");
    expect(why(`${local}\nassignments: { default: { model: claude-sonnet-5 } }`)).toContain("<provider>/<model-id>");
  });

  it("keeps a model id verbatim after the first slash — LM Studio ids contain slashes", () => {
    expect(parseModelRef("lmstudio/google/gemma-3n-e4b")).toEqual({ provider: "lmstudio", model: "google/gemma-3n-e4b", ref: "lmstudio/google/gemma-3n-e4b" });
    expect(modelRefIssue("lmstudio/a/b/c")).toBeUndefined();
  });

  it("refuses /auto — no model decides which model runs (invariant 4)", () => {
    const m = why(`${local}\nassignments: { default: { model: local/auto } }`);
    expect(m).toContain("assignments.default.model");
    expect(m).toContain("auto-router");
    expect(modelRefIssue("openrouter/auto")).toMatch(/auto-router/);
    expect(modelRefIssue("openrouter/anthropic/claude-sonnet-5:auto")).toMatch(/auto-router/);
  });

  it("refuses a fallback list where one model belongs", () => {
    const m = why(`${local}\nassignments: { default: { model: [local/a, local/b] } }`);
    expect(m).toContain("assignments.default.model");
    expect(m).toContain("list of fallbacks is refused");
  });

  it("refuses a secret VALUE where a secret NAME belongs", () => {
    const m = why(`providers: { openrouter: { kind: openai-compatible, base_url: https://openrouter.ai/api/v1, locality: off_machine, auth: { secret: sk-or-v1-deadbeef }, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1024 } } }`);
    expect(m).toContain("providers.openrouter.auth.secret");
    expect(m).toContain("never the key itself");
  });

  it("refuses an off_machine provider with no data_policy", () => {
    const m = why("providers: { openrouter: { kind: openai-compatible, base_url: https://openrouter.ai/api/v1, locality: off_machine } }");
    expect(m).toContain("providers.openrouter.data_policy");
    expect(m).toContain("what may leave this machine is a declaration");
  });

  it("refuses an unknown provider kind, a bad locality, a bad base_url and an unknown field", () => {
    expect(why("providers: { x: { kind: anthropic, base_url: https://api.anthropic.com/v1, locality: off_machine } }")).toContain("providers.x.kind");
    expect(why("providers: { x: { kind: openai-compatible, base_url: https://a/v1, locality: nearby } }")).toContain("providers.x.locality");
    expect(why("providers: { x: { kind: openai-compatible, base_url: /v1, locality: on_machine } }")).toContain("providers.x.base_url");
    expect(why(`${local}\nassignments: { default: { model: local/m, effrot: low } }`)).toMatch(/assignments\.default:.*effrot/);
  });

  it("refuses a budget with no limit, an unknown action, and a budget for a provider that is not here", () => {
    expect(why(`${local}\nbudgets: { instance: { action: stop } }`)).toContain("budgets.instance");
    expect(why(`${local}\nbudgets: { instance: { daily_usd: 5, action: warn } }`)).toContain("budgets.instance.action");
    expect(why(`${local}\nbudgets: { providers: { openrouter: { daily_usd: 5 } } }`)).toContain("budgets.providers.openrouter");
  });

  it("refuses a tier literally named default inside tiers:", () => {
    expect(why(`${local}\nassignments: { default: { model: local/m }, tiers: { default: { model: local/m } } }`)).toContain("assignments.tiers.default");
  });

  it("validateCompute returns every issue rather than throwing on the first", () => {
    const r = validateCompute({ providers: { x: { kind: "openai-compatible", base_url: "nope", locality: "off_machine" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["providers.x.base_url: base_url must be an http(s) URL ending at the API root, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:1234/v1", expect.stringContaining("providers.x.data_policy")]);
  });
});

describe("resolution", () => {
  const cfg = parseCompute(SKETCH);

  it("resolves a tier, a crew and the default to (provider, model, effort)", () => {
    expect(resolveAssignment(cfg, "fast")).toMatchObject({ provider: "lmstudio", model: "google/gemma-3n-e4b", effort: "low", from: "fast" });
    expect(resolveAssignment(cfg, "crew:researcher")).toMatchObject({ provider: "lmstudio", model: "google/gemma-3n-e4b", effort: "medium", from: "crew:researcher" });
    expect(resolveAssignment(cfg, "default")).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-5", from: "default" });
    expect(resolveAssignment(cfg, "deep")?.critical).toBe(true);
    expect(resolveAssignment(cfg, "fast")?.config.locality).toBe("on_machine");
  });

  it("an unknown tier or crew lands on default, never on an invented model", () => {
    expect(resolveAssignment(cfg, "nonesuch")).toMatchObject({ from: "default", provider: "openrouter" });
    expect(resolveAssignment(cfg, "crew:nonesuch")).toMatchObject({ from: "default" });
    expect(resolveAssignment(cfg, null)).toMatchObject({ from: "default" });
  });

  it("assignments become the (model, effort) map resolveTier already reads — and fall back to rules.yaml's tiers when absent", () => {
    const tiers = computeTiers(cfg)!;
    expect(resolveTier(tiers, "deep")).toEqual({ tier: "deep", model: "openrouter/anthropic/claude-sonnet-5", effort: "high" });
    expect(resolveTier(tiers, "nonesuch").tier).toBe("default");

    // no assignments: the caller keeps the map it parsed from rules.yaml
    const noAssignments = parseCompute("providers: {}");
    const fromRules = parseTiers({ default: { model: "haiku" }, deep: { model: "opus", effort: "high" } });
    expect(computeTiers(noAssignments) ?? fromRules).toBe(fromRules);
    expect(resolveTier(computeTiers(noAssignments) ?? fromRules, "deep")).toEqual({ tier: "deep", model: "opus", effort: "high" });
  });
});

describe("the D4 overlay and hot reload", () => {
  const paths = COMPUTE_FILES_DEFAULT;

  it("the default overlay is seed first, the instance's own file after it", () => {
    expect(paths).toBe("seed/compute.yaml:compute.yaml");
  });

  it("the last EXISTING file wins, whole", async () => {
    const seedOnly = await loadCompute(paths, fakeFs({ "seed/compute.yaml": "# nothing\n" }));
    expect(seedOnly.path).toBe("seed/compute.yaml");
    expect(seedOnly.compute.assignments).toBeUndefined();

    const both = await loadCompute(paths, fakeFs({ "seed/compute.yaml": SKETCH, "compute.yaml": `${local()}\nassignments: { default: { model: local/m } }` }));
    expect(both.path).toBe("compute.yaml");
    expect(Object.keys(both.compute.providers)).toEqual(["local"]); // replaced whole, not merged
  });

  it("no file at all is an empty configuration, not a failure", async () => {
    expect(await loadCompute(paths, fakeFs({}))).toEqual({ compute: emptyCompute() });
  });

  it("an invalid file at STARTUP fails loudly, naming the file", async () => {
    await expect(loadCompute(paths, fakeFs({ "compute.yaml": "providers: { x: { kind: nope } }" }))).rejects.toThrow(/compute\.yaml:.*providers\.x\.kind/s);
  });

  it("an invalid file at RELOAD keeps the last good configuration", async () => {
    const files: Record<string, string> = { "compute.yaml": SKETCH };
    const store = new ComputeStore(await loadCompute(paths, fakeFs(files)));
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("openrouter");

    files["compute.yaml"] = "providers: { openrouter: { kind: openai-compatible, base_url: https://openrouter.ai/api/v1, locality: off_machine } }"; // half-written save
    const bad = await store.reload(paths, fakeFs(files));
    expect(bad.ok).toBe(false);
    expect(bad.failedPath).toBe("compute.yaml");
    expect(bad.errors?.join(" ")).toContain("providers.openrouter.data_policy");
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("openrouter"); // still the last good map
    expect(store.current.assignments).toBeDefined();

    files["compute.yaml"] = `${local()}\nassignments: { default: { model: local/m } }`; // saved properly
    const good = await store.reload(paths, fakeFs(files));
    expect(good).toEqual({ ok: true, path: "compute.yaml", changed: true });
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("local");
  });

  it("a watch event re-reads through the same path, and a reload that changes nothing says so", async () => {
    const files: Record<string, string> = { "compute.yaml": SKETCH };
    const reloads: boolean[] = [];
    let fire = (): void => {};
    let closed = false;
    const watch = (watched: string[], onChange: () => void) => {
      expect(watched).toEqual(["seed/compute.yaml", "compute.yaml"]);
      fire = onChange;
      return () => {
        closed = true;
      };
    };
    const w = await startComputeWatch({ paths, readFileFn: fakeFs(files), watch, debounceMs: 0, onReload: (r) => reloads.push(r.changed) });
    expect(w.store.path).toBe("compute.yaml");

    fire();
    fire(); // two events, one save: coalesced by the debounce
    await new Promise((r) => setTimeout(r, 20));
    expect(reloads).toEqual([false]);

    files["compute.yaml"] = `${local()}\nassignments: { default: { model: local/m } }`;
    fire();
    await new Promise((r) => setTimeout(r, 20));
    expect(reloads).toEqual([false, true]);
    expect(resolveAssignment(w.store.current, "fast")?.provider).toBe("local");

    await w.close();
    expect(closed).toBe(true);
  });
});

function local(): string {
  return "providers: { local: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine } }";
}
