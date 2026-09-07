// The console's vault client: the artifacts module's VaultClient contract
// over the reconciler's HTTP bridge (D5) — bearer per call, the uniform
// envelope mapped to VaultError, bytes moved as base64 both ways so binary
// artifacts survive. No filesystem, no git, no mount (invariant 7).

import { VaultError, type VaultClient } from "@foldedspacelabs/metistry-artifacts";
import type { ErrorCode } from "@foldedspacelabs/metistry-core";

export interface VaultHttpConfig {
  url: string; // METISTRY_RECONCILER_URL
  token: string; // METISTRY_BRIDGE_TOKEN_RECONCILER
  timeoutMs?: number;
}

const CODES = new Set<ErrorCode>(["unauthenticated", "forbidden", "not_found", "invalid_request", "conflict", "rate_limited", "not_available", "internal"]);

export function httpVaultClient(cfg: VaultHttpConfig): VaultClient {
  const base = cfg.url.replace(/\/+$/, "");
  const timeout = cfg.timeoutMs ?? 15_000;

  async function request(method: "GET" | "POST", path: string, query?: Record<string, string | null | undefined>, body?: unknown): Promise<Response> {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    return r;
  }

  /** The bridge's envelope → VaultError; anything unexpected → not_available (the bridge is a dependency, not a fault of the caller). */
  async function refuse(r: Response): Promise<never> {
    let code: ErrorCode = "not_available";
    let message = `vault bridge returned ${r.status}`;
    try {
      const j = (await r.json()) as { error?: { code?: string; message?: string } };
      if (j.error?.code && CODES.has(j.error.code as ErrorCode)) code = j.error.code as ErrorCode;
      if (j.error?.message) message = j.error.message;
    } catch {}
    throw new VaultError(code, message);
  }

  return {
    async read(path) {
      const r = await request("GET", "/vault/read", { path, encoding: "base64" });
      if (r.status === 404) return null;
      if (!r.ok) return refuse(r);
      const j = (await r.json()) as { path: string; content_base64: string; sha256: string; bytes: number };
      return { path: j.path, content: Buffer.from(j.content_base64, "base64"), sha256: j.sha256, bytes: j.bytes };
    },
    async write(path, content, intent, expectedSha256) {
      const r = await request("POST", "/vault/write", undefined, { path, content_base64: content.toString("base64"), intent, ...(expectedSha256 !== undefined ? { expected_sha256: expectedSha256 } : {}) });
      if (!r.ok) return refuse(r);
      const j = (await r.json()) as { path: string; sha256: string; bytes: number; created: boolean };
      return { path: j.path, sha256: j.sha256, bytes: j.bytes, created: j.created };
    },
    async delete(path, intent) {
      const r = await request("POST", "/vault/delete", undefined, { path, intent });
      if (r.status === 404) return; // already gone
      if (!r.ok) return refuse(r);
    },
    async list(prefix, depth = 1) {
      const r = await request("GET", "/vault/list", { prefix, depth: String(depth) });
      if (r.status === 404) return [];
      if (!r.ok) return refuse(r);
      return ((await r.json()) as { entries: Array<{ path: string; kind: "file" | "dir"; bytes?: number }> }).entries;
    },
    async log(path, limit = 20) {
      const r = await request("GET", "/vault/log", { path, limit: String(limit) });
      if (!r.ok) return refuse(r);
      return ((await r.json()) as { entries: Array<{ sha: string; author: string; date: string; subject: string }> }).entries;
    },
    async diff(path, from, to) {
      const r = await request("GET", "/vault/diff", { path, from, to });
      if (!r.ok) return refuse(r);
      return (await r.json()) as { diff: string; from: string; to: string };
    },
    async flush() {
      const r = await request("POST", "/flush");
      if (!r.ok) return refuse(r);
      return r.json();
    },
  };
}
