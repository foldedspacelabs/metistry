import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTestEnvIsolated, isAllowedTestVar, isTempPath, loadTestEnv, scrubTestEnv, testEnvViolations, TEST_ENV_TEMP_ONLY } from "../src/test-env.js";

const fresh = () => mkdtemp(join(tmpdir(), "metistry-test-env-"));
const TMP = tmpdir();

describe("the allowlist", () => {
  it("admits how to reach the scratch database and nothing else", () => {
    for (const ok of ["METISTRY_DB_HOST", "METISTRY_DB_PORT", "METISTRY_DB_USER", "METISTRY_DB_PASSWORD", "METISTRY_DB_NAME", "METISTRY_TEST_DB_NAME"]) {
      expect(isAllowedTestVar(ok), ok).toBe(true);
    }
    for (const no of ["METISTRY_INSTANCE_DIR", "METISTRY_RECONCILER_URL", "METISTRY_BRIDGE_TOKEN_RECONCILER", "METISTRY_ASSISTANT_TOKEN", "METISTRY_ORIGIN", "METISTRY_COMPUTE_FILES", "METISTRY_INBOX_DIR", "METISTRY_LOCAL_OWNER_TOKEN"]) {
      expect(isAllowedTestVar(no), no).toBe(false);
    }
  });
});

describe("scrubTestEnv", () => {
  it("deletes every METISTRY_* the allowlist does not name, and leaves everything else alone", () => {
    const env = {
      METISTRY_DB_PASSWORD: "pw",
      METISTRY_TEST_DB_NAME: "metistry_test_x",
      METISTRY_INSTANCE_DIR: "/Users/nobody/instance",
      METISTRY_COMPUTE_FILES: "/Users/nobody/instance/compute.yaml",
      METISTRY_INBOX_DIR: "/Users/nobody/instance/inbox",
      METISTRY_LOCAL_OWNER_TOKEN: "tok",
      HOME: "/Users/nobody",
      PATH: "/usr/bin",
    };
    expect(scrubTestEnv(env)).toEqual(["METISTRY_COMPUTE_FILES", "METISTRY_INBOX_DIR", "METISTRY_INSTANCE_DIR", "METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(env).toEqual({ METISTRY_DB_PASSWORD: "pw", METISTRY_TEST_DB_NAME: "metistry_test_x", HOME: "/Users/nobody", PATH: "/usr/bin" });
  });
});

describe("loadTestEnv", () => {
  it("takes the database lines out of a real dotenv file and refuses the rest of it", async () => {
    const dir = await fresh();
    const file = join(dir, ".env");
    await writeFile(
      file,
      [
        "# a running install's environment",
        "METISTRY_DB_PASSWORD=from-file",
        'METISTRY_DB_HOST="127.0.0.1"',
        "export METISTRY_TEST_DB_NAME=metistry_test_ci",
        "METISTRY_INSTANCE_DIR=/Users/nobody/Development/metistry-instance",
        "METISTRY_RECONCILER_URL=http://127.0.0.1:8788",
        "METISTRY_BRIDGE_TOKEN_RECONCILER=secret",
        "CLAUDE_CODE_OAUTH_TOKEN=also-secret",
      ].join("\n") + "\n",
    );
    const env: NodeJS.ProcessEnv = { METISTRY_ORIGIN: "https://studio.ts.net" };
    const r = loadTestEnv(file, env);
    expect(r.hasDb).toBe(true);
    expect(r.loaded).toEqual(["METISTRY_DB_HOST", "METISTRY_DB_PASSWORD", "METISTRY_TEST_DB_NAME"]);
    expect(r.removed).toEqual(["METISTRY_ORIGIN"]);
    expect(env).toEqual({ METISTRY_DB_HOST: "127.0.0.1", METISTRY_DB_PASSWORD: "from-file", METISTRY_TEST_DB_NAME: "metistry_test_ci" });
  });

  it("never overrides a value the caller already set — CI passes the password in, there is no file", async () => {
    const env: NodeJS.ProcessEnv = { METISTRY_DB_PASSWORD: "ci-only" };
    const r = loadTestEnv(join(await fresh(), "nope", ".env"), env);
    expect(r).toEqual({ hasDb: true, loaded: [], removed: [] });
    expect(env.METISTRY_DB_PASSWORD).toBe("ci-only");
  });

  it("no file, no database: hasDb is false so the suite skips rather than fails", async () => {
    expect(loadTestEnv(join(await fresh(), ".env"), {}).hasDb).toBe(false);
  });
});

describe("the guard", () => {
  it("passes on an environment that names only the scratch database", () => {
    expect(testEnvViolations({ METISTRY_DB_PASSWORD: "pw", HOME: "/Users/nobody" }, TMP)).toEqual([]);
    expect(() => assertTestEnvIsolated({ METISTRY_DB_PASSWORD: "pw" }, TMP)).not.toThrow();
  });

  it("allows the two path variables under os.tmpdir() and refuses them anywhere else", () => {
    for (const name of TEST_ENV_TEMP_ONLY) {
      expect(testEnvViolations({ [name]: join(TMP, "metistry-fixture") }, TMP)).toEqual([]);
      const bad = testEnvViolations({ [name]: "/Users/nobody/Development/metistry-instance" }, TMP);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.name).toBe(name);
      expect(bad[0]!.why).toContain("not a fixture");
    }
  });

  it("names every offending variable, and redacts the secret-shaped ones", () => {
    let message = "";
    try {
      assertTestEnvIsolated({ METISTRY_RECONCILER_URL: "http://127.0.0.1:8788", METISTRY_BRIDGE_TOKEN_RECONCILER: "would-have-committed", METISTRY_ASSISTANT_TOKEN: "t" }, TMP);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("not isolated");
    expect(message).toContain("METISTRY_RECONCILER_URL=http://127.0.0.1:8788");
    expect(message).toContain("METISTRY_BRIDGE_TOKEN_RECONCILER=<redacted>");
    expect(message).toContain("METISTRY_ASSISTANT_TOKEN=<redacted>");
    expect(message).not.toContain("would-have-committed");
    expect(message).toContain("--product-dir");
  });

  it("isTempPath: the temp root and below, never a sibling that merely starts with the same letters", () => {
    expect(isTempPath(TMP, TMP)).toBe(true);
    expect(isTempPath(join(TMP, "a", "b"), TMP)).toBe(true);
    expect(isTempPath(`${TMP}-not-really`, TMP)).toBe(false);
    expect(isTempPath("/Users/nobody", TMP)).toBe(false);
  });
});
