// "stdout is the protocol" as a conformance test (plan-refresh R5).
//
// Three layers, smallest first:
//   1. the rule itself — what counts as a frame, what counts as noise;
//   2. the harness, proved against fixture children that behave and misbehave,
//      so a green result below means something;
//   3. the repo's actual stdio components, spawned with a bare environment.
//
// On (3): every bridge in this tree is `transport: http` today, and the
// eventkit helper's wire is a UNIX SOCKET, not stdio — so its startup banner
// on stdout is a log line and stays one. The one component whose protocol is
// literally stdout is mcp-apple-fm's Swift helper (JSON lines, `emit()`), and
// it is darwin-only and built out of tree, so it is skipped where it cannot
// run — like packages/cli's runtime-deps integration test. The manifest sweep
// is what stops that skip becoming a blind spot: declare `transport: stdio`
// anywhere in the tree and this file fails until the component is listed here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { checkStdioConformance, isJsonLineFrame, renderStdoutViolations, stdoutViolations } from "../src/stdio-conformance.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** A child written inline: `node -e <src>`, so the fixtures are readable next to the assertion. */
const nodeChild = (src: string, requests: string[] = []) =>
  checkStdioConformance({ command: process.execPath, args: ["-e", src], env: {}, requests, timeoutMs: 15_000 });

describe("the rule", () => {
  it("a frame is one complete JSON object on its own line", () => {
    expect(isJsonLineFrame('{"id":1,"ok":true}')).toBe(true);
    expect(isJsonLineFrame('{"jsonrpc":"2.0","id":1,"result":{}}')).toBe(true);
    expect(isJsonLineFrame("[1,2,3]")).toBe(true);
    expect(isJsonLineFrame("")).toBe(false);
    expect(isJsonLineFrame("42")).toBe(false); // a bare scalar is not a frame
    expect(isJsonLineFrame("starting eventkit helper")).toBe(false);
    expect(isJsonLineFrame('{"id":1,"ok":')).toBe(false); // a half-written frame reads exactly like noise
  });

  it("names every non-frame line, and lets the final newline alone", () => {
    expect(stdoutViolations('{"id":1}\n{"id":2}\n')).toEqual([]);
    expect(stdoutViolations("")).toEqual([]);
    const v = stdoutViolations('{"id":1}\nlistening on 7810\n\n{"id":2}\n');
    expect(v.map((x) => x.line)).toEqual([2, 3]);
    expect(v[0]!.why).toContain("logs go to stderr");
    expect(v[1]!.why).toContain("blank line");
    expect(renderStdoutViolations("afm-helper", v)).toContain('line 2: "listening on 7810"');
    expect(renderStdoutViolations("afm-helper", v)).toContain("Move them to stderr");
  });

  it("truncates a long line rather than pasting a log into the failure", () => {
    const [v] = stdoutViolations("x".repeat(500));
    expect(v!.text.length).toBeLessThan(220);
    expect(v!.text.endsWith("…")).toBe(true);
  });
});

describe("the harness", () => {
  it("a well-behaved child: one frame per request, nothing else on stdout, free to log on stderr", async () => {
    const r = await nodeChild(
      `
      process.stderr.write("afm-helper: model loaded\\n");
      let buf = "";
      process.stdin.on("data", (d) => {
        buf += d;
        for (const line of buf.split("\\n").slice(0, -1)) {
          process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, ok: true }) + "\\n");
        }
        buf = buf.slice(buf.lastIndexOf("\\n") + 1);
      });
      `,
      ['{"id":1,"text":"hello"}'],
    );
    expect(r.violations).toEqual([]);
    expect(r.frames).toEqual([{ id: 1, ok: true }]);
    expect(r.stderr).toContain("model loaded");
    expect(r.silent).toBe(false);
  });

  it("catches the failure it exists for: a banner printed before the first frame", async () => {
    const r = await nodeChild(`console.log("afm-helper starting"); process.stdout.write(JSON.stringify({ id: 0, ok: true }) + "\\n");`);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ line: 1, text: "afm-helper starting" });
    expect(r.frames).toEqual([{ id: 0, ok: true }]); // and the frame still parses, which is why this is easy to miss
  });

  it("an error frame is still a frame — a non-zero exit is not a violation", async () => {
    const r = await nodeChild(`process.stdout.write(JSON.stringify({ id: 0, ok: false, error: "unavailable" }) + "\\n"); process.exit(2);`);
    expect(r.exitCode).toBe(2);
    expect(r.violations).toEqual([]);
  });

  it("a stack trace goes to stderr; one on stdout is caught", async () => {
    const thrown = await nodeChild(`throw new Error("boom");`);
    expect(thrown.violations).toEqual([]);
    expect(thrown.stderr).toContain("boom");
    expect(thrown.silent).toBe(true);

    const leaked = await nodeChild(`try { throw new Error("boom"); } catch (e) { console.log(e.stack); }`);
    expect(leaked.violations.length).toBeGreaterThan(0);
  });

  it("a child that hangs is killed rather than hanging the suite", async () => {
    const r = await checkStdioConformance({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000);"], env: {}, timeoutMs: 300 });
    expect(r.exitCode).toBeNull();
    expect(r.violations).toEqual([]);
  });

  it("the environment is bare by default — nothing inherited from the runner", async () => {
    const r = await nodeChild(`process.stdout.write(JSON.stringify({ env: Object.keys(process.env).filter((k) => k.startsWith("METISTRY_")) }) + "\\n");`);
    expect(r.frames).toEqual([{ env: [] }]);
  });
});

// ---- the repo's own stdio components ------------------------------------------

/** Every component manifest in the tree, with the path it came from. */
function manifests(): { path: string; doc: Record<string, unknown> }[] {
  const out: { path: string; doc: Record<string, unknown> }[] = [];
  for (const root of ["packages", "apps", "collectors", "routines", "targets"]) {
    const dir = join(REPO, root);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "manifest.yaml");
      if (!existsSync(file)) continue;
      out.push({ path: `${root}/${entry.name}/manifest.yaml`, doc: (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

/** Components whose protocol is stdout and which have a conformance case below. */
const COVERED_STDIO = new Set<string>([]);

describe("every stdio component in the tree is covered", () => {
  it("declaring transport: stdio without a case here fails this test", () => {
    const uncovered = manifests()
      .filter((m) => m.doc.transport === "stdio")
      .map((m) => m.path)
      .filter((p) => !COVERED_STDIO.has(p));
    expect(uncovered, "add a checkStdioConformance case for each, then list it in COVERED_STDIO").toEqual([]);
  });

  it("the eventkit helper is a socket server, not a stdio one — its stdout is a log by design", () => {
    const swift = readFileSync(join(REPO, "packages/mcp-eventkit/helper/ek-helper.swift"), "utf8");
    expect(swift).toContain("sockPath"); // if this ever becomes a stdio child, the banner on line ~144 becomes a protocol violation
    expect(readFileSync(join(REPO, "packages/mcp-eventkit/src/helper.ts"), "utf8")).toContain('from "node:net"');
  });
});

// mcp-apple-fm's Swift helper: `emit()` is the only thing that may reach
// stdout. Built by packages/mcp-apple-fm/scripts/build-helper.sh, which needs
// a Mac — skipped elsewhere, like the CLI's runtime-deps integration test.
const AFM_HELPER = join(REPO, "packages/mcp-apple-fm/helper/afm-helper.app/Contents/MacOS/afm-helper");
const haveAfm = process.platform === "darwin" && existsSync(AFM_HELPER);

describe.skipIf(!haveAfm)("afm-helper (darwin, built)", () => {
  it("answers one request with frames and nothing else, on an empty environment", async () => {
    const r = await checkStdioConformance({ command: AFM_HELPER, env: {}, requests: ['{"id":1,"op":"check"}'], timeoutMs: 60_000 });
    expect(r.violations, renderStdoutViolations("afm-helper", r.violations)).toEqual([]);
    // It may refuse (no FoundationModels on this machine) — a refusal is a frame too.
    for (const f of r.frames) expect(f).toHaveProperty("ok");
  });

  it("garbage in does not become garbage out on the protocol stream", async () => {
    const r = await checkStdioConformance({ command: AFM_HELPER, env: {}, requests: ["not json at all", '{"no":"id"}'], timeoutMs: 60_000 });
    expect(r.violations, renderStdoutViolations("afm-helper", r.violations)).toEqual([]);
  });
});
