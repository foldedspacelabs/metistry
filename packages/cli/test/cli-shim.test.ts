// cli-shim.ts: the shim's content, its path (a sibling of `state/bin/`, not
// inside it — see the file's own header comment for why), idempotence
// (unchanged content is left alone), mode 0755, the shell-unsafe refusal,
// and the defensive guard against a symlink or a foreign file already
// sitting at the path.
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliShimLinkHint, cliShimPath, renderCliShim, writeCliShim } from "../src/cli-shim.js";
import { realExec } from "../src/exec.js";
import { StepRunner } from "../src/steps.js";
import { fakeExec, shown } from "./fixtures.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "metistry-shim-"));
}

describe("renderCliShim", () => {
  it("is a POSIX script that resolves this install's own node and cli, an operator's own env winning", () => {
    const content = renderCliShim("/opt/metistry", undefined);
    expect(content).toMatch(/^#!\/bin\/sh\n/);
    expect(content).toContain('export METISTRY_PRODUCT_DIR="${METISTRY_PRODUCT_DIR:-/opt/metistry}"');
    expect(content).not.toContain("METISTRY_INSTANCE_DIR"); // none given — nothing to default
    expect(content).toContain('NODE="$METISTRY_PRODUCT_DIR/runtime/node/bin/node"');
    expect(content).toContain('[ -x "$NODE" ] || NODE="$(command -v node)"'); // the checkout shape: no bundled runtime pack
    expect(content).toContain('MAIN="$METISTRY_PRODUCT_DIR/current/packages/cli/dist/main.js"');
    expect(content).toContain('[ -f "$MAIN" ] || MAIN="$METISTRY_PRODUCT_DIR/packages/cli/dist/main.js"'); // the checkout shape: no `current`
    expect(content).toContain('exec "$NODE" "$MAIN" "$@"');
  });

  it("exports the instance dir too, when there is one", () => {
    const content = renderCliShim("/opt/metistry", "/opt/instance");
    expect(content).toContain('export METISTRY_INSTANCE_DIR="${METISTRY_INSTANCE_DIR:-/opt/instance}"');
  });

  it("refuses a path with a shell-unsafe character rather than emit a broken script", () => {
    expect(() => renderCliShim('/tmp/a"b', undefined)).toThrow(/shell-unsafe/);
    expect(() => renderCliShim("/tmp/ok", "/tmp/i$(rm -rf /)")).toThrow(/shell-unsafe/);
  });
});

describe("cliShimPath / cliShimLinkHint", () => {
  it("is under the instance dir's .metistry/state/cli when there is one, else the product dir's — a sibling of state/bin, never inside it", async () => {
    const P = await tmp();
    const I = await tmp();
    expect(cliShimPath(P, undefined)).toBe(join(P, ".metistry", "state", "cli", "metistry"));
    expect(cliShimPath(P, I)).toBe(join(I, ".metistry", "state", "cli", "metistry"));
  });

  it("is the one line up/doctor both point at", () => {
    expect(cliShimLinkHint("/x/metistry")).toBe("ln -s /x/metistry ~/.local/bin/metistry");
  });
});

describe("writeCliShim", () => {
  it("writes the resolved content and reports the link one-liner", async () => {
    const P = await tmp();
    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await writeCliShim(r, P, undefined);

    const path = cliShimPath(P, undefined);
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(renderCliShim(P, undefined));
    expect(exec.calls.map(shown)).toEqual([`chmod 755 ${path}`]);
    expect(lines.join("\n")).toContain(`ln -s ${path} ~/.local/bin/metistry`);
  });

  it("is actually mode 0755 once the real chmod runs (fakeExec above only records the command)", async () => {
    const P = await tmp();
    const r = new StepRunner({ dryRun: false, out: () => {}, exec: realExec });
    await writeCliShim(r, P, undefined);
    expect(statSync(cliShimPath(P, undefined)).mode & 0o777).toBe(0o755);
  });

  it("is idempotent: unchanged content is neither rewritten nor rechmoded", async () => {
    const P = await tmp();
    const exec = fakeExec();
    const r1 = new StepRunner({ dryRun: false, out: () => {}, exec });
    await writeCliShim(r1, P, undefined);

    const path = cliShimPath(P, undefined);
    const before = readFileSync(path, "utf8");

    const lines: string[] = [];
    const r2 = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await writeCliShim(r2, P, undefined);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(exec.calls.map(shown)).toEqual([`chmod 755 ${path}`]); // only from the first write
    expect(lines.join("\n")).toContain("unchanged");
  });

  it("re-writes when the product dir (and so the content) changes", async () => {
    const P = await tmp();
    const I = await tmp();
    const exec = fakeExec();
    const r = new StepRunner({ dryRun: false, out: () => {}, exec });
    await writeCliShim(r, P, undefined);
    await writeCliShim(r, P, I); // same install root, now an instance — different path AND content

    expect(exec.calls.map(shown)).toEqual([`chmod 755 ${cliShimPath(P, undefined)}`, `chmod 755 ${cliShimPath(P, I)}`]);
  });

  it("a dry run writes nothing but previews the plan from the real, current filesystem state", async () => {
    const P = await tmp();
    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: true, out: (l) => lines.push(l), exec });
    await writeCliShim(r, P, undefined);

    const path = cliShimPath(P, undefined);
    expect(existsSync(path)).toBe(false);
    expect(exec.calls).toEqual([]);
    expect(lines.some((l) => l.includes(`write ${path}`))).toBe(true);
    expect(lines.some((l) => l.startsWith("[dry-run] chmod 755"))).toBe(true);
  });

  it("leaves an existing symlink at the path alone and says why, rather than overwriting it", async () => {
    const P = await tmp();
    const path = cliShimPath(P, undefined);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync("/usr/local/bin/node", path);

    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await writeCliShim(r, P, undefined);

    expect(exec.calls).toEqual([]); // no chmod — nothing was written
    expect(lstatSync(path).isSymbolicLink()).toBe(true); // untouched
    expect(lines.join("\n")).toContain("not a plain file");
  });

  it("leaves a foreign file at the path alone (does not look like a shim this install wrote)", async () => {
    const P = await tmp();
    const path = cliShimPath(P, undefined);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\necho not the shim\n");

    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await writeCliShim(r, P, undefined);

    expect(exec.calls).toEqual([]); // no chmod — nothing was written
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho not the shim\n"); // untouched
    expect(lines.join("\n")).toContain("not a shim this install wrote");
  });

  it("a case-insensitive volume's state/bin/Metistry (the launchd shape's supervisor symlink) does not stop the shim being written at its own, sibling path", async () => {
    // The whole reason the shim lives at state/cli/ and not state/bin/: on
    // macOS's default case-insensitive volume, `state/bin/metistry` and
    // `state/bin/Metistry` are the SAME directory entry, and the supervisor
    // already owns that name under the launchd shape (supervisor.ts). A real
    // symlink is simulated directly (this test machine's own volume may not
    // be case-insensitive, e.g. in CI on Linux), and state/bin/ is populated
    // exactly the way `up` populates it, to prove the sibling directory is
    // not merely untested but actually unreachable by that collision.
    const P = await tmp();
    const stateDir = join(P, ".metistry", "state");
    mkdirSync(join(stateDir, "bin"), { recursive: true });
    symlinkSync("/usr/local/bin/node", join(stateDir, "bin", "Metistry"));

    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await writeCliShim(r, P, undefined);

    const path = cliShimPath(P, undefined);
    expect(path).toBe(join(stateDir, "cli", "metistry")); // sibling of state/bin, never inside it
    expect(existsSync(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(renderCliShim(P, undefined));
    expect(exec.calls.map(shown)).toEqual([`chmod 755 ${path}`]);
    // the supervisor's own symlink, at its own unrelated path, untouched
    expect(lstatSync(join(stateDir, "bin", "Metistry")).isSymbolicLink()).toBe(true);
  });

  it("a shell-unsafe product dir is a note, not a thrown failure — the rest of up/update must not go down over a cosmetic feature", async () => {
    const P = await tmp();
    const unsafe = join(P, 'a"b');
    const exec = fakeExec();
    const lines: string[] = [];
    const r = new StepRunner({ dryRun: false, out: (l) => lines.push(l), exec });
    await expect(writeCliShim(r, unsafe, undefined)).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("not written");
  });
});
