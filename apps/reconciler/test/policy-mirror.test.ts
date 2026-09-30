// The reconciler keeps the compose policy mirror current (X-7): a grant
// change made by ANY writer — a CLI verb through the bridge, a hand edit, a
// pull — reaches `.metistry/state/policy/secrets.yaml` within one interval,
// so a revoke reaches a running container on its next call.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretsMirrorDir } from "@foldedspacelabs/metistry-core";
import { startPolicyMirror } from "../src/policy-mirror.js";

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("startPolicyMirror", () => {
  it("mirrors at start, follows a hand-edited revoke written by rename, and removes the mirror when the policy is deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metistry-x7-reconciler-mirror-"));
    await mkdir(join(dir, ".metistry", "state"), { recursive: true });
    const canonical = join(dir, ".metistry", "secrets.yaml");
    const mirrored = join(secretsMirrorDir(dir), "secrets.yaml");
    await writeFile(canonical, "secrets:\n  k:\n    grants:\n      provider:openrouter: on\n");
    const lines: string[] = [];
    const m = startPolicyMirror(dir, { intervalMs: 20, log: (l) => lines.push(l) });
    try {
      await m.first;
      expect(readFileSync(mirrored, "utf8")).toContain("provider:openrouter: on");

      await writeFile(`${canonical}.tmp`, "secrets:\n  k:\n    grants:\n      provider:openrouter: off\n");
      await rename(`${canonical}.tmp`, canonical);
      await until(() => readFileSync(mirrored, "utf8").includes("provider:openrouter: off"));

      await rm(canonical);
      await until(() => !existsSync(mirrored));
      expect(lines.filter((l) => l.includes("written")).length).toBeGreaterThanOrEqual(2);
      expect(lines.some((l) => l.includes("removed"))).toBe(true);
    } finally {
      m.stop();
    }
  });

  it("a failing mirror never throws, and says so once until the error changes", async () => {
    const lines: string[] = [];
    let n = 0;
    const m = startPolicyMirror("/nowhere", {
      intervalMs: 10,
      log: (l) => lines.push(l),
      mirror: async () => {
        n++;
        throw new Error("EACCES");
      },
    });
    await m.first;
    await until(() => n >= 4);
    m.stop();
    expect(lines.filter((l) => l.includes("EACCES"))).toHaveLength(1);
  });
});
