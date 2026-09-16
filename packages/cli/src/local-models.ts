// Local model servers — LM Studio, Ollama, and the `llama-server` Metistry
// builds into its own runtime pack — behind ONE protocol.
//
// Three properties this module exists to hold:
//
//   * **Discovery is `GET <base>/v1/models`, for all three.** There is no
//     per-vendor list call and no vendor SDK. LM Studio and Ollama are peers
//     Metistry finds where they already run; the bundled `llama-server` is
//     what is there when neither is. A server that answers is reported even
//     when `compute.yaml` names no provider for it — with the one command
//     that would configure it — because "there is a model server on this Mac
//     and nothing is using it" is a finding, not a silence.
//   * **Absent is never a failure.** Every row here is ok or absent. A Mac
//     with no local server is a supported install (every provider can be
//     off_machine), so a doctor run on one must stay green.
//   * **Installing a model is the server's own mechanism, spoken directly.**
//     `lms get` for LM Studio, `POST /api/pull` for Ollama, and a plain HTTPS
//     GET of a Hugging Face URL for `llama-server`. No new dependency: a
//     GGUF is one file behind one URL, and `huggingface_hub` is a decade of
//     maintenance for a `fetch` call.
//
// Nothing here opens `compute.yaml` or writes it — the caller passes the
// parsed configuration in, and `compute.ts` owns every write (as the `user`
// principal, through the reconciler). That is also what keeps the import
// arrow one-way: compute.ts → local-models.ts, never back.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runCheck, type ChildSpecInput, type CheckResult, type Compute, type Provider, type Serve } from "@foldedspacelabs/metistry-core";
import type { Exec } from "./exec.js";
import { StepFailed } from "./steps.js";

/** The API root with no trailing slash, so `${root}/models` is right whatever the file says. */
export function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * `http://127.0.0.1:11434` from `http://127.0.0.1:11434/v1`. Ollama's own
 * `/api/pull` and `/api/tags` sit ABOVE the OpenAI-compatible root, so the
 * one place that has to climb out of `/v1` does it here rather than by
 * string surgery at the call site.
 */
export function serverOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return apiRoot(baseUrl);
  }
}

/** The port a base URL dials, as a number; undefined when it is not a URL. */
export function portOf(baseUrl: string): number | undefined {
  try {
    const u = new URL(baseUrl);
    const p = u.port || (u.protocol === "https:" ? "443" : "80");
    return Number(p);
  } catch {
    return undefined;
  }
}

// ---- the three servers --------------------------------------------------------

export const LOCAL_SERVER_NAMES = ["lmstudio", "ollama", "llamaserver"] as const;
export type LocalServerName = (typeof LOCAL_SERVER_NAMES)[number];

/**
 * What `seed/compute-templates/llamaserver.yaml` writes — NOT llama.cpp's
 * own 8080, which is already the Metistry console's default port
 * (`CONSOLE_DEFAULT_PORT`). 7813 continues the loopback block the bridges
 * use (apple-fm 7810, eventkit 7811, reconciler 7812). The port in
 * `compute.yaml` is what actually decides; this is only the default the
 * template and the unconfigured-server scan use.
 */
export const LLAMASERVER_DEFAULT_PORT = 7813;

export interface LocalServerSpec {
  name: LocalServerName;
  label: string;
  defaultBaseUrl: string;
  /** `metistry compute providers add --from <template>` */
  template: string;
  /** where a person gets it, for the line that says one is missing */
  origin: string;
}

export const LOCAL_SERVERS: Record<LocalServerName, LocalServerSpec> = {
  lmstudio: { name: "lmstudio", label: "LM Studio", defaultBaseUrl: "http://127.0.0.1:1234/v1", template: "lmstudio", origin: "lmstudio.ai (or the headless `lms` CLI)" },
  ollama: { name: "ollama", label: "Ollama", defaultBaseUrl: "http://127.0.0.1:11434/v1", template: "ollama", origin: "ollama.com" },
  llamaserver: { name: "llamaserver", label: "llama-server (bundled)", defaultBaseUrl: `http://127.0.0.1:${LLAMASERVER_DEFAULT_PORT}/v1`, template: "llamaserver", origin: "bundled — `metistry compute providers add --from llamaserver` and `metistry up`" },
};

/**
 * Which of the three a provider block IS. A `serve:` block says so outright;
 * otherwise the default ports are the only evidence there is, and a provider
 * on neither is a local server Metistry can talk to but not manage.
 */
export function serverOf(name: string, p: Provider): LocalServerName | undefined {
  if (p.serve) return p.serve.runtime;
  const port = portOf(p.base_url);
  if (port === 1234) return "lmstudio";
  if (port === 11434) return "ollama";
  if ((LOCAL_SERVER_NAMES as readonly string[]).includes(name)) return name as LocalServerName;
  return undefined;
}

// ---- /v1/models ---------------------------------------------------------------

export interface ModelsProbe {
  ok: boolean;
  models: string[];
  /** `owned_by` per model id where the server gives one — `library` is Ollama's, and the cheapest way to tell which server answered an unexpected port */
  owned_by: Record<string, string>;
  /** one line: a model count, an HTTP status, or why it did not answer. Never a secret. */
  detail: string;
}

interface ModelsResponse {
  data?: Array<{ id?: unknown; owned_by?: unknown }>;
}

/**
 * `GET <root>/models`, the one discovery call. Shared by `compute providers
 * test`, `compute models list` and doctor, so all three agree on what
 * "answering" means and word a failure the same way.
 */
export async function fetchModels(opts: { url: string; bearer?: string | undefined; fetchFn?: typeof fetch | undefined; timeoutMs?: number | undefined; local?: boolean | undefined }): Promise<ModelsProbe> {
  const url = `${apiRoot(opts.url)}/models`;
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(url, {
      headers: { accept: "application/json", ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    return { ok: false, models: [], owned_by: {}, detail: `${url} did not answer (${err instanceof Error ? err.message : String(err)})${opts.local ? " — is the local server running?" : ""}` };
  }
  if (!res.ok) return { ok: false, models: [], owned_by: {}, detail: `${url} → HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (the credential was refused)" : ""}` };
  let body: ModelsResponse;
  try {
    body = (await res.json()) as ModelsResponse;
  } catch {
    return { ok: false, models: [], owned_by: {}, detail: `${url} answered ${res.status} but not JSON` };
  }
  const owned: Record<string, string> = {};
  for (const m of body.data ?? []) {
    const id = String(m?.id ?? "");
    if (id && typeof m?.owned_by === "string") owned[id] = m.owned_by;
  }
  const models = (body.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean).sort();
  return { ok: true, models, owned_by: owned, detail: `${url} → ${models.length} model(s)` };
}

// ---- discovery ------------------------------------------------------------------

export interface LocalServerRow {
  server: LocalServerName;
  label: string;
  /** the API root actually probed — a configured provider's, or the server's default port */
  url: string;
  ok: boolean;
  models: string[];
  detail: string;
  /** the `compute.yaml` provider that dials this URL, when one does */
  provider?: string;
  /** set when the server answered and nothing in `compute.yaml` points at it */
  hint?: string;
}

/**
 * Probe all three known local servers, at the URL `compute.yaml` gives when
 * it gives one and at the vendor's default port otherwise. In parallel:
 * three connection refusals in series is three timeouts a person waits for.
 */
export async function probeLocalServers(opts: { compute?: Compute | undefined; fetchFn?: typeof fetch | undefined; timeoutMs?: number | undefined }): Promise<LocalServerRow[]> {
  const providers = Object.entries(opts.compute?.providers ?? {}).filter(([, p]) => p.locality === "on_machine");
  const byServer = new Map<LocalServerName, { name: string; provider: Provider }>();
  for (const [name, provider] of providers) {
    const s = serverOf(name, provider);
    if (s && !byServer.has(s)) byServer.set(s, { name, provider });
  }
  return Promise.all(
    LOCAL_SERVER_NAMES.map(async (server): Promise<LocalServerRow> => {
      const spec = LOCAL_SERVERS[server];
      const configured = byServer.get(server);
      const url = apiRoot(configured?.provider.base_url ?? spec.defaultBaseUrl);
      const probe = await fetchModels({ url, fetchFn: opts.fetchFn, timeoutMs: opts.timeoutMs ?? 2_000, local: true });
      return {
        server,
        label: spec.label,
        url,
        ok: probe.ok,
        models: probe.models,
        detail: probe.detail,
        ...(configured ? { provider: configured.name } : {}),
        ...(probe.ok && !configured ? { hint: `answering, but no provider in compute.yaml dials it — \`metistry compute providers add --from ${spec.template}\`` } : {}),
      };
    }),
  );
}

/**
 * One doctor row per local server. ABSENT, never failed: a Mac that runs no
 * local model server is a supported install — every provider may be
 * off_machine — so this section can never turn a healthy doctor red.
 *
 * Returned as plain `CheckResult & { kind }` rather than doctor's own
 * `DoctorRow` so the import arrow stays doctor.ts → here.
 */
export async function localServerRows(opts: { compute?: Compute | undefined; fetchFn?: typeof fetch | undefined; timeoutMs?: number | undefined }): Promise<Array<CheckResult & { kind: string }>> {
  const rows = await probeLocalServers(opts);
  return Promise.all(
    rows.map(async (r) => ({
      kind: "local-model",
      ...(await runCheck(`local:${r.server}`, `${r.url}/models answers`, async () => {
        if (!r.ok) {
          return {
            status: "absent" as const,
            remediation: `${r.label} is not answering on ${r.url} — nothing is wrong unless you meant to run it (${LOCAL_SERVERS[r.server].origin})`,
            meta: { url: r.url, ...(r.provider ? { provider: r.provider } : {}) },
          };
        }
        return {
          ...(r.hint ? { status: "ok" as const, remediation: r.hint } : {}),
          meta: {
            url: r.url,
            models: r.models,
            loaded: r.models.length,
            ...(r.provider ? { provider: r.provider } : { configured: false }),
          },
        };
      })),
    })),
  );
}

// ---- installing a model ----------------------------------------------------------

export interface PullProgress {
  (line: string): void;
}

/**
 * `lms get <id>`. LM Studio's own CLI, because it is the only thing that
 * knows LM Studio's model directory, its quant picking and its index — and
 * shelling out to a tool the user already has beats reimplementing that.
 */
export async function lmsGet(opts: { exec: Exec; model: string; args?: string[] | undefined; timeoutMs?: number | undefined }): Promise<{ ok: boolean; detail: string }> {
  const r = await opts.exec("lms", ["get", opts.model, ...(opts.args ?? [])], { timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  if (r.code === 0) return { ok: true, detail: `lms get ${opts.model}` };
  if (r.code === 127 || /not found|ENOENT/i.test(r.stderr)) {
    throw new StepFailed(
      `\`lms\` is not on PATH, and it is how LM Studio installs a model. Install LM Studio (lmstudio.ai) or its headless CLI, then re-run — or pull the model in LM Studio's own window; \`metistry compute models list\` will see it either way.`,
    );
  }
  return { ok: false, detail: `lms get ${opts.model} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
}

/** `lms load|unload <id>` — LM Studio is the only one of the three with an addressable load. */
export async function lmsLoad(opts: { exec: Exec; model: string; unload?: boolean | undefined; ttlSeconds?: number | undefined; timeoutMs?: number | undefined }): Promise<{ ok: boolean; detail: string }> {
  const args = opts.unload ? ["unload", opts.model] : ["load", opts.model, ...(opts.ttlSeconds ? ["--ttl", String(opts.ttlSeconds)] : [])];
  const r = await opts.exec("lms", args, { timeoutMs: opts.timeoutMs ?? 10 * 60_000 });
  if (r.code === 0) return { ok: true, detail: `lms ${args.join(" ")}` };
  if (r.code === 127 || /not found|ENOENT/i.test(r.stderr)) throw new StepFailed("`lms` is not on PATH — LM Studio's CLI is what loads and unloads its models (lmstudio.ai)");
  return { ok: false, detail: `lms ${args.join(" ")} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
}

/**
 * `POST <origin>/api/pull`, streamed. Ollama answers NDJSON — one object per
 * line, `status` plus `completed`/`total` on the layer being fetched — so
 * progress is reported as it arrives rather than after a silent ten minutes.
 * Its own API, above `/v1`: OpenAI's protocol has no notion of installing a
 * model, and inventing one here would be a Metistry-shaped Ollama.
 */
export async function ollamaPull(opts: { origin: string; model: string; fetchFn?: typeof fetch | undefined; onProgress?: PullProgress | undefined; timeoutMs?: number | undefined }): Promise<{ ok: boolean; detail: string }> {
  const url = `${serverOrigin(opts.origin)}/api/pull`;
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, stream: true }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60 * 60_000),
    });
  } catch (err) {
    throw new StepFailed(`${url} did not answer (${err instanceof Error ? err.message : String(err)}) — is Ollama running?`);
  }
  if (!res.ok) throw new StepFailed(`${url} → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);

  let last = "";
  let failure: string | undefined;
  for await (const line of ndjson(res)) {
    const obj = line as { status?: unknown; error?: unknown; completed?: unknown; total?: unknown };
    if (typeof obj.error === "string") failure = obj.error;
    if (typeof obj.status !== "string") continue;
    const pct = typeof obj.completed === "number" && typeof obj.total === "number" && obj.total > 0 ? ` ${Math.floor((obj.completed / obj.total) * 100)}%` : "";
    const text = `${obj.status}${pct}`;
    if (text !== last) {
      last = text;
      opts.onProgress?.(text);
    }
  }
  if (failure) throw new StepFailed(`ollama pull ${opts.model} failed: ${failure}`);
  return { ok: true, detail: `${url} → ${opts.model} (${last || "done"})` };
}

/** One parsed object per NDJSON line of a streaming response. */
async function* ndjson(res: Response): AsyncGenerator<unknown> {
  const body = res.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* a partial or non-JSON line is progress noise, never a reason to stop a download */
      }
    }
  }
  const tail = buf.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      /* ditto */
    }
  }
}

/** `<owner>/<repo>/<path…>.gguf` — what `compute models install llamaserver/…` takes. */
export interface GgufRef {
  /** `<owner>/<repo>` */
  repo: string;
  /** the path INSIDE the repo, which is often a directory deep (`tinyllamas/stories15M-q4_0.gguf`) */
  file: string;
  /** the basename, for the file on disk and the server's `--alias` */
  name: string;
  url: string;
}

/**
 * Split and refuse in one place. A Hugging Face GGUF is addressed by repo
 * and path and nothing else; `resolve/main/<path>` is the plain-HTTPS form
 * of that, which is why no library is needed to fetch one.
 *
 * Everything after the second segment is the PATH, not one file name: real
 * repos keep quants in subdirectories (`tinyllamas/stories15M-q4_0.gguf`),
 * and a parser that insisted on exactly three segments would simply be
 * unable to name half of Hugging Face.
 */
export function parseGgufRef(ref: string): GgufRef {
  const parts = ref.split("/");
  if (parts.length < 3 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new StepFailed(`${JSON.stringify(ref)} is not a Hugging Face GGUF — give \`<owner>/<repo>/<path>.gguf\`, e.g. unsloth/gemma-3-4b-it-GGUF/gemma-3-4b-it-Q4_K_M.gguf (the path is on the repo's Files tab)`);
  }
  const [owner, repo, ...rest] = parts as [string, string, ...string[]];
  const file = rest.join("/");
  if (!/\.gguf$/i.test(file)) throw new StepFailed(`${file} is not a .gguf — llama-server loads GGUF files only`);
  return { repo: `${owner}/${repo}`, file, name: rest[rest.length - 1]!, url: `https://huggingface.co/${owner}/${repo}/resolve/main/${rest.map(encodeURIComponent).join("/")}` };
}

export interface GgufDownload {
  path: string;
  bytes: number;
  sha256: string;
  /** true when Hugging Face published the object's sha256 and it matched */
  verified: boolean;
  detail: string;
}

/**
 * Download one GGUF to `<dir>/<file>` — to `<file>.part` first, moved into
 * place only after the bytes are counted and (where Hugging Face publishes
 * one) the digest checked. A half-downloaded model that llama-server tries
 * to load is a crash loop; a `.part` left behind is a retry.
 *
 * `X-Linked-Etag` is the sha256 of the LFS object, which is what a GGUF in
 * a Hugging Face repo is. When it is absent the size is still checked
 * against `X-Linked-Size`/`content-length`, and `verified` says which of the
 * two happened rather than implying a check that did not occur.
 *
 * REDIRECTS ARE FOLLOWED BY HAND, for two reasons that are both about this
 * header. Hugging Face serves the digest on an INTERMEDIATE hop
 * (`resolve/main` → `resolve/<commit>` 307 → CDN 302, and the 302 is the one
 * that carries it), so `redirect: "follow"` hands back a final response with
 * no digest at all and the check would silently never happen. And the last
 * hop is a pre-signed URL on another origin: the token goes to
 * `huggingface.co` and stops there, because forwarding an Authorization
 * header across origins is how credentials leak to a CDN.
 */
export async function downloadGguf(opts: {
  ref: GgufRef;
  dir: string;
  fetchFn?: typeof fetch | undefined;
  /** `METISTRY_HF_TOKEN` — only needed for a gated or private repo */
  token?: string | undefined;
  onProgress?: PullProgress | undefined;
  timeoutMs?: number | undefined;
}): Promise<GgufDownload> {
  const dest = join(opts.dir, opts.ref.name);
  const part = `${dest}.part`;
  await mkdir(opts.dir, { recursive: true });
  const fetchFn = opts.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 2 * 60 * 60_000);

  let url = opts.ref.url;
  let res: Response;
  let want = "";
  let wantBytes = 0;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new StepFailed(`${opts.ref.url} redirected more than 5 times — refusing to keep following`);
    const sameOrigin = safeOrigin(url);
    try {
      res = await fetchFn(url, {
        redirect: "manual",
        headers: { accept: "application/octet-stream", ...(opts.token && sameOrigin ? { authorization: `Bearer ${opts.token}` } : {}) },
        signal,
      });
    } catch (err) {
      throw new StepFailed(`${url} did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
    // any hop may carry the LFS object's digest and size; the last one does not
    want = want || (res.headers.get("x-linked-etag") ?? "").replace(/"/g, "").trim();
    wantBytes = wantBytes || Number(res.headers.get("x-linked-size") ?? 0);
    if (res.status === 401 || res.status === 403) {
      throw new StepFailed(`${opts.ref.repo} refused the download (HTTP ${res.status}) — a gated or private repo needs METISTRY_HF_TOKEN set to a Hugging Face access token with read scope`);
    }
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    if (!location) throw new StepFailed(`${url} → HTTP ${res.status} with no Location to follow`);
    url = new URL(location, url).toString();
  }
  if (!res.ok) throw new StepFailed(`${opts.ref.url} → HTTP ${res.status}`);
  wantBytes = wantBytes || Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  let bytes = 0;
  let announced = -1;
  const body = res.body;
  if (!body) throw new StepFailed(`${opts.ref.url} answered ${res.status} with no body`);
  // STREAMED to disk, never buffered: a 30 GB GGUF through Buffer.concat is
  // an out-of-memory crash, and the model files this exists to fetch are
  // exactly the ones big enough to cause it.
  const fh = await open(part, "w");
  try {
    for await (const chunk of body) {
      const u8 = chunk as Uint8Array;
      hash.update(u8);
      await fh.write(u8);
      bytes += u8.byteLength;
      if (wantBytes > 0) {
        const pct = Math.floor((bytes / wantBytes) * 10) * 10;
        if (pct > announced) {
          announced = pct;
          opts.onProgress?.(`${opts.ref.name}: ${pct}% (${mib(bytes)} of ${mib(wantBytes)})`);
        }
      }
    }
  } finally {
    await fh.close();
  }
  const sha256 = hash.digest("hex");
  const looksSha = /^[0-9a-f]{64}$/.test(want);
  if (looksSha && sha256 !== want) {
    await rm(part, { force: true });
    throw new StepFailed(`${opts.ref.file} failed its checksum (Hugging Face published ${want}, the download hashed to ${sha256}) — nothing was installed`);
  }
  if (wantBytes > 0 && bytes !== wantBytes) {
    await rm(part, { force: true });
    throw new StepFailed(`${opts.ref.file} is ${bytes} bytes, but the server said ${wantBytes} — the download was truncated and was discarded`);
  }
  await rename(part, dest);
  return {
    path: dest,
    bytes,
    sha256,
    verified: looksSha,
    detail: looksSha ? `${mib(bytes)}, sha256 ${sha256.slice(0, 12)}… verified against Hugging Face` : `${mib(bytes)}${wantBytes > 0 ? " (size matched; the repo published no sha256)" : " (the repo published neither a size nor a sha256)"}`,
  };
}

/** Is this URL still Hugging Face's own, rather than the pre-signed CDN it redirects to? Only then may the token go with the request. */
function safeOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "huggingface.co" || host.endsWith(".huggingface.co");
  } catch {
    return false;
  }
}

function mib(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// ---- the bundled binary, and its supervisor child ----------------------------------

/** `<product>/runtime/llamacpp/bin/llama-server` — built by ops/release/build-runtime-deps.sh, signed with the rest of the pack. */
export function bundledLlamaServer(productDir: string): string {
  return join(productDir, "runtime", "llamacpp", "bin", "llama-server");
}

/** A `model_path` as written, resolved: absolute stays, relative hangs off the instance directory (where `compute models install` puts GGUFs). */
export function resolveModelPath(instanceDir: string, modelPath: string): string {
  return isAbsolute(modelPath) ? modelPath : join(instanceDir.replace(/\/+$/, ""), modelPath);
}

/** Where `compute models install llamaserver/<owner>/<repo>/<file>` puts the file: per-machine state, not the vault. */
export function modelsDir(instanceDir: string): string {
  return join(instanceDir.replace(/\/+$/, ""), "state", "models");
}

/** The same path, written into `compute.yaml` relative to the instance so the file survives a move. */
export function relativeModelPath(repo: string, file: string): string {
  return join("state", "models", repo, file);
}

/**
 * A `--cors-origins` value no browser can ever send, which is what makes the
 * bundled server's answers unreadable to a web page that dials loopback. Not
 * the empty string: an empty argv element is refused by the child schema,
 * and a word in `ps` says what it is for.
 */
export const NO_BROWSER_ORIGIN = "metistry-no-browser-origin";

export interface LlamaServerChildOptions {
  /** the install root — where `runtime/` is */
  productDir: string;
  /** the instance repo — where a relative `model_path` resolves */
  instanceDir: string;
  /** the provider's name in compute.yaml; the child is always called `llamaserver` */
  provider: string;
  serve: Serve;
  /** the base environment every supervisor child gets (`launchdBaseEnv`) */
  env: Record<string, string>;
  log: string;
  exists?: (p: string) => boolean;
}

export type LlamaServerChild = { child: ChildSpecInput; binary: string; model: string } | { skipped: string };

/**
 * The OPTIONAL supervisor child. Declared only when `compute.yaml` names a
 * provider with a `serve: { runtime: llamaserver, … }` block — an install
 * that uses LM Studio, Ollama or nothing local at all gets no child and no
 * process, which is why this returns a reason instead of throwing.
 *
 * `--host 127.0.0.1` is not configurable and is not read from the file: the
 * base URL is checked against the port, the loopback is hard-coded, and a
 * model server that binds 0.0.0.0 because a config line said so would be an
 * unauthenticated completion endpoint on the network (invariant 8).
 *
 * `--cors-origins` is the other half of that, and loopback alone does NOT
 * cover it: llama-server's default is `*`, which lets any web page the user
 * happens to visit `fetch('http://127.0.0.1:<port>/v1/…')` AND READ THE
 * ANSWER — free use of the local model, and a fingerprint of what is loaded.
 * The value here is deliberately one no browser can ever send, so the
 * response is unreadable cross-origin. (`extra_args` is appended after it and
 * llama.cpp takes the last occurrence, so an install that really does want a
 * browser origin can say `--cors-origins localhost` and mean it.)
 *
 * No TCC: it reads one GGUF the user chose and listens on loopback.
 */
export function llamaServerChild(opts: LlamaServerChildOptions): LlamaServerChild {
  const exists = opts.exists ?? existsSync;
  const binary = bundledLlamaServer(opts.productDir);
  if (!exists(binary)) {
    return { skipped: `providers.${opts.provider} asks for the bundled llama-server, but ${binary} is not installed — \`metistry update\` fetches the runtime pack (docs/ops/bundled-runtime.md)` };
  }
  const model = resolveModelPath(opts.instanceDir, opts.serve.model_path);
  if (!exists(model)) {
    return { skipped: `providers.${opts.provider}.serve.model_path is ${opts.serve.model_path}, and ${model} is not there — \`metistry compute models install ${opts.provider}/<owner>/<repo>/<file>.gguf\` downloads one` };
  }
  const alias = basename(model).replace(/\.gguf$/i, "");
  return {
    binary,
    model,
    child: {
      name: "llamaserver",
      argv: [binary, "--model", model, "--alias", alias, "--host", "127.0.0.1", "--port", String(opts.serve.port), "--cors-origins", NO_BROWSER_ORIGIN, ...opts.serve.extra_args],
      cwd: dirname(binary),
      env: opts.env,
      log: opts.log,
      ready: { kind: "tcp", port: opts.serve.port },
    },
  };
}
