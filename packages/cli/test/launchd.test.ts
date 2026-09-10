// The plist templates as shipped in ops/launchd: every one parses, renders
// with no placeholder left (the exact sed the by-hand install used), refuses
// bad values, and has a systemd twin. Plus `$(which node)` resolution.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { launchdCommands, loadPlistTemplates, nodeOnPath, parsePlistTemplate, renderPlist, renderSystemdUnit } from "../src/launchd.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("launchd templates", () => {
  it("every shipped plist parses: a label, ProgramArguments, and the checkout-relative code it runs", async () => {
    const templates = await loadPlistTemplates(repoRoot);
    expect(templates.length).toBeGreaterThanOrEqual(5);
    for (const t of templates) {
      expect(t.label, t.file).toMatch(/^com\.foldedspacelabs\.metistry\.[a-z-]+$/);
      expect(t.file).toBe(`${t.label}.plist`);
      expect(t.programArguments.length).toBeGreaterThan(0);
      expect(t.repoPaths.length, t.file).toBeGreaterThan(0);
      for (const p of t.repoPaths) expect(p, t.file).not.toMatch(/^\.env/);
    }
    const byLabel = Object.fromEntries(templates.map((t) => [t.label, t]));
    expect(byLabel["com.foldedspacelabs.metistry.watchdog"]!.repoPaths).toEqual(["apps/watchdog/dist/main.js"]);
    expect(byLabel["com.foldedspacelabs.metistry.reconciler"]!.repoPaths).toEqual(["apps/reconciler/dist/main.js"]);
    expect(byLabel["com.foldedspacelabs.metistry.eventkit-helper"]!.repoPaths).toEqual(["packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper"]);
    expect(byLabel["com.foldedspacelabs.metistry.eventkit-helper"]!.environment).toEqual({ METISTRY_EK_SOCKET: "/tmp/metistry-eventkit.sock" });
    expect(byLabel["com.foldedspacelabs.metistry.watchdog"]!.workingDirectory).toBe("__REPO__");
  });

  it("renders every shipped template with __REPO__, __NODE__ and __ENV_FILE__ replaced and nothing left behind", async () => {
    for (const t of await loadPlistTemplates(repoRoot)) {
      const out = renderPlist(t.template, { repo: "/srv/metistry", node: "/usr/local/bin/node", envFile: "/i/state/.env" });
      expect(out, t.file).not.toContain("__");
      expect(out).toContain("/srv/metistry");
      // the environment comes from the INSTANCE, never from the checkout
      if (t.template.includes("__ENV_FILE__")) expect(out, t.file).toContain("set -a; . /i/state/.env; set +a;");
      if (t.template.includes("__NODE__")) expect(out).toContain("exec /usr/local/bin/node /srv/metistry/");
      expect(out).toContain(`<string>${t.label}</string>`);
      expect(out.split("\n").length).toBe(t.template.split("\n").length); // a substitution, nothing else
    }
  });

  it("refuses values that would leave or introduce placeholders, and templates with unknown ones", () => {
    expect(() => renderPlist("<string>__REPO__</string>", { repo: "", node: "/n", envFile: "/e" })).toThrow(/empty __REPO__/);
    expect(() => renderPlist("<string>__REPO__</string>", { repo: "/x/__y__", node: "/n", envFile: "/e" })).toThrow(/contains "__"/);
    expect(() => renderPlist("<string>__ENV_FILE__</string>", { repo: "/x", node: "/n", envFile: "" })).toThrow(/empty __ENV_FILE__/);
    expect(() => renderPlist("<string>__REPO__/__HOME__</string>", { repo: "/x", node: "/n", envFile: "/e" })).toThrow(/unrendered placeholder __HOME__/);
  });

  it("parsePlistTemplate unescapes XML entities and tolerates a plist with no ProgramArguments", () => {
    const t = parsePlistTemplate("x.plist", "<plist><dict><key>Label</key><string>l</string><key>ProgramArguments</key><array><string>a &amp;&lt;b&gt;</string></array></dict></plist>");
    expect(t.programArguments).toEqual(["a &<b>"]);
    expect(t.repoPaths).toEqual([]);
    const bare = parsePlistTemplate("bare.plist", "<plist><dict></dict></plist>");
    expect(bare.label).toBe("bare");
    expect(bare.programArguments).toEqual([]);
  });

  it("launchdCommands: bootout (tolerated), bootstrap, kickstart -k — argument arrays, in that order", () => {
    expect(launchdCommands("com.x.y", "/h/Library/LaunchAgents/com.x.y.plist", 501)).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/com.x.y"], tolerateFailure: true },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", "/h/Library/LaunchAgents/com.x.y.plist"] },
      { cmd: "launchctl", args: ["kickstart", "-k", "gui/501/com.x.y"] },
    ]);
  });

  it("renderSystemdUnit says the same thing as the plist without a shell", async () => {
    const templates = await loadPlistTemplates(repoRoot);
    const wd = templates.find((t) => t.label.endsWith(".watchdog"))!;
    const unit = renderSystemdUnit(wd, { repo: "/srv/metistry", node: "/usr/bin/node", envFile: "/i/state/.env" });
    expect(unit).toContain("[Service]");
    expect(unit).toContain("EnvironmentFile=/i/state/.env");
    expect(unit).toContain("WorkingDirectory=/srv/metistry");
    expect(unit).toContain("ExecStart=/usr/bin/node /srv/metistry/apps/watchdog/dist/main.js");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("/bin/sh");
    expect(unit).not.toContain("__");
    const helper = templates.find((t) => t.label.endsWith(".eventkit-helper"))!;
    const hu = renderSystemdUnit(helper, { repo: "/srv/metistry", node: "/usr/bin/node", envFile: "/i/state/.env" });
    expect(hu).toContain("ExecStart=/srv/metistry/packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper");
    expect(hu).toContain("Environment=METISTRY_EK_SOCKET=/tmp/metistry-eventkit.sock");
    expect(hu).not.toContain("EnvironmentFile");
  });

  it("nodeOnPath is `$(which node)`: the first node on PATH, symlink unresolved; execPath as the fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "metistry-path-"));
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    await writeFile(join(root, "b", "node"), "");
    expect(nodeOnPath({ PATH: `${join(root, "a")}:${join(root, "b")}` }, "/fallback/node")).toBe(join(root, "b", "node"));
    expect(nodeOnPath({ PATH: join(root, "a") }, "/fallback/node")).toBe("/fallback/node");
    expect(nodeOnPath({}, "/fallback/node")).toBe("/fallback/node");
  });
});
