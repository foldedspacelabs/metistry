// The Swift helper's own tests, from the package's suite: T8-2a's bold tests
// live there — a tap scoped to app X yields nothing from app Y, and the
// 10-hour stop fires — because the helper, not this bridge, decides what a
// recording hears and when it ends. `scripts/test-helper.sh` compiles the
// kit with its tests and fakes (no audio device, no TCC grant) and runs
// them; `scripts/build-helper.sh --compile-only` proves the adapters still
// build against the SDK — unsigned and not a bundle, so the build can never
// be granted anything and never signs. Darwin with a Swift toolchain only, so
// it SKIPS on Linux CI — the same shape as apple-fm's helper integration test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
      // T8-2b's bold test, the helper's half: the inbox drain's half (one report) is collectors/inbox-drain
      expect(report).toContain("ok   a crash saves up to the crash, and the session is owed with every line written before it");
      // T8-3's test: the picker's choice is the only filter the helper builds — both microphone paths
      expect(report).toContain("ok   the picker's choice is the only filter the helper builds (macOS 15: the microphone in the stream)");
      expect(report).toContain("ok   the picker's choice is the only filter the helper builds (macOS 14: the microphone as a second session)");
      expect(report).toContain("ok   a Window or Screen start names no content — the picker is never asked, nothing opens");
      expect(report).toContain("ok   a cancelled picker is no choice: refused, no session, nothing open");
      expect(report).toMatch(/\d+ checks, 0 failed/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  it("builds against the SDK: the process tap, the microphone, ScreenCaptureKit, SpeechTranscriber and the socket", () => {
    const out = mkdtempSync(join(tmpdir(), "lc-helper-build-"));
    try {
      const bin = join(out, "lc-helper");
      const report = execFileSync(join(root, "scripts/build-helper.sh"), ["--compile-only", bin], { encoding: "utf8" });
      expect(report).toContain("built (unsigned");
      // the usage strings are linked into the executable itself (PoC-9)
      const embedded = execFileSync("otool", ["-X", "-s", "__TEXT", "__info_plist", bin], { encoding: "utf8" });
      expect(embedded.length).toBeGreaterThan(0);
      const bytes = readFileSync(bin);
      expect(bytes.includes(Buffer.from("NSAudioCaptureUsageDescription"))).toBe(true);
      expect(bytes.includes(Buffer.from("com.foldedspacelabs.metistry.live-capture"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});

// The bundle's contract, as text: nothing here signs, loads or asks for a
// permission. What TCC keys a grant on is the bundle identifier and the
// signing identifier; both are pinned here so a rename — which would make
// every Mac consent again — fails a test instead of an owner.
describe("the recorder bundle (T8-2b)", () => {
  const BUNDLE_ID = "com.foldedspacelabs.metistry.live-capture";
  const plist = readFileSync(join(root, "helper/Info.plist"), "utf8");
  const ents = readFileSync(join(root, "helper/lc-helper.entitlements"), "utf8");
  const build = readFileSync(join(root, "scripts/build-helper.sh"), "utf8");
  const main = readFileSync(join(root, "helper/sources/helper/main.swift"), "utf8");
  const key = (k: string) => new RegExp(`<key>${k}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];

  it("names one identifier everywhere: Info.plist, codesign, and the helper's own fallback", () => {
    expect(key("CFBundleIdentifier")).toBe(BUNDLE_ID);
    expect(key("CFBundleExecutable")).toBe("lc-helper");
    expect(build.match(/--identifier (\S+)/g)).toEqual([`--identifier ${BUNDLE_ID}`, `--identifier ${BUNDLE_ID}`]);
    expect(main).toContain(`?? "${BUNDLE_ID}"`);
  });

  it("carries the usage strings macOS shows — microphone and app audio — and says the audio stays on the Mac", () => {
    for (const k of ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription"]) {
      expect(key(k)).toMatch(/Metistry .* on this Mac\.$/);
    }
    // no speech-recognition string: SpeechTranscriber has no authorization API, and SFSpeechRecognizer's prompt names Apple
    expect(plist).not.toContain("<key>NSSpeechRecognitionUsageDescription</key>");
    expect(plist).toMatch(/<key>LSUIElement<\/key><true\/>/);
    expect(plist).not.toContain("<key>LSBackgroundOnly</key>");
  });

  it("asks the hardened runtime for the microphone and nothing else — never the sandbox, never a debugger", () => {
    const keys = [...ents.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.device.audio-input"]);
    expect(build).toContain("--options runtime");
    expect(build).toContain("plutil -convert xml1");
    expect(build).toContain("codesign --verify --strict");
  });
});

// T8-3, the other half of "the picker's choice is the only filter the helper
// builds": the kit's tests prove the recorder opens only the picker's handle;
// this proves, from the sources, that the machine-facing code has no other way
// to get a filter — it never constructs an SCContentFilter and never
// enumerates shareable content. Text only: nothing is built, run or granted.
describe("the helper builds no filter of its own (T8-3)", () => {
  const dir = join(root, "helper/sources");
  const sources = ["kit", "helper"].flatMap((sub) =>
    readdirSync(join(dir, sub)).filter((f) => f.endsWith(".swift")).map((f) => ({ file: `${sub}/${f}`, text: stripComments(readFileSync(join(dir, sub, f), "utf8")) })),
  );
  const screen = sources.find((s) => s.file === "helper/screen.swift")!.text;

  it("no source constructs an SCContentFilter or enumerates shareable content", () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/SCContentFilter\s*\(/);
      expect(text, file).not.toMatch(/SCContentFilter\s*\.\s*init/);
      expect(text, file).not.toMatch(/SCShareableContent(?!Style)\b/);
      expect(text, file).not.toMatch(/getShareableContent|excludingDesktopWindows|SCScreenshotManager/);
      // …and no other screen API reaches around ScreenCaptureKit's stream
      expect(text, file).not.toMatch(/CGWindowListCreateImage|CGDisplayStream|CGDisplayCreateImage|CGRequestScreenCaptureAccess/);
    }
  });

  it("the one filter arrives in the picker's observer, and is the one the stream opens from", () => {
    expect(screen).toMatch(/didUpdateWith filter: SCContentFilter/);
    expect(screen.match(/SCStream\(filter:/g)).toHaveLength(1);
    expect(screen).toMatch(/filters\[plan\.picked\.handle\]/);
  });

  it("the picker takes one window or one display, never the helper, and the choice cannot change mid-stream", () => {
    expect(screen).toMatch(/\(style, pickerMode\) = \(\.window, \.singleWindow\)/);
    expect(screen).toMatch(/\(style, pickerMode\) = \(\.display, \.singleDisplay\)/);
    expect(screen).not.toMatch(/multipleWindows|singleApplication|multipleApplications/);
    expect(screen).toMatch(/excludedBundleIDs = \[excludingBundleID\]/);
    expect(screen).toMatch(/allowsChangingSelectedContent = false/);
  });

  it("the stream's sound is the filter's, never the helper's own, and nothing is hidden from macOS's indicators", () => {
    expect(screen).toMatch(/capturesAudio = plan\.appAudio/);
    expect(screen).toMatch(/excludesCurrentProcessAudio = true/);
    expect(screen).toMatch(/captureMicrophone = plan\.microphoneInStream/);
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/sharingType|setContentProtection|NSWindowSharingNone/);
    }
  });

  it("nothing captured is sent anywhere by the helper: no network API in any source", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/URLSession|URLRequest|NWConnection|CFSocket|import Network/);
    }
  });
});

/** Swift sources without their comments, so a comment naming an API is not a use of it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
