// The sole committer's one route off this machine.
//
// A confined reconciler's Seatbelt profile denies every outbound
// destination but the supervisor's loopback CONNECT proxy, so git has to be
// told about it. `git.ts` builds a deliberately minimal environment per call
// (no user config beyond `~/.gitconfig`, no prompts), which is exactly why
// the proxy arrives as `-c http.proxy` rather than as `HTTPS_PROXY`: an
// environment allowlist would have to admit it anyway, and one explicit flag
// is readable in a log.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../src/git.js";

const PROXY = "http://reconciler:deadbeef@127.0.0.1:7814";

describe("git through the egress door", () => {
  const before = process.env.METISTRY_GIT_HTTP_PROXY;
  afterEach(() => {
    if (before === undefined) delete process.env.METISTRY_GIT_HTTP_PROXY;
    else process.env.METISTRY_GIT_HTTP_PROXY = before;
  });

  /** A repo with a `git` on PATH is enough: the assertion is on the argv git was given, read back out of its own config parser. */
  async function repo(): Promise<Git> {
    const root = await mkdtemp(join(tmpdir(), "metistry-gp-"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "x\n");
    const g = new Git(root);
    await g.raw(["init", "-q", "-b", "main"]);
    return g;
  }

  it("passes the proxy to git when this install confines the reconciler", async () => {
    const g = await repo();
    process.env.METISTRY_GIT_HTTP_PROXY = PROXY;
    // `git config --get http.proxy` reports the value the -c flags injected,
    // which is the only way to see argv from outside the process
    const r = await g.raw(["config", "--get", "http.proxy"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(PROXY);
  });

  it("passes nothing when it does not — an unconfined install reaches its remote directly, as it always did", async () => {
    const g = await repo();
    delete process.env.METISTRY_GIT_HTTP_PROXY;
    const r = await g.raw(["config", "--get", "http.proxy"]);
    // exit 1 and no output: git has no such key
    expect(r.stdout.trim()).toBe("");
    expect(r.code).not.toBe(0);
  });

  it("an empty variable is not a proxy — a blank line in .env must not become `http.proxy=`", async () => {
    const g = await repo();
    process.env.METISTRY_GIT_HTTP_PROXY = "   ";
    const r = await g.raw(["config", "--get", "http.proxy"]);
    expect(r.stdout.trim()).toBe("");
  });

  it("the commit-signing flags are still there: an automated committer never signs as the user", async () => {
    const g = await repo();
    process.env.METISTRY_GIT_HTTP_PROXY = PROXY;
    expect((await g.raw(["config", "--get", "commit.gpgsign"])).stdout.trim()).toBe("false");
    expect((await g.raw(["config", "--get", "tag.gpgsign"])).stdout.trim()).toBe("false");
  });
});
