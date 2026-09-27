// The hand-over from the release an update is leaving to the one it just
// installed (update-reexec.ts), with an injected exec: the exact argv and
// environment the new CLI is started with, its exit code passed through, the
// loop guard, the capability check and the fall-back when the new CLI never
// starts. release.test.ts drives the same thing through `update()` itself.
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StepRunner } from "../src/steps.js";
import {
  acknowledgeContinuation,
  continuationArgs,
  parseContinueFrom,
  reexecIntoRelease,
  REEXEC_CAPABILITY_FILE,
  releaseCliMain,
  supportsContinuation,
  UPDATE_REEXEC_ACK_ENV,
  UPDATE_REEXEC_ENV,
} from "../src/update-reexec.js";
import { fakeExec, put } from "./fixtures.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** A product dir whose `current` release carries a CLI that understands the hand-over (unless `capable: false`). */
async function product(opts: { capable?: boolean } = {}) {
  const P = await mkdtemp(join(tmpdir(), "metistry-reexec-"));
  const runDir = join(P, "current");
  await put(runDir, "packages/cli/dist/main.js", "// the new release's cli\n");
  if (opts.capable !== false) await put(runDir, `packages/cli/dist/${REEXEC_CAPABILITY_FILE}`, "export {};\n");
  return { P, runDir };
}

function runner(exec = fakeExec()) {
  const out: string[] = [];
  return { r: new StepRunner({ dryRun: false, out: (l) => out.push(l), exec, env: {} }), out, exec };
}

const base = (P: string, runDir: string) => ({ productDir: P, runDir, version: "0.2.0", runningVersion: "0.1.0", env: { METISTRY_INSTANCE_DIR: "/i" } as NodeJS.ProcessEnv });

describe("--continue-from", () => {
  it("accepts the one step there is and refuses anything else", () => {
    expect(parseContinueFrom(undefined)).toBeUndefined();
    expect(parseContinueFrom("switched")).toBe("switched");
    expect(() => parseContinueFrom("product")).toThrow(/--continue-from must be switched/);
    expect(() => parseContinueFrom(true)).toThrow(/--continue-from must be switched/);
  });

  it("the capability file is this module's own compiled name — a rename would silently turn the hand-over off", () => {
    expect(existsSync(join(SRC, REEXEC_CAPABILITY_FILE.replace(/\.js$/, ".ts")))).toBe(true);
  });

  it("forwards the owner's flags and sets its own last, so they win", () => {
    const args = continuationArgs("/p/current/packages/cli/dist/main.js", { "skip-migrate": true, "env-file": "/i/.env", "product-dir": "/elsewhere", "no-reexec": true, "continue-from": "x", channel: "git", "app-path": "--odd value" }, "/p");
    expect(args).toEqual([
      "/p/current/packages/cli/dist/main.js",
      "update",
      "--skip-migrate",
      "--env-file=/i/.env",
      "--app-path=--odd value",
      "--continue-from=switched",
      "--channel=release",
      "--product-dir=/p",
    ]);
  });

  it("the child's half of the handshake writes the file it was given, and nothing without one", async () => {
    const d = await mkdtemp(join(tmpdir(), "metistry-ack-"));
    await acknowledgeContinuation({});
    await acknowledgeContinuation({ [UPDATE_REEXEC_ACK_ENV]: join(d, "started") });
    expect(existsSync(join(d, "started"))).toBe(true);
  });
});

describe("reexecIntoRelease", () => {
  it("starts the NEW release's CLI with the marker and the handshake path, and passes its exit code through", async () => {
    const { P, runDir } = await product();
    let seen: NodeJS.ProcessEnv = {};
    const exec = fakeExec({
      [process.execPath]: async (_args, o) => {
        seen = o?.env ?? {};
        await writeFile(o!.env![UPDATE_REEXEC_ACK_ENV]!, "started\n");
        return { code: 3 };
      },
    });
    const { r } = runner(exec);
    const res = await reexecIntoRelease(r, { ...base(P, runDir), flags: { "skip-build": true } });

    expect(res).toMatchObject({ status: "continued", code: 3 });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.cmd).toBe(process.execPath);
    expect(exec.calls[0]!.args).toEqual([releaseCliMain(runDir), "update", "--skip-build", "--continue-from=switched", "--channel=release", `--product-dir=${P}`]);
    expect(seen[UPDATE_REEXEC_ENV]).toBe("1");
    expect(seen.METISTRY_INSTANCE_DIR).toBe("/i"); // the same environment, plus the marker
    // the handshake file is cleaned up once the child has answered
    expect(existsSync(seen[UPDATE_REEXEC_ACK_ENV]!)).toBe(false);
  });

  it("runs it on the bundled runtime's node when the release brought one", async () => {
    const { P, runDir } = await product();
    await put(P, "runtime/node/bin/node", "");
    const exec = fakeExec();
    await reexecIntoRelease(runner(exec).r, { ...base(P, runDir), flags: {} });
    expect(exec.calls[0]!.cmd).toBe(join(P, "runtime", "node", "bin", "node"));
  });

  it("never hands over a second time: the marker in its own environment refuses it (loop guard)", async () => {
    const { P, runDir } = await product();
    const { r, out, exec } = runner();
    const res = await reexecIntoRelease(r, { ...base(P, runDir), env: { [UPDATE_REEXEC_ENV]: "1" }, flags: {} });
    expect(res.status).toBe("skipped");
    expect(exec.calls).toEqual([]);
    expect(out.join("\n")).toContain(`${UPDATE_REEXEC_ENV} is set`);
  });

  it("falls back — loudly — when the new CLI exits without ever starting (a bad pack)", async () => {
    const { P, runDir } = await product();
    const exec = fakeExec({ [process.execPath]: () => ({ code: 1 }) });
    const { r, out } = runner(exec);
    const res = await reexecIntoRelease(r, { ...base(P, runDir), flags: {} });
    expect(res).toMatchObject({ status: "fell-back", code: 1 });
    expect(out.join("\n")).toContain("0.2.0's CLI did not start (exit 1) — the rest of this update runs on 0.1.0's code instead");
  });

  it("a new CLI that started and then failed is NOT a fall-back: its exit code is the answer", async () => {
    const { P, runDir } = await product();
    const exec = fakeExec({
      [process.execPath]: async (_a, o) => {
        await writeFile(o!.env![UPDATE_REEXEC_ACK_ENV]!, "started\n");
        return { code: 1 };
      },
    });
    const res = await reexecIntoRelease(runner(exec).r, { ...base(P, runDir), flags: {} });
    expect(res).toMatchObject({ status: "continued", code: 1 });
  });

  it("does not hand over to a release whose CLI predates it — that CLI would ignore the flag and run a whole second update", async () => {
    const { P, runDir } = await product({ capable: false });
    expect(supportsContinuation(runDir)).toBe(false);
    const { r, out, exec } = runner();
    const res = await reexecIntoRelease(r, { ...base(P, runDir), flags: {} });
    expect(res.status).toBe("skipped");
    expect(exec.calls).toEqual([]);
    expect(out.join("\n")).toContain("0.2.0's CLI predates the hand-over");
  });

  it("--no-reexec finishes on the running code, and says whose code that is", async () => {
    const { P, runDir } = await product();
    const { r, out, exec } = runner();
    const res = await reexecIntoRelease(r, { ...base(P, runDir), flags: {}, disabled: true });
    expect(res.status).toBe("skipped");
    expect(exec.calls).toEqual([]);
    expect(out.join("\n")).toContain("--no-reexec: the rest of this update runs on 0.1.0's code");
  });
});
