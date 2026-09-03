// Client for the resident Swift helper over its Unix socket (JSON lines).
// Why a socket and not a child process: TCC attributes access to the
// launchd job's ROOT binary (PoC-1), so the granted helper must be its own
// service — this bridge is a separate, un-privileged service that connects.
// One connection per request keeps the Swift side trivially sequential.

import { connect } from "node:net";

export interface HelperResponse {
  id: number;
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface HelperClient {
  request(payload: Record<string, unknown>): Promise<HelperResponse>;
}

export class Helper implements HelperClient {
  private nextId = 1;
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 30_000,
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
      const timer = setTimeout(() => finish({ id, ok: false, error: "helper timeout" }), this.timeoutMs);
      sock.on("connect", () => sock.write(JSON.stringify({ id, ...payload }) + "\n"));
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          try {
            finish(JSON.parse(buf.slice(0, nl)) as HelperResponse);
          } catch {
            finish({ id, ok: false, error: "bad helper response" });
          }
        }
      });
      sock.on("error", (e) => finish({ id, ok: false, error: `helper unreachable: ${e.message}` }));
      sock.on("end", () => finish({ id, ok: false, error: "helper closed" }));
    });
  }
}
