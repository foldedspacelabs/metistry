// `metistry compute` against fakes for everything outside the process: the
// login Keychain is a Map behind a `security` exec fake, every provider call
// is a fake fetch, and the instance repo is a temp directory. The assertions
// that matter are the conservative ones — a key never reaches argv, an edit
// that would not validate is never written, a provider still named by an
// assignment cannot be removed, and a refusal names the field.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompute } from "@foldedspacelabs/metistry-core";
import {
  COMPUTE_TEMPLATES,
  STABLE_PREFIX_HIT_RATIO,
  apiRoot,
  assign,
  cacheReport,
  computeReport,
  modelsInstall,
  modelsList,
  modelsLoad,
  parseAssignmentTarget,
  parseBudgetAction,
  parseBudgetTarget,
  parseEffort,
  parseTemplate,
  providerTest,
  providersAdd,
  providersRemove,
  parseSince,
  readTemplate,
  renderCacheReport,
  renderComputeReport,
  renderModelsInstall,
  renderModelsList,
  renderProviderTest,
  setBudget,
  type ComputeOptions,
} from "../src/compute.js";
import { createUi, strip } from "../src/ui.js";
import type { Exec, ExecOptions } from "../src/exec.js";
import { main } from "../src/main.js";

// A product checkout these tests may safely hand to `main()`: seed/ copied out
// of the real one, and — the whole point — no `.env`. Passing the real
// checkout instead makes `main()` load a RUNNING install's environment,
// reconciler bridge included, and `compute providers add` is then committed to
// the operator's instance repo no matter what `--instance` said. That is not a
// worry, it happened (docs/ops/testing.md).
const REPO = await mkdtemp(join(tmpdir(), "metistry-compute-product-"));
const SEED = join(REPO, "seed");
await cp(fileURLToPath(new URL("../../../seed", import.meta.url)), SEED, { recursive: true });

/** A login Keychain in a Map, keyed by (account, service). Records calls so a test can prove a value never reached argv. */
function fakeSecurity(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const calls: Array<{ args: string[]; opts: ExecOptions }> = [];
  const exec: Exec = async (cmd, args, opts = {}) => {
    calls.push({ args, opts });
    if (cmd !== "security") return { code: 1, stdout: "", stderr: "not security" };
    const at = `${args[args.indexOf("-a") + 1] ?? ""}/${args[args.indexOf("-s") + 1] ?? ""}`;
    if (args[0] === "add-generic-password") {
      const [a, b] = String(opts.stdin ?? "").split("\n");
      if (a === undefined || a !== b) return { code: 1, stdout: "", stderr: "passwords don't match" };
      store.set(at, a);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "find-generic-password") {
      if (!store.has(at)) return { code: 44, stdout: "", stderr: "not found" };
      return { code: 0, stdout: args.includes("-w") ? `${store.get(at)}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args[0]}` };
  };
  return { exec, store, calls };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** `/models` and `/chat/completions` from a table of routes; every call recorded. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response("no route", { status: 502 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const KEY = "sk-or-v1-never-in-argv";
const ACCOUNT = "metistry-test-account";

async function instance(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "metistry-compute-"));
}

/** Options plus the lines the verb printed. */
function harness(dir: string, extra: Partial<ComputeOptions> = {}): { o: ComputeOptions; lines: string[] } {
  const lines: string[] = [];
  const o: ComputeOptions = {
    instanceDir: dir,
    seedDir: SEED,
    env: { METISTRY_KEYCHAIN_ACCOUNT: ACCOUNT },
    platform: "darwin",
    uid: 501,
    out: (l: string) => lines.push(l),
    ...extra,
  };
  return { o, lines };
}

const file = (dir: string) => join(dir, ".metistry", "compute.yaml");
/** The instance fixture: `.metistry/` has to exist before a hand-written compute.yaml can land in it. */
const withMetistryDir = async (dir: string) => {
  await mkdir(join(dir, ".metistry"), { recursive: true });
  return dir;
};

// A cloud that does NOT claim ZDR, written BY HAND. No shipped template is
// non-ZDR any more (OPEN-7, 2026-09-17: the Zen template went, and every
// other OpenAI-compatible cloud is a base URL you write yourself), so the
// C13 warning has to be proved on the shape people are actually left with.
const HANDWRITTEN_CLOUD = `providers:
  cloud:
    kind: openai-compatible
    base_url: https://cloud.example/v1
    locality: off_machine
    auth: { secret: METISTRY_CLOUD_API_KEY }
    data_policy: { allow: [Projects], deny_sources: [comms], max_brief_bytes: 65536 }
    pricing: { example-model: { in_per_m: 1, out_per_m: 2 } }
`;

describe("argument parsing: strict, never a guess", () => {
  it("assignment targets", () => {
    expect(parseAssignmentTarget("default")).toEqual({ kind: "default" });
    expect(parseAssignmentTarget("deep")).toEqual({ kind: "tier", name: "deep" });
    expect(parseAssignmentTarget("crew:researcher")).toEqual({ kind: "crew", name: "researcher" });
    expect(() => parseAssignmentTarget("Deep")).toThrow(/not an assignment target/);
    expect(() => parseAssignmentTarget(undefined)).toThrow(/default.*crew:/s);
  });

  it("budget targets, actions, efforts and templates", () => {
    expect(parseBudgetTarget("instance")).toEqual({ kind: "instance" });
    expect(parseBudgetTarget("provider:openrouter")).toEqual({ kind: "provider", name: "openrouter" });
    expect(() => parseBudgetTarget("openrouter")).toThrow(/instance.*provider:/s);
    expect(parseBudgetAction("critical_only")).toBe("critical_only");
    expect(parseBudgetAction("warn")).toBeUndefined(); // the old spelling is not silently accepted
    expect(parseEffort(undefined)).toBeUndefined();
    expect(() => parseEffort("extreme")).toThrow(/low, medium or high/);
    expect(parseTemplate("openrouter")).toBe("openrouter");
    expect(parseTemplate("anthropic")).toBeUndefined();
  });

  it("apiRoot tolerates a trailing slash so `${root}/models` is always right", () => {
    expect(apiRoot("http://127.0.0.1:1234/v1/")).toBe("http://127.0.0.1:1234/v1");
  });
});

describe("providers add", () => {
  it("writes a local provider with no secret and no network", async () => {
    const dir = await instance();
    const { o, lines } = harness(dir, { platform: "linux" });
    const r = await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    expect(r.name).toBe("lmstudio");
    expect(r.secretStatus).toBe("none");
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("base_url: http://127.0.0.1:1234/v1");
    expect(text).toContain("locality: on_machine");
    expect(text).toMatch(/^# compute\.yaml/); // the header this command writes for a file that did not exist
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("reads the key from stdin into the USER Keychain account, never into argv or the file", async () => {
    const dir = await instance();
    const kc = fakeSecurity();
    const http = fakeFetch({ "https://openrouter.ai/api/v1/models": { body: { data: [{ id: "anthropic/claude-sonnet-5" }] } } });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn, readSecret: async () => `${KEY}\n` });
    const r = await providersAdd({ ...o, template: "openrouter" });

    expect(r.secret).toBe("METISTRY_OPENROUTER_API_KEY");
    expect(r.secretStatus).toBe("stored");
    expect(kc.store.get(`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`)).toBe(KEY);
    for (const c of kc.calls) expect(c.args.join(" ")).not.toContain(KEY); // stdin only
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("secret: METISTRY_OPENROUTER_API_KEY");
    expect(text).not.toContain(KEY);

    // and it ends with a real probe, carrying the bearer it just stored
    expect(r.test?.ok).toBe(true);
    expect(http.calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect((http.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("refuses a second provider of the same name, a bad --name, and a --secret that is a value", async () => {
    const dir = await instance();
    const { o } = harness(dir, { platform: "linux" });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    await expect(providersAdd({ ...o, template: "lmstudio", skipTest: true })).rejects.toThrow(/already declares provider lmstudio/);
    await expect(providersAdd({ ...o, template: "lmstudio", name: "LM Studio", skipTest: true })).rejects.toThrow(/--name/);
    await expect(providersAdd({ ...o, template: "openrouter", secret: KEY, skipTest: true })).rejects.toThrow(/never the key itself/);
  });

  it("--name and --base-url rewrite the template block", async () => {
    const dir = await instance();
    const { o } = harness(dir, { platform: "linux" });
    await providersAdd({ ...o, template: "ollama", name: "box", baseUrl: "http://10.0.0.4:11434/v1", skipTest: true });
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("box:");
    expect(text).toContain("base_url: http://10.0.0.4:11434/v1");
  });

  it("every shipped template is one named provider block", async () => {
    for (const name of COMPUTE_TEMPLATES) {
      expect((await readTemplate(SEED, name)).name).toBe(name);
    }
  });

  // The Apple FM provider IS one of Metistry's own bridges, so its
  // credential is a secret this install already holds. Asking the operator
  // to paste back a token we minted would be theatre.
  it("applefm: adds with no prompt when the bridge token is already in the environment", async () => {
    const dir = await instance();
    const { o, lines } = harness(dir, { platform: "darwin", env: { METISTRY_KEYCHAIN_ACCOUNT: ACCOUNT, METISTRY_BRIDGE_TOKEN_APPLE_FM: "already-set" } });
    const r = await providersAdd({ ...o, template: "applefm", skipTest: true, readSecret: async () => { throw new Error("must not prompt"); } });
    expect(r.secret).toBe("METISTRY_BRIDGE_TOKEN_APPLE_FM");
    expect(r.secretStatus).toBe("present");
    expect(lines.join("\n")).toContain("already set in this install's environment");
    expect(lines.join("\n")).not.toContain("already-set"); // the VALUE never prints
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("applefm:");
    expect(text).toContain("secret: METISTRY_BRIDGE_TOKEN_APPLE_FM");
    expect(text).toContain("runtime: applefm");
    // and it parses back as a served, on-machine provider a collector may use
    const cfg = parseCompute(text);
    expect(cfg.providers.applefm?.locality).toBe("on_machine");
    expect(cfg.providers.applefm?.serve).toEqual({ runtime: "applefm", port: 7810, extra_args: [] });
  });
});

describe("assign / budget: the file is edited in place and never left invalid", () => {
  async function withLocal(): Promise<{ dir: string; o: ComputeOptions; lines: string[] }> {
    const dir = await instance();
    const { o, lines } = harness(dir, { platform: "linux" });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    return { dir, o, lines };
  }

  it("assigns default, a tier and a crew, keeping the file's comments", async () => {
    const { dir, o } = await withLocal();
    await writeFile(file(dir), `${await readFile(file(dir), "utf8")}\n# a note the operator wrote by hand\n`);
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "lmstudio/google/gemma-3n-e4b" });
    const r = await assign({ ...o, target: parseAssignmentTarget("deep"), model: "lmstudio/google/gemma-3n-e4b", effort: "high" });
    await assign({ ...o, target: parseAssignmentTarget("crew:researcher"), model: "lmstudio/google/gemma-3n-e4b" });
    expect(r).toMatchObject({ target: "assignments.tiers.deep", provider: "lmstudio", model: "google/gemma-3n-e4b", effort: "high", warn_non_zdr: false });
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("# a note the operator wrote by hand");
    expect(text).toContain("researcher:");
    expect(text).toMatch(/model: lmstudio\/google\/gemma-3n-e4b/);
  });

  it("a tier cannot be assigned before default — every unknown tier lands there", async () => {
    const { dir, o } = await withLocal();
    await expect(assign({ ...o, target: parseAssignmentTarget("fast"), model: "lmstudio/a" })).rejects.toThrow(/assignments\.default is not set yet/);
    expect(await readFile(file(dir), "utf8")).not.toContain("assignments:");
  });

  it("an effort already in the file survives a reassignment that does not name one", async () => {
    const { dir, o } = await withLocal();
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "lmstudio/a" });
    await assign({ ...o, target: parseAssignmentTarget("fast"), model: "lmstudio/a", effort: "low" });
    const r = await assign({ ...o, target: parseAssignmentTarget("fast"), model: "lmstudio/b" });
    expect(r.effort).toBe("low");
  });

  it("refuses a model whose provider is not in the file, naming the field, and writes nothing", async () => {
    const { dir, o } = await withLocal();
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "lmstudio/a" });
    const before = await readFile(file(dir), "utf8");
    await expect(assign({ ...o, target: parseAssignmentTarget("deep"), model: "openrouter/anthropic/claude-sonnet-5" })).rejects.toThrow(/assignments\.tiers\.deep\.model/);
    await expect(assign({ ...o, target: parseAssignmentTarget("deep"), model: "lmstudio/auto" })).rejects.toThrow(/auto-router/);
    await expect(assign({ ...o, target: parseAssignmentTarget("deep"), model: "gemma" })).rejects.toThrow(/<provider>\/<model-id>/);
    expect(await readFile(file(dir), "utf8")).toBe(before);
  });

  it("warns, never blocks, on an off_machine provider that does not claim ZDR (C13)", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_CLOUD_API_KEY`]: KEY });
    const { o, lines } = harness(dir, { exec: kc.exec });
    await writeFile(file(await withMetistryDir(dir)), HANDWRITTEN_CLOUD);
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "cloud/example-model" });
    const r = await assign({ ...o, target: parseAssignmentTarget("deep"), model: "cloud/example-model" });
    expect(r.warn_non_zdr).toBe(true);
    expect(lines.join("\n")).toContain("zero data retention");
    expect(await readFile(file(dir), "utf8")).toContain("model: cloud/example-model");
  });

  it("budgets: an action with no limit is refused; --daily and --monthly accumulate", async () => {
    const { dir, o } = await withLocal();
    await expect(setBudget({ ...o, target: parseBudgetTarget("instance"), action: "stop" })).rejects.toThrow(/budgets\.instance.*never fires/s);
    await setBudget({ ...o, target: parseBudgetTarget("instance"), monthly: 60, action: "stop" });
    const r = await setBudget({ ...o, target: parseBudgetTarget("instance"), daily: 5, action: "critical_only" });
    expect(r).toMatchObject({ target: "budgets.instance", daily_usd: 5, monthly_usd: 60, action: "critical_only" });
    await setBudget({ ...o, target: parseBudgetTarget("provider:lmstudio"), daily: 1, action: "allow" });
    expect(await readFile(file(dir), "utf8")).toContain("action: allow");
    await expect(setBudget({ ...o, target: parseBudgetTarget("provider:nope"), daily: 1, action: "stop" })).rejects.toThrow(/budgets\.providers\.nope/);
  });

  it("refuses to remove a provider an assignment or a budget still names", async () => {
    const { dir, o } = await withLocal();
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "lmstudio/a" });
    await expect(providersRemove({ ...o, name: "lmstudio" })).rejects.toThrow(/assignments\.default/);
    expect(await readFile(file(dir), "utf8")).toContain("lmstudio:");
    await expect(providersRemove({ ...o, name: "nope" })).rejects.toThrow(/does not declare a provider called nope/);
  });

  it("removes an unreferenced provider", async () => {
    const { dir, o } = await withLocal();
    await providersAdd({ ...o, template: "ollama", skipTest: true });
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "ollama/llama" });
    await providersRemove({ ...o, name: "lmstudio" });
    const text = await readFile(file(dir), "utf8");
    expect(text).not.toContain("lmstudio:");
    expect(text).toContain("ollama:");
  });
});

describe("test / models list: live probes through the one seam", () => {
  it("carries the bearer, reports the model count, and fails a 401 without printing the key", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`]: KEY });
    const http = fakeFetch({ "https://openrouter.ai/api/v1/models": { status: 401, body: { error: "no" } } });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true });
    const t = await providerTest({ ...o, name: "openrouter" });
    expect(t.ok).toBe(false);
    expect(t.detail).toContain("HTTP 401");
    expect(renderProviderTest(t)).toContain("FAILED");
    expect(JSON.stringify(t)).not.toContain(KEY);
  });

  it("--complete makes one real one-token call on an assigned model, with the provider's request block", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`]: KEY });
    const http = fakeFetch({
      "https://openrouter.ai/api/v1/models": { body: { data: [{ id: "z" }, { id: "anthropic/claude-sonnet-5" }] } },
      "https://openrouter.ai/api/v1/chat/completions": { body: { choices: [] } },
    });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true });
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "openrouter/anthropic/claude-sonnet-5" });
    const t = await providerTest({ ...o, name: "openrouter", complete: true });
    expect(t.completion).toMatchObject({ ok: true, model: "anthropic/claude-sonnet-5" });
    const body = JSON.parse(String(http.calls.at(-1)?.init?.body));
    expect(body).toMatchObject({ model: "anthropic/claude-sonnet-5", max_tokens: 1, provider: { order: ["anthropic"], allow_fallbacks: false } });
  });

  it("with nothing assigned, --complete picks the bake-off's own shortlist model, not the alphabetically-first one from a 447-model catalogue (the bug this fixes)", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`]: KEY });
    const http = fakeFetch({
      "https://openrouter.ai/api/v1/models": { body: { data: [{ id: "aion-labs/aion-2.0" }, { id: "anthropic/claude-sonnet-5" }, { id: "zzz/z" }] } },
      "https://openrouter.ai/api/v1/chat/completions": { status: 404, body: { error: "no route" } },
    });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true });
    // no assignment at all — this is the exact state that produced the bug report
    const t = await providerTest({ ...o, name: "openrouter", complete: true });
    expect(t.listingOk).toBe(true); // the key is fine; only the probe model was wrong
    expect(t.ok).toBe(false); // the completion still failed, and --complete was asked
    expect(t.completion).toMatchObject({ ok: false, model: "anthropic/claude-sonnet-5" });
    expect(t.completion?.reason).toMatch(/shortlist/);
    const text = renderProviderTest(t);
    expect(text).toContain("listing ok");
    expect(text).toContain("anthropic/claude-sonnet-5");
    expect(text).toContain("override with --model");
    const completionLine = text.split("\n").find((l) => l.includes("completion"));
    expect(completionLine).not.toContain("aion-labs"); // the completion probe never falls back to the alphabetically-first model again
  });

  it("--model overrides the automatic choice, even over an existing assignment", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`]: KEY });
    const http = fakeFetch({
      "https://openrouter.ai/api/v1/models": { body: { data: [{ id: "anthropic/claude-sonnet-5" }, { id: "z" }] } },
      "https://openrouter.ai/api/v1/chat/completions": { body: { choices: [] } },
    });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true });
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "openrouter/anthropic/claude-sonnet-5" });
    const t = await providerTest({ ...o, name: "openrouter", complete: true, model: "z" });
    expect(t.completion).toMatchObject({ ok: true, model: "z", reason: "--model" });
  });

  it("falls back to OpenRouter's own auto-router when nothing is assigned and the shortlist model is not served", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_OPENROUTER_API_KEY`]: KEY });
    const http = fakeFetch({
      "https://openrouter.ai/api/v1/models": { body: { data: [{ id: "aion-labs/aion-2.0" }, { id: "openrouter/auto" }] } },
      "https://openrouter.ai/api/v1/chat/completions": { body: { choices: [] } },
    });
    const { o } = harness(dir, { exec: kc.exec, fetchFn: http.fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true });
    const t = await providerTest({ ...o, name: "openrouter", complete: true });
    expect(t.completion).toMatchObject({ ok: true, model: "openrouter/auto" });
    expect(t.completion?.reason).toMatch(/auto-router/);
  });

  it("a non-OpenRouter provider with nothing assigned still probes the first listed model, as before", async () => {
    const dir = await instance();
    const http = fakeFetch({
      "http://127.0.0.1:1234/v1/models": { body: { data: [{ id: "b-model" }, { id: "a-model" }] } },
      "http://127.0.0.1:1234/v1/chat/completions": { body: { choices: [] } },
    });
    const { o } = harness(dir, { platform: "linux", fetchFn: http.fn });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    const t = await providerTest({ ...o, name: "lmstudio", complete: true });
    // fetchModels sorts the listing, so this is the alphabetically-first —
    // unchanged from before this fix for a provider with no shortlist entry.
    expect(t.completion).toMatchObject({ ok: true, model: "a-model" });
  });

  it("a missing Keychain item names the variable and how to store it, never a value", async () => {
    const dir = await instance();
    const kc = fakeSecurity();
    const { o } = harness(dir, { exec: kc.exec, fetchFn: fakeFetch({}).fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true, readSecret: async () => KEY });
    kc.store.clear();
    await expect(providerTest({ ...o, name: "openrouter" })).rejects.toThrow(/METISTRY_OPENROUTER_API_KEY, which is not in the login Keychain/);
    await expect(providerTest({ ...o, name: "nope" })).rejects.toThrow(/providers\.nope is not declared/);
  });

  it("models list reports every declared provider, and an unreachable local server says so", async () => {
    const dir = await instance();
    const http = fakeFetch({ "http://127.0.0.1:1234/v1/models": { body: { data: [{ id: "google/gemma-3n-e4b" }] } } });
    const { o } = harness(dir, { platform: "linux", fetchFn: http.fn });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    await providersAdd({ ...o, template: "ollama", skipTest: true });
    const r = await modelsList({ ...o });
    expect(r.providers.map((p) => p.name)).toEqual(["lmstudio", "ollama"]);
    expect(r.providers[0]?.models).toEqual(["google/gemma-3n-e4b"]);
    expect(r.providers[1]?.ok).toBe(false); // no route: HTTP 502 from the fake
    expect(renderModelsList(r)).toContain("lmstudio/google/gemma-3n-e4b");
    expect((await modelsList({ ...o, provider: "lmstudio" })).providers).toHaveLength(1);
  });

  it("also reports a local server that is RUNNING but that no provider dials, with the command that would add it", async () => {
    const dir = await instance();
    // Ollama is up on its default port; compute.yaml knows only about LM Studio
    const http = fakeFetch({
      "http://127.0.0.1:1234/v1/models": { body: { data: [{ id: "qwen/qwen3-coder-30b" }] } },
      "http://127.0.0.1:11434/v1/models": { body: { data: [{ id: "gemma3:4b", owned_by: "library" }] } },
    });
    const { o } = harness(dir, { platform: "linux", fetchFn: http.fn });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    const r = await modelsList({ ...o });
    expect(r.providers.map((p) => p.name)).toEqual(["lmstudio"]);
    expect(r.detected.map((d) => d.server)).toEqual(["ollama"]);
    const text = renderModelsList(r);
    expect(text).toContain("not configured — `metistry compute providers add --from ollama`");
    expect(text).toContain("(ollama)/gemma3:4b");
    // asking about ONE provider is not an excuse to scan the whole Mac
    expect((await modelsList({ ...o, provider: "lmstudio" })).detected).toEqual([]);
  });
});

describe("models install", () => {
  /** `lms`, recorded. Every other command falls through to the Keychain fake. */
  function fakeLms(code = 0) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code, stdout: "", stderr: code === 0 ? "" : "boom" };
    };
    return { exec, calls };
  }

  it("LM Studio: `lms get <id>`", async () => {
    const dir = await instance();
    const lms = fakeLms();
    const { o, lines } = harness(dir, { platform: "linux", fetchFn: fakeFetch({}).fn, exec: lms.exec });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    const r = await modelsInstall({ ...o, ref: "lmstudio/qwen/qwen3-coder-30b" });
    expect(r).toMatchObject({ provider: "lmstudio", server: "lmstudio", model: "qwen/qwen3-coder-30b", ok: true });
    expect(lms.calls).toContainEqual(["lms", "get", "qwen/qwen3-coder-30b"]);
    expect(lines.at(-1)).toContain("lms get qwen/qwen3-coder-30b");
    expect(renderModelsInstall(r)).toContain("installed");
  });

  it("Ollama: POST /api/pull above /v1, with progress", async () => {
    const dir = await instance();
    const ndjson = [{ status: "pulling manifest" }, { status: "success" }].map((o) => JSON.stringify(o)).join("\n");
    const http = ((async (input: string | URL | Request) => {
      if (String(input) === "http://127.0.0.1:11434/api/pull") return new Response(ndjson, { status: 200 });
      return new Response("{}", { status: 502 });
    }) as unknown) as typeof fetch;
    const { o, lines } = harness(dir, { platform: "linux", fetchFn: http });
    await providersAdd({ ...o, template: "ollama", skipTest: true });
    const r = await modelsInstall({ ...o, ref: "ollama/gemma3:4b" });
    expect(r.ok).toBe(true);
    expect(lines.join("\n")).toContain("pulling manifest");
  });

  it("llama-server: downloads the GGUF and writes serve.model_path as the `user`", async () => {
    const dir = await instance();
    const bytes = new TextEncoder().encode("GGUF-bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const url = "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf";
    const http = ((async (input: string | URL | Request) => {
      if (String(input) === url) return new Response(bytes as unknown as BodyInit, { status: 200, headers: { "x-linked-etag": `"${sha}"`, "x-linked-size": String(bytes.byteLength) } });
      return new Response("{}", { status: 502 });
    }) as unknown) as typeof fetch;
    const { o } = harness(dir, { platform: "linux", fetchFn: http });
    await providersAdd({ ...o, template: "llamaserver", skipTest: true });
    const r = await modelsInstall({ ...o, ref: "llamaserver/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf" });
    expect(r.model_path).toBe(".metistry/state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
    expect(r.sha256).toBe(sha);
    expect(existsSync(join(dir, r.model_path!))).toBe(true);
    // the file on disk is what the schema accepts back — a write that would
    // not validate is refused before it is written
    const after = await readFile(file(dir), "utf8");
    expect(after).toContain("model_path: .metistry/state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
    expect((await computeReport(o)).providers[0]?.name).toBe("llamaserver");
  });

  it("refuses to install into a cloud provider, and into a local one it has no mechanism for", async () => {
    const dir = await instance();
    const kc = fakeSecurity();
    const { o } = harness(dir, { exec: kc.exec, fetchFn: fakeFetch({}).fn });
    await providersAdd({ ...o, template: "openrouter", skipTest: true, readSecret: async () => KEY });
    await expect(modelsInstall({ ...o, ref: "openrouter/anthropic/claude-sonnet-5" })).rejects.toThrow(/its models are a catalogue, not an install/);

    await writeFile(file(dir), `${await readFile(file(dir), "utf8")}\n  odd: { kind: openai-compatible, base_url: "http://127.0.0.1:5555/v1", locality: on_machine }\n`);
    await expect(modelsInstall({ ...o, ref: "odd/some-model" })).rejects.toThrow(/does not know how to install a model into odd/);
  });

  it("load/unload acts for LM Studio and says what governs residency for the other two", async () => {
    const dir = await instance();
    const lms = fakeLms();
    const { o } = harness(dir, { platform: "linux", fetchFn: fakeFetch({}).fn, exec: lms.exec });
    await providersAdd({ ...o, template: "lmstudio", skipTest: true });
    await providersAdd({ ...o, template: "ollama", skipTest: true });
    await providersAdd({ ...o, template: "llamaserver", skipTest: true });

    expect(await modelsLoad({ ...o, ref: "lmstudio/m", ttlSeconds: 600 })).toMatchObject({ ok: true, noop: false, action: "load" });
    expect(lms.calls).toContainEqual(["lms", "load", "m", "--ttl", "600"]);
    expect(await modelsLoad({ ...o, ref: "lmstudio/m", unload: true })).toMatchObject({ action: "unload", noop: false });

    const oll = await modelsLoad({ ...o, ref: "ollama/gemma3:4b" });
    expect(oll).toMatchObject({ ok: true, noop: true });
    expect(oll.detail).toContain("keep_alive");
    const llama = await modelsLoad({ ...o, ref: "llamaserver/whatever" });
    expect(llama.noop).toBe(true);
    expect(llama.detail).toContain("metistry restart llamaserver");
  });
});

describe("show", () => {
  it("reports the overlay, secret PRESENCE (never a value), assignments and the non-ZDR warning", async () => {
    const dir = await instance();
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_CLOUD_API_KEY`]: KEY });
    const { o } = harness(dir, { exec: kc.exec });
    const empty = await computeReport(o);
    expect(empty.assigns_nothing).toBe(true);
    expect(renderComputeReport(empty)).toContain("rules.yaml's `tiers:` is still the live map");
    // the no-providers hint names every template — a stale, partial list here
    // is exactly the drift the 2026-09-17 second-instance guide caught in
    // main.ts's --help (docs/product/record/2026-09-17-second-instance-guide.md)
    for (const t of COMPUTE_TEMPLATES) expect(renderComputeReport(empty), t).toContain(t);

    await writeFile(file(await withMetistryDir(dir)), HANDWRITTEN_CLOUD);
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "cloud/example-model" });
    await assign({ ...o, target: parseAssignmentTarget("deep"), model: "cloud/example-model", effort: "high" });
    await setBudget({ ...o, target: parseBudgetTarget("instance"), monthly: 60, action: "stop" });
    const r = await computeReport(o);
    expect(r.file).toBe(file(dir));
    expect(r.files).toEqual([join(SEED, "compute.yaml"), file(dir)]); // seed first, the instance's own last
    expect(r.providers[0]).toMatchObject({ name: "cloud", secret: "METISTRY_CLOUD_API_KEY", secret_present: true, models_assigned: ["example-model"] });
    expect(r.assignments.map((a) => a.target)).toEqual(["default", "deep"]);
    expect(r.assignments[1]).toMatchObject({ target: "deep", provider: "cloud", effort: "high", warn_non_zdr: true });
    expect(r.instance_budget).toMatchObject({ monthly_usd: 60, action: "stop" });
    const text = renderComputeReport(r);
    expect(text).toContain("METISTRY_CLOUD_API_KEY (in Keychain)");
    expect(text).not.toContain(KEY);
    expect(text).toContain("Not wired yet");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe("metistry compute (the command)", () => {
  const run = async (args: string[], exec?: Exec) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), platform: "linux", uid: 501, ...(exec ? { exec } : {}) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("show --json on an instance with no compute.yaml: valid, empty, and honest about it", async () => {
    const dir = await instance();
    const r = await run(["compute", "show", "--json", "--instance", dir, "--product-dir", REPO]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.assigns_nothing).toBe(true);
    expect(report.providers).toEqual([]);
    expect(report.file).toBe(join(SEED, "compute.yaml")); // the seed's, which assigns nothing
  });

  it("providers add --json: exactly one JSON document on stdout, the Keychain notice on stderr", async () => {
    // openrouter has a secret to ask about; linux has no login Keychain to ask
    // it into, so `providersAdd` prints a notice through the same `out` the
    // JSON result goes to — this is the case PR #174 found mixed on one
    // stream (docs/ops/cli.md's `--json` paragraph).
    const dir = await instance();
    const r = await run(["compute", "providers", "add", "--from", "openrouter", "--skip-test", "--json", "--instance", dir, "--product-dir", REPO]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out); // throws if the notice leaked onto stdout ahead of the document
    expect(parsed).toMatchObject({ name: "openrouter", secretStatus: "skipped" });
    expect(r.err).toContain("no login Keychain on linux");
  });

  it("add → assign → budget → show, all through the command, and each write lands in the instance's file", async () => {
    const dir = await instance();
    const P = ["--instance", dir, "--product-dir", REPO];
    expect((await run(["compute", "providers", "add", "--from", "lmstudio", "--skip-test", ...P])).code).toBe(0);
    expect((await run(["compute", "assign", "default", "lmstudio/google/gemma-3n-e4b", ...P])).code).toBe(0);
    expect((await run(["compute", "assign", "routine", "lmstudio/google/gemma-3n-e4b", "--effort", "low", ...P])).code).toBe(0);
    expect((await run(["compute", "budget", "instance", "--monthly", "60", "--action", "stop", ...P])).code).toBe(0);
    const text = await readFile(file(dir), "utf8");
    expect(text).toContain("lmstudio:");
    expect(text).toContain("routine:");
    expect(text).toContain("monthly_usd: 60");

    const shown = JSON.parse((await run(["compute", "show", "--json", ...P])).out);
    expect(shown.assignments.map((a: { target: string }) => a.target)).toEqual(["default", "routine"]);
  });

  it("usage errors exit 2 and change nothing", async () => {
    const dir = await instance();
    const P = ["--instance", dir, "--product-dir", REPO];
    expect((await run(["compute", "providers", "add", "--from", "anthropic", ...P])).code).toBe(2);
    expect((await run(["compute", "budget", "instance", "--daily", "5", "--action", "warn", ...P])).code).toBe(2);
    expect((await run(["compute", "nonesuch", ...P])).code).toBe(2);
    delete process.env.METISTRY_INSTANCE_DIR; // loadInstallEnv writes it back into the environment; an earlier test's --instance must not answer for this one
    // --product-dir even here: without one the CLI resolves the checkout it is
    // running inside and reads that install's .env, which would answer with a
    // real instance directory and turn this exit-2 case into an exit 0.
    expect((await run(["compute", "show", "--product-dir", REPO])).code).toBe(2); // no instance dir
    expect(existsSync(file(dir))).toBe(false);
  });

  it("a refusal from the schema exits 1 with the field in it", async () => {
    const dir = await instance();
    const P = ["--instance", dir, "--product-dir", REPO];
    await run(["compute", "providers", "add", "--from", "lmstudio", "--skip-test", ...P]);
    await run(["compute", "assign", "default", "lmstudio/a", ...P]);
    const r = await run(["compute", "assign", "deep", "openrouter/anthropic/claude-sonnet-5", ...P]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("assignments.tiers.deep.model");
  });

  it("--dry-run prints the plan and writes nothing", async () => {
    const dir = await instance();
    const r = await run(["compute", "providers", "add", "--from", "ollama", "--dry-run", "--instance", dir, "--product-dir", REPO]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[dry-run]");
    expect(existsSync(file(dir))).toBe(false);
  });

  it("the --help text for `providers add --from` names every template — it must derive from COMPUTE_TEMPLATES, not a copy of it", async () => {
    const r = await run(["help"]);
    expect(r.code).toBe(0);
    for (const t of COMPUTE_TEMPLATES) expect(r.out, t).toContain(t);
  });
});

// ---- cache-report: OPEN-6's measurement ---------------------------------------
//
// A read verb, against fakes for both of its sources: the console (the named
// query through the generic door) and `compute.yaml` (the rates). Nothing
// here dials a provider or calls a model — the point of the verb is that it
// reads a ledger of calls already made.
describe("cache-report", () => {
  const TOKEN = "local-owner-token-never-in-output";
  const ROW = {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-5",
    tier: "default",
    caching: "auto",
    turns: 10,
    turns_reporting: 10,
    turns_hit: 9,
    tokens_in: "1000000",
    tokens_out: "20000",
    cache_read: "900000",
    cache_write: "100000",
    hit_ratio: "0.9000", // pg hands `numeric` back as a STRING; the verb must not take that as NaN
    cost_usd: "1.500000",
    turns_unpriced: 0,
  };

  /** The console, answering the one path and refusing anything unauthenticated. */
  function consoleServing(rows: unknown[], status = 200) {
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (auth !== `Bearer ${TOKEN}`) return new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 });
      if (status !== 200) return new Response(JSON.stringify({ error: { code: "unknown_query", message: "no such query" } }), { status });
      return new Response(JSON.stringify({ rows, as_of: "2026-09-19T12:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  const reportOpts = (dir: string, fetchFn: typeof fetch): ComputeOptions =>
    harness(dir, { platform: "linux", env: { METISTRY_LOCAL_OWNER_TOKEN: TOKEN }, fetchFn }).o;

  it("--since is strict about its spelling — a window nobody meant is worse than an error", () => {
    expect(parseSince(undefined)).toBe(7);
    expect(parseSince("")).toBe(7);
    expect(parseSince("14")).toBe(14);
    expect(parseSince("14d")).toBe(14);
    expect(parseSince("2w")).toBe(14);
    expect(parseSince("3m")).toBe(90);
    expect(() => parseSince("7 days")).toThrow(/<n>d.*<n>w.*<n>m/s);
    expect(() => parseSince("yesterday")).toThrow();
    expect(() => parseSince("0")).toThrow(/at least one day/);
  });

  it("reads the ledger through the console's generic query door and nowhere else (invariant 3)", async () => {
    const dir = await instance();
    const c = consoleServing([ROW]);
    const r = await cacheReport({ ...reportOpts(dir, c.fn), since: "14d" });
    expect(c.calls).toEqual(["http://127.0.0.1:8080/api/q/cache_report?days=14"]);
    expect(r.since_days).toBe(14);
    expect(r.as_of).toBe("2026-09-19T12:00:00.000Z");
    expect(r.groups).toHaveLength(1);
    // `numeric`-as-string off the wire has to come back a number, ratio included
    expect(r.groups[0]).toMatchObject({ tokens_in: 1_000_000, cache_read: 900_000, hit_ratio: 0.9, cost_usd: 1.5 });
    expect(r.totals).toMatchObject({ turns: 10, hit_ratio: 0.9 });
  });

  it("a stable prefix reads ok against the threshold; a cold one names what to look at", async () => {
    const dir = await instance();
    const ok = await cacheReport({ ...reportOpts(dir, consoleServing([ROW]).fn) });
    expect(ok.threshold).toBe(STABLE_PREFIX_HIT_RATIO);
    expect(ok.verdict.status).toBe("ok");
    expect(ok.verdict.line).toContain("90%");

    // 200k of 1M cached, and MORE written than read: the prefix is being
    // rebuilt every turn, which is the expensive shape.
    const cold = await cacheReport({
      ...reportOpts(dir, consoleServing([{ ...ROW, cache_read: "200000", cache_write: "800000", hit_ratio: "0.2000", turns_hit: 4 }]).fn),
    });
    expect(cold.verdict.status).toBe("degraded");
    expect(cold.verdict.line).toMatch(/20%/);
    expect(cold.verdict.line).toMatch(/changes turn to turn/);
    expect(cold.verdict.line).toMatch(/WRITTEN to the cache than read/);
  });

  it("a provider that reported no cache field at all is a WIRE finding, not a prefix one", async () => {
    // The distinction the engine keeps NULL for. Telling someone to audit
    // their system prompt when the provider never answered the question is
    // the one wrong answer this report could give.
    const dir = await instance();
    const r = await cacheReport({
      ...reportOpts(dir, consoleServing([{ ...ROW, turns_reporting: 0, turns_hit: 0, cache_read: "0", cache_write: "0", hit_ratio: "0.0000" }]).fn),
    });
    expect(r.verdict.status).toBe("degraded");
    expect(r.verdict.line).toMatch(/NOT ONE response reported a cache field/);
    expect(r.verdict.line).toMatch(/cached_tokens/);
    expect(r.verdict.line).not.toMatch(/changes turn to turn/);
  });

  it("nothing on `caching: auto` is n/a, not a failing grade", async () => {
    const dir = await instance();
    const r = await cacheReport({ ...reportOpts(dir, consoleServing([{ ...ROW, caching: "off", cache_read: "0", hit_ratio: "0.0000" }]).fn) });
    expect(r.verdict.status).toBe("n/a");
    expect(r.verdict.line).toMatch(/caching: auto/);
    const empty = await cacheReport({ ...reportOpts(dir, consoleServing([]).fn) });
    expect(empty.verdict.status).toBe("n/a");
    expect(empty.verdict.line).toMatch(/about ten real turns/);
  });

  it("the dollar saving comes from compute.yaml's rates, and its absence names the field that would fill it (R3)", async () => {
    const dir = await withMetistryDir(await instance());
    // no `pricing:` for this model — the normal OpenRouter case, whose
    // responses carry `usage.cost` and no rates at all
    const none = await cacheReport({ ...reportOpts(dir, consoleServing([ROW]).fn) });
    expect(none.groups[0]!.saved_usd).toBeUndefined();
    expect(none.groups[0]!.saved_unavailable).toContain('pricing["anthropic/claude-sonnet-5"].in_per_m');
    expect(none.totals.saved_usd).toBeUndefined();

    await writeFile(
      file(dir),
      `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    caching: auto
    data_policy: { allow: [Projects], deny_sources: [], max_brief_bytes: 65536 }
    pricing: { anthropic/claude-sonnet-5: { in_per_m: 3, out_per_m: 15 } }
`,
    );
    const priced = await cacheReport({ ...reportOpts(dir, consoleServing([ROW]).fn) });
    // 900k read saved 0.9 × $3/M = $2.43; 100k written cost 0.25 × $3/M = $0.075
    expect(priced.groups[0]!.saved_usd).toBeCloseTo(2.43 - 0.075, 6);
    expect(priced.totals.saved_usd).toBeCloseTo(2.355, 6);

    // A prefix rewritten every turn and never read comes out NEGATIVE. That
    // is the finding; a floor at zero would be the one number here that lies.
    const wasted = await cacheReport({
      ...reportOpts(dir, consoleServing([{ ...ROW, cache_read: "0", cache_write: "1000000", hit_ratio: "0.0000" }]).fn),
    });
    expect(wasted.groups[0]!.saved_usd).toBeLessThan(0);
  });

  it("a `caching:` changed inside the window is shown as a change, not averaged away", async () => {
    const dir = await withMetistryDir(await instance());
    await writeFile(
      file(dir),
      `providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    caching: auto
    data_policy: { allow: [Projects], deny_sources: [], max_brief_bytes: 65536 }
`,
    );
    const r = await cacheReport({ ...reportOpts(dir, consoleServing([{ ...ROW, caching: "off" }]).fn) });
    expect(r.groups[0]!.caching).toBe("off"); // what was in force when these turns ran …
    expect(r.groups[0]!.caching_now).toBe("auto"); // … and what the file says today
    expect(renderCacheReport(r, createUi({ env: {} }))).toContain("off → now auto");
  });

  it("a console that does not know the query says so, with the command that lands it", async () => {
    const dir = await instance();
    await expect(cacheReport({ ...reportOpts(dir, consoleServing([], 404).fn) })).rejects.toThrow(/metistry update/);
  });

  it("renders a table per provider/model with the verdict under it, and reads the same without colour", async () => {
    const dir = await instance();
    const r = await cacheReport({
      ...reportOpts(dir, consoleServing([ROW, { ...ROW, tier: "crew:researcher", cache_read: "0", cache_write: "500000", hit_ratio: "0.0000" }]).fn),
    });
    const plain = renderCacheReport(r, createUi({ env: {} }));
    expect(plain).toContain("openrouter/anthropic/claude-sonnet-5");
    expect(plain).toContain("crew:researcher");
    expect(plain).toContain("90%");
    expect(plain).toContain("hit ratio");
    expect(strip(plain)).toBe(plain); // rule 1: no colour on a pipe, and the words carry the meaning
    expect(plain).toMatch(/(\[!\]|\[ok\])/); // the status word's icon, in the ASCII spelling a non-UTF-8 terminal gets
    expect(plain).not.toContain(TOKEN);
  });

  it("the command prints one JSON document, exits 0 on a degraded reading, and refuses an unparseable --since", async () => {
    const dir = await instance();
    const out: string[] = [];
    const errs: string[] = [];
    const c = consoleServing([{ ...ROW, cache_read: "100000", hit_ratio: "0.1000" }]);
    // `main()` reads process.env, which the suite scrubs to the scratch-db
    // allowlist (test/setup.ts) — so the owner token comes the other way the
    // real command finds it: the login Keychain, behind the `security` fake.
    const exec: Exec = async (cmd, args) =>
      cmd === "security" && args[0] === "find-generic-password" && args.includes("metistry:METISTRY_LOCAL_OWNER_TOKEN")
        ? { code: 0, stdout: `${TOKEN}\n`, stderr: "" }
        : { code: 44, stdout: "", stderr: "not found" };
    const io = { out: (s: string) => out.push(s), err: (s: string) => errs.push(s), platform: "darwin" as const, uid: 501, fetchFn: c.fn, exec };
    const code = await main(["compute", "cache-report", "--since", "2w", "--json", "--instance", dir, "--product-dir", REPO], io);
    // a low hit ratio is a READING; exiting non-zero would make it look like
    // a broken console to anything scripting this
    expect(errs.join("\n")).toBe("");
    expect(code).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({ since_days: 14, threshold: STABLE_PREFIX_HIT_RATIO });
    expect(doc.verdict.status).toBe("degraded");
    expect(strip(out.join("\n"))).toBe(out.join("\n")); // rule 2: `--json` is never coloured
    expect(out.join("\n")).not.toContain(TOKEN);

    expect(await main(["compute", "cache-report", "--since", "yesterday", "--instance", dir, "--product-dir", REPO], io)).toBe(1);
    expect(errs.join("\n")).toMatch(/--since takes a number of days/);
  });
});
