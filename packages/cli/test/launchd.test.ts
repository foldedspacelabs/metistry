// The plist templates as shipped in ops/launchd: every one parses, renders
// with no placeholder left (the exact sed the by-hand install used), refuses
// bad values, and has a systemd twin. Plus `$(which node)` resolution.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELPER_SERVICES, launchdCommands, loadPlistTemplates, loadSupervisedTemplates, nodeOnPath, parsePlistTemplate, readPlistTemplates, renderPlist, renderSystemdUnit } from "../src/launchd.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The supervisor plist's own two placeholders — `up` computes them (packages/cli/src/supervisor.ts). */
const SUPERVISOR_EXTRA = { SUPERVISOR_BIN: "/i/state/bin/Metistry", SUPERVISOR_CONFIG: "/i/state/supervisor.json" };
/** The assistant job's four config-file sandbox parameters (sandbox.ts `engineConfigParams`). */
const CONFIG_EXTRA = { CONFIG_IDENTITY: "/i/.metistry/identity.yaml", CONFIG_ASSISTANT_PROMPT: "/i/.metistry/assistant-prompt.md", CONFIG_RULES: "/i/.metistry/rules.yaml", CONFIG_COMPUTE: "/i/.metistry/compute.yaml", CONFIG_SECRETS: "/i/.metistry/secrets.yaml" };
/** The reconciler job's own profile parameters (sandbox.ts `reconcilerSandboxParams`) plus the egress door both confined children name. */
const RECONCILER_EXTRA = {
  SANDBOX_PROFILE: "/srv/metistry/ops/sandbox/reconciler.sb",
  INSTANCE_DIR: "/i",
  GIT_PREFIX: "/Library/Developer/CommandLineTools/usr",
  GIT_CONFIG_GLOBAL: "/Users/x/.gitconfig",
  ASKPASS_BIN: "/i/.metistry/state/bin/git-askpass",
  RECONCILER_TCP: "localhost:7812",
  EMBED_TCP: "localhost:11434",
};
const EGRESS_EXTRA = { PROXY_TCP: "localhost:7814" };

describe("launchd templates", () => {
  it("every shipped plist parses: a label, ProgramArguments, and the checkout-relative code it runs", async () => {
    const templates = await readPlistTemplates(repoRoot);
    expect(templates.length).toBeGreaterThanOrEqual(5);
    for (const t of templates) {
      // the supervisor's label IS the prefix — it is the install, not one of its services
      expect(t.label, t.file).toMatch(/^com\.foldedspacelabs\.metistry(\.[a-z-]+)?$/);
      expect(t.file).toBe(`${t.label}.plist`);
      expect(t.programArguments.length).toBeGreaterThan(0);
      // the db job execs the Postgres toolchain, not this repo's code
      if (t.service !== "db") expect(t.repoPaths.length, t.file).toBeGreaterThan(0);
      for (const p of t.repoPaths) expect(p, t.file).not.toMatch(/^\.env/);
    }
    const byLabel = Object.fromEntries(templates.map((t) => [t.label, t]));
    expect(byLabel["com.foldedspacelabs.metistry.watchdog"]!.repoPaths).toEqual(["apps/watchdog/dist/main.js"]);
    expect(byLabel["com.foldedspacelabs.metistry.reconciler"]!.repoPaths).toEqual(["apps/reconciler/dist/main.js"]);
    // the EventKit helper's agent is `calendar` now — the label is what
    // System Settings shows, and it is not part of a TCC requirement
    expect(byLabel["com.foldedspacelabs.metistry.calendar"]!.repoPaths).toEqual(["packages/mcp-eventkit/helper/ek-helper.app/Contents/MacOS/ek-helper"]);
    expect(byLabel["com.foldedspacelabs.metistry.calendar"]!.environment).toEqual({ METISTRY_EK_SOCKET: "/tmp/metistry-eventkit.sock" });
    expect(byLabel["com.foldedspacelabs.metistry.watchdog"]!.workingDirectory).toBe("__REPO__");
    // the supervisor: one agent, named for the install, running the watchdog's
    // entry point against a config `up` writes
    const sup = byLabel["com.foldedspacelabs.metistry"]!;
    expect(sup.service).toBe("supervisor");
    expect(sup.repoPaths).toEqual(["apps/watchdog/dist/main.js"]);
    expect(sup.standardOutPath).toBe("/tmp/metistry-supervisor.log");
  });

  it("renders every shipped template with __REPO__, __NODE__ and __ENV_FILE__ replaced and nothing left behind", async () => {
    for (const t of await loadPlistTemplates(repoRoot)) {
      const out = renderPlist(t.template, {
        repo: "/srv/metistry",
        node: "/usr/local/bin/node",
        envFile: "/i/state/.env",
        extra: { ...SUPERVISOR_EXTRA, ...RECONCILER_EXTRA, ...EGRESS_EXTRA, NODE_PREFIX: "/usr/local", PRODUCT_DIR: "/srv/metistry", STATE_DIR: "/s", TMP_DIR: "/tmp", CONSOLE_TCP: "localhost:8080", DB_TCP: "localhost:5432", ...CONFIG_EXTRA, PG_BIN: "/pg/bin", PG_DATA: "/d" },
      });
      expect(out, t.file).not.toContain("__");
      expect(out).toContain("/srv/metistry");
      // the environment comes from the INSTANCE, never from the checkout —
      // and every interpolated path is single-quoted, because the default
      // product and instance locations are under `~/Library/Application
      // Support/…` and an unquoted space splits the sh -c command
      if (t.template.includes("__ENV_FILE__")) expect(out, t.file).toContain("set -a; . '/i/state/.env'; set +a;");
      // the reconciler's `exec` is `sandbox-exec`, which then runs node —
      // the sole committer is confined (ops/sandbox/reconciler.sb)
      if (t.template.includes("__NODE__")) {
        expect(out, t.file).toContain(t.service === "reconciler" ? "exec '/usr/bin/sandbox-exec' -f '/srv/metistry/ops/sandbox/reconciler.sb'" : "exec '/usr/local/bin/node' '/srv/metistry/");
        if (t.service === "reconciler") expect(out, t.file).toContain("'/usr/local/bin/node' '/srv/metistry/apps/reconciler/dist/main.js'");
      }
      expect(out).toContain(`<string>${t.label}</string>`);
      expect(out.split("\n").length).toBe(t.template.split("\n").length); // a substitution, nothing else
    }
  });

  it("survives a space in the install path — which the Mac app's default location has", async () => {
    // ~/Library/Application Support/Metistry/{product,trial-instance}: the
    // default product dir and a default instance dir BOTH sit under a
    // directory with a space in its name. Unquoted, the sh -c jobs died with
    // `/bin/sh: /Users/…/Library/Application: No such file or directory`
    // (2026-09-10 launchd trial).
    const repo = "/Users/x/Library/Application Support/Metistry/product/current";
    const envFile = "/Users/x/Library/Application Support/Metistry/inst/state/.env";
    const node = "/Users/x/Library/Application Support/Metistry/product/runtime/node/bin/node";
    for (const t of await readPlistTemplates(repoRoot)) {
      const out = renderPlist(t.template, {
        repo,
        node,
        envFile,
        env: { A: "b" },
        extra: { PG_BIN: "/pg/bin", PG_DATA: "/d", NODE_PREFIX: "/n", PRODUCT_DIR: repo, STATE_DIR: "/s", TMP_DIR: "/tmp", CONSOLE_TCP: "localhost:8460", DB_TCP: "localhost:8461", ...CONFIG_EXTRA, ...SUPERVISOR_EXTRA, ...RECONCILER_EXTRA, ...EGRESS_EXTRA, SANDBOX_PROFILE: `${repo}/ops/sandbox/reconciler.sb` },
      });
      const shell = /<string>set -a;[^<]*<\/string>/.exec(out)?.[0];
      if (!shell) continue;
      // every path the shell sees is a single quoted word
      expect(shell, t.file).toContain(`. '${envFile}'`);
      expect(shell, t.file).toContain(t.service === "reconciler" ? `exec '/usr/bin/sandbox-exec' -f '${repo}/ops/sandbox/reconciler.sb'` : `exec '${node}' '${repo}/`);
      // and every -D the confined job carries is a quoted word too, so a
      // parameter whose path has a space in it does not split the command
      if (t.service === "reconciler") expect(shell, t.file).toContain(`-D 'PRODUCT_DIR=${repo}'`);
      // Every occurrence of the space-bearing path is INSIDE a single-quoted
      // word. Proven by deleting the quoted words and looking at what is
      // left, which is stronger than the old "preceded by a quote" lookbehind
      // — the confined reconciler's arguments are `-D 'KEY=<path>'`, where
      // the path is quoted but not adjacent to the quote.
      const unquoted = shell.replace(/'[^']*'/g, "''");
      expect(unquoted, t.file).not.toContain("/Users/x/Library/Application Support");
    }
  });

  // T8-2b: the live-capture recorder and its bridge. Rendered as text only —
  // no plist is loaded, nothing is signed, no permission is asked.
  it("the recorder is the signed lc-helper as the job's ONE program argument, and the bridge is an ordinary node job", async () => {
    const byLabel = Object.fromEntries((await readPlistTemplates(repoRoot)).map((t) => [t.label, t]));
    const recorder = byLabel["com.foldedspacelabs.metistry.recorder"]!;
    expect(recorder.service).toBe("recorder");
    // nothing — sh, node — in front of it: a TCC grant attaches to the job's root binary (PoC-1)
    expect(recorder.programArguments).toEqual(["__REPO__/packages/mcp-live-capture/helper/lc-helper.app/Contents/MacOS/lc-helper"]);
    expect(recorder.repoPaths).toEqual(["packages/mcp-live-capture/helper/lc-helper.app/Contents/MacOS/lc-helper"]);
    // the socket the bridge dials; the capture directory is the instance's, added by `up`
    expect(recorder.environment).toEqual({ METISTRY_LC_SOCKET: "/tmp/metistry-live-capture.sock" });
    expect(recorder.standardOutPath).toBe("/tmp/metistry-recorder.log");
    expect(recorder.template).toContain("<key>KeepAlive</key><true/>"); // a crash restarts it, and the restart recovers the session
    const bridge = byLabel["com.foldedspacelabs.metistry.live-capture"]!;
    expect(bridge.repoPaths).toEqual(["packages/mcp-live-capture/dist/main.js"]);
    expect(bridge.programArguments.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    const unit = renderSystemdUnit(recorder, { repo: "/srv/metistry", node: "/usr/bin/node", envFile: "/i/state/.env" });
    expect(unit).toContain("ExecStart=/srv/metistry/packages/mcp-live-capture/helper/lc-helper.app/Contents/MacOS/lc-helper");
    expect(HELPER_SERVICES).toContain("recorder");
  });

  it("live capture is opt-in under EVERY shape: no recorder and no bridge until METISTRY_LIVE_CAPTURE_URL is set", async () => {
    const services = async (shape: "compose" | "launchd", env: NodeJS.ProcessEnv) => (await loadPlistTemplates(repoRoot, shape, undefined, env)).map((t) => t.service);
    const on = { METISTRY_LIVE_CAPTURE_URL: "http://127.0.0.1:7815" };
    expect(await services("compose", {})).not.toContain("recorder");
    expect(await services("compose", {})).not.toContain("live-capture");
    expect(await services("compose", on)).toEqual(expect.arrayContaining(["recorder", "live-capture"]));
    // launchd: the recorder is an agent, the bridge a supervisor child
    expect(await services("launchd", {})).not.toContain("recorder");
    expect(await services("launchd", on)).toContain("recorder");
    expect(await services("launchd", on)).not.toContain("live-capture");
    expect((await loadSupervisedTemplates(repoRoot, undefined, {})).map((t) => t.service)).not.toContain("live-capture");
    expect((await loadSupervisedTemplates(repoRoot, undefined, on)).map((t) => t.service)).toContain("live-capture");
    // the older bridges' compose behaviour is unchanged
    expect(await services("compose", {})).toContain("calendar");
  });

  it("refuses values that would leave or introduce placeholders, and templates with unknown ones", () => {
    expect(() => renderPlist("<string>__REPO__</string>", { repo: "", node: "/n", envFile: "/e" })).toThrow(/empty __REPO__/);
    expect(() => renderPlist("<string>__REPO__</string>", { repo: "/x/__y__", node: "/n", envFile: "/e" })).toThrow(/contains "__"/);
    expect(() => renderPlist("<string>__ENV_FILE__</string>", { repo: "/x", node: "/n", envFile: "" })).toThrow(/empty __ENV_FILE__/);
    expect(() => renderPlist("<string>__REPO__/__HOME__</string>", { repo: "/x", node: "/n", envFile: "/e" })).toThrow(/unrendered placeholder __HOME__/);
    // a value carrying a quote would escape the sh -c wrapping the four
    // dotenv-sourcing jobs rely on: refused, never escaped
    expect(() => renderPlist("<string>__REPO__</string>", { repo: "/Users/o'brien/m", node: "/n", envFile: "/e" })).toThrow(/single quote/);
  });

  it("parsePlistTemplate unescapes XML entities and tolerates a plist with no ProgramArguments", () => {
    const t = parsePlistTemplate("x.plist", "<plist><dict><key>Label</key><string>l</string><key>ProgramArguments</key><array><string>a &amp;&lt;b&gt;</string></array></dict></plist>");
    expect(t.programArguments).toEqual(["a &<b>"]);
    expect(t.repoPaths).toEqual([]);
    const bare = parsePlistTemplate("bare.plist", "<plist><dict></dict></plist>");
    expect(bare.label).toBe("bare");
    expect(bare.programArguments).toEqual([]);
  });

  it("launchdCommands: bootout (tolerated), WAIT for it to be gone, bootstrap, kickstart -k — argument arrays, in that order", () => {
    // the wait is load-bearing: bootout returns before launchd has finished,
    // and bootstrapping the same label in that window fails with
    // `Bootstrap failed: 5: Input/output error`
    expect(launchdCommands("com.x.y", "/h/Library/LaunchAgents/com.x.y.plist", 501)).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/com.x.y"], tolerateFailure: true },
      { cmd: "launchctl", args: ["print", "gui/501/com.x.y"], awaitGone: true },
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
    // systemd parses quoted arguments; EnvironmentFile= does not, so that one
    // line carries the path bare (renderSystemdUnit)
    expect(unit).toContain("ExecStart='/usr/bin/node' '/srv/metistry/apps/watchdog/dist/main.js'");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("/bin/sh");
    expect(unit).not.toContain("__");
    const helper = templates.find((t) => t.label.endsWith(".calendar"))!;
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
