// Every CLI test runs with the operator's install out of reach.
//
// This suite calls `main()`, and `main()` reads a real install's environment:
// it resolves a product checkout, loads that checkout's `.env`, and hands the
// result to write paths that POST to `METISTRY_RECONCILER_URL` with
// `METISTRY_BRIDGE_TOKEN_RECONCILER`. `--instance <temp dir>` does not stop
// that — the bridge decides where the write lands, not the flag.
//
// Three things, in order:
//   1. the environment is scrubbed to the scratch-database allowlist;
//   2. `METISTRY_PRODUCT_DIR` is pinned at an empty temp directory, so a
//      `main()` call with no `--product-dir` resolves THAT and not the
//      checkout the test happens to be running inside;
//   3. after every test the environment is checked again — which is the part
//      that matters, because it fails the moment a test points
//      `--product-dir` at the real checkout, the one way left in.
//
// docs/ops/testing.md.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { assertTestEnvIsolated, loadTestEnv, scrubTestEnv } from "@foldedspacelabs/metistry-core/test-env";

loadTestEnv(new URL("../../../.env", import.meta.url));

/** An empty directory that is not a product checkout: `resolveProductDir` prefers it over walking up to the real one. */
const SANDBOX = mkdtempSync(join(tmpdir(), "metistry-cli-no-checkout-"));

beforeEach(() => {
  scrubTestEnv();
  process.env.METISTRY_PRODUCT_DIR = SANDBOX;
});

afterEach(() => {
  try {
    assertTestEnvIsolated();
  } finally {
    scrubTestEnv();
  }
});
