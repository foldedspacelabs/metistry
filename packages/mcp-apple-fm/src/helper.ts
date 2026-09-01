// Resident Swift helper child: JSON-lines over stdio, one pending map,
// auto-respawn on death. Injectable spawn for tests.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface HelperResponse {
  id: number;
  ok: boolean;
  error?: string;
  classification?: { category: string; has_action: boolean; action: string };
  probe?: string;
  category?: string;
  ready?: boolean;
}

export type Spawner = () => ChildProcess;

export class Helper {
  private child: ChildProcess | null = null;
  private pending = new Map<number, (r: HelperResponse) => void>();
  private nextId = 1;

  constructor(
    private readonly spawner: Spawner,
    private readonly timeoutMs = 30_000,
  ) {}

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = this.spawner();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const msg = JSON.parse(line) as HelperResponse;
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* non-JSON noise from the helper is ignored */
      }
    });
    child.on("exit", () => {
      for (const [id, resolve] of this.pending) {
        this.pending.delete(id);
        resolve({ id, ok: false, error: "helper exited" });
      }
      this.child = null;
    });
    this.child = child;
    return child;
  }

  async request(payload: { text?: string; op?: string }): Promise<HelperResponse> {
    const id = this.nextId++;
    const child = this.ensure();
    return new Promise<HelperResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: "helper timeout" });
      }, this.timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin!.write(JSON.stringify({ id, ...payload }) + "\n");
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

export function defaultSpawner(binaryPath: string): Spawner {
  return () => spawn(binaryPath, [], { stdio: ["pipe", "pipe", "inherit"] });
}
