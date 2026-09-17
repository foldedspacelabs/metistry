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
  firstOnMachineBaseUrl,
  loadCompute,
  modelRefIssue,
  parseCompute,
  parseModelRef,
  parseTiers,
  resolveAssignment,
  resolveTier,
  servedProviders,
  collectorProviderIssue,
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

  it("every shipped provider template is a valid provider block", () => {
    for (const name of ["openrouter", "lmstudio", "ollama"]) {
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
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
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
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
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
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
  lmstudio: { kind: openai-compatible, base_url: http://127.0.0.1:1234/v1, locality: on_machine }
  ollama: { kind: openai-compatible, base_url: http://127.0.0.1:11434/v1, locality: on_machine }
`);
    expect(firstOnMachineBaseUrl(cfg)).toBe("http://127.0.0.1:1234/v1");
  });

  it("is undefined when nothing runs on this machine", () => {
    expect(firstOnMachineBaseUrl(emptyCompute())).toBeUndefined();
  });
});
