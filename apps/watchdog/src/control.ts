// The supervisor's control socket — how `metistry restart|stop|start console`
// reaches a process launchd does not know about.
//
// A unix socket in the instance's `state/run/`, mode 0600, one JSON object
// per line in each direction. Filesystem permissions are the first boundary;
// the shared token in `supervisor.json` (also 0600) is the second, because
// invariant 8 says a request authenticates as if it came off the internet
// even when it cannot have. The comparison is constant-time and the refusal
// says only `unauthorized`.
//
// There is deliberately no "stop everything" op: stopping the whole install
// is `launchctl bootout` of the supervisor's own label, which is a thing
// launchd already does properly.

import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { CONTROL_UNAUTHORIZED, controlRequestSchema, type ControlResponse } from "@foldedspacelabs/metistry-core";
import type { Supervisor } from "./supervisor.js";

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Handle one already-parsed request. Exported so the tests exercise the protocol without a socket. */
export async function handleControl(sup: Supervisor, raw: unknown): Promise<ControlResponse> {
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `bad request: ${parsed.error.issues.map((i: { message: string }) => i.message).join("; ")}` };
  const req = parsed.data;
  if (!tokenMatches(req.token, sup.config.token)) return { ok: false, error: CONTROL_UNAUTHORIZED };
  if (req.op === "status") return { ok: true, children: sup.status() };
  const service = req.service;
  if (!service) return { ok: false, error: `${req.op} needs a service name — known: ${sup.names().join(", ")}` };
  if (!sup.has(service)) return { ok: false, error: `unknown service: ${service} — this supervisor runs ${sup.names().join(", ")}` };
  if (req.op === "stop") await sup.stopChild(service);
  else if (req.op === "start") await sup.startService(service);
  else await sup.restartService(service);
  return { ok: true, detail: `${req.op} ${service}`, children: sup.status() };
}

export interface ControlServer {
  server: Server;
  close: () => Promise<void>;
}

export async function listenControl(sup: Supervisor, log: (line: string) => void = (l) => console.log(l)): Promise<ControlServer> {
  const path = sup.config.socket;
  // a socket left behind by a killed supervisor would make bind fail with
  // EADDRINUSE forever; launchd restarts us, so clearing it is the only way
  // back without a person
  try {
    unlinkSync(path);
  } catch {
    // ENOENT is the normal case
  }
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        void (async () => {
          let res: ControlResponse;
          try {
            res = await handleControl(sup, JSON.parse(line));
          } catch (err) {
            res = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (res.error && res.error !== CONTROL_UNAUTHORIZED) log(`control: ${res.error}`);
          socket.write(JSON.stringify(res) + "\n");
        })();
      }
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // the socket inherits the process umask otherwise; 0600 is the boundary
  chmodSync(path, 0o600);
  log(`control socket: ${path} (0600)`);
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
          resolve();
        });
      }),
  };
}
