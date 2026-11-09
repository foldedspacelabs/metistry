// Client for the resident Swift helper over its Unix socket (JSON lines).
// Why a socket and not a child process: TCC attributes access to the
// launchd job's ROOT binary (PoC-1), so the granted helper must be its own
// service — this bridge is a separate, un-privileged service that connects.
// One connection per request keeps the Swift side trivially sequential.

import { connect } from "node:net";

export interface HelperResponse {
  id: number;
  ok: boolean;
  /** The helper's refusal word (`invalid_scope`, `already_recording`, `not_available`, …). */
  code?: string;
  error?: string;
  [k: string]: unknown;
}

export interface HelperClient {
  request(payload: Record<string, unknown>): Promise<HelperResponse>;
}

/**
 * How long the bridge waits on the helper (`METISTRY_LC_HELPER_TIMEOUT_MS`).
 * A start can wait on the OS and the owner: the transcriber's first set-up,
 * the microphone prompt the first time it is asked, and — for Window and
 * Screen — the system picker, which the helper abandons after 120 s.
 */
export const DEFAULT_HELPER_TIMEOUT_MS = 150_000;

export class Helper implements HelperClient {
  private nextId = 1;
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  ) {}

  request(payload: Record<string, unknown>): Promise<HelperResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      let buf = "";
      const sock = connect(this.socketPath);
      const finish = (r: HelperResponse) => {
        clearTimeout(timer);
        sock.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ id, ok: false, code: "unreachable", error: "helper timeout" }), this.timeoutMs);
      sock.on("connect", () => sock.write(JSON.stringify({ id, ...payload }) + "\n"));
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          try {
            finish(JSON.parse(buf.slice(0, nl)) as HelperResponse);
          } catch {
            finish({ id, ok: false, code: "unreachable", error: "bad helper response" });
          }
        }
      });
      sock.on("error", (e) => finish({ id, ok: false, code: "unreachable", error: `helper unreachable: ${e.message}` }));
      sock.on("end", () => finish({ id, ok: false, code: "unreachable", error: "helper closed" }));
    });
  }
}
