// The vault bridge — §4.3 wire contract over node:http: per-caller bearer
// (CRIT-9; loopback is not a trust boundary), uniform error envelope,
// behavioral check(). Reads come from the working tree; every mutation
// carries a commit intent and is queued for the sole committer.
//
// **The principal comes from the credential.** The bearer decides which
// `CallerClass` a request is (paths.ts's authority table); the body's
// `intent.principal` is attribution INSIDE what that class may claim. A body
// that exceeds its credential is `forbidden` with the standard envelope and a
// `runs` row — never silently downgraded to something it did not ask for.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorized, errorEnvelope, finishRun, INSTANCE_LAYOUT, isVaultPath, runCheck, startRun, statusFor, type ErrorCode } from "@foldedspacelabs/metistry-core";
import type { Vault, Outcome } from "./vault.js";
import { parseIntent } from "./vault.js";
import type { Committer } from "./committer.js";
import type { Db, Indexer } from "./indexer.js";
import type { Embeddings } from "./embeddings.js";
import { parseMode, searchVault } from "./search.js";
import type { CallerClass } from "./paths.js";
import type { EmbedClient } from "@foldedspacelabs/metistry-core";

export interface BridgeConfig {
  /** `METISTRY_BRIDGE_TOKEN_RECONCILER` — the console's bearer, and every caller the console fronts. */
  token: string;
  /**
   * `METISTRY_BRIDGE_TOKEN_RECONCILER_USER` — the owner-class bearer, held by
   * the CLI on this machine and by nothing that listens on a socket.
   *
   * Absent, there is no owner class at all: `.metistry/` is unwritable through
   * this bridge for every caller (fail closed, and `check()` degrades with the
   * command that fixes it). It is never defaulted to `token` — that would be
   * the shared-bearer hole with a longer name.
   */
  ownerToken?: string | undefined;
  maxBodyBytes: number;
}

export interface BridgeDeps {
  vault: Vault;
  committer: Committer;
  /** Absent in tests that have no db: `POST /reconcile` answers not_available. */
  indexer?: Indexer | undefined;
  /** Phase 6. Absent → search is keyword-only and `POST /embeddings/rebuild` answers not_available. */
  embeddings?: Embeddings | undefined;
  embedClient?: EmbedClient | undefined;
  db?: Db | undefined;
}

/**
 * Which class of caller presented this bearer, or null for none.
 *
 * The owner bearer is tried first and both comparisons are constant-time
 * (core's `authorized`), so this says nothing about which token was closer.
 * An empty/absent `ownerToken` can match nothing: `parseBearer` requires a
 * non-empty token, and the guard here makes that explicit rather than
 * load-bearing.
 */
export function callerFor(header: string | undefined | null, cfg: BridgeConfig): CallerClass | null {
  if (cfg.ownerToken && authorized(header, cfg.ownerToken)) return "owner";
  if (cfg.token && authorized(header, cfg.token)) return "console";
  return null;
}

/**
 * Every refusal of a mutation, with the caller CLASS on it — the record that
 * answers "did anything try to write `.metistry/` as somebody it is not".
 *
 * The log line is unconditional (a deployment with no database still has its
 * log); the `runs` row is the queryable half. Neither can fail the request:
 * an audit that takes the bridge down with it would be a denial of service
 * wearing a security hat.
 */
async function auditRefusal(db: Db | undefined, r: { caller: CallerClass; tool: string; code: ErrorCode; path: string; principal: string }): Promise<void> {
  const line = `reconciler: refused ${r.tool} ${r.path} — ${r.code}; caller ${r.caller} claimed principal ${r.principal}`;
  console.warn(line);
  if (!db) return;
  try {
    const id = await startRun(db, { component: "reconciler", kind: "auth", tool: r.tool, meta: { caller: r.caller, principal: r.principal, path: r.path, code: r.code } });
    await finishRun(db, id, { ok: false, error: line });
  } catch (err) {
    console.error("reconciler: could not record the refusal:", err instanceof Error ? err.message : err);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
function fail(res: ServerResponse, code: ErrorCode, message?: string): void {
  send(res, statusFor(code), errorEnvelope(code, message));
}
function reply<T>(res: ServerResponse, out: Outcome<T>, status = 200, shape: (v: T) => unknown = (v) => v): void {
  if (out.ok) return send(res, status, shape(out.value));
  fail(res, out.code, out.message);
}

/**
 * Defence in depth on top of `confine()`, for `GET /vault/read` only:
 * `.metistry/state/.env`, `.metistry/compute.yaml`, `.obsidian/workspace.json` and the
 * root `CLAUDE.md`/`README.md` are all real files `confine()` happily resolves — nothing
 * about path confinement says they aren't machinery — so they would otherwise be served
 * to ANY bearer holding this token. The console's `/api/knowledge/*` narrows to vault
 * content with the same predicate, but that is a second door onto this one; the bridge
 * must not depend on a caller choosing to narrow.
 *
 * `Artifacts/**` stays readable: it is binary content `packages/artifacts`'s
 * `ArtifactsService` reads and writes through this exact endpoint, not vault knowledge —
 * `isVaultPath` excludes it from the KNOWLEDGE walk on purpose, but that is a different
 * question from whether this bridge may serve it.
 */
function isReadableByBridge(rel: string): boolean {
  return isVaultPath(rel) || rel === INSTANCE_LAYOUT.artifactsDir || rel.startsWith(`${INSTANCE_LAYOUT.artifactsDir}/`);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function clampInt(v: string | null, fallback: number, min: number, max: number): number {
  const n = v === null || v === "" ? fallback : Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Decode the request body's content: utf8 `content` or `content_base64`, never both. */
function bodyContent(body: Record<string, unknown>): Buffer | null {
  const hasText = typeof body.content === "string";
  const hasB64 = typeof body.content_base64 === "string";
  if (hasText === hasB64) return null;
  if (hasText) return Buffer.from(body.content as string, "utf8");
  const b64 = body.content_base64 as string;
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) return null;
  return Buffer.from(b64, "base64");
}

function expectedSha(body: Record<string, unknown>): { ok: true; sha: string | undefined } | { ok: false } {
  const v = body.expected_sha256;
  if (v === undefined || v === null) return { ok: true, sha: undefined };
  if (typeof v !== "string" || !(v === "" || /^[0-9a-f]{64}$/.test(v))) return { ok: false };
  return { ok: true, sha: v };
}

export function makeBridge(deps: BridgeDeps, cfg: BridgeConfig): Server {
  const { vault, committer } = deps;
  return createServer(async (req, res) => {
    try {
      // The one place a caller is named, and it is named by its bearer.
      const caller = callerFor(req.headers.authorization, cfg);
      if (caller === null) return fail(res, "unauthenticated");
      const url = new URL(req.url ?? "/", "http://x");
      const key = `${req.method} ${url.pathname}`;
      const q = url.searchParams;

      if (key === "GET /check") {
        const result = await runCheck("reconciler", "instance repo present, git runs, HEAD readable, vault listable, queue depth reported", async () => {
          if (!(await vault.git.isRepo())) throw new Error(`no git repository at ${vault.root} — set METISTRY_INSTANCE_DIR to the instance repo (docs/ops/reconciler.md)`);
          const head = await vault.git.head();
          const listed = await vault.list("", 1);
          const embeddings = deps.embeddings ? await deps.embeddings.status().catch(() => null) : null;
          const meta = {
            head,
            queue_depth: committer.depth,
            last_flush: committer.lastFlush ? { at: new Date(committer.lastFlush.at).toISOString(), ...committer.lastFlush.result } : null,
            last_push: committer.lastPush ? { at: new Date(committer.lastPush.at).toISOString(), ...committer.lastPush.result } : null,
            last_reconcile: deps.indexer?.last ?? null,
            embeddings,
            // What each bearer may do, stated by the bridge itself: doctor
            // and the Mac app read this rather than inferring it from a
            // version number.
            principal_from_credential: true,
            owner_bearer: Boolean(cfg.ownerToken),
          };
          if (!listed.ok) return { status: "degraded" as const, remediation: `the vault at ${vault.root} is not listable — check the instance directory (docs/ops/reconciler.md)`, meta };
          // First, because it is the one that stops the OWNER's own verbs:
          // `metistry update`, `deployment set-shape` and `secrets` all write
          // a protected path through this bridge as the owner class.
          if (!cfg.ownerToken) {
            return {
              status: "degraded" as const,
              remediation:
                "METISTRY_BRIDGE_TOKEN_RECONCILER_USER is not set, so no caller may write a §4.7 protected path — `metistry update` and `metistry deployment set-shape` will be refused. Mint it with `metistry secrets sync --to env` (or `metistry up`), then `metistry restart reconciler` (docs/ops/auth.md)",
              meta,
            };
          }
          if (head === null) return { status: "degraded" as const, remediation: "repository has no commits yet — the first flushed write creates one", meta };
          if (committer.lastPush && !committer.lastPush.result.ok) {
            return { status: "degraded" as const, remediation: `last push failed: ${committer.lastPush.result.error ?? "unknown"} — check the remote/credentials; commits are safe locally`, meta };
          }
          // Embedding never fails the bridge — the index and every keyword
          // path keep working — but a stalled embedder is a `degraded` the
          // user can act on (§6 decision 8).
          if (embeddings?.degraded) {
            return {
              status: "degraded" as const,
              remediation: `embedding is not running (${embeddings.degraded}) — start the embedder with \`ollama serve\` and \`ollama pull ${embeddings.model}\`; search stays keyword until it is back`,
              meta,
            };
          }
          if (embeddings?.rebuild_required) {
            const other = embeddings.stored.filter((s) => s.model !== embeddings.model || s.dim !== embeddings.dim).map((s) => `${s.model}/${s.dim}d`);
            return {
              status: "degraded" as const,
              remediation: `stored vectors are ${other.join(", ")} but the configured model is ${embeddings.model}/${embeddings.dim}d — rebuild is required: POST /embeddings/rebuild`,
              meta,
            };
          }
          return { meta };
        });
        return send(res, result.status === "failed" ? 503 : 200, result);
      }

      if (key === "GET /vault/read") {
        // `encoding=base64` hands back the bytes untouched (binary artifacts); default stays utf8 `content`.
        if (q.get("encoding") === "base64") {
          const out = await vault.readBytes(q.get("path"));
          // Checked on the CONFINED path, after confine() has already produced its own
          // 400/403 for traversal, `.git`, and `.metistry/instance-migrations/` — this
          // only narrows what a path that already resolved cleanly may be.
          if (out.ok && !isReadableByBridge(out.value.path)) return fail(res, "not_found");
          return reply(res, out, 200, (v) => ({ path: v.path, content_base64: v.content.toString("base64"), sha256: v.sha256, bytes: v.bytes }));
        }
        const out = await vault.read(q.get("path"));
        if (out.ok && !isReadableByBridge(out.value.path)) return fail(res, "not_found");
        return reply(res, out);
      }

      if (key === "GET /vault/list") {
        const depth = clampInt(q.get("depth"), 1, 1, 20);
        return reply(res, await vault.list(q.get("prefix") ?? "", depth), 200, (entries) => ({ prefix: q.get("prefix") ?? "", depth, entries }));
      }

      if (key === "GET /vault/search") {
        const term = (q.get("q") ?? "").trim();
        if (!term || term.length > 200) return fail(res, "invalid_request", "q required (≤200 chars)");
        const limit = clampInt(q.get("limit"), 20, 1, 100);
        const mode = parseMode(q.get("mode"));
        if (mode === undefined) return fail(res, "invalid_request", "mode must be keyword, semantic, or hybrid");
        const result = await searchVault({ vault, db: deps.db, embeddings: deps.embeddings, client: deps.embedClient }, term, limit, mode);
        // Defence in depth, not a live case today: keyword hits come from `walkVault()`
        // and semantic hits are joined against `knowledge_files`, both already restricted
        // to `isVaultPath` — this drops anything that reaches here anyway rather than
        // trusting that restriction never drifts.
        return send(res, 200, { ...result, hits: result.hits.filter((h) => isVaultPath(h.path)) });
      }

      if (key === "GET /vault/log") {
        const limit = clampInt(q.get("limit"), 20, 1, 200);
        return reply(res, await vault.log(q.get("path"), limit), 200, (entries) => ({ path: q.get("path") ?? null, entries }));
      }

      if (key === "GET /vault/diff") return reply(res, await vault.diff(q.get("path"), q.get("from"), q.get("to")));

      if (key === "POST /vault/write" || key === "POST /vault/delete" || key === "POST /vault/rename") {
        const body = await readJson(req, cfg.maxBodyBytes);
        if (!body) return fail(res, "invalid_request", "JSON object body required (within the size cap)");
        const intent = parseIntent(body.intent);
        if (!intent.ok) return fail(res, intent.code, intent.message);
        const exp = expectedSha(body);
        if (!exp.ok) return fail(res, "invalid_request", "expected_sha256 must be 64 hex chars or empty");

        // Every `forbidden` from a mutation is audited with the caller class:
        // a console bearer asking to be the user on `.metistry/rules.yaml` is
        // the shape this PR exists to refuse, and a refusal nobody can see
        // afterwards is half a control.
        const refused = async <T>(out: Outcome<T>, tool: string, path: unknown): Promise<Outcome<T>> => {
          if (!out.ok && out.code === "forbidden") {
            await auditRefusal(deps.db, { caller, tool, code: out.code, path: typeof path === "string" ? path : String(path), principal: intent.value.principal });
          }
          return out;
        };

        if (key === "POST /vault/write") {
          const content = bodyContent(body);
          if (!content) return fail(res, "invalid_request", "exactly one of content (utf8) or content_base64");
          const out = await refused(await vault.write(body.path, content, intent.value, caller, exp.sha), "vault_write", body.path);
          return reply(res, out, out.ok && out.value.created ? 201 : 200, (v) => ({ ...v, queued: true }));
        }
        if (key === "POST /vault/delete") {
          const out = await refused(await vault.delete(body.path, intent.value, caller, exp.sha), "vault_delete", body.path);
          return reply(res, out, 200, (v) => ({ ...v, deleted: true, queued: true }));
        }
        const out = await refused(await vault.rename(body.from, body.to, intent.value, caller), "vault_rename", `${String(body.from)} → ${String(body.to)}`);
        return reply(res, out, 200, (v) => ({ ...v, queued: true }));
      }

      if (key === "POST /flush") {
        const r = await committer.flush();
        return send(res, 200, r);
      }

      if (key === "POST /reconcile") {
        if (!deps.indexer) return fail(res, "not_available");
        return send(res, 200, await deps.indexer.reconcile("on_demand"));
      }

      // Decision 8's deterministic rebuild: every vector, from the working
      // tree, under the currently configured model. The way a model change
      // is applied — and the way `rebuild_required` is cleared.
      if (key === "POST /embeddings/rebuild") {
        if (!deps.embeddings) return fail(res, "not_available", "no embedder configured (METISTRY_EMBED_ENABLED=false, or no db)");
        const started = Date.now();
        const summary = await deps.embeddings.rebuild();
        return send(res, 200, { ...summary, model: deps.embeddings.model, duration_ms: Date.now() - started });
      }

      if (key === "GET /embeddings/status") {
        if (!deps.embeddings) return fail(res, "not_available", "no embedder configured");
        return send(res, 200, await deps.embeddings.status());
      }

      return fail(res, "not_found");
    } catch (err) {
      console.error("reconciler: request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) fail(res, "internal");
    }
  });
}
