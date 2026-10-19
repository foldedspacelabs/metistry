// `.env` is derived (X-124; owner ruling 2026-10-04): `metistry up` writes
// `.metistry/state/.env` from `.metistry/*.yaml` and the login Keychain under
// a header carrying the hash of its body; doctor's `env` row reads the hash;
// a hand edit is named line by line and adopted before the file is written
// again. Everything here runs against a temp instance and a fake Keychain
// (fake-security.ts); nothing touches the real one, and no value is printed.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretService } from "@foldedspacelabs/metistry-core";
import { envFileRow } from "../src/doctor.js";
import { parseDotEnv } from "../src/env.js";
import { composeEnvBody, diffAgainstRecord, ENV_HASH_PREFIX, inspectEnvText, parseRenderRecord, PRE_RENDER_FILENAME, renderRecordPath, restampIfRendered, splitEnvHeader, stampEnv } from "../src/env-render.js";
import { ensureSecret, renderEnvFile, syncSecrets, type RenderEnvOptions } from "../src/secrets.js";
import { up } from "../src/up.js";
import { fakeKeychain } from "./fake-security.js";
import { checkout, fakeExec, okDoctor, put } from "./fixtures.js";

const INSTANCE_ID = "11111111-2222-4333-8444-555555555555";
const item = (name: string) => `${INSTANCE_ID}/metistry:${name}`;

/** A hand-written `.env` as an install from before X-124 has one: secrets beside configuration, a comment, a quoted value. */
const HAND_WRITTEN = `# my notes on this install
METISTRY_DB_HOST=127.0.0.1
METISTRY_DB_PASSWORD=pw-from-hand
METISTRY_ORIGIN=https://mac.example.ts.net
METISTRY_CONSOLE_PORT=8080
METISTRY_BRIDGE_TOKEN_EVENTKIT=ek-by-hand
METISTRY_WATCHDOG_INTERVAL_SEC=300
METISTRY_GIT_AUTHOR_NAME="Some One"
`;
const HAND_VALUES = ["pw-from-hand", "ek-by-hand"];

async function instance(): Promise<{ dir: string; envFile: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "metistry-env-render-"));
  const stateDir = join(dir, ".metistry", "state");
  await mkdir(stateDir, { recursive: true });
  return { dir, envFile: join(stateDir, ".env"), stateDir };
}

function renderOpts(kc: ReturnType<typeof fakeKeychain>, envFile: string, lines: string[], extra: Partial<RenderEnvOptions> = {}): RenderEnvOptions {
  return { envFile, exec: kc.exec, instanceId: INSTANCE_ID, platform: "darwin", env: {}, out: (l) => lines.push(l), ...extra };
}

const mode = async (p: string) => (await stat(p)).mode & 0o777;
const adds = (kc: ReturnType<typeof fakeKeychain>) => kc.calls.filter((c) => c.args[0] === "add-generic-password").length;

describe("the stamp (env-render.ts)", () => {
  it("stamps a body with a header and its sha256, verifies it, and tells a hand edit from a render", () => {
    const text = stampEnv("A=1\nB=2\n");
    expect(splitEnvHeader(text)).toMatchObject({ present: true, body: "A=1\nB=2\n" });
    expect(inspectEnvText(text).kind).toBe("rendered");
    expect(inspectEnvText(text.replace("B=2", "B=3"))).toMatchObject({ kind: "hand-edited" });
    // the stamp itself edited by hand is a hand edit too
    expect(inspectEnvText(text.replace(/sha256: [0-9a-f]{8}/, "sha256: 00000000")).kind).toBe("hand-edited");
    expect(inspectEnvText("A=1\n").kind).toBe("pre-render");
    expect(inspectEnvText(undefined).kind).toBe("absent");
    // stamping twice replaces the stamp rather than stacking two
    expect(stampEnv(text)).toBe(text);
    // a hash-shaped line in the BODY is a value, not a stamp
    const deep = stampEnv(`A=1\nB=2\nC=3\nD=4\nE=5\n${ENV_HASH_PREFIX}${"0".repeat(64)}\n`);
    expect(inspectEnvText(deep).kind).toBe("rendered");
  });

  it("restampIfRendered keeps a rendered file verifiable and leaves a pre-render file header-less", () => {
    const rendered = stampEnv("A=1\n");
    expect(inspectEnvText(restampIfRendered(rendered, `${rendered}B=2\n`)).kind).toBe("rendered");
    expect(restampIfRendered("A=1\n", "A=1\nB=2\n")).toBe("A=1\nB=2\n");
  });

  it("composes three sections in a fixed order and omits empty ones", () => {
    const titles = { derived: "d", keychain: "k", carried: "c" };
    expect(composeEnvBody({ derived: [], keychain: ["K=1"], carried: ["C=2"] }, titles)).toBe("\n# --- k ---\nK=1\n\n# --- c ---\nC=2\n");
    expect(composeEnvBody({ derived: [], keychain: [], carried: [] }, titles)).toBe("\n");
  });

  it("a record that is not a version-1 record is nothing", () => {
    expect(parseRenderRecord("not json")).toBeUndefined();
    expect(parseRenderRecord(JSON.stringify({ version: 2 }))).toBeUndefined();
    expect(parseRenderRecord(JSON.stringify({ version: 1, sha256: "x", lines: { A: "h" }, sections: { derived: ["A"] } }))).toEqual({ version: 1, sha256: "x", lines: { A: "h" }, sections: { derived: ["A"], keychain: [], carried: [] }, superseded: {} });
  });
});

describe("renderEnvFile", () => {
  const derived = { METISTRY_ORIGIN: { value: "http://127.0.0.1:8080", from: "deployment.yaml remote:" } };

  it("**two derivations from the same yaml and Keychain are byte-identical** — over its own output, and into a fresh instance", async () => {
    const kc = fakeKeychain();
    const a = await instance();
    await writeFile(a.envFile, HAND_WRITTEN);
    const lines: string[] = [];
    const first = await renderEnvFile(renderOpts(kc, a.envFile, lines, { derived }));
    const text1 = await readFile(a.envFile, "utf8");
    expect(inspectEnvText(text1)).toEqual({ kind: "rendered", sha256: first.sha256 });
    expect(await mode(a.envFile)).toBe(0o600);
    expect(await mode(renderRecordPath(a.stateDir))).toBe(0o600);

    // again, over what it just wrote: the same bytes, and not one Keychain write
    const writesBefore = adds(kc);
    const second = await renderEnvFile(renderOpts(kc, a.envFile, lines, { derived }));
    expect(await readFile(a.envFile, "utf8")).toBe(text1);
    expect(second.before).toEqual({ kind: "rendered", sha256: first.sha256 });
    expect(adds(kc)).toBe(writesBefore);
    expect(second.adopted).toEqual([]);
    expect(second.rotated).toEqual([]);

    // a second instance from the same hand-written file and the same Keychain: the same bytes
    const b = await instance();
    await writeFile(b.envFile, HAND_WRITTEN);
    await renderEnvFile(renderOpts(kc, b.envFile, lines, { derived }));
    expect(await readFile(b.envFile, "utf8")).toBe(text1);

    // sections in a fixed order, sorted within; the carried line keeps the right-hand side it had
    const body = splitEnvHeader(text1).body;
    expect(body).toBe(
      [
        "",
        "# --- derived from .metistry/*.yaml ---",
        "METISTRY_ORIGIN=http://127.0.0.1:8080",
        "",
        `# --- from the login Keychain (metistry:<VAR>, account ${INSTANCE_ID}) ---`,
        "METISTRY_BRIDGE_TOKEN_EVENTKIT=ek-by-hand",
        "METISTRY_DB_PASSWORD=pw-from-hand",
        "",
        "# --- carried from the previous .env: configuration nothing in .metistry/*.yaml decides yet (an edit here is kept, and named) ---",
        "METISTRY_CONSOLE_PORT=8080",
        "METISTRY_DB_HOST=127.0.0.1",
        'METISTRY_GIT_AUTHOR_NAME="Some One"',
        "METISTRY_WATCHDOG_INTERVAL_SEC=300",
        "",
      ].join("\n"),
    );
    // names only, never a value — in the report and in every argv
    for (const v of HAND_VALUES) {
      expect(lines.join("\n")).not.toContain(v);
      for (const c of kc.calls) for (const a of c.argv) expect(a).not.toContain(v);
    }
  });

  it("the first render of a hand-written file loses nothing: secrets adopted into the Keychain, configuration carried, the file kept beside, a superseded value named", async () => {
    const kc = fakeKeychain();
    const { envFile, stateDir, dir } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    const lines: string[] = [];
    const r = await renderEnvFile(renderOpts(kc, envFile, lines, { derived }));
    expect(r.before.kind).toBe("pre-render");
    // adopt, never mint over: the Keychain now holds what the running services were started with
    expect(r.adopted).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_DB_PASSWORD"]);
    expect(kc.store.get(item("METISTRY_DB_PASSWORD"))).toBe("pw-from-hand");
    expect(kc.store.get(item("METISTRY_BRIDGE_TOKEN_EVENTKIT"))).toBe("ek-by-hand");
    expect(r.minted).toEqual([]);
    expect(r.carried).toEqual(["METISTRY_CONSOLE_PORT", "METISTRY_DB_HOST", "METISTRY_GIT_AUTHOR_NAME", "METISTRY_WATCHDOG_INTERVAL_SEC"]);
    // every value the hand-written file had is in the derived one, except the one yaml now decides — and that one is NAMED
    const before = parseDotEnv(HAND_WRITTEN);
    const after = parseDotEnv(await readFile(envFile, "utf8"));
    for (const [k, v] of Object.entries(before)) expect(after[k], k).toBe(k === "METISTRY_ORIGIN" ? "http://127.0.0.1:8080" : v);
    expect(r.superseded).toEqual(["METISTRY_ORIGIN"]);
    expect(lines.join("\n")).toContain("METISTRY_ORIGIN: the file's value is superseded by deployment.yaml remote:, which is what is rendered");
    // the previous file, byte for byte, beside the render
    expect(r.preRenderKept).toBe(join(stateDir, PRE_RENDER_FILENAME));
    expect(await readFile(r.preRenderKept!, "utf8")).toBe(HAND_WRITTEN);
    expect(await mode(r.preRenderKept!)).toBe(0o600);
    expect(lines.join("\n")).toContain("carried as written (nothing in .metistry/*.yaml decides these yet): METISTRY_CONSOLE_PORT, METISTRY_DB_HOST, METISTRY_GIT_AUTHOR_NAME, METISTRY_WATCHDOG_INTERVAL_SEC");

    // doctor says, once, what the render stopped honouring; the next render finds nothing to supersede and the row is ok
    const row = await envFileRow(dir);
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("METISTRY_ORIGIN (now decided by deployment.yaml remote:)");
    expect(row.remediation).not.toContain("mac.example.ts.net");
    await renderEnvFile(renderOpts(kc, envFile, lines, { derived }));
    expect((await envFileRow(dir)).status).toBe("ok");
  });

  it("**a hand-edited line is reported, never silently kept or silently lost**", async () => {
    const kc = fakeKeychain();
    const { envFile, dir, stateDir } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    const lines: string[] = [];
    await renderEnvFile(renderOpts(kc, envFile, lines));
    expect((await envFileRow(dir)).status).toBe("ok");

    // the owner edits the rendered file: a secret changed, a carried line changed, a line added, a secret removed
    const rendered = await readFile(envFile, "utf8");
    const edited = rendered
      .replace("METISTRY_BRIDGE_TOKEN_EVENTKIT=ek-by-hand", "METISTRY_BRIDGE_TOKEN_EVENTKIT=ek-edited")
      .replace("METISTRY_WATCHDOG_INTERVAL_SEC=300", "METISTRY_WATCHDOG_INTERVAL_SEC=60")
      .replace("METISTRY_DB_PASSWORD=pw-from-hand\n", "")
      .concat("METISTRY_NEW_KNOB=1\n");
    await writeFile(envFile, edited);

    // doctor names the lines — and no value
    const row = await envFileRow(dir);
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("changed METISTRY_BRIDGE_TOKEN_EVENTKIT, METISTRY_WATCHDOG_INTERVAL_SEC; added METISTRY_NEW_KNOB; removed METISTRY_DB_PASSWORD");
    expect(row.action).toEqual({ kind: "run_verb", command: ["metistry", "up"], label: "Derive .env again" });
    const asJson = JSON.stringify(row);
    for (const v of ["ek-edited", "ek-by-hand", "pw-from-hand"]) expect(asJson).not.toContain(v);
    expect(row.meta).toMatchObject({ state: "hand-edited", diff: { changed: ["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_WATCHDOG_INTERVAL_SEC"], added: ["METISTRY_NEW_KNOB"], removed: ["METISTRY_DB_PASSWORD"] } });

    // the render honours every edit before it overwrites the file, and says so
    lines.length = 0;
    const r = await renderEnvFile(renderOpts(kc, envFile, lines));
    expect(r.before.kind).toBe("hand-edited");
    expect(r.handEdited).toEqual({ changed: ["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_WATCHDOG_INTERVAL_SEC"], added: ["METISTRY_NEW_KNOB"], removed: ["METISTRY_DB_PASSWORD"] });
    // the edited secret went INTO the Keychain — not kept in the file alone, not thrown away
    expect(r.adoptedEdits).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT"]);
    expect(kc.store.get(item("METISTRY_BRIDGE_TOKEN_EVENTKIT"))).toBe("ek-edited");
    const after = parseDotEnv(await readFile(envFile, "utf8"));
    expect(after.METISTRY_BRIDGE_TOKEN_EVENTKIT).toBe("ek-edited");
    // the edited configuration line is carried with its new value; the added one is carried
    expect(after.METISTRY_WATCHDOG_INTERVAL_SEC).toBe("60");
    expect(after.METISTRY_NEW_KNOB).toBe("1");
    // the removed secret is still in the store, so it comes back — said, not silent
    expect(after.METISTRY_DB_PASSWORD).toBe("pw-from-hand");
    const said = lines.join("\n");
    expect(said).toContain("hand edit since the last render: changed METISTRY_BRIDGE_TOKEN_EVENTKIT, METISTRY_WATCHDOG_INTERVAL_SEC; added METISTRY_NEW_KNOB; removed METISTRY_DB_PASSWORD");
    expect(said).toContain("your edit of METISTRY_BRIDGE_TOKEN_EVENTKIT went into the login Keychain and is what is rendered");
    expect(said).toContain("removed by hand but still in the store, so rendered again: METISTRY_DB_PASSWORD");
    for (const v of ["ek-edited", "ek-by-hand", "pw-from-hand"]) expect(said).not.toContain(v);
    // the file verifies again, and the hand-edited file is kept beside it
    expect(inspectEnvText(await readFile(envFile, "utf8")).kind).toBe("rendered");
    expect(await readFile(join(stateDir, PRE_RENDER_FILENAME), "utf8")).toBe(edited);
    expect((await envFileRow(dir)).status).toBe("ok");
  });

  it("a hand edit that touches no assignment is still a hand edit, and says so without inventing a line", async () => {
    const kc = fakeKeychain();
    const { envFile, dir } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    await renderEnvFile(renderOpts(kc, envFile, [], { derived }));
    await writeFile(envFile, (await readFile(envFile, "utf8")).concat("# a note I added\n"));
    const row = await envFileRow(dir);
    expect(row.status).toBe("degraded");
    expect(row.remediation).toContain("no assignment differs (a comment or blank line was edited)");
    const r = await renderEnvFile(renderOpts(kc, envFile, [], { derived }));
    expect(r.handEdited).toEqual({ changed: [], added: [], removed: [] });
    expect((await envFileRow(dir)).status).toBe("ok");
  });

  it("a removed carried line stays removed — the owner's removal stands, and is named", async () => {
    const kc = fakeKeychain();
    const { envFile } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    await renderEnvFile(renderOpts(kc, envFile, [], { derived }));
    await writeFile(envFile, (await readFile(envFile, "utf8")).replace("METISTRY_WATCHDOG_INTERVAL_SEC=300\n", ""));
    const lines: string[] = [];
    const r = await renderEnvFile(renderOpts(kc, envFile, lines, { derived }));
    expect(r.handEdited?.removed).toEqual(["METISTRY_WATCHDOG_INTERVAL_SEC"]);
    expect(parseDotEnv(await readFile(envFile, "utf8")).METISTRY_WATCHDOG_INTERVAL_SEC).toBeUndefined();
    expect(lines.join("\n")).toContain("removed by hand and in no store, so gone: METISTRY_WATCHDOG_INTERVAL_SEC");
  });

  it("the Keychain's value wins over a pre-render file's differing line, and the service that holds the old one is named", async () => {
    const kc = fakeKeychain({ [item("METISTRY_LOCAL_OWNER_TOKEN")]: "kc-owner" });
    const { envFile } = await instance();
    await writeFile(envFile, "METISTRY_LOCAL_OWNER_TOKEN=file-owner\n");
    const lines: string[] = [];
    const r = await renderEnvFile(renderOpts(kc, envFile, lines, { serviceRunning: async () => true }));
    expect(parseDotEnv(await readFile(envFile, "utf8")).METISTRY_LOCAL_OWNER_TOKEN).toBe("kc-owner");
    expect(r.rotated).toEqual(["METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(r.restart).toEqual(["console"]);
    expect(lines.join("\n")).toContain("RESTART NEEDED: the console is running with the previous METISTRY_LOCAL_OWNER_TOKEN");
    // the file's value is not lost: it is in the kept copy
    expect(await readFile(r.preRenderKept!, "utf8")).toBe("METISTRY_LOCAL_OWNER_TOKEN=file-owner\n");
    expect(lines.join("\n")).not.toContain("file-owner");
    expect(lines.join("\n")).not.toContain("kc-owner");
  });

  it("delivers the named secrets a service reads as METISTRY_SECRET_*, drops a delivery nothing names any more by name, and carries one when the sources could not be read", async () => {
    const kc = fakeKeychain({ [`${INSTANCE_ID}/${secretService("openrouter_api_key")}`]: "sk-or-x", [`${INSTANCE_ID}/${secretService("linear_api_key")}`]: "lin-x" });
    const { envFile } = await instance();
    const lines: string[] = [];
    const a = await renderEnvFile(renderOpts(kc, envFile, lines, { deliver: ["openrouter_api_key", "linear_api_key"], deliverComplete: true }));
    expect(a.keychain).toEqual(["METISTRY_SECRET_LINEAR_API_KEY", "METISTRY_SECRET_OPENROUTER_API_KEY"]);
    const text = await readFile(envFile, "utf8");
    expect(parseDotEnv(text).METISTRY_SECRET_OPENROUTER_API_KEY).toBe("sk-or-x");
    // linear's connection is gone: its line is dropped, and said
    const b = await renderEnvFile(renderOpts(kc, envFile, lines, { deliver: ["openrouter_api_key"], deliverComplete: true }));
    expect(b.dropped).toEqual(["METISTRY_SECRET_LINEAR_API_KEY"]);
    expect(parseDotEnv(await readFile(envFile, "utf8")).METISTRY_SECRET_LINEAR_API_KEY).toBeUndefined();
    expect(lines.join("\n")).toContain("no longer delivered — nothing in compute.yaml, the connections or secrets.yaml names METISTRY_SECRET_LINEAR_API_KEY any more");
    // the sources could not be read this run: the delivery the file has is carried, not dropped
    const c = await renderEnvFile(renderOpts(kc, envFile, lines, { deliver: [], deliverComplete: false }));
    expect(c.dropped).toEqual([]);
    expect(c.carried).toEqual(["METISTRY_SECRET_OPENROUTER_API_KEY"]);
    expect(parseDotEnv(await readFile(envFile, "utf8")).METISTRY_SECRET_OPENROUTER_API_KEY).toBe("sk-or-x");
    // a delivered value is never adopted as an install variable of its own
    expect(kc.store.has(item("METISTRY_SECRET_OPENROUTER_API_KEY"))).toBe(false);
    expect(lines.join("\n")).not.toContain("sk-or-x");
  });

  it("mints a generated secret only when no store has it, and never one whose opt-in is unset", async () => {
    const kc = fakeKeychain();
    const { envFile } = await instance();
    // declared (commented) in the file, so the install knows the name; nowhere else
    await writeFile(envFile, "# METISTRY_LOCAL_OWNER_TOKEN=\n# METISTRY_LIVE_CAPTURE_CONTROL_TOKEN=\n");
    const r = await renderEnvFile(renderOpts(kc, envFile, [], { mint: () => "minted-token" }));
    expect(r.minted).toEqual(["METISTRY_LOCAL_OWNER_TOKEN"]);
    expect(r.skipped).toEqual(["METISTRY_LIVE_CAPTURE_CONTROL_TOKEN"]);
    expect(kc.store.get(item("METISTRY_LOCAL_OWNER_TOKEN"))).toBe("minted-token");
    expect(parseDotEnv(await readFile(envFile, "utf8"))).toEqual({ METISTRY_LOCAL_OWNER_TOKEN: "minted-token" });
  });

  it("without a Keychain the secret lines are the store: carried as written, stamped, and a hand edit is still named", async () => {
    const kc = fakeKeychain();
    const { envFile, dir } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    const lines: string[] = [];
    const r = await renderEnvFile(renderOpts(kc, envFile, lines, { platform: "linux", derived }));
    expect(kc.calls).toEqual([]);
    expect(r.keychain).toEqual([]);
    expect(r.carried).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_CONSOLE_PORT", "METISTRY_DB_HOST", "METISTRY_DB_PASSWORD", "METISTRY_GIT_AUTHOR_NAME", "METISTRY_WATCHDOG_INTERVAL_SEC"]);
    const text = await readFile(envFile, "utf8");
    expect(inspectEnvText(text).kind).toBe("rendered");
    expect(parseDotEnv(text).METISTRY_DB_PASSWORD).toBe("pw-from-hand");
    await writeFile(envFile, text.replace("pw-from-hand", "pw-edited"));
    expect((await envFileRow(dir)).remediation).toContain("changed METISTRY_DB_PASSWORD");
    const again = await renderEnvFile(renderOpts(kc, envFile, lines, { platform: "linux", derived }));
    expect(again.handEdited?.changed).toEqual(["METISTRY_DB_PASSWORD"]);
    expect(parseDotEnv(await readFile(envFile, "utf8")).METISTRY_DB_PASSWORD).toBe("pw-edited");
  });

  it("an in-place writer keeps a rendered file verifiable, and never stamps a file that was not rendered", async () => {
    const kc = fakeKeychain();
    const { envFile } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    // pre-render: `ensureSecret` appends and the file stays header-less, for `up` to derive
    await ensureSecret("METISTRY_BRIDGE_TOKEN_APPLE_FM", { ...renderOpts(kc, envFile, []), mint: () => "afm-1" });
    expect(inspectEnvText(await readFile(envFile, "utf8")).kind).toBe("pre-render");
    await renderEnvFile(renderOpts(kc, envFile, []));
    // rendered: the same writer re-stamps, so doctor does not cry hand edit over a CLI write
    await ensureSecret("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE", { ...renderOpts(kc, envFile, []), mint: () => "lc-1" });
    const text = await readFile(envFile, "utf8");
    expect(inspectEnvText(text).kind).toBe("rendered");
    expect(parseDotEnv(text).METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE).toBe("lc-1");
    // …and the next render folds the appended line into its section
    const r = await renderEnvFile(renderOpts(kc, envFile, []));
    expect(r.keychain).toContain("METISTRY_BRIDGE_TOKEN_LIVE_CAPTURE");
  });

  it("`secrets sync --to env` is the render", async () => {
    const kc = fakeKeychain();
    const { envFile } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    const lines: string[] = [];
    const r = await syncSecrets("env", renderOpts(kc, envFile, lines));
    expect(r.wrote).toBe(envFile);
    expect(r.adopted).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_DB_PASSWORD"]);
    expect(r.changed).toEqual(["METISTRY_BRIDGE_TOKEN_EVENTKIT", "METISTRY_DB_PASSWORD"]);
    expect(inspectEnvText(await readFile(envFile, "utf8")).kind).toBe("rendered");
  });

  it("the record and the diff name lines without holding a value", async () => {
    const kc = fakeKeychain();
    const { envFile, stateDir } = await instance();
    await writeFile(envFile, HAND_WRITTEN);
    await renderEnvFile(renderOpts(kc, envFile, []));
    const recordText = await readFile(renderRecordPath(stateDir), "utf8");
    for (const v of HAND_VALUES) expect(recordText).not.toContain(v);
    const record = parseRenderRecord(recordText)!;
    expect(Object.keys(record.lines).sort()).toEqual(Object.keys(parseDotEnv(HAND_WRITTEN)).sort());
    expect(diffAgainstRecord(record, new Map(Object.entries(parseDotEnv(HAND_WRITTEN))))).toEqual({ changed: [], added: [], removed: [] });
  });
});

describe("doctor's env row", () => {
  it("absent, pre-render and rendered, each with the one fix", async () => {
    const { dir, envFile } = await instance();
    const absent = await envFileRow(dir);
    expect(absent).toMatchObject({ kind: "instance", name: "env", status: "absent", action: { kind: "run_verb", command: ["metistry", "up"], label: "Derive .env" } });
    await writeFile(envFile, HAND_WRITTEN);
    const pre = await envFileRow(dir);
    expect(pre.status).toBe("degraded");
    expect(pre.remediation).toContain("written by hand, or by a release before .env was derived");
    expect(pre.remediation).toContain(PRE_RENDER_FILENAME);
    expect(pre.action).toEqual({ kind: "run_verb", command: ["metistry", "up"], label: "Derive .env" });
    await writeFile(envFile, stampEnv("A=1\n"));
    const ok = await envFileRow(dir);
    expect(ok.status).toBe("ok");
    expect(ok.action).toBeUndefined();
    // edited with no record beside it: still a hand edit, honestly without the lines
    await writeFile(envFile, `${stampEnv("A=1\n")}B=2\n`);
    const edited = await envFileRow(dir);
    expect(edited.status).toBe("degraded");
    expect(edited.remediation).toContain("which lines is not known: no render record beside it");
  });
});

describe("metistry up derives the instance's .env", () => {
  const NODE = "/usr/local/bin/node";
  const withKeychain = () => {
    const kc = fakeKeychain();
    return { kc, exec: fakeExec({ security: (argv, opts) => kc.exec("security", argv, opts) }) };
  };

  it("renders it once per run before compose reads it, moves a checkout's file into the instance, and a second `up` is byte-identical; a dry run writes nothing", async () => {
    const P = await checkout();
    await put(P, ".env", "METISTRY_ORIGIN=http://127.0.0.1:8080\nMETISTRY_DB_PASSWORD=pw\n");
    const inst = await mkdtemp(join(tmpdir(), "mi-"));
    await mkdir(join(inst, ".metistry"), { recursive: true });
    const env = () => ({ METISTRY_INSTANCE_DIR: inst, METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-bearer" }) as NodeJS.ProcessEnv;
    const base = { productDir: P, platform: "darwin" as const, uid: 501, node: NODE, cliShim: false, home: "/h", launchd: false, doctorFn: okDoctor };
    const target = join(inst, ".metistry", "state", ".env");

    // a dry run plans the derive and writes nothing — so compose is still planned against the checkout's file
    const dry = await up({ ...base, env: env(), exec: fakeExec(), out: () => {}, dryRun: true });
    expect(dry.commands).toEqual([
      expect.stringContaining(`derive ${target} from .metistry/*.yaml and the login Keychain`),
      expect.stringContaining("mirror "),
      `(cd ${P} && docker compose up -d --build)`,
      "metistry doctor",
    ]);
    expect(existsSync(target)).toBe(false);

    const { kc, exec } = withKeychain();
    const lines: string[] = [];
    const first = await up({ ...base, env: env(), exec, out: (l) => lines.push(l) });
    expect(first.code).toBe(0);
    const text = await readFile(target, "utf8");
    expect(inspectEnvText(text).kind).toBe("rendered");
    // the checkout's file was the previous one: its secret adopted, its configuration carried, compose told the new path
    expect(kc.store.get("metistry/metistry:METISTRY_DB_PASSWORD")).toBe("pw");
    expect(parseDotEnv(text)).toEqual({ METISTRY_ORIGIN: "http://127.0.0.1:8080", METISTRY_DB_PASSWORD: "pw" });
    expect(exec.calls.filter((c) => c.cmd === "docker").map((c) => c.args.join(" "))).toEqual([`compose --env-file ${target} up -d --build`]);
    const derive = first.commands.findIndex((c) => c.startsWith("derive "));
    const compose = first.commands.findIndex((c) => c.includes("docker compose"));
    expect(derive).toBeGreaterThanOrEqual(0);
    expect(derive).toBeLessThan(compose);
    expect(lines.join("\n")).not.toContain("pw\n");

    const second = await up({ ...base, env: env(), exec: withKeychain().exec, out: () => {} });
    expect(second.code).toBe(0);
    expect(await readFile(target, "utf8")).toBe(text);
  });
});
