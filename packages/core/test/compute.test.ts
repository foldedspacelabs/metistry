// compute.yaml is the file that says where work runs and what it may cost,
// so the assertions that matter are the refusals: every rule the schema
// exists to enforce must fail with a message that NAMES THE FIELD (the
// rivet adopt, plan refresh §1 R3) rather than a generic type error, and a
// half-written save must never take a running install's assignments away.
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_FILES_DEFAULT,
  INSTANCE_LAYOUT,
  ComputeStore,
  assignsNothing,
  computeTiers,
  emptyCompute,
  firstOnMachineBaseUrl,
  loadCompute,
  modelRefIssue,
  parseCompute,
  parseModelRef,
  parseTiers,
  resolveAssignment,
  resolveIntentTier,
  resolveTier,
  servedProviders,
  collectorProviderIssue,
  credentialEnvNames,
  credentialFromEnv,
  credentialOf,
  engineStatus,
  providerSecretNames,
  providerTag,
  resolveCrewAssignment,
  PRIVATE_TIER,
  PrivateTierUnavailable,
  resolvePrivateTier,
  turnTier,
  SECRET_DELIVERY_PREFIX,
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
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
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

  // OPEN-4, ruled 2026-09-17. The seed assigns nothing (above), so the only
  // way to hold it to the ruling is to READ the example it tells people to
  // uncomment: uncomment it here and check what `critical_only` would keep.
  it("the seed's uncommented example marks `default` critical and nothing else (OPEN-4)", () => {
    const lines = readFileSync(new URL("../../../seed/compute.yaml", import.meta.url), "utf8").split("\n");
    const example = lines.slice(lines.findIndex((l) => l.startsWith("# providers:"))).map((l) => l.replace(/^# ?/, "")).join("\n");
    const cfg = parseCompute(example);
    expect(resolveAssignment(cfg, "default")?.critical).toBe(true);   // the turn the user is waiting on
    expect(resolveAssignment(cfg, "routine")?.critical).toBe(false);  // the evening fold stops
    expect(resolveAssignment(cfg, "crew:researcher")?.critical).toBe(false); // delegation stops
    // and the trap the seed's comment warns about: the mark travels with the
    // assignment, so an UNDECLARED tier lands on default and inherits it
    expect(resolveAssignment(cfg, "nonesuch")).toMatchObject({ from: "default", critical: true });
  });

  /** A shipped template's `provider:` block, as compute.yaml would carry it under `providers.<name>`. */
  const template = (name: string): string => {
    const m = parseYaml(readFileSync(new URL(`../../../seed/compute-templates/${name}/manifest.yaml`, import.meta.url), "utf8")) as { name: string; provider: unknown };
    return stringifyYaml({ providers: { [m.name]: m.provider } });
  };

  it("every shipped provider template is a valid provider block", () => {
    for (const name of ["openrouter", "lmstudio", "ollama", "llamaserver", "applefm"]) {
      const cfg = parseCompute(template(name));
      expect(Object.keys(cfg.providers)).toEqual([name]);
    }
  });

  it("caching is off unless a provider says otherwise, and the openrouter template is the one that does (OPEN-6)", () => {
    const cfg = parseCompute(SKETCH);
    expect(cfg.providers.openrouter?.caching).toBeUndefined();   // the sketch predates the field: nothing is sent for it
    expect(cfg.providers.lmstudio?.caching).toBeUndefined();
    const tmpl = parseCompute(template("openrouter"));
    expect(tmpl.providers.openrouter?.caching).toBe("auto");
    for (const name of ["lmstudio", "ollama", "llamaserver", "applefm"]) {
      expect(template(name)).not.toContain("caching:");
    }
  });

  it("refuses caching: auto on an on_machine provider, naming the field — a local server has no field to send", () => {
    const m = why("providers: { local: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine, caching: auto } }");
    expect(m).toContain("providers.local.caching");
    expect(m).toContain("caches its own prefix");
    // and a mode that is neither says so
    expect(why("providers: { x: { kind: openai-compatible, base_url: https://a/v1, locality: off_machine, caching: sometimes, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } } }")).toContain("providers.x.caching");
  });

  it("a pricing: entry may carry its own cache multipliers, and is unchanged without them", () => {
    const cfg = parseCompute(`
providers:
  cloud:
    kind: openai-compatible
    base_url: https://a/v1
    locality: off_machine
    caching: auto
    data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 }
    pricing:
      plain: { in_per_m: 3, out_per_m: 15 }
      tuned: { in_per_m: 3, out_per_m: 15, cache_read_multiplier: 0.05, cache_write_multiplier: 2 }
`);
    expect(cfg.providers.cloud?.pricing?.plain).toEqual({ in_per_m: 3, out_per_m: 15 });
    expect(cfg.providers.cloud?.pricing?.tuned).toEqual({ in_per_m: 3, out_per_m: 15, cache_read_multiplier: 0.05, cache_write_multiplier: 2 });
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

// Stage-2 shadow mode (§3.7). The schema's whole job here is that a block
// which would spend money twice says so explicitly, and that a block the
// engine does not read is refused instead of accepted.
describe("shadow:", () => {
  const both = `providers:
  local: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
  other: { kind: openai-compatible, base_url: http://127.0.0.1:7813/v1, locality: on_machine }
`;
  const withShadow = (block: string): string => `${both}assignments: { default: { model: local/a, ${block} } }`;

  it("resolves the candidate to (provider, model, fraction) beside the assignment it belongs to", () => {
    const cfg = parseCompute(withShadow("shadow: { model: other/qwen3.6-35b-a3b, fraction: 0.1 }"));
    expect(cfg.assignments?.default.shadow).toEqual({ model: "other/qwen3.6-35b-a3b", fraction: 0.1 });
    const a = resolveAssignment(cfg, "default")!;
    expect(a.shadow).toEqual({ provider: "other", model: "qwen3.6-35b-a3b", ref: "other/qwen3.6-35b-a3b", fraction: 0.1, config: cfg.providers.other });
    // and it travels with the assignment, so a turn that FELL BACK to default is shadowed too
    expect(resolveAssignment(cfg, "nonesuch")?.shadow?.model).toBe("qwen3.6-35b-a3b");
  });

  it("is absent by default — every install without the block resolves a shadow of undefined", () => {
    expect(resolveAssignment(parseCompute(SKETCH), "default")?.shadow).toBeUndefined();
  });

  it("fraction is REQUIRED and is a fraction: the rate is the spend, so nothing picks it for you", () => {
    expect(why(withShadow("shadow: { model: other/m }"))).toContain("shadow.fraction is required");
    expect(why(withShadow("shadow: { model: other/m, fraction: 1.5 }"))).toContain("assignments.default.shadow.fraction");
    expect(why(withShadow("shadow: { model: other/m, fraction: -0.1 }"))).toContain("assignments.default.shadow.fraction");
    // the two ends are legal: 0 stages the block in, 1 shadows everything
    expect(parseCompute(withShadow("shadow: { model: other/m, fraction: 0 }")).assignments?.default.shadow?.fraction).toBe(0);
    expect(parseCompute(withShadow("shadow: { model: other/m, fraction: 1 }")).assignments?.default.shadow?.fraction).toBe(1);
  });

  it("the candidate is one pinned <provider>/<model> that this file declares", () => {
    expect(why(withShadow("shadow: { model: nosuch/m, fraction: 0.1 }"))).toContain("assignments.default.shadow.model");
    expect(why(withShadow("shadow: { model: bare-id, fraction: 0.1 }"))).toContain("assignments.default.shadow.model");
    expect(why(withShadow("shadow: { model: other/auto, fraction: 0.1 }"))).toContain("auto-router");
    expect(why(withShadow("shadow: { model: other/m, fraction: 0.1, effort: low }"))).toContain("shadow");
  });

  it("refuses a shadow of the model that already answers — it measures nothing and doubles the turn", () => {
    expect(why(withShadow("shadow: { model: local/a, fraction: 0.1 }"))).toContain("measures nothing and doubles what the turn costs");
  });

  it("refuses the block on a tier or a crew, naming the field — the engine reads it on `default` only", () => {
    expect(why(`${both}assignments: { default: { model: local/a }, tiers: { deep: { model: local/a, shadow: { model: other/m, fraction: 0.1 } } } }`)).toContain(
      "assignments.tiers.deep.shadow",
    );
    expect(why(`${both}assignments: { default: { model: local/a }, crews: { researcher: { model: local/a, shadow: { model: other/m, fraction: 0.1 } } } }`)).toContain(
      "assignments.crews.researcher.shadow",
    );
  });
});

describe("the D4 overlay and hot reload", () => {
  const paths = COMPUTE_FILES_DEFAULT;
  // the instance half of the default overlay, now under `.metistry/` (INSTANCE_LAYOUT)
  const INSTANCE = INSTANCE_LAYOUT.compute;

  it("the default overlay is seed first, the instance's own file after it", () => {
    expect(paths).toBe(`seed/compute.yaml:${INSTANCE}`);
  });

  it("the last EXISTING file wins, whole", async () => {
    const seedOnly = await loadCompute(paths, fakeFs({ "seed/compute.yaml": "# nothing\n" }));
    expect(seedOnly.path).toBe("seed/compute.yaml");
    expect(seedOnly.compute.assignments).toBeUndefined();

    const both = await loadCompute(paths, fakeFs({ "seed/compute.yaml": SKETCH, [INSTANCE]: `${local()}\nassignments: { default: { model: local/m } }` }));
    expect(both.path).toBe(INSTANCE);
    expect(Object.keys(both.compute.providers)).toEqual(["local"]); // replaced whole, not merged
  });

  it("no file at all is an empty configuration, not a failure", async () => {
    expect(await loadCompute(paths, fakeFs({}))).toEqual({ compute: emptyCompute() });
  });

  it("an invalid file at STARTUP fails loudly, naming the file", async () => {
    await expect(loadCompute(paths, fakeFs({ [INSTANCE]: "providers: { x: { kind: nope } }" }))).rejects.toThrow(/compute\.yaml:.*providers\.x\.kind/s);
  });

  it("an invalid file at RELOAD keeps the last good configuration", async () => {
    const files: Record<string, string> = { [INSTANCE]: SKETCH };
    const store = new ComputeStore(await loadCompute(paths, fakeFs(files)));
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("openrouter");

    files[INSTANCE] = "providers: { openrouter: { kind: openai-compatible, base_url: https://openrouter.ai/api/v1, locality: off_machine } }"; // half-written save
    const bad = await store.reload(paths, fakeFs(files));
    expect(bad.ok).toBe(false);
    expect(bad.failedPath).toBe(INSTANCE);
    expect(bad.errors?.join(" ")).toContain("providers.openrouter.data_policy");
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("openrouter"); // still the last good map
    expect(store.current.assignments).toBeDefined();

    files[INSTANCE] = `${local()}\nassignments: { default: { model: local/m } }`; // saved properly
    const good = await store.reload(paths, fakeFs(files));
    expect(good).toEqual({ ok: true, path: INSTANCE, changed: true });
    expect(resolveAssignment(store.current, "deep")?.provider).toBe("local");
  });

  it("a watch event re-reads through the same path, and a reload that changes nothing says so", async () => {
    const files: Record<string, string> = { [INSTANCE]: SKETCH };
    const reloads: boolean[] = [];
    let fire = (): void => {};
    let closed = false;
    const watch = (watched: string[], onChange: () => void) => {
      expect(watched).toEqual(["seed/compute.yaml", INSTANCE]);
      fire = onChange;
      return () => {
        closed = true;
      };
    };
    const w = await startComputeWatch({ paths, readFileFn: fakeFs(files), watch, debounceMs: 0, onReload: (r) => reloads.push(r.changed) });
    expect(w.store.path).toBe(INSTANCE);

    fire();
    fire(); // two events, one save: coalesced by the debounce
    await new Promise((r) => setTimeout(r, 20));
    expect(reloads).toEqual([false]);

    files[INSTANCE] = `${local()}\nassignments: { default: { model: local/m } }`;
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

// ---- `serve:` — the bundled llama-server (PR 2) -------------------------------
//
// ADDITIVE, and the tests say so: the PR-1 file shape must keep parsing
// unchanged, and everything the new block adds must REFUSE loudly rather
// than start a server somewhere nobody is dialling.

describe("serve:", () => {
  const served = (extra = "") => `
providers:
  llamaserver:
    kind: openai-compatible
    base_url: http://127.0.0.1:8080/v1
    locality: on_machine
    serve:
      runtime: llamaserver
      model_path: state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf
      port: 8080${extra}
`;

  it("is optional: a provider without it parses exactly as it did in PR 1", () => {
    const cfg = parseCompute(local());
    expect(cfg.providers.local?.serve).toBeUndefined();
    expect(servedProviders(cfg)).toEqual([]);
  });

  it("parses, defaults extra_args to [], and is reported by servedProviders", () => {
    const cfg = parseCompute(served());
    const [only] = servedProviders(cfg);
    expect(only?.name).toBe("llamaserver");
    expect(only?.serve).toEqual({ runtime: "llamaserver", model_path: "state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf", port: 8080, extra_args: [] });
  });

  it("keeps extra_args verbatim", () => {
    const cfg = parseCompute(served("\n      extra_args: ['--ctx-size', '8192']"));
    expect(servedProviders(cfg)[0]?.serve.extra_args).toEqual(["--ctx-size", "8192"]);
  });

  it("refuses a serve.port the base_url does not dial — a server Metistry starts must be reachable where it listens", () => {
    const bad = served().replace("port: 8080", "port: 8081");
    expect(() => parseCompute(bad)).toThrow(/serve\.port is 8081 but base_url dials port 8080/);
  });

  it("refuses serve: on an off_machine provider, naming the field", () => {
    expect(() =>
      parseCompute(`
providers:
  remote:
    kind: openai-compatible
    base_url: https://example.invalid:8080/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
    serve: { runtime: llamaserver, model_path: a.gguf, port: 8080 }
`),
    ).toThrow(/serve: is how a provider says Metistry starts it/);
  });

  it("refuses a runtime that is not the bundled one — LM Studio and Ollama are peers, never children", () => {
    expect(() => parseCompute(served().replace("runtime: llamaserver", "runtime: lmstudio"))).toThrow(/serve\.runtime must be one of llamaserver/);
  });

  it("refuses a model_path that is not a .gguf", () => {
    expect(() => parseCompute(served().replace(/model_path: .*/, "model_path: state/models/model.safetensors"))).toThrow(/is the path of a \.gguf file/);
  });

  it("refuses an unknown key inside serve: (strict, like every other block)", () => {
    expect(() => parseCompute(served("\n      keep_alive: 60"))).toThrow(/keep_alive/);
  });

  it("requires model_path for llamaserver — a server with no model to load starts and then dies", () => {
    expect(() => parseCompute(served().replace(/\n      model_path: .*/, ""))).toThrow(/serve\.runtime: llamaserver needs serve\.model_path/);
  });
});

// ---- `serve: { runtime: applefm }` — the Apple FM bridge (PR 4) ---------------
//
// Additive again, and with the opposite shape: `applefm` starts NOTHING (the
// bridge is a supervised service already), so the block that would describe a
// process is refused rather than ignored.

describe("serve: { runtime: applefm }", () => {
  const applefm = (extra = "") => `
providers:
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
    auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }
    serve:
      runtime: applefm
      port: 7810${extra}
`;

  it("parses with no model_path at all, and is reported by servedProviders", () => {
    const cfg = parseCompute(applefm());
    const [only] = servedProviders(cfg);
    expect(only?.name).toBe("applefm");
    expect(only?.serve).toEqual({ runtime: "applefm", port: 7810, extra_args: [] });
    expect(cfg.providers.applefm?.auth).toEqual({ secret: "METISTRY_BRIDGE_TOKEN_APPLE_FM" });
  });

  it("refuses model_path: the model is the operating system's and nothing would ever load the file", () => {
    expect(() => parseCompute(applefm("\n      model_path: state/models/x.gguf"))).toThrow(/applefm loads no file/);
  });

  it("refuses extra_args: there is no argv to extend", () => {
    expect(() => parseCompute(applefm("\n      extra_args: ['--verbose']"))).toThrow(/starts no process, so there is no argv/);
  });

  it("still ties the port to the base_url", () => {
    expect(() => parseCompute(applefm().replace("port: 7810", "port: 7811"))).toThrow(/serve\.port is 7811 but base_url dials port 7810/);
  });
});

describe("collectorProviderIssue — the collector money rule", () => {
  const cfg = parseCompute(`
providers:
  applefm:
    kind: openai-compatible
    base_url: http://127.0.0.1:7810/v1
    locality: on_machine
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
`);

  it("allows an on_machine provider — cost 0 by definition, not by a second field", () => {
    expect(collectorProviderIssue("inbox-drain", "applefm", cfg.providers.applefm)).toBeUndefined();
  });

  it("refuses an off_machine one, naming both the collector and the field that would permit it", () => {
    const why = collectorProviderIssue("inbox-drain", "openrouter", cfg.providers.openrouter);
    expect(why).toContain("inbox-drain names openrouter");
    expect(why).toContain("locality: off_machine");
    expect(why).toContain("uses_model:");
  });

  it("says nothing about a provider this file does not declare — that is 'no tier configured', not 'billable'", () => {
    expect(collectorProviderIssue("inbox-drain", "nope", undefined)).toBeUndefined();
  });
});

describe("firstOnMachineBaseUrl", () => {
  it("is the embedder's default URL: the first on_machine provider, in declaration order", () => {
    const cfg = parseCompute(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
  lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
`);
    expect(firstOnMachineBaseUrl(cfg)).toBe("http://127.0.0.1:1234/v1");
  });

  it("is undefined when nothing runs on this machine", () => {
    expect(firstOnMachineBaseUrl(emptyCompute())).toBeUndefined();
  });
});

describe("assignments.intent — the intent tier's model (PoC-20 phase 1)", () => {
  const local = `
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`;

  it("resolves to (provider, model) with the provider's block", () => {
    const cfg = parseCompute(`${local}  intent: { model: ollama/gemma4:e4b-it-qat }\n`);
    const tier = resolveIntentTier(cfg);
    expect(tier?.provider).toBe("ollama");
    expect(tier?.model).toBe("gemma4:e4b-it-qat");
    expect(tier?.config.base_url).toBe("http://127.0.0.1:11434/v1");
  });

  it("is UNDEFINED when absent — it never falls back to `default`, which for most installs is billable", () => {
    expect(resolveIntentTier(parseCompute(local))).toBeUndefined();
    expect(resolveIntentTier(emptyCompute())).toBeUndefined();
  });

  it("REFUSES an off-machine provider at load, naming the field", () => {
    const r = validateCompute({
      providers: {
        openrouter: { kind: "openai-compatible", base_url: "https://openrouter.ai/api/v1", locality: "off_machine", data_policy: { allow: ["Areas"], deny_sources: [], max_brief_bytes: 1024 } },
      },
      assignments: { default: { model: "openrouter/x" }, intent: { model: "openrouter/x" } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/assignments.intent.model/);
    expect(r.errors.join(" ")).toMatch(/locality: off_machine/);
  });

  it("refuses a provider this file does not declare", () => {
    const r = validateCompute({
      providers: { ollama: { kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1", locality: "on_machine" } },
      assignments: { default: { model: "ollama/a" }, intent: { model: "nope/b" } },
    });
    expect(r.ok).toBe(false);
  });

  it("takes a model and nothing else — no effort, no critical, no shadow on a free one-token call", () => {
    const r = validateCompute({
      providers: { ollama: { kind: "openai-compatible", base_url: "http://127.0.0.1:11434/v1", locality: "on_machine" } },
      assignments: { default: { model: "ollama/a" }, intent: { model: "ollama/a", effort: "low" } },
    });
    expect(r.ok).toBe(false);
  });
});

// ---- T8-6: the private tier (plan §2.15) -----------------------------------------
//
// A capture session's turns run on `assignments.tiers.private`, and that tier
// may only be on this machine. The refusals are the point: at load, at
// resolution, and — the case the whole tier exists for — no fallback to a
// `default` that is off the machine or shadowed there.
describe("the private tier — a capture session's turns stay on this machine (T8-6)", () => {
  const BOTH = `
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`;

  it("is the tier named `private`", () => {
    expect(PRIVATE_TIER).toBe("private");
  });

  it("resolves an on-machine private tier to (provider, model, effort) with the provider's block", () => {
    const cfg = parseCompute(`${BOTH}  tiers:\n    private: { model: ollama/gemma4:e4b-it-qat, effort: high, max_output_tokens: 2048 }\n`);
    const r = resolvePrivateTier(cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignment).toMatchObject({ provider: "ollama", model: "gemma4:e4b-it-qat", effort: "high", from: "private", max_output_tokens: 2048, critical: false });
    expect(r.assignment.config.locality).toBe("on_machine");
    expect(r.assignment.shadow).toBeUndefined();
    expect(resolveAssignment(cfg, "private")).toMatchObject({ provider: "ollama", from: "private" });
  });

  it("REFUSES assigning a cloud model to `private` at load, naming the field", () => {
    const r = validateCompute(parseYaml(`${BOTH}  tiers:\n    private: { model: openrouter/anthropic/claude-sonnet-5 }\n`));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join(" ");
    expect(all).toContain("assignments.tiers.private.model");
    expect(all).toContain("locality: off_machine");
    expect(all).toContain("metistry compute assign private");
  });

  it("refuses at load when the provider it names is later repointed off the machine", () => {
    const moved = BOTH.replace("ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }", "ollama: { kind: openai-compatible, base_url: https://ollama.example/v1, locality: off_machine, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } }");
    expect(moved).not.toBe(BOTH);
    expect(() => parseCompute(`${moved}  tiers:\n    private: { model: ollama/gemma4:e4b-it-qat }\n`)).toThrow(/assignments\.tiers\.private\.model.*off_machine/);
  });

  it("NEVER falls back to an off-machine default: unassigned is a refusal, not a turn answered elsewhere", () => {
    const cfg = parseCompute(BOTH);
    const r = resolvePrivateTier(cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("never falls back to default");
    expect(r.reason).toContain("metistry compute assign private");
    // the resolver every turn goes through refuses too — the ordinary unknown-name rule would have answered on openrouter
    expect(resolveAssignment(cfg, "nonesuch")?.provider).toBe("openrouter");
    expect(() => resolveAssignment(cfg, "private")).toThrow(PrivateTierUnavailable);
  });

  it("does not fall back to an ON-machine default either — its shadow could still run the turn off the machine", () => {
    const cfg = parseCompute(`
providers:
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }
assignments:
  default: { model: ollama/gemma4:e4b-it-qat, shadow: { model: openrouter/anthropic/claude-sonnet-5, fraction: 1 } }
`);
    expect(resolveAssignment(cfg, "default")?.shadow?.provider).toBe("openrouter");
    expect(resolvePrivateTier(cfg).ok).toBe(false);
    expect(() => resolveAssignment(cfg, "private")).toThrow(PrivateTierUnavailable);
  });

  it("with no assignments at all it refuses rather than handing the turn to rules.yaml's tiers", () => {
    expect(resolveAssignment(emptyCompute(), "nonesuch")).toBeUndefined(); // the ordinary rule: the caller falls back to rules.yaml
    expect(() => resolveAssignment(emptyCompute(), "private")).toThrow(/never falls back/);
  });

  it("re-checks a hand-built object that never went through the schema", () => {
    const cfg = parseCompute(BOTH);
    const forged = { ...cfg, assignments: { ...cfg.assignments!, tiers: { private: { model: "openrouter/anthropic/claude-sonnet-5", effort: "medium" as const } } } };
    const r = resolvePrivateTier(forged);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("locality: off_machine");
    const switchedOff = parseCompute(`${BOTH}  tiers:\n    private: { model: ollama/gemma4:e4b-it-qat }\n`);
    switchedOff.providers.ollama = { ...switchedOff.providers.ollama!, enabled: false };
    expect(resolvePrivateTier(switchedOff)).toMatchObject({ ok: false });
  });

  it("a capture session in scope overrides whatever tier the rules or the policy chose", () => {
    expect(turnTier("deep", { captureSession: true })).toBe("private");
    expect(turnTier(null, { captureSession: true })).toBe("private");
    expect(turnTier("deep", { captureSession: false })).toBe("deep");
    expect(turnTier(undefined, { captureSession: false })).toBeUndefined();
  });
});

// ---- T4-18: keys as secret references, the switch, billing ------------------------

const CLOUD = (auth: string, extra = "") => `
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    auth: { secret: ${JSON.stringify(auth)} }
    data_policy: { allow: [Areas], deny_sources: [], max_brief_bytes: 1024 }${extra}
assignments:
  default: { model: openrouter/anthropic/claude-sonnet-5 }
`;

describe("auth.secret is a reference (plan §2.14, T4-18)", () => {
  it("takes {{ secret.<name> }} — one of this instance's secrets", () => {
    const cfg = parseCompute(CLOUD("{{ secret.openrouter_api_key }}"));
    expect(credentialOf(cfg.providers.openrouter!.auth!.secret)).toEqual({ kind: "secret", name: "openrouter_api_key", ref: "{{ secret.openrouter_api_key }}" });
  });

  it("takes env:NAME and, so every file written before it still loads, the bare NAME — both an install variable", () => {
    expect(credentialOf("env:METISTRY_BRIDGE_TOKEN_APPLE_FM")).toMatchObject({ kind: "env", name: "METISTRY_BRIDGE_TOKEN_APPLE_FM", legacy: false });
    expect(credentialOf("METISTRY_OPENROUTER_API_KEY")).toMatchObject({ kind: "env", name: "METISTRY_OPENROUTER_API_KEY", legacy: true });
    expect(parseCompute(CLOUD("env:METISTRY_KEY")).providers.openrouter?.auth?.secret).toBe("env:METISTRY_KEY");
    expect(parseCompute(CLOUD("METISTRY_OPENROUTER_API_KEY")).providers.openrouter?.auth?.secret).toBe("METISTRY_OPENROUTER_API_KEY");
  });

  it("refuses a pasted key, a malformed reference and a lowercase bare name — each naming the field and the two spellings", () => {
    for (const bad of ["sk-or-v1-deadbeef", "{{ secret.Bad-Name }}", "{{ secrets.x }}", "openrouter_api_key", "env:lower"]) {
      const m = why(CLOUD(bad));
      expect(m, bad).toContain("providers.openrouter.auth.secret");
      expect(m, bad).toContain("{{ secret.<name> }}");
      expect(m, bad).toContain("never the key itself");
    }
  });

  it("a named secret reaches a service as METISTRY_SECRET_<NAME> — a namespace no install variable is in", () => {
    const c = credentialOf("{{ secret.db_password }}")!;
    expect(credentialEnvNames(c)).toEqual([`${SECRET_DELIVERY_PREFIX}DB_PASSWORD`]);
    // the install's own database password is NOT this secret, whatever the names say
    expect(credentialFromEnv(c, { METISTRY_DB_PASSWORD: "the-db-one" })).toBeUndefined();
    expect(credentialFromEnv(c, { METISTRY_SECRET_DB_PASSWORD: "the-named-one" })).toBe("the-named-one");
  });

  it("for one release a *_api_key secret also answers to the line T4-3 filled from it — a running engine keeps its key across migrate-scope's rewrite", () => {
    const c = credentialOf("{{ secret.openrouter_api_key }}")!;
    expect(credentialEnvNames(c)).toEqual(["METISTRY_SECRET_OPENROUTER_API_KEY", "METISTRY_OPENROUTER_API_KEY"]);
    expect(credentialFromEnv(c, { METISTRY_OPENROUTER_API_KEY: "old-line" })).toBe("old-line");
    expect(credentialFromEnv(c, { METISTRY_OPENROUTER_API_KEY: "old-line", METISTRY_SECRET_OPENROUTER_API_KEY: "new-line" })).toBe("new-line");
    // never a fallback that would spell ANOTHER secret's delivery variable
    expect(credentialEnvNames(credentialOf("{{ secret.secret_x_api_key }}")!)).toEqual(["METISTRY_SECRET_SECRET_X_API_KEY"]);
    // and nothing for a name that was never a provider credential
    expect(credentialEnvNames(credentialOf("{{ secret.github_write }}")!)).toEqual(["METISTRY_SECRET_GITHUB_WRITE"]);
  });

  it("an env reference is read from the variable it names, and a blank value is no value", () => {
    const c = credentialOf("env:METISTRY_BRIDGE_TOKEN_APPLE_FM")!;
    expect(credentialFromEnv(c, { METISTRY_BRIDGE_TOKEN_APPLE_FM: "tok" })).toBe("tok");
    expect(credentialFromEnv(c, { METISTRY_BRIDGE_TOKEN_APPLE_FM: "  " })).toBeUndefined();
  });

  it("providerSecretNames lists every {{ secret.x }} the providers reference, once — what `secrets sync --to env` delivers", () => {
    const cfg = parseCompute(`
providers:
  a: { kind: openai-compatible, base_url: "https://a.example/v1", locality: off_machine, auth: { secret: "{{ secret.shared_key }}" }, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } }
  b: { kind: openai-compatible, base_url: "https://b.example/v1", locality: off_machine, auth: { secret: "{{ secret.shared_key }}" }, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } }
  c: { kind: openai-compatible, base_url: "http://127.0.0.1:7810/v1", locality: on_machine, auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM } }
  d: { kind: openai-compatible, base_url: "https://d.example/v1", locality: off_machine, auth: { secret: "{{ secret.other }}" }, data_policy: { allow: [], deny_sources: [], max_brief_bytes: 1 } }
`);
    expect(providerSecretNames(cfg)).toEqual(["shared_key", "other"]);
  });

  it("engineStatus: absent until the delivery line exists, naming the reference and the variable — never a value", () => {
    const cfg = parseCompute(CLOUD("{{ secret.openrouter_api_key }}"));
    const off = engineStatus(cfg, {});
    expect(off.ok).toBe(false);
    expect(off.secret).toBe("{{ secret.openrouter_api_key }}");
    expect(off.why).toContain("providers.openrouter.auth.secret is {{ secret.openrouter_api_key }}");
    expect(off.why).toContain("METISTRY_SECRET_OPENROUTER_API_KEY");
    expect(off.fix).toContain("metistry secrets sync --to env");
    expect(engineStatus(cfg, { METISTRY_SECRET_OPENROUTER_API_KEY: "k" }).ok).toBe(true);
    expect(engineStatus(cfg, { METISTRY_OPENROUTER_API_KEY: "k" }).ok).toBe(true);
    // the pre-T4-18 spelling reads exactly as it did
    const legacy = engineStatus(parseCompute(CLOUD("METISTRY_OPENROUTER_API_KEY")), {});
    expect(legacy.why).toContain("providers.openrouter.auth.secret names METISTRY_OPENROUTER_API_KEY, which is unset here");
  });
});

describe("the provider switch (C130)", () => {
  const TWO = (enabled: string) => `
providers:
  lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine${enabled} }
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
`;

  it("is on unless the file says enabled: false — every file written before it is unchanged", () => {
    expect(parseCompute(TWO("")).providers.lmstudio?.enabled).toBeUndefined();
    expect(parseCompute(TWO(", enabled: false")).providers.lmstudio?.enabled).toBe(false);
    expect(why(TWO(", enabled: nope"))).toContain("providers.lmstudio.enabled");
  });

  it("a switched-off provider may be declared, but nothing may be assigned to it — default, tier, crew, shadow and intent each refused by name", () => {
    const base = TWO(", enabled: false");
    const cases: Array<[string, string]> = [
      ["assignments:\n  default: { model: lmstudio/a }\n", "assignments.default.model"],
      ["assignments:\n  default: { model: ollama/a }\n  tiers: { deep: { model: lmstudio/a } }\n", "assignments.tiers.deep.model"],
      ["assignments:\n  default: { model: ollama/a }\n  crews: { researcher: { model: lmstudio/a } }\n", "assignments.crews.researcher.model"],
      ["assignments:\n  default: { model: ollama/a, shadow: { model: lmstudio/a, fraction: 0.1 } }\n", "assignments.default.shadow.model"],
      ["assignments:\n  default: { model: ollama/a }\n  intent: { model: lmstudio/a }\n", "assignments.intent.model"],
    ];
    for (const [block, field] of cases) {
      const m = why(`${base}${block}`);
      expect(m, field).toContain(field);
      expect(m, field).toContain("providers.lmstudio is switched off");
      expect(m, field).toContain("metistry compute providers set lmstudio --enabled on");
    }
    expect(parseCompute(`${base}assignments:\n  default: { model: ollama/a }\n`).assignments?.default.model).toBe("ollama/a");
  });

  it("a crew whose own model is on a switched-off provider is parked with the reason, never run on it", () => {
    const cfg = parseCompute(`${TWO(", enabled: false")}assignments:\n  default: { model: ollama/a }\n`);
    const r = resolveCrewAssignment(cfg, "researcher", { model: "lmstudio/a", effort: "medium" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("providers.lmstudio is switched off");
  });

  it("the embedder's default skips a switched-off local server", () => {
    expect(firstOnMachineBaseUrl(parseCompute(TWO(", enabled: false")))).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("billing (C128) and the one tag (C132)", () => {
  it("token or subscription, off this machine only; the tag is Local, Cloud or Subscription", () => {
    const sub = parseCompute(CLOUD("{{ secret.k }}", "\n    billing: subscription"));
    expect(sub.providers.openrouter?.billing).toBe("subscription");
    expect(providerTag(sub.providers.openrouter!)).toBe("subscription");
    expect(providerTag(parseCompute(CLOUD("{{ secret.k }}")).providers.openrouter!)).toBe("cloud");
    expect(providerTag(parseCompute(CLOUD("{{ secret.k }}", "\n    billing: token")).providers.openrouter!)).toBe("cloud");
    const local = parseCompute("providers: { lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine } }");
    expect(providerTag(local.providers.lmstudio!)).toBe("local");
  });

  it("refuses billing on a local server — it bills nothing — and an unknown mode, naming the field", () => {
    expect(why("providers: { lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine, billing: subscription } }")).toContain("providers.lmstudio.billing");
    expect(why(CLOUD("{{ secret.k }}", "\n    billing: monthly"))).toContain("billing must be token or subscription");
  });
});
