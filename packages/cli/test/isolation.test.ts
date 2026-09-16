// The guard that makes the rest of this suite safe to write carelessly.
//
// `metistry` verbs resolve a product checkout, read its `.env`, and then act
// on whatever that file points at — an instance directory, a reconciler URL, a
// bridge token. Run from inside the Metistry checkout with no `--product-dir`,
// that file belongs to a RUNNING install, and `--instance <temp dir>` does not
// help: `writeProtected` sends the write to the bridge named in the
// environment, which commits it into the operator's private instance repo.
//
// That is how `2b03664 metistry compute providers add lmstudio` reached a real
// instance repo on 2026-09-15. These tests fail if it can happen again.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTestEnvIsolated, isTempPath, scrubTestEnv, testEnvViolations } from "@foldedspacelabs/metistry-core/test-env";
import { loadInstallEnv, resolveProductDir } from "../src/env.js";
import { resolveInstanceDir } from "../src/instance.js";
import { main } from "../src/main.js";

const fresh = (label: string) => mkdtemp(join(tmpdir(), `metistry-isolation-${label}-`));

/** Every verb that will act on an instance directory if it can find one. */
const INSTANCE_VERBS: string[][] = [
  ["compute", "show"],
  ["compute", "providers", "add", "--from", "lmstudio", "--skip-test"],
  ["compute", "assign", "default", "lmstudio/x"],
  ["compute", "budget", "instance", "--monthly", "1", "--action", "stop"],
  ["identity"],
  ["connect-repo", "--url", "git@example.test:x/y.git"],
  ["deployment", "set-shape", "launchd"],
];

describe("the harness cannot reach the operator's install", () => {
  it("the environment a test starts in names nothing outside the scratch database", () => {
    expect(testEnvViolations()).toEqual([]);
    for (const name of Object.keys(process.env)) {
      if (!name.startsWith("METISTRY_")) continue;
      expect(name, `${name} survived the scrub`).toMatch(/^METISTRY_(DB_|TEST_DB_NAME$|PRODUCT_DIR$)/);
    }
  });

  it("no instance-dir verb resolves a directory outside os.tmpdir()", async () => {
    for (const argv of INSTANCE_VERBS) {
      const code = await main([...argv], { out: () => {}, err: () => {} });
      const resolved = resolveInstanceDir(process.env);
      expect(resolved === undefined || isTempPath(resolved), `${argv.join(" ")} resolved ${resolved}`).toBe(true);
      // and it refused rather than guessing — the refusal names the variable
      expect(code, `${argv.join(" ")} did not refuse`).toBe(2);
    }
  });

  it("`--product-dir` at a sandbox is what the ambient walk would otherwise have found", async () => {
    const sandbox = process.env.METISTRY_PRODUCT_DIR;
    expect(sandbox).toBeDefined();
    expect(isTempPath(sandbox!)).toBe(true);
    expect(resolveProductDir(undefined)).toBe(sandbox);
  });

  it("the guard has teeth: a checkout whose .env points at a real instance fails the assertion", async () => {
    const checkout = await fresh("checkout");
    await writeFile(
      join(checkout, ".env"),
      ["METISTRY_INSTANCE_DIR=/Users/nobody/Development/metistry-instance", "METISTRY_RECONCILER_URL=http://127.0.0.1:8788", "METISTRY_BRIDGE_TOKEN_RECONCILER=would-have-committed"].join("\n") + "\n",
    );
    try {
      loadInstallEnv({ productDir: checkout });
      expect(process.env.METISTRY_INSTANCE_DIR).toBe("/Users/nobody/Development/metistry-instance");
      expect(() => assertTestEnvIsolated()).toThrow(/not isolated/);
      expect(() => assertTestEnvIsolated()).toThrow(/METISTRY_RECONCILER_URL=http:\/\/127\.0\.0\.1:8788/);
      expect(() => assertTestEnvIsolated()).toThrow(/METISTRY_BRIDGE_TOKEN_RECONCILER=<redacted>/); // a violation report is not a place to print a token
    } finally {
      scrubTestEnv();
    }
  });
});
