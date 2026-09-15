// install.mjs merges into a file every other tool also writes, so the tests
// that matter are: creates it when absent, preserves everything else, and a
// second run changes nothing. The schema asserted here is Cursor's own
// (cursor.com/docs/hooks: `~/.cursor/hooks.json`, `"version": 1`, and each hook
// name mapping to an ARRAY of `{ command, timeout? }`).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_EVENT, HOOK_MARKER, TIMEOUT_SECONDS, configFile, hookScript, installHook, isOurs, mergeHook } from "../install.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const INSTALL = join(ROOT, "install.mjs");

function home(): string {
  return mkdtempSync(join(tmpdir(), "metistry-cursor-home-"));
}

/** A fresh `~/.cursor/hooks.json` path, with the directory made and optional existing content. */
function seed(content?: string): string {
  const file = join(home(), ".cursor", "hooks.json");
  mkdirSync(join(file, ".."), { recursive: true });
  if (content !== undefined) writeFileSync(file, content);
  return file;
}

function read(file: string): { version?: number; hooks?: Record<string, unknown[]> } {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("the hook's own definition", () => {
  it("is Cursor's native shape: an absolute executable path in an array under sessionEnd", () => {
    expect(HOOK_EVENT).toBe("sessionEnd");
    expect(configFile("/h")).toBe("/h/.cursor/hooks.json");
    expect(hookScript()).toBe(join(ROOT.replace(/\/$/, ""), "hooks", "session-end.mjs"));
    expect(hookScript().endsWith(HOOK_MARKER)).toBe(true);
    expect(existsSync(hookScript())).toBe(true);
  });
});

describe("merge", () => {
  it("creates the file when absent", () => {
    const file = join(home(), ".cursor", "hooks.json");
    const r = installHook({ file });
    expect(r.state).toBe("written");
    expect(read(file)).toEqual({ version: 1, hooks: { sessionEnd: [{ command: hookScript(), timeout: TIMEOUT_SECONDS }] } });
  });

  it("is idempotent — a second run writes nothing", () => {
    const file = join(home(), ".cursor", "hooks.json");
    expect(installHook({ file }).state).toBe("written");
    const before = readFileSync(file, "utf8");
    expect(installHook({ file }).state).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(read(file).hooks!.sessionEnd).toHaveLength(1);
  });

  it("preserves other hooks, other sessionEnd entries and unknown top-level keys", () => {
    const file = seed(
      JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./hooks/format.sh" }], sessionEnd: [{ command: "./hooks/audit.sh", timeout: 30 }] }, somethingElse: true }),
    );
    installHook({ file });
    const doc = read(file);
    expect(doc).toMatchObject({ version: 1, somethingElse: true });
    expect(doc.hooks!.afterFileEdit).toEqual([{ command: "./hooks/format.sh" }]);
    expect(doc.hooks!.sessionEnd).toEqual([{ command: "./hooks/audit.sh", timeout: 30 }, { command: hookScript(), timeout: TIMEOUT_SECONDS }]);
  });

  it("replaces an entry left by a checkout that has since moved, in place", () => {
    const stale = `/old/place/plugins/cursor/hooks/session-end.mjs`;
    const doc = { version: 1, hooks: { sessionEnd: [{ command: stale, timeout: 10 }, { command: "./audit.sh" }] } };
    expect(isOurs({ command: stale })).toBe(true);
    const next = mergeHook(doc, "/new/place/plugins/cursor/hooks/session-end.mjs") as typeof doc;
    expect(next.hooks.sessionEnd).toEqual([{ command: "/new/place/plugins/cursor/hooks/session-end.mjs", timeout: 10 }, { command: "./audit.sh" }]);
  });

  it("--remove takes out only our entry, and drops the key when it was the only one", () => {
    const file = seed(JSON.stringify({ version: 1, hooks: { sessionEnd: [{ command: "./audit.sh" }] } }));
    installHook({ file });
    expect(read(file).hooks!.sessionEnd).toHaveLength(2);
    expect(installHook({ file, remove: true }).state).toBe("written");
    expect(read(file).hooks!.sessionEnd).toEqual([{ command: "./audit.sh" }]);

    const solo = seed();
    installHook({ file: solo });
    installHook({ file: solo, remove: true });
    expect(read(solo)).toEqual({ version: 1, hooks: {} });
  });

  it("leaves a future schema version alone", () => {
    expect((mergeHook({ version: 2, hooks: {} }, "/x/plugins/cursor/hooks/session-end.mjs") as { version: number }).version).toBe(2);
  });

  it("refuses rather than clobbers when the file is not something it can merge into", () => {
    const file = seed();
    for (const bad of ["[1,2]", `{"hooks": []}`, `{"hooks": {"sessionEnd": {}}}`]) {
      writeFileSync(file, bad, { flag: "w" });
      expect(() => installHook({ file })).toThrow(/refusing to replace it|does not hold a JSON object/);
      expect(readFileSync(file, "utf8")).toBe(bad);
    }
    writeFileSync(file, "not json at all", { flag: "w" });
    expect(() => installHook({ file })).toThrow(/is not JSON this installer can merge into/);
    expect(readFileSync(file, "utf8")).toBe("not json at all");
  });

  it("treats an empty file as an empty config", () => {
    const file = seed("  \n");
    expect(installHook({ file }).state).toBe("written");
    expect(read(file).hooks!.sessionEnd).toHaveLength(1);
  });
});

describe("the seam `metistry connect cursor` will call", () => {
  it("--json --home <dir> reports the file, the state and the command", async () => {
    const dir = home();
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [INSTALL, "--json", "--home", dir], { env: { PATH: process.env.PATH } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
    });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      file: join(dir, ".cursor", "hooks.json"),
      state: "written",
      command: hookScript(),
      entry: { command: hookScript(), timeout: TIMEOUT_SECONDS },
      event: "sessionEnd",
      enabled_by: "METISTRY_CAPTURE_ON_STOP=1",
      removed: false,
    });
    expect(read(join(dir, ".cursor", "hooks.json")).hooks!.sessionEnd).toHaveLength(1);
  });
});
