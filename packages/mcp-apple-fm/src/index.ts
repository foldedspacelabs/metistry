// apple-fm bridge — the §4.3 wire contract over node:http:
// bearer caller auth (CRIT-9: loopback is not a trust boundary), uniform
// error envelope, behavioral check(), and the deterministic redaction pass
// over MODEL OUTPUT (§4.3 default 3 — PoC-13's OTP lesson: the helper's
// action field is model-generated text and gets scrubbed before anyone
// sees it).
//
// TWO SURFACES, ONE LISTENER, ONE BEARER (PR 4, PoC-19):
//
//   /check, /classify   the bridge contract — Metistry's error envelope
//   /v1/models,         an OpenAI-compatible provider, so `compute.yaml` can
//   /v1/chat/completions  list Apple Foundation Models with the same four
//                       lines as LM Studio and the engine needs no new code
//
// They share the listener and the auth on purpose. Invariant 8 says the
// network is not a boundary: a `/v1` that skipped the bearer because "it is
// only a local model" would be an unauthenticated completion endpoint on
// loopback, which is precisely the thing the rest of this file exists to
// refuse. The engine presents the bridge token like any other provider
// secret — `auth: { secret: METISTRY_BRIDGE_TOKEN_APPLE_FM }` in
// `compute.yaml`, resolved from the environment `metistry secrets sync --to
// env` writes.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  authorized,
  errorEnvelope,
  statusFor,
  scrubModelOutput,
  runCheck,
  type ErrorCode,
} from "@foldedspacelabs/metistry-core";
import type { Helper } from "./helper.js";
import {
  MODEL_ID,
  chatCompletion,
  modelsList,
  openAiError,
  statusForHelperCode,
  translateChatRequest,
  typeForHelperCode,
} from "./v1.js";

export interface BridgeConfig {
  token: string; // per-bridge bearer token (CRIT-9)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function fail(res: ServerResponse, code: ErrorCode): void {
  send(res, statusFor(code), errorEnvelope(code));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function makeBridge(helper: Helper, cfg: BridgeConfig): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const v1 = path.startsWith("/v1/");
    try {
      // every caller authenticates — no unauthenticated surface at all.
      // `/v1` answers in OpenAI's error shape because its caller is an
      // OpenAI client; the refusal itself is identical.
      if (!authorized(req.headers.authorization, cfg.token)) {
        return v1 ? send(res, 401, openAiError("authentication required", "unauthenticated", "invalid_request_error")) : fail(res, "unauthenticated");
      }

      const key = `${req.method} ${path}`;

      if (key === "GET /v1/models") return send(res, 200, modelsList());

      if (key === "POST /v1/chat/completions") {
        let raw: unknown;
        try {
          raw = await readJson(req);
        } catch {
          return send(res, 400, openAiError("body is not JSON", "bad_json"));
        }
        const t = translateChatRequest(raw);
        if (!t.ok) return send(res, t.status, t.body);
        const r = await helper.request(t.request);
        if (!r.ok || !r.completion) {
          const status = statusForHelperCode(r.code);
          // The helper's message is its own (a schema it could not translate,
          // a window it would have overrun) and is what makes the refusal
          // actionable, so it crosses the wire verbatim. It never contains
          // the caller's content — every one of them names a FIELD.
          return send(res, status, openAiError(r.error ?? "the Apple Foundation Models helper did not answer", r.code ?? "internal", typeForHelperCode(r.code)));
        }
        return send(res, 200, chatCompletion(r.completion, { id: randomUUID() }));
      }

      if (v1) return send(res, 404, openAiError(`no such endpoint: ${path} — this provider serves /v1/models and /v1/chat/completions`, "not_found"));

      if (key === "GET /check") {
        const result = await runCheck("apple-fm", "real classification of a canned item through FoundationModels", async () => {
          const r = await helper.request({ op: "check" });
          if (!r.ok) throw new Error(r.error ?? "helper check failed — is this an Apple Silicon Mac with FM assets?");
          return { meta: { category: r.category } };
        });
        return send(res, result.status === "ok" ? 200 : 503, result);
      }

      if (key === "POST /classify") {
        const body = (await readJson(req)) as { items?: { id: number | string; text: string }[] };
        if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
          return fail(res, "invalid_request");
        }
        const results = [];
        for (const item of body.items) {
          if (typeof item.text !== "string") return fail(res, "invalid_request");
          const r = await helper.request({ text: item.text });
          results.push(
            r.ok && r.classification
              ? {
                  id: item.id,
                  ok: true,
                  classification: {
                    category: r.classification.category,
                    has_action: r.classification.has_action,
                    // model OUTPUT: deterministic scrub before it leaves (§4.3)
                    action: scrubModelOutput(r.classification.action),
                  },
                }
              : { id: item.id, ok: false, error: "classification failed" },
          );
        }
        return send(res, 200, { results });
      }

      return fail(res, "not_found");
    } catch {
      if (!res.headersSent) {
        if (v1) send(res, 500, openAiError("internal error", "internal", "server_error"));
        else fail(res, "internal");
      }
    }
  });
}

export { MODEL_ID };
