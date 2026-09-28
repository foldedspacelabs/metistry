// The Swift helper's own tests, from the package's suite: T8-2a's bold tests
// live there — a tap scoped to app X yields nothing from app Y, and the
// 10-hour stop fires — because the helper, not this bridge, decides what a
// recording hears and when it ends. `scripts/test-helper.sh` compiles the
// kit with its tests and fakes (no audio device, no TCC grant) and runs
// them; `scripts/build-helper.sh` proves the adapters still build against
// the SDK. Darwin with a Swift toolchain only, so it SKIPS on Linux CI —
// the same shape as apple-fm's helper integration test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function haveSwift(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!haveSwift())("the live-capture helper (Swift, darwin)", () => {
  it("passes its kit tests: the tap scope, the 10-hour stop, the lifecycle, the socket protocol", () => {
    const out = mkdtempSync(join(tmpdir(), "lc-helper-tests-"));
    try {
      const report = execFileSync(join(root, "scripts/test-helper.sh"), [out], { encoding: "utf8" });
      expect(report).toContain("ok   a tap scoped to app X yields nothing from app Y (process objects)");
      expect(report).toContain("ok   a tap scoped to app X yields nothing from app Y (macOS 26 bundle IDs)");
      expect(report).toContain("ok   the 10-hour stop fires");
      expect(report).toMatch(/\d+ checks, 0 failed/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  it("builds against the SDK: the process tap, the microphone, SpeechTranscriber and the socket", () => {
    const out = mkdtempSync(join(tmpdir(), "lc-helper-build-"));
    try {
      const report = execFileSync(join(root, "scripts/build-helper.sh"), [join(out, "lc-helper")], { encoding: "utf8" });
      expect(report).toContain("built:");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
