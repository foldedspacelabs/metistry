// install.mjs puts one entry in a directory full of other people's plugins, so
// the tests that matter are: it creates the link, a second run changes nothing,
// it repoints a link left by a checkout that has moved, it refuses to touch a
// file it did not create, and --remove takes back exactly one thing.
//
// The shape asserted here is OpenCode's own, checked against
// opencode.ai/docs/plugins and a running OpenCode 1.18.30 (2026-09-16):
// `~/.config/opencode/plugins/` (XDG_CONFIG_HOME wins when set), loaded by
// extension — `.js` and `.ts` are imported, `.mjs` is not.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_FILENAME, PLUGIN_MARKER, configDir, installPlugin, isOurs, pluginDir, pluginModule } from "../install.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const INSTALL = join(ROOT, "install.mjs");

function home(): string {
  return mkdtempSync(join(tmpdir(), "metistry-opencode-home-"));
}

describe("where OpenCode looks", () => {
  it("is ~/.config/opencode/plugins, and $XDG_CONFIG_HOME when that is set", () => {
    expect(configDir("/h", {})).toBe("/h/.config/opencode");
    expect(pluginDir("/h", {})).toBe("/h/.config/opencode/plugins");
    expect(pluginDir("/h", { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode/plugins");
  });

  it("links the checkout's plugin.js — the extension OpenCode's loader takes", () => {
    expect(PLUGIN_FILENAME).toBe("metistry.js");
    expect(pluginModule()).toBe(join(ROOT, "plugin.js"));
    expect(pluginModule().endsWith(PLUGIN_MARKER)).toBe(true);
    expect(existsSync(pluginModule())).toBe(true);
  });
});

describe("install", () => {
  it("creates the directory and the link", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    const r = installPlugin({ dir });
    expect(r.state).toBe("linked");
    expect(lstatSync(r.file).isSymbolicLink()).toBe(true);
    expect(readlinkSync(r.file)).toBe(pluginModule());
  });

  it("is idempotent — a second run does nothing", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    expect(installPlugin({ dir }).state).toBe("linked");
    expect(installPlugin({ dir }).state).toBe("unchanged");
  });

  it("repoints a link left behind by a checkout that has since moved", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    mkdirSync(dir, { recursive: true });
    const stale = `/old/place/${PLUGIN_MARKER}`;
    symlinkSync(stale, join(dir, PLUGIN_FILENAME));
    expect(isOurs(join(dir, PLUGIN_FILENAME))).toBe(true);
    const r = installPlugin({ dir });
    expect(r.state).toBe("linked");
    expect(readlinkSync(r.file)).toBe(pluginModule());
  });

  it("leaves every other plugin in the directory alone", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "someone-elses.js"), "export const Other = async () => ({})\n");
    installPlugin({ dir });
    expect(existsSync(join(dir, "someone-elses.js"))).toBe(true);
    installPlugin({ dir, remove: true });
    expect(existsSync(join(dir, "someone-elses.js"))).toBe(true);
    expect(existsSync(join(dir, PLUGIN_FILENAME))).toBe(false);
  });

  it("refuses rather than clobbers a real file sitting at its name", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PLUGIN_FILENAME), "// someone wrote their own\n");
    expect(() => installPlugin({ dir })).toThrow(/already exists and was not put there by this installer/);
    expect(() => installPlugin({ dir, remove: true })).toThrow(/already exists/);
  });

  it("--remove on a directory that never had it is not an error", () => {
    const dir = join(home(), ".config", "opencode", "plugins");
    expect(installPlugin({ dir, remove: true }).state).toBe("unchanged");
  });
});

describe("the seam `metistry connect opencode` can call", () => {
  function run(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [INSTALL, ...args], { env: { PATH: process.env.PATH } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code, stdout }));
    });
  }

  it("--json --home <dir> reports the file, the state and what it points at", async () => {
    const dir = home();
    const out = await run(["--json", "--home", dir]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      file: join(dir, ".config", "opencode", "plugins", PLUGIN_FILENAME),
      state: "linked",
      target: pluginModule(),
      removed: false,
      event: "session.idle",
      enabled_by: "METISTRY_CAPTURE_ON_STOP=1",
    });
    expect((await run(["--json", "--home", dir])).stdout).toContain(`"state": "unchanged"`);
    expect((await run(["--json", "--remove", "--home", dir])).stdout).toContain(`"state": "removed"`);
  });
});
