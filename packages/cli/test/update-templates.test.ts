// `metistry update`'s seed-templates step (W2 checkpoint D1): a template a
// release adds reached only a FRESH init, so an upgraded vault never got
// `Templates/Brief.md` and the Morning Brief skipped every morning. The step
// copies what the vault LACKS and nothing else — the owner's templates are
// theirs (invariant 2): an existing file is never rewritten, through the
// bridge (the reconciler's create-only compare-and-swap) or directly.
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StepRunner } from "../src/steps.js";
import { seedTemplates, update } from "../src/update.js";
import { checkout, fakeExec, okDoctor, put } from "./fixtures.js";

const SEED = { "Brief.md": "# Brief\n{{ calendar }}\n", "Daily.md": "# Daily (seed)\n", "Plan.md": "# Plan (seed)\n" };
const MINE = "# Daily — mine, edited in Obsidian\n";

/** A product with seed templates, and a flat instance whose vault has Daily.md (edited) and nothing else the seed has. */
async function fixture(): Promise<{ P: string; inst: string }> {
  const P = await checkout({ git: true });
  for (const [name, text] of Object.entries(SEED)) await put(P, `seed/vault/Templates/${name}`, text);
  await put(P, "seed/vault/Templates/README.txt", "not a template");
  const inst = await mkdtemp(join(tmpdir(), "mi-"));
  await put(inst, ".metistry/identity.yaml", "name: Test\n");
  await put(inst, "Templates/Daily.md", MINE);
  await put(inst, "Templates/Mine.md", "# a template the seed has never heard of\n");
  return { P, inst };
}

const runner = (lines: string[], dryRun = false) => new StepRunner({ dryRun, out: (l) => lines.push(l), exec: fakeExec(), env: {} });

/** The reconciler's /vault/write as far as this step reaches it: the create-only compare-and-swap, against a real directory. */
function fakeBridge(inst: string) {
  const calls: { path: string; content: string; expected: unknown }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; content: string; expected_sha256?: string };
    if (!String(url).endsWith("/vault/write")) return new Response("{}", { status: 404 });
    calls.push({ path: body.path, content: body.content, expected: body.expected_sha256 });
    const target = join(inst, body.path);
    let exists = true;
    try {
      readFileSync(target);
    } catch {
      exists = false;
    }
    if (body.expected_sha256 === "" && exists) return new Response(JSON.stringify({ ok: false, error: { code: "conflict", message: "exists" } }), { status: 409 });
    await writeFile(target, body.content);
    return new Response(JSON.stringify({ ok: true, path: body.path, created: !exists, queued: true }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("update: seed templates the vault lacks", () => {
  it("directly (no bridge): copies only the missing .md templates; the owner's bytes are untouched; a second run copies nothing", async () => {
    const { P, inst } = await fixture();
    const lines: string[] = [];
    const o = { seedDir: join(P, "seed"), instanceDir: inst, env: {}, platform: "linux" as const, uid: 501, fetchFn: fetch };
    const first = await seedTemplates(runner(lines), o);
    expect(first.copied).toEqual(["Templates/Brief.md", "Templates/Plan.md"]);
    expect(first.kept).toEqual(["Templates/Daily.md"]);
    expect(readFileSync(join(inst, "Templates/Brief.md"), "utf8")).toBe(SEED["Brief.md"]);
    expect(readFileSync(join(inst, "Templates/Plan.md"), "utf8")).toBe(SEED["Plan.md"]);
    expect(readFileSync(join(inst, "Templates/Daily.md"), "utf8")).toBe(MINE);
    expect((await readdir(join(inst, "Templates"))).sort()).toEqual(["Brief.md", "Daily.md", "Mine.md", "Plan.md"]);
    // each file named in the log
    expect(lines.join("\n")).toContain("seeded Templates/Brief.md");
    expect(lines.join("\n")).toContain("seeded Templates/Plan.md");

    const again: string[] = [];
    const second = await seedTemplates(runner(again), o);
    expect(second).toEqual({ copied: [], kept: ["Templates/Brief.md", "Templates/Daily.md", "Templates/Plan.md"] });
    expect(again.join("\n")).toContain("the vault has all 3 seed template(s) — nothing copied");
  });

  it("through the reconciler as user, create-only: one POST per missing template with expected_sha256 \"\"; a file that appeared in between is kept", async () => {
    const { P, inst } = await fixture();
    const bridge = fakeBridge(inst);
    const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok" };
    const o = { seedDir: join(P, "seed"), instanceDir: inst, env, platform: "darwin" as const, uid: 501, fetchFn: bridge.fn };
    const out = await seedTemplates(runner([]), o);
    expect(bridge.calls).toEqual([
      { path: "Templates/Brief.md", content: SEED["Brief.md"], expected: "" },
      { path: "Templates/Plan.md", content: SEED["Plan.md"], expected: "" },
    ]);
    expect(out.copied).toEqual(["Templates/Brief.md", "Templates/Plan.md"]);
    expect(readFileSync(join(inst, "Templates/Daily.md"), "utf8")).toBe(MINE);

    // the owner wrote Plan.md between the look and the write: the bridge's CAS refuses, and it is kept
    const { P: P2, inst: inst2 } = await fixture();
    const racing = fakeBridge(inst2);
    const raced = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body).includes("Templates/Plan.md")) await writeFile(join(inst2, "Templates/Plan.md"), "# Plan — mine\n");
      return racing.fn(url, init);
    }) as unknown as typeof fetch;
    const r2 = await seedTemplates(runner([]), { ...o, seedDir: join(P2, "seed"), instanceDir: inst2, fetchFn: raced });
    expect(r2.copied).toEqual(["Templates/Brief.md"]);
    expect(r2.kept).toEqual(["Templates/Daily.md", "Templates/Plan.md"]);
    expect(readFileSync(join(inst2, "Templates/Plan.md"), "utf8")).toBe("# Plan — mine\n");
  });

  it("never fails the update: a refused write is named with the rerun; a legacy or missing instance is a note", async () => {
    const { P, inst } = await fixture();
    const refusing = (async () => new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "no" } }), { status: 403 })) as unknown as typeof fetch;
    const lines: string[] = [];
    const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok" };
    const out = await seedTemplates(runner(lines), { seedDir: join(P, "seed"), instanceDir: inst, env, platform: "darwin", uid: 501, fetchFn: refusing });
    expect(out.copied).toEqual([]);
    expect(lines.join("\n")).toContain("Templates/Brief.md was NOT seeded");
    expect(lines.join("\n")).toContain("rerun `metistry update`");

    const legacy = await mkdtemp(join(tmpdir(), "mi-"));
    await put(legacy, "identity.yaml", "name: Old\n");
    const notes: string[] = [];
    expect(await seedTemplates(runner(notes), { seedDir: join(P, "seed"), instanceDir: legacy, env: {}, platform: "linux", uid: 501, fetchFn: fetch })).toEqual({ copied: [], kept: [] });
    expect(notes.join("\n")).toContain("legacy layout — not seeded");
  });

  it("a dry run writes nothing and says what it would", async () => {
    const { P, inst } = await fixture();
    const lines: string[] = [];
    const out = await seedTemplates(runner(lines, true), { seedDir: join(P, "seed"), instanceDir: inst, env: {}, platform: "linux", uid: 501, fetchFn: fetch });
    expect(out.copied).toEqual(["Templates/Brief.md", "Templates/Plan.md"]);
    expect((await readdir(join(inst, "Templates"))).sort()).toEqual(["Daily.md", "Mine.md"]);
  });

  it("`update` runs the step after the lock, through the same bridge, and reports it", async () => {
    const { P, inst } = await fixture();
    const bridge = fakeBridge(inst);
    const env = { METISTRY_INSTANCE_DIR: inst, METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "tok", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok" };
    const r = await update({
      productDir: P,
      env,
      platform: "linux",
      uid: 501,
      version: "0.0.9",
      now: new Date("2026-09-27T12:00:00Z"),
      out: () => {},
      cliShim: false,
      skipBuild: true,
      skipMigrate: true,
      exec: fakeExec(),
      fetchFn: bridge.fn,
      doctorFn: okDoctor,
      keychain: undefined,
    });
    expect(r.code).toBe(0);
    expect(bridge.calls.map((c) => c.path)).toEqual([".metistry/metistry.lock", "Templates/Brief.md", "Templates/Plan.md"]);
    expect(r.seededTemplates).toEqual({ copied: ["Templates/Brief.md", "Templates/Plan.md"], kept: ["Templates/Daily.md"] });
    expect(readFileSync(join(inst, "Templates/Daily.md"), "utf8")).toBe(MINE);
  });
});
