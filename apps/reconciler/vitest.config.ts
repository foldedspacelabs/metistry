import { defineConfig } from "vitest/config";

// Three of this package's suites drive the reconcile loop against the same
// scratch database and each start from an empty index (invariant 1: the
// index is derived, so a test that cares about counts must own the table).
// Run the files one at a time rather than teaching every suite to scope its
// own rows — the suite is seconds long and correctness is the point.
export default defineConfig({
  test: { fileParallelism: false },
});
