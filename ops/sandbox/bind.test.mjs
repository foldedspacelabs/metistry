// Can a confined process actually LISTEN where its profile says it may?
//
// 0.14.2 shipped a reconciler that could not: reconciler.sb granted
// `network-bind` on its bridge port, and on macOS 26 (Darwin 25) `listen()`
// is refused with EPERM unless `network-inbound` names the same address. The
// reconciler crash-looped on `listen EPERM 127.0.0.1:7812` the first time an
// install found a real git and confined it. Every other test of the profile
// connected OUT; none listened.
//
// This one reads each profile, finds every parameterised `network-bind`
// rule, and for each: fills every `(param …)` the profile declares with a
// harmless scratch value, puts a FREE HIGH port (the kernel's pick, never a
// port the owner's instance uses) in the bind parameter, and runs
//   sandbox-exec -f <profile> -D … node -e '<listen on that port>'
// It fails on EPERM. It also listens on a second free port the profile does
// NOT name, and requires that to be refused — so the fix cannot be "allow
// every inbound".
//
// Zero dependencies (node:test), so the macOS CI job runs it with nothing
// installed: `node --test ops/sandbox/*.test.mjs`. Skipped (not passed) off
// macOS, where there is no sandbox-exec.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const HERE = dirname(fileURLToPath(import.meta.url));
const skip = process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) ? "sandbox-exec is macOS-only" : false;
// Darwin 25 = macOS 26: where a bind rule alone stopped being enough to listen
const DARWIN_MAJOR = Number(release().split(".")[0]);

/** The parameter names a profile declares, in order of first use. */
export function declaredParams(sbpl) {
  const code = sbpl.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n");
  return [...new Set([...code.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((m) => m[1]))];
}

/** The parameters a profile binds (`(allow network-bind (local ip (param "X")))`). */
export function boundParams(sbpl) {
  const code = sbpl.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n");
  return [...code.matchAll(/\(allow network-bind \(local ip \(param "([A-Z0-9_]+)"\)\)\)/g)].map((m) => m[1]);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** node's self-contained root: the brew prefix for a Homebrew node, else two levels up (packages/cli/src/sandbox.ts `nodePrefixFor`). */
function nodePrefix(nodeBin) {
  const real = realpathSync(nodeBin);
  const cellar = real.indexOf("/Cellar/");
  return cellar !== -1 ? real.slice(0, cellar) : dirname(dirname(real));
}

const PROBE = `
const s = require("node:net").createServer();
s.on("error", (e) => { console.log("denied:" + e.code); process.exit(0); });
s.listen(Number(process.argv[1]), "127.0.0.1", () => { console.log("allowed"); s.close(); });
`;

const root = skip ? "" : realpathSync(mkdtempSync(join(tmpdir(), "metistry-sbbind-")));
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Every declared parameter, filled with a scratch value of the right shape. */
async function fill(names, overrides) {
  const out = {};
  for (const name of names) {
    if (overrides[name]) out[name] = overrides[name];
    else if (name === "NODE_BIN") out[name] = realpathSync(process.execPath);
    else if (name === "NODE_PREFIX") out[name] = nodePrefix(process.execPath);
    else if (name.endsWith("_TCP")) out[name] = `localhost:${await freePort()}`;
    else if (name.endsWith("_DIR") || name.endsWith("_PREFIX")) {
      out[name] = join(root, name.toLowerCase());
      mkdirSync(out[name], { recursive: true });
    } else {
      // a file granted by literal (CONFIG_*, GIT_CONFIG_GLOBAL, ASKPASS_BIN)
      out[name] = join(root, "files", name.toLowerCase());
      mkdirSync(dirname(out[name]), { recursive: true });
      writeFileSync(out[name], "");
    }
  }
  return out;
}

function listenConfined(profile, params, port) {
  const argv = ["-f", profile, ...Object.entries(params).flatMap(([k, v]) => ["-D", `${k}=${v}`]), realpathSync(process.execPath), "-e", PROBE, String(port)];
  // the working directory must be inside a granted subpath (README "Writing a rule" 3)
  const cwd = params.PRODUCT_DIR ?? root;
  const r = spawnSync(SANDBOX_EXEC, argv, { cwd, encoding: "utf8", timeout: 30_000 });
  const out = (r.stdout ?? "").trim();
  if (!out) throw new Error(`the confined probe printed nothing (status ${r.status}): ${r.stderr}`);
  return out;
}

const profiles = readdirSync(HERE).filter((f) => f.endsWith(".sb") && f !== "unconfined.sb").sort();

describe("ops/sandbox profiles: a confined process can listen exactly where its profile says", { skip }, () => {
  it("found profiles to check, and at least one binds a parameterised port", () => {
    assert.ok(profiles.includes("reconciler.sb"), `profiles: ${profiles.join(", ")}`);
    assert.ok(boundParams(readFileSync(join(HERE, "reconciler.sb"), "utf8")).includes("RECONCILER_TCP"));
  });

  for (const file of profiles) {
    const sbpl = readFileSync(join(HERE, file), "utf8");
    for (const param of boundParams(sbpl)) {
      it(`${file}: every bind rule has its network-inbound twin (${param})`, () => {
        // static: the rule macOS 26 needs for listen() to succeed
        assert.match(sbpl, new RegExp(`\\(allow network-inbound \\(local ip \\(param "${param}"\\)\\)\\)`), `${file} binds ${param} but has no (allow network-inbound (local ip (param "${param}"))) — listen() is EPERM on macOS 26`);
      });

      it(`${file}: listens on ${param} (a free high port), and nowhere else`, async () => {
        const own = await freePort();
        const other = await freePort();
        const params = await fill(declaredParams(sbpl), { [param]: `localhost:${own}` });
        const profile = join(HERE, file);
        assert.equal(listenConfined(profile, params, own), "allowed", `${file}: listen on its own ${param} port ${own} was refused — the reconciler would crash-loop`);
        assert.equal(listenConfined(profile, params, other), "denied:EPERM", `${file}: listen on port ${other}, which it does not name, must be refused`);
      });
    }
  }

  it("assistant.sb: the engine opens no server — listen is refused on macOS 26", { skip: DARWIN_MAJOR < 25 ? "a bind rule alone allowed listen before macOS 26" : false }, async () => {
    const sbpl = readFileSync(join(HERE, "assistant.sb"), "utf8");
    assert.doesNotMatch(sbpl.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n"), /network-inbound/);
    const params = await fill(declaredParams(sbpl), {});
    assert.equal(listenConfined(join(HERE, "assistant.sb"), params, await freePort()), "denied:EPERM");
  });
});
