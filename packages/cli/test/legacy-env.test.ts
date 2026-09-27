// `metistry secrets retire-legacy-env` — the product checkout's `.env`,
// still read after the instance's own: what only it has is listed by name,
// copied (appended, never over a line the instance has) and — with --yes, and
// only when nothing still sources it and it is not how the CLI finds the
// instance — deleted.
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobFilesFor, legacyEnvReport, retireLegacyEnv } from "../src/legacy-env.js";
import { main } from "../src/main.js";

const SECRET = "only-in-the-old-file-value";

async function install(opts: { legacy: string; own?: string }) {
  const product = await mkdtemp(join(tmpdir(), "metistry-legacy-p-"));
  const inst = await mkdtemp(join(tmpdir(), "mi-"));
  const home = await mkdtemp(join(tmpdir(), "metistry-legacy-h-"));
  await writeFile(join(product, ".env"), opts.legacy, { mode: 0o600 });
  const target = join(inst, ".metistry", "state", ".env");
  if (opts.own !== undefined) {
    await mkdir(join(inst, ".metistry", "state"), { recursive: true });
    await writeFile(target, opts.own, { mode: 0o600 });
  }
  return { product, inst, home, legacy: join(product, ".env"), target };
}

const LEGACY = [
  `METISTRY_INSTANCE_DIR=/somewhere`,
  `METISTRY_BRIDGE_TOKEN_APPLE_FM=${SECRET}`,
  `METISTRY_AFM_URL=http://127.0.0.1:7813`,
  `METISTRY_DB_PORT=5432`,
  `METISTRY_CONSOLE_PORT=8080`,
  "",
].join("\n");
const OWN = ["# the instance's own", "METISTRY_DB_PORT=55432", "METISTRY_CONSOLE_PORT=8080", ""].join("\n");

describe("what the old file still has", () => {
  it("sorts every name into only-there, shadowed and same; the pointer is never a candidate", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    const rep = await legacyEnvReport({ legacy: i.legacy, target: i.target, jobFiles: [] });
    expect(rep).toMatchObject({
      onlyLegacy: ["METISTRY_AFM_URL", "METISTRY_BRIDGE_TOKEN_APPLE_FM"],
      shadowed: ["METISTRY_DB_PORT"],
      same: ["METISTRY_CONSOLE_PORT"],
      pointer: true,
      sourcedBy: [],
    });
  });

  it("a job file that sources it is found — by the whole path, not a prefix of .env.example", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    await writeFile(join(i.inst, ".metistry", "state", "supervisor.json"), JSON.stringify({ children: [{ argv: ["/bin/sh", "-c", `set -a; . '${i.legacy}'; set +a; exec node x`] }] }));
    await mkdir(join(i.home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(join(i.home, "Library", "LaunchAgents", "com.foldedspacelabs.metistry.watchdog.plist"), `<string>. '${i.legacy}.example'</string>`);
    await writeFile(join(i.home, "Library", "LaunchAgents", "com.example.other.plist"), `<string>. '${i.legacy}'</string>`); // not ours: never read
    const files = await jobFilesFor({ instanceDir: i.inst, home: i.home });
    expect(files.map((f) => f.split("/").pop())).toEqual(["supervisor.json", "com.foldedspacelabs.metistry.watchdog.plist"]);
    const rep = await legacyEnvReport({ legacy: i.legacy, target: i.target, jobFiles: files });
    expect(rep?.sourcedBy).toEqual([join(i.inst, ".metistry", "state", "supervisor.json")]);
  });
});

describe("retiring it", () => {
  it("without --yes: names only, nothing written, nothing deleted", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    const lines: string[] = [];
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [], yes: false, pointerOnlyInLegacy: false, out: (l) => lines.push(l) });
    expect(r).toMatchObject({ copied: [], deleted: false });
    expect(readFileSync(i.target, "utf8")).toBe(OWN);
    expect(existsSync(i.legacy)).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("only in the old file — to copy: METISTRY_AFM_URL, METISTRY_BRIDGE_TOKEN_APPLE_FM");
    expect(text).toContain("rerun with --yes");
    expect(text).not.toContain(SECRET);
  });

  it("--yes appends what only it had — every existing byte kept, 0600 — and deletes it", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    const lines: string[] = [];
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [], yes: true, pointerOnlyInLegacy: false, out: (l) => lines.push(l) });
    expect(r).toMatchObject({ copied: ["METISTRY_AFM_URL", "METISTRY_BRIDGE_TOKEN_APPLE_FM"], deleted: true });
    const after = readFileSync(i.target, "utf8");
    expect(after.startsWith(OWN)).toBe(true);
    expect(after).toContain(`METISTRY_BRIDGE_TOKEN_APPLE_FM=${SECRET}\n`);
    expect(after).toContain("METISTRY_AFM_URL=http://127.0.0.1:7813\n");
    expect(after).not.toContain("METISTRY_INSTANCE_DIR");
    expect(after.match(/^METISTRY_DB_PORT=/gm)).toHaveLength(1); // the instance's value, alone
    expect(statSync(i.target).mode & 0o777).toBe(0o600);
    expect(existsSync(i.legacy)).toBe(false);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("an instance with no state/.env yet gets one, created 0600", async () => {
    const i = await install({ legacy: "METISTRY_DB_PASSWORD=pw\n" });
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [], yes: true, pointerOnlyInLegacy: false, out: () => {} });
    expect(r.deleted).toBe(true);
    expect(readFileSync(i.target, "utf8")).toContain("METISTRY_DB_PASSWORD=pw\n");
    expect(statSync(i.target).mode & 0o777).toBe(0o600);
  });

  it("**keeps the file while a job still sources it** — copies, but does not delete", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    const job = join(i.inst, ".metistry", "state", "supervisor.json");
    await writeFile(job, `". '${i.legacy}'"`);
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [job], yes: true, pointerOnlyInLegacy: false, out: () => {} });
    expect(r.copied).toHaveLength(2);
    expect(r.deleted).toBe(false);
    expect(r.kept).toContain("run `metistry up` first");
    expect(existsSync(i.legacy)).toBe(true);
  });

  it("**keeps the file while it is how this CLI finds the instance**", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [], yes: true, pointerOnlyInLegacy: true, out: () => {} });
    expect(r.deleted).toBe(false);
    expect(r.kept).toContain("found the instance only through METISTRY_INSTANCE_DIR");
    expect(existsSync(i.legacy)).toBe(true);
  });

  it("**keeps the file when a value cannot be written as a dotenv line**, naming it", async () => {
    const i = await install({ legacy: `METISTRY_WEIRD=it's got "both"\nMETISTRY_FINE=x\n`, own: OWN });
    const r = await retireLegacyEnv({ legacy: i.legacy, target: i.target, jobFiles: [], yes: true, pointerOnlyInLegacy: false, out: () => {} });
    expect(r).toMatchObject({ copied: ["METISTRY_FINE"], uncopyable: ["METISTRY_WEIRD"], deleted: false });
    expect(existsSync(i.legacy)).toBe(true);
  });
});

describe("through main(), as the owner runs it", () => {
  // main() loads both files into process.env, as the real CLI does; put it
  // back before the isolation guard (test/setup.ts) looks
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("METISTRY_")));
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("METISTRY_") && !(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  async function run(argv: string[], home: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), platform: "linux", home });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("the deprecation notice names the verb, and the verb retires the file on any platform (no Keychain involved)", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    delete process.env.METISTRY_INSTANCE_DIR;
    const preview = await run(["secrets", "retire-legacy-env", "--instance", i.inst, "--product-dir", i.product], i.home);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("only in the old file — to copy: METISTRY_AFM_URL, METISTRY_BRIDGE_TOKEN_APPLE_FM");
    expect(preview.err).toContain("`metistry secrets retire-legacy-env` lists what only it still has");
    delete process.env.METISTRY_INSTANCE_DIR;
    const done = await run(["secrets", "retire-legacy-env", "--yes", "--instance", i.inst, "--product-dir", i.product], i.home);
    expect(done.code).toBe(0);
    expect(existsSync(i.legacy)).toBe(false);
    expect(done.err).not.toContain("still being read as a fallback"); // not about a file this run deleted
    expect(`${done.out}${done.err}`).not.toContain(SECRET);
  });

  it("refuses to delete the file the CLI found the instance through, and exits 1", async () => {
    const i = await install({ legacy: LEGACY, own: OWN });
    await writeFile(i.legacy, LEGACY.replace("METISTRY_INSTANCE_DIR=/somewhere", `METISTRY_INSTANCE_DIR=${i.inst}`));
    delete process.env.METISTRY_INSTANCE_DIR;
    const r = await run(["secrets", "retire-legacy-env", "--yes", "--product-dir", i.product], i.home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("was NOT deleted");
    expect(existsSync(i.legacy)).toBe(true);
  });
});
