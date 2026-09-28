// Product files the vault has under another CASE only (0.14.2 owner report:
// seeded 2026-09-06 with `Me/Profile.md`, the product reads `Me/profile.md`,
// and every working-day read failed). `update` renames them to the seed's
// spelling — two steps through a temporary name, each a commit, because on a
// case-insensitive filesystem a one-step rename is no change to the OS or to
// git — and never looks at a file the seed does not ship. Real git, temp repos.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StepRunner } from "../src/steps.js";
import { CASE_RENAME_SUFFIX, renameCaseMismatches, vaultCaseMismatches } from "../src/vault-case.js";
import { vaultCaseRow } from "../src/doctor.js";
import { put } from "./fixtures.js";

const PROFILE = "---\ntimezone: America/New_York\nworking_days: [mon, tue, wed, thu, fri]\n---\n";

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

/** A seed, and a flat instance committed as the 2026-09-06 seed left it — plus the owner's own files, which must never move. */
async function fixture(): Promise<{ seed: string; inst: string }> {
  const seed = await mkdtemp(join(tmpdir(), "mc-seed-"));
  await put(seed, "vault/Me/profile.md", "seed profile\n");
  await put(seed, "vault/Me/Working Style.md", "seed style\n");
  await put(seed, "vault/Templates/Daily.md", "seed daily\n");
  const inst = await mkdtemp(join(tmpdir(), "mc-inst-"));
  await put(inst, ".metistry/identity.yaml", "name: Test\n");
  await put(inst, "Me/Profile.md", PROFILE);
  await put(inst, "Me/Working Style.md", "mine\n");
  await put(inst, "Templates/Daily.md", "mine\n");
  await put(inst, "Projects/PROFILE.md", "the owner's own file, which the seed does not ship\n");
  await put(inst, "Me/notes.md", "the owner's\n");
  git(inst, "init", "-q");
  git(inst, "add", "-A");
  git(inst, "commit", "-q", "-m", "seeded 2026-09-06");
  return { seed, inst };
}

const runner = (lines: string[], dryRun = false) => new StepRunner({ dryRun, out: (l) => lines.push(l), env: {} });
const opts = (seed: string, inst: string, extra: Partial<Parameters<typeof renameCaseMismatches>[1]> = {}) => ({ seedDir: seed, instanceDir: inst, env: {}, platform: "linux" as const, uid: 501, fetchFn: fetch, ...extra });

describe("vault case: the seed's files, spelled as the seed spells them", () => {
  it("finds a seed file the vault has under another case only — and nothing the seed does not ship", async () => {
    const { seed, inst } = await fixture();
    expect(await vaultCaseMismatches(seed, inst)).toEqual([{ canonical: "Me/profile.md", actual: "Me/Profile.md" }]);
  });

  it("directly (no bridge): two commits through a temporary name; git and the disk both end on the seed's spelling; bytes and the owner's files untouched; a second run is a no-op", async () => {
    const { seed, inst } = await fixture();
    const lines: string[] = [];
    const out = await renameCaseMismatches(runner(lines), opts(seed, inst));
    expect(out).toEqual({ renamed: [{ canonical: "Me/profile.md", actual: "Me/Profile.md" }], left: [] });
    expect(await readdir(join(inst, "Me"))).toContain("profile.md");
    expect(await readdir(join(inst, "Me"))).not.toContain("Profile.md");
    expect(git(inst, "ls-files", "Me").trim().split("\n").sort()).toEqual(["Me/Working Style.md", "Me/notes.md", "Me/profile.md"]);
    expect(await readFile(join(inst, "Me/profile.md"), "utf8")).toBe(PROFILE);
    expect(git(inst, "status", "--porcelain")).toBe("");
    expect(git(inst, "log", "--format=%s", "-2").trim().split("\n")).toEqual([
      "metistry update: rename Me/Profile.md to Me/profile.md, the name the product reads (step 2 of 2 — a case-only rename)",
      "metistry update: rename Me/Profile.md to Me/profile.md, the name the product reads (step 1 of 2 — a case-only rename)",
    ]);
    expect(await readdir(join(inst, "Projects"))).toEqual(["PROFILE.md"]);

    const head = git(inst, "rev-parse", "HEAD");
    const again: string[] = [];
    expect(await renameCaseMismatches(runner(again), opts(seed, inst))).toEqual({ renamed: [], left: [] });
    expect(git(inst, "rev-parse", "HEAD")).toBe(head);
    expect(again.join("\n")).toContain("nothing renamed");
  });

  it("through the reconciler: rename to the temporary name, flush, rename to the seed's name, flush — as user, with the owner bearer", async () => {
    const { seed, inst } = await fixture();
    const calls: { path: string; body: any; auth: string | null }[] = [];
    // The bridge as far as this step reaches it: /vault/rename moves the file,
    // /flush commits what moved — the committer's own two commands.
    let moved: string[] = [];
    const bridge = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
      if (path === "/vault/rename") {
        await rename(join(inst, body.from), join(inst, body.to));
        moved = [body.from, body.to];
        return new Response(JSON.stringify({ from: body.from, to: body.to }), { status: 200 });
      }
      if (path === "/flush") {
        if (moved.length === 0) return new Response(JSON.stringify({ commits: [] }), { status: 200 });
        git(inst, "add", "-A", "--", ...moved);
        git(inst, "commit", "-q", "--only", "-m", "via bridge", "--", ...moved);
        const commits = [{ sha: git(inst, "rev-parse", "HEAD").trim(), paths: moved }];
        moved = [];
        return new Response(JSON.stringify({ commits }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER: "console-tok", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok" };
    const out = await renameCaseMismatches(runner([]), opts(seed, inst, { env, fetchFn: bridge }));
    expect(out.renamed).toEqual([{ canonical: "Me/profile.md", actual: "Me/Profile.md" }]);
    const tmp = `Me/Profile.md${CASE_RENAME_SUFFIX}`;
    expect(calls.map((c) => [c.path, c.body?.from, c.body?.to])).toEqual([
      ["/vault/rename", "Me/Profile.md", tmp],
      ["/flush", undefined, undefined],
      ["/vault/rename", tmp, "Me/profile.md"],
      ["/flush", undefined, undefined],
    ]);
    expect(calls.every((c) => c.auth === "Bearer owner-tok")).toBe(true);
    expect(calls[0]!.body.intent.principal).toBe("user");
    expect(git(inst, "ls-files", "Me").trim().split("\n").sort()).toEqual(["Me/Working Style.md", "Me/notes.md", "Me/profile.md"]);
    expect(git(inst, "status", "--porcelain")).toBe("");
  });

  it("a first step the reconciler could not commit is put back — the file never stays under a name nothing reads — and the update carries on", async () => {
    const { seed, inst } = await fixture();
    const renames: string[] = [];
    const paused = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/vault/rename") {
        const b = JSON.parse(String(init?.body));
        await rename(join(inst, b.from), join(inst, b.to));
        renames.push(`${b.from} → ${b.to}`);
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ commits: [], paused: "merge" }), { status: 200 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const env = { METISTRY_RECONCILER_URL: "http://127.0.0.1:7812", METISTRY_BRIDGE_TOKEN_RECONCILER_USER: "owner-tok" };
    const out = await renameCaseMismatches(runner(lines), opts(seed, inst, { env, fetchFn: paused }));
    expect(out.renamed).toEqual([]);
    expect(out.left[0]!.why).toMatch(/was put back/);
    expect(renames).toEqual([`Me/Profile.md → Me/Profile.md${CASE_RENAME_SUFFIX}`, `Me/Profile.md${CASE_RENAME_SUFFIX} → Me/Profile.md`]);
    expect(await readdir(join(inst, "Me"))).toContain("Profile.md");
    expect(lines.join("\n")).toContain("rerun `metistry update`");
  });

  it("a dry run renames nothing and says what it would", async () => {
    const { seed, inst } = await fixture();
    const out = await renameCaseMismatches(runner([], true), opts(seed, inst));
    expect(out.renamed).toHaveLength(1);
    expect(await readdir(join(inst, "Me"))).toContain("Profile.md");
    expect(git(inst, "log", "--format=%s").trim()).toBe("seeded 2026-09-06");
  });

  it("doctor: a row naming each mismatch and the fix; no row at all when every name matches", async () => {
    const { seed, inst } = await fixture();
    const row = await vaultCaseRow(inst, seed);
    expect(row).toMatchObject({ kind: "instance", name: "vault case", status: "degraded", meta: { mismatches: [{ canonical: "Me/profile.md", actual: "Me/Profile.md" }] } });
    expect(row!.remediation).toContain("Me/Profile.md → Me/profile.md");
    expect(row!.remediation).toContain("`metistry update` renames it");
    await renameCaseMismatches(runner([]), opts(seed, inst));
    expect(await vaultCaseRow(inst, seed)).toBeNull();
  });
});
