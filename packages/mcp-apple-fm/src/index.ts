// apple-fm bridge — the §4.3 wire contract over node:http:
// bearer caller auth (CRIT-9: loopback is not a trust boundary), uniform
// error envelope, behavioral check(), and the deterministic redaction pass
// over MODEL OUTPUT (§4.3 default 3 — PoC-13's OTP lesson: the helper's
// action field is model-generated text and gets scrubbed before anyone
// sees it).

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
    try {
      // every caller authenticates — no unauthenticated surface at all
      if (!authorized(req.headers.authorization, cfg.token)) return fail(res, "unauthenticated");

      const key = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;

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
      if (!res.headersSent) fail(res, "internal");
    }
  });
}
