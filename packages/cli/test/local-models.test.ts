// Local model servers, against fakes for everything outside the process:
// `/v1/models` is a fake fetch, `lms` is a fake exec, Ollama's pull is a
// fake NDJSON stream and Hugging Face is a fake response with the headers it
// really sends. The assertions that matter are the conservative ones —
//
//   * a server that is not running is ABSENT, never a failure (a Mac with no
//     local model server is a supported install);
//   * a server that IS running but is not in compute.yaml is reported, with
//     the one command that would configure it;
//   * a GGUF whose digest does not match what Hugging Face published is
//     discarded and nothing is written;
//   * the supervisor child exists only when compute.yaml asks for it, binds
//     loopback, and skips with a REASON rather than failing `up`.
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCompute, providerSchema, type Compute } from "@foldedspacelabs/metistry-core";
import { readTemplate } from "../src/compute.js";
import {
  APPLEFM_DEFAULT_PORT,
  LLAMASERVER_DEFAULT_PORT,
  LOCAL_SERVERS,
  NO_BROWSER_ORIGIN,
  downloadGguf,
  fetchModels,
  llamaServerChild,
  lmsGet,
  lmsLoad,
  localServerRows,
  parseGgufRef,
  portOf,
  probeLocalServers,
  relativeModelPath,
  serverOf,
  serverOrigin,
} from "../src/local-models.js";
import type { Exec } from "../src/exec.js";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const LMSTUDIO = "http://127.0.0.1:1234/v1/models";
const OLLAMA = "http://127.0.0.1:11434/v1/models";

interface Route {
  status?: number;
  body?: unknown;
  /** an NDJSON body, streamed a line at a time */
  ndjson?: unknown[];
  /** raw bytes plus headers, for the Hugging Face fake */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

/** Every URL a test does not name is a connection refusal, which is what an absent local server actually is. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`connect ECONNREFUSED (no fake route for ${url})`);
    if (route.ndjson) {
      const text = route.ndjson.map((o) => JSON.stringify(o)).join("\n") + "\n";
      return new Response(text, { status: route.status ?? 200, headers: { "content-type": "application/x-ndjson" } });
    }
    if (route.bytes) return new Response(route.bytes as BodyInit, { status: route.status ?? 200, headers: route.headers ?? {} });
    // a 3xx carries headers and no body — `new Response(body, {status: 3xx})` is refused by undici
    if (route.status && route.status >= 300 && route.status < 400) return new Response(null, { status: route.status, headers: route.headers ?? {} });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { ...(route.headers ?? {}), "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** LM Studio's shape: ids with slashes in them, `owned_by: organization_owner`. */
const lmStudioModels = { body: { object: "list", data: [{ id: "qwen/qwen3-coder-30b", object: "model", owned_by: "organization_owner" }, { id: "text-embedding-nomic-embed-text-v1.5", object: "model", owned_by: "organization_owner" }] } };
/** Ollama's shape: `owned_by: library` — the research note's tell for which server answered. */
const ollamaModels = { body: { object: "list", data: [{ id: "gemma3:4b", object: "model", owned_by: "library" }] } };
/** llama-server's: one model, the `--alias` it was started with. */
const llamaModels = { body: { object: "list", data: [{ id: "gemma-3-4b-it-Q4_K_M", object: "model", owned_by: "llamacpp" }] } };

const computeOf = (yaml: string): Compute => parseCompute(yaml);

describe("URL helpers", () => {
  it("climbs out of /v1 for the APIs that live above it, and reads the port", () => {
    expect(serverOrigin("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(portOf("http://127.0.0.1:1234/v1")).toBe(1234);
    expect(portOf("https://openrouter.ai/api/v1")).toBe(443);
    expect(portOf("not a url")).toBeUndefined();
  });

  it("identifies which of the four a provider is — a serve: block outright, the default ports otherwise", () => {
    const cfg = computeOf(`
providers:
  lms:       { kind: openai-compatible, base_url: "http://127.0.0.1:1234/v1",  locality: on_machine }
  oll:       { kind: openai-compatible, base_url: "http://127.0.0.1:11434/v1", locality: on_machine }
  mine:      { kind: openai-compatible, base_url: "http://127.0.0.1:9999/v1",  locality: on_machine, serve: { runtime: llamaserver, model_path: a.gguf, port: 9999 } }
  afm:       { kind: openai-compatible, base_url: "http://127.0.0.1:7810/v1",  locality: on_machine }
  elsewhere: { kind: openai-compatible, base_url: "http://127.0.0.1:5555/v1",  locality: on_machine }
`);
    expect(serverOf("lms", cfg.providers.lms!)).toBe("lmstudio");
    expect(serverOf("oll", cfg.providers.oll!)).toBe("ollama");
    expect(serverOf("mine", cfg.providers.mine!)).toBe("llamaserver");
    expect(serverOf("afm", cfg.providers.afm!)).toBe("applefm");
    // a local server on a port nobody recognises: talk to it, never claim to manage it
    expect(serverOf("elsewhere", cfg.providers.elsewhere!)).toBeUndefined();
  });
});

describe("/v1/models — the one discovery call", () => {
  it("sorts the ids and keeps owned_by, so `library` still identifies Ollama", async () => {
    const http = fakeFetch({ [OLLAMA]: ollamaModels });
    const r = await fetchModels({ url: "http://127.0.0.1:11434/v1/", fetchFn: http.fn });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["gemma3:4b"]);
    expect(r.owned_by["gemma3:4b"]).toBe("library");
    expect(r.detail).toContain("1 model(s)");
  });

  it("says 'is the local server running?' only for a local one, and never leaks a credential", async () => {
    const http = fakeFetch({});
    const local = await fetchModels({ url: "http://127.0.0.1:1234/v1", fetchFn: http.fn, local: true });
    expect(local.ok).toBe(false);
    expect(local.detail).toContain("is the local server running?");
    const cloud = await fetchModels({ url: "http://127.0.0.1:1234/v1", fetchFn: http.fn, bearer: "sk-never-printed" });
    expect(cloud.detail).not.toContain("is the local server running?");
    expect(cloud.detail).not.toContain("sk-never-printed");
  });

  it("treats a 401 as refused-credential and a non-JSON 200 as not-JSON, never as models", async () => {
    const http = fakeFetch({ [LMSTUDIO]: { status: 401 } });
    expect((await fetchModels({ url: "http://127.0.0.1:1234/v1", fetchFn: http.fn })).detail).toContain("the credential was refused");
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await fetchModels({ url: "http://127.0.0.1:1234/v1", fetchFn: html })).detail).toContain("but not JSON");
  });
});

describe("discovery", () => {
  it("finds a server nothing is configured for, and says the command that would configure it", async () => {
    const http = fakeFetch({ [LMSTUDIO]: lmStudioModels });
    const rows = await probeLocalServers({ compute: computeOf("providers: {}"), fetchFn: http.fn });
    expect(rows.map((r) => r.server)).toEqual(["lmstudio", "ollama", "llamaserver", "applefm"]);
    const lms = rows.find((r) => r.server === "lmstudio")!;
    expect(lms.ok).toBe(true);
    expect(lms.provider).toBeUndefined();
    expect(lms.hint).toContain("metistry compute providers add --from lmstudio");
    expect(lms.models).toEqual(["qwen/qwen3-coder-30b", "text-embedding-nomic-embed-text-v1.5"]);
    // the ones that are not running: reported, with no hint to configure nothing
    expect(rows.filter((r) => !r.ok).map((r) => r.server)).toEqual(["ollama", "llamaserver", "applefm"]);
    expect(rows.find((r) => r.server === "ollama")?.hint).toBeUndefined();
  });

  it("probes a CONFIGURED provider's own URL rather than the vendor default, and names the provider", async () => {
    const http = fakeFetch({ "http://127.0.0.1:9999/v1/models": llamaModels });
    const cfg = computeOf(`providers: { mine: { kind: openai-compatible, base_url: "http://127.0.0.1:9999/v1", locality: on_machine, serve: { runtime: llamaserver, model_path: a.gguf, port: 9999 } } }`);
    const rows = await probeLocalServers({ compute: cfg, fetchFn: http.fn });
    const served = rows.find((r) => r.server === "llamaserver")!;
    expect(served.url).toBe("http://127.0.0.1:9999/v1");
    expect(served.provider).toBe("mine");
    expect(served.hint).toBeUndefined(); // already configured: nothing to suggest
  });

  it("ignores off_machine providers — discovery is about this Mac", async () => {
    const http = fakeFetch({});
    const cfg = computeOf(`
providers:
  openrouter:
    kind: openai-compatible
    base_url: https://openrouter.ai/api/v1
    locality: off_machine
    data_policy: { allow: [Knowledge], deny_sources: [], max_brief_bytes: 1024 }
`);
    const rows = await probeLocalServers({ compute: cfg, fetchFn: http.fn });
    expect(rows.every((r) => r.provider === undefined)).toBe(true);
    expect(http.calls.map((c) => c.url)).not.toContain("https://openrouter.ai/api/v1/models");
  });
});

describe("doctor rows", () => {
  it("is one row per server, ok or absent — and ABSENT IS NEVER A FAILURE", async () => {
    const http = fakeFetch({ [OLLAMA]: ollamaModels });
    const rows = await localServerRows({ compute: computeOf("providers: {}"), fetchFn: http.fn });
    expect(rows.map((r) => r.name)).toEqual(["local:lmstudio", "local:ollama", "local:llamaserver", "local:applefm"]);
    expect(rows.every((r) => r.kind === "local-model")).toBe(true);
    expect(rows.some((r) => r.status === "failed")).toBe(false);
    expect(rows.filter((r) => r.status === "absent").map((r) => r.name)).toEqual(["local:lmstudio", "local:llamaserver", "local:applefm"]);

    const ollama = rows.find((r) => r.name === "local:ollama")!;
    expect(ollama.status).toBe("ok");
    expect(ollama.meta).toMatchObject({ models: ["gemma3:4b"], loaded: 1, configured: false });
    expect(ollama.remediation).toContain("metistry compute providers add --from ollama");
  });

  it("an absent server's remediation says nothing is wrong, and names where to get it", async () => {
    const rows = await localServerRows({ fetchFn: fakeFetch({}).fn });
    const lms = rows.find((r) => r.name === "local:lmstudio")!;
    expect(lms.status).toBe("absent");
    expect(lms.remediation).toContain("nothing is wrong unless you meant to run it");
    expect(lms.remediation).toContain(LOCAL_SERVERS.lmstudio.origin);
  });

  it("names the provider, and drops the hint, once compute.yaml dials it", async () => {
    const http = fakeFetch({ [LMSTUDIO]: lmStudioModels });
    const cfg = computeOf(`providers: { lmstudio: { kind: openai-compatible, base_url: "http://127.0.0.1:1234/v1", locality: on_machine } }`);
    const row = (await localServerRows({ compute: cfg, fetchFn: http.fn })).find((r) => r.name === "local:lmstudio")!;
    expect(row.status).toBe("ok");
    expect(row.remediation).toBeUndefined();
    expect(row.meta).toMatchObject({ provider: "lmstudio", loaded: 2 });
  });
});

// Apple FM is the one local server that AUTHENTICATES — it is a Metistry
// bridge, and every bridge route takes the bearer (invariant 8). A probe
// that forgot it would get a truthful 401 and report "absent", which is a
// lie about a running server.
describe("discovery: the apple-fm bridge", () => {
  const AFM = `http://127.0.0.1:${APPLEFM_DEFAULT_PORT}/v1/models`;
  const afmModels = { body: { object: "list", data: [{ id: "foundation-model", object: "model", owned_by: "apple" }] } };

  it("sends the bridge bearer from the environment and lists applefm/foundation-model", async () => {
    const http = fakeFetch({ [AFM]: afmModels });
    const rows = await probeLocalServers({ compute: computeOf("providers: {}"), env: { METISTRY_BRIDGE_TOKEN_APPLE_FM: "t0ken" }, fetchFn: http.fn });
    const afm = rows.find((r) => r.server === "applefm")!;
    expect(afm.ok).toBe(true);
    expect(afm.models).toEqual(["foundation-model"]);
    expect(afm.hint).toContain("metistry compute providers add --from applefm");
    const headers = http.calls.find((c) => c.url === AFM)!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t0ken");
  });

  it("prefers the configured provider's own auth.secret over the conventional variable", async () => {
    const http = fakeFetch({ [AFM]: afmModels });
    const cfg = computeOf(`providers: { applefm: { kind: openai-compatible, base_url: "http://127.0.0.1:${APPLEFM_DEFAULT_PORT}/v1", locality: on_machine, auth: { secret: METISTRY_OTHER_TOKEN } } }`);
    const rows = await probeLocalServers({ compute: cfg, env: { METISTRY_OTHER_TOKEN: "other", METISTRY_BRIDGE_TOKEN_APPLE_FM: "conventional" }, fetchFn: http.fn });
    expect(rows.find((r) => r.server === "applefm")?.provider).toBe("applefm");
    const headers = http.calls.find((c) => c.url === AFM)!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer other");
  });

  it("without the token the 401 is reported as refused, not as models", async () => {
    const http = fakeFetch({ [AFM]: { status: 401 } });
    const rows = await probeLocalServers({ compute: computeOf("providers: {}"), env: {}, fetchFn: http.fn });
    const afm = rows.find((r) => r.server === "applefm")!;
    expect(afm.ok).toBe(false);
    expect(afm.detail).toContain("the credential was refused");
  });
});

describe("install: LM Studio", () => {
  const fakeLms = (code: number, stderr = ""): { exec: Exec; calls: string[][] } => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code, stdout: "", stderr };
    };
    return { exec, calls };
  };

  it("spawns `lms get <id>` — never a shell, never an interpolated string", async () => {
    const { exec, calls } = fakeLms(0);
    const r = await lmsGet({ exec, model: "qwen/qwen3-coder-30b" });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([["lms", "get", "qwen/qwen3-coder-30b"]]);
  });

  it("a missing `lms` is an instruction, not a stack trace", async () => {
    const { exec } = fakeLms(127, "command not found: lms");
    await expect(lmsGet({ exec, model: "x" })).rejects.toThrow(/`lms` is not on PATH/);
  });

  it("load passes --ttl; unload does not", async () => {
    const { exec, calls } = fakeLms(0);
    await lmsLoad({ exec, model: "m", ttlSeconds: 3600 });
    await lmsLoad({ exec, model: "m", unload: true });
    expect(calls).toEqual([["lms", "load", "m", "--ttl", "3600"], ["lms", "unload", "m"]]);
  });
});

describe("install: Ollama", () => {
  it("streams /api/pull's NDJSON as progress, and posts ABOVE /v1", async () => {
    const { ollamaPull } = await import("../src/local-models.js");
    const http = fakeFetch({
      "http://127.0.0.1:11434/api/pull": {
        ndjson: [
          { status: "pulling manifest" },
          { status: "pulling 1a2b", completed: 50, total: 100 },
          { status: "pulling 1a2b", completed: 100, total: 100 },
          { status: "success" },
        ],
      },
    });
    const seen: string[] = [];
    const r = await ollamaPull({ origin: "http://127.0.0.1:11434/v1", model: "gemma3:4b", fetchFn: http.fn, onProgress: (l) => seen.push(l) });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["pulling manifest", "pulling 1a2b 50%", "pulling 1a2b 100%", "success"]);
    expect(JSON.parse(String(http.calls[0]?.init?.body))).toEqual({ model: "gemma3:4b", stream: true });
  });

  it("an `error` anywhere in the stream fails the install rather than reporting success", async () => {
    const { ollamaPull } = await import("../src/local-models.js");
    const http = fakeFetch({ "http://127.0.0.1:11434/api/pull": { ndjson: [{ status: "pulling manifest" }, { error: "model not found" }] } });
    await expect(ollamaPull({ origin: "http://127.0.0.1:11434/v1", model: "nope", fetchFn: http.fn })).rejects.toThrow(/model not found/);
  });

  it("a server that is not there says so, naming Ollama", async () => {
    const { ollamaPull } = await import("../src/local-models.js");
    await expect(ollamaPull({ origin: "http://127.0.0.1:11434/v1", model: "m", fetchFn: fakeFetch({}).fn })).rejects.toThrow(/is Ollama running\?/);
  });
});

describe("install: a Hugging Face GGUF for llama-server", () => {
  const BYTES = new TextEncoder().encode("GGUF not-a-real-model-but-enough-to-hash");
  // sha256 of BYTES, computed the same way downloadGguf does
  const sha = async () => (await import("node:crypto")).createHash("sha256").update(BYTES).digest("hex");
  const URL_ = "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf";

  it("parses `<owner>/<repo>/<path>.gguf` into the plain resolve/main URL — no library, one GET", () => {
    const ref = parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
    expect(ref).toEqual({ repo: "unsloth/gemma-3-4b-it-GGUF", file: "gemma-3-4b-it-Q4_K_M.gguf", name: "gemma-3-4b-it-Q4_K_M.gguf", url: URL_ });
    expect(() => parseGgufRef("unsloth/gemma-3-4b-it-GGUF")).toThrow(/is not a Hugging Face GGUF/);
    expect(() => parseGgufRef("a/b/model.safetensors")).toThrow(/is not a \.gguf/);
    expect(() => parseGgufRef("a/b/../../etc/passwd.gguf")).toThrow(/is not a Hugging Face GGUF/);
  });

  it("keeps a path INSIDE the repo, because real repos keep quants in subdirectories", () => {
    // ggml-org/models really does serve this one from tinyllamas/
    const ref = parseGgufRef("ggml-org/models/tinyllamas/stories15M-q4_0.gguf");
    expect(ref.repo).toBe("ggml-org/models");
    expect(ref.file).toBe("tinyllamas/stories15M-q4_0.gguf");
    expect(ref.name).toBe("stories15M-q4_0.gguf");
    expect(ref.url).toBe("https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories15M-q4_0.gguf");
  });

  it("verifies the sha256 Hugging Face publishes, and leaves no .part behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const http = fakeFetch({ [URL_]: { bytes: BYTES, headers: { "x-linked-etag": `"${await sha()}"`, "x-linked-size": String(BYTES.byteLength) } } });
    const seen: string[] = [];
    const got = await downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn, onProgress: (l) => seen.push(l) });
    expect(got.verified).toBe(true);
    expect(got.bytes).toBe(BYTES.byteLength);
    expect(got.detail).toContain("verified against Hugging Face");
    expect(existsSync(got.path)).toBe(true);
    expect(existsSync(`${got.path}.part`)).toBe(false);
    expect(seen.at(-1)).toContain("100%");
  });

  it("DISCARDS a download whose digest is not the one published — nothing is installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const http = fakeFetch({ [URL_]: { bytes: BYTES, headers: { "x-linked-etag": `"${"0".repeat(64)}"` } } });
    await expect(downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn })).rejects.toThrow(/failed its checksum/);
    expect(existsSync(join(dir, "gemma-3-4b-it-Q4_K_M.gguf"))).toBe(false);
    expect(existsSync(join(dir, "gemma-3-4b-it-Q4_K_M.gguf.part"))).toBe(false);
  });

  it("says so honestly when the repo publishes no digest — size only, `verified: false`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const http = fakeFetch({ [URL_]: { bytes: BYTES, headers: { "content-length": String(BYTES.byteLength) } } });
    const got = await downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn });
    expect(got.verified).toBe(false);
    expect(got.detail).toContain("the repo published no sha256");
  });

  it("follows redirects BY HAND, so the digest Hugging Face puts on an intermediate hop is not lost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const cdn = "https://us.aws.cdn.hf.co/xet-bridge-us/deadbeef";
    // the shape the real service answers with: 307 with nothing, 302 with the
    // digest, then the bytes on ANOTHER ORIGIN
    const http = fakeFetch({
      [URL_]: { status: 307, headers: { location: "/unsloth/gemma-3-4b-it-GGUF/resolve/abc123/gemma-3-4b-it-Q4_K_M.gguf" } },
      "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/abc123/gemma-3-4b-it-Q4_K_M.gguf": { status: 302, headers: { location: cdn, "x-linked-etag": `"${await sha()}"`, "x-linked-size": String(BYTES.byteLength) } },
      [cdn]: { bytes: BYTES, headers: {} },
    });
    const got = await downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn, token: "hf_secret" });
    expect(got.verified).toBe(true);
    // and the token stopped at huggingface.co: a pre-signed CDN URL needs no
    // credential, and forwarding one across origins is how it leaks
    const auth = http.calls.map((c) => [c.url, (c.init?.headers as Record<string, string> | undefined)?.authorization]);
    expect(auth.filter(([u]) => String(u).startsWith("https://huggingface.co")).every(([, a]) => a === "Bearer hf_secret")).toBe(true);
    expect(auth.find(([u]) => u === cdn)?.[1]).toBeUndefined();
  });

  it("refuses a redirect loop rather than following forever", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const http = fakeFetch({ [URL_]: { status: 302, headers: { location: URL_ } } });
    await expect(downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn })).rejects.toThrow(/redirected more than 5 times/);
  });

  it("a gated repo names METISTRY_HF_TOKEN, and a token is sent as a bearer when there is one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-gguf-"));
    const denied = fakeFetch({ [URL_]: { status: 403 } });
    await expect(downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: denied.fn })).rejects.toThrow(/METISTRY_HF_TOKEN/);
    const http = fakeFetch({ [URL_]: { bytes: BYTES, headers: {} } });
    await downloadGguf({ ref: parseGgufRef("unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf"), dir, fetchFn: http.fn, token: "hf_secret" });
    expect((http.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer hf_secret");
  });

  it("writes an instance-RELATIVE model_path, so the file survives a move", () => {
    expect(relativeModelPath("unsloth/gemma-3-4b-it-GGUF", "gemma-3-4b-it-Q4_K_M.gguf")).toBe(".metistry/state/models/unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf");
  });
});

describe("the supervisor child (darwin)", () => {
  const serve = { runtime: "llamaserver" as const, model_path: ".metistry/state/models/a/b/m.gguf", port: 7813, extra_args: [] };
  const base = { PATH: "/usr/bin:/bin", HOME: "/Users/t" };

  async function fixture(): Promise<{ product: string; instance: string }> {
    const product = await mkdtemp(join(tmpdir(), "metistry-prod-"));
    const instance = await mkdtemp(join(tmpdir(), "mi-" /* short on purpose: the supervisor socket under .metistry/state/run/ has ~103 bytes to live in */));
    return { product, instance };
  }

  it("renders argv from the bundled binary, binds LOOPBACK, and aliases the model by file name", async () => {
    const { product, instance } = await fixture();
    const binary = join(product, "runtime", "llamacpp", "bin", "llama-server");
    const model = join(instance, ".metistry", "state", "models", "a", "b", "m.gguf");
    const built = llamaServerChild({ productDir: product, instanceDir: instance, provider: "llamaserver", serve, env: base, log: "/tmp/metistry-llamaserver.log", exists: (p) => p === binary || p === model });
    expect("child" in built).toBe(true);
    if (!("child" in built)) return;
    expect(built.child).toMatchObject({
      name: "llamaserver",
      argv: [binary, "--model", model, "--alias", "m", "--host", "127.0.0.1", "--port", "7813", "--cors-origins", NO_BROWSER_ORIGIN],
      env: base,
      log: "/tmp/metistry-llamaserver.log",
      ready: { kind: "tcp", port: 7813 },
    });
    // the host is hard-coded: no configuration path can put a completion
    // endpoint on the network (invariant 8)
    expect(built.child.argv).not.toContain("0.0.0.0");
    // and llama-server's `*` default is not left in place: a web page the
    // user visits must not be able to read this server's answers
    expect(built.child.argv).not.toContain("*");
    expect(built.child.argv.every((a) => a.length > 0)).toBe(true); // the child schema refuses an empty argv element
  });

  it("appends extra_args verbatim, after the flags the product sets", async () => {
    const { product, instance } = await fixture();
    const built = llamaServerChild({ productDir: product, instanceDir: instance, provider: "p", serve: { ...serve, extra_args: ["--ctx-size", "8192", "--embeddings"] }, env: base, log: "/l", exists: () => true });
    if (!("child" in built)) throw new Error("expected a child");
    expect(built.child.argv.slice(-3)).toEqual(["--ctx-size", "8192", "--embeddings"]);
  });

  it("SKIPS WITH A REASON rather than failing when the runtime pack is not installed", async () => {
    const { product, instance } = await fixture();
    const built = llamaServerChild({ productDir: product, instanceDir: instance, provider: "llamaserver", serve, env: base, log: "/l", exists: () => false });
    expect("skipped" in built && built.skipped).toMatch(/is not installed — `metistry update`/);
  });

  it("SKIPS WITH A REASON when the GGUF named is not there, naming the command that downloads one", async () => {
    const { product, instance } = await fixture();
    const binary = join(product, "runtime", "llamacpp", "bin", "llama-server");
    const built = llamaServerChild({ productDir: product, instanceDir: instance, provider: "llamaserver", serve, env: base, log: "/l", exists: (p) => p === binary });
    expect("skipped" in built && built.skipped).toMatch(/compute models install llamaserver\//);
  });

  it("takes an ABSOLUTE model_path as given", async () => {
    const { product, instance } = await fixture();
    const built = llamaServerChild({ productDir: product, instanceDir: instance, provider: "p", serve: { ...serve, model_path: "/Volumes/models/big.gguf" }, env: base, log: "/l", exists: () => true });
    if (!("child" in built)) throw new Error("expected a child");
    expect(built.child.argv[2]).toBe("/Volumes/models/big.gguf");
    expect(built.child.argv[4]).toBe("big");
  });
});

describe("the seed template", () => {
  it("validates against the schema through the same reader `providers add` uses, and does not take the console's port", async () => {
    const { name, block } = await readTemplate({ seedDir: join(REPO, "seed"), instanceDir: await mkdtemp(join(tmpdir(), "metistry-no-instance-")) }, "llamaserver");
    expect(name).toBe("llamaserver");
    const p = providerSchema.parse(block);
    expect(p.serve).toMatchObject({ runtime: "llamaserver", port: LLAMASERVER_DEFAULT_PORT, extra_args: [] });
    expect(p.locality).toBe("on_machine");
    expect(p.base_url).toBe(LOCAL_SERVERS.llamaserver.defaultBaseUrl);
    expect(LLAMASERVER_DEFAULT_PORT).not.toBe(8080); // CONSOLE_DEFAULT_PORT — the collision this default exists to avoid
  });
});
