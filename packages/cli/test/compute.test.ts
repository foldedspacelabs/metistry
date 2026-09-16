// `metistry compute` against fakes for everything outside the process: the
// login Keychain is a Map behind a `security` exec fake, every provider call
// is a fake fetch, and the instance repo is a temp directory. The assertions
// that matter are the conservative ones — a key never reaches argv, an edit
// that would not validate is never written, a provider still named by an
// assignment cannot be removed, and a refusal names the field.
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompute } from "@foldedspacelabs/metistry-core";
import {
  COMPUTE_TEMPLATES,
  apiRoot,
  assign,
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
  readTemplate,
  renderComputeReport,
  renderModelsInstall,
  renderModelsList,
  renderProviderTest,
  setBudget,
  type ComputeOptions,
} from "../src/compute.js";
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

const file = (dir: string) => join(dir, "compute.yaml");

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
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_ZEN_API_KEY`]: KEY });
    const { o, lines } = harness(dir, { exec: kc.exec });
    await providersAdd({ ...o, template: "zen", skipTest: true });
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "zen/example-model" });
    const r = await assign({ ...o, target: parseAssignmentTarget("deep"), model: "zen/example-model" });
    expect(r.warn_non_zdr).toBe(true);
    expect(lines.join("\n")).toContain("zero data retention");
    expect(await readFile(file(dir), "utf8")).toContain("model: zen/example-model");
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
    expect(r.model_path).toBe("state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
    expect(r.sha256).toBe(sha);
    expect(existsSync(join(dir, r.model_path!))).toBe(true);
    // the file on disk is what the schema accepts back — a write that would
    // not validate is refused before it is written
    const after = await readFile(file(dir), "utf8");
    expect(after).toContain("model_path: state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
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
    const kc = fakeSecurity({ [`${ACCOUNT}/metistry:METISTRY_ZEN_API_KEY`]: KEY });
    const { o } = harness(dir, { exec: kc.exec });
    const empty = await computeReport(o);
    expect(empty.assigns_nothing).toBe(true);
    expect(renderComputeReport(empty)).toContain("rules.yaml's `tiers:` is still the live map");

    await providersAdd({ ...o, template: "zen", skipTest: true });
    await assign({ ...o, target: parseAssignmentTarget("default"), model: "zen/example-model" });
    await assign({ ...o, target: parseAssignmentTarget("deep"), model: "zen/example-model", effort: "high" });
    await setBudget({ ...o, target: parseBudgetTarget("instance"), monthly: 60, action: "stop" });
    const r = await computeReport(o);
    expect(r.file).toBe(file(dir));
    expect(r.files).toEqual([join(SEED, "compute.yaml"), file(dir)]); // seed first, the instance's own last
    expect(r.providers[0]).toMatchObject({ name: "zen", secret: "METISTRY_ZEN_API_KEY", secret_present: true, models_assigned: ["example-model"] });
    expect(r.assignments.map((a) => a.target)).toEqual(["default", "deep"]);
    expect(r.assignments[1]).toMatchObject({ target: "deep", provider: "zen", effort: "high", warn_non_zdr: true });
    expect(r.instance_budget).toMatchObject({ monthly_usd: 60, action: "stop" });
    const text = renderComputeReport(r);
    expect(text).toContain("METISTRY_ZEN_API_KEY (in Keychain)");
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
});
