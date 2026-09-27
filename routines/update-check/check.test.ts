// The Update Check (design-build-plan §2.20): newer → one row the console
// streams as `release.available`; not newer → silent; could not tell → a skip
// row, never a throw. Against a fake feed and a fake database.
import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, run, COMPONENT, type UpdateCheckCtx } from "./run.js";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function feed(answer: () => Response | Promise<Response>): { fetchFn: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    seen.push({ url: String(input), headers: init?.headers ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetchFn, seen };
}
const release = (tag: unknown, status = 200) => () => new Response(JSON.stringify({ tag_name: tag, draft: false }), { status });

function db() {
  const rows: { sql: string; params: unknown[] }[] = [];
  return {
    rows,
    query: async (sql: string, params: unknown[] = []) => {
      rows.push({ sql, params });
      return { rows: [] };
    },
    meta: () => rows.map((r) => JSON.parse(String(r.params[1]))),
  };
}

const ctx = (o: Partial<UpdateCheckCtx>): UpdateCheckCtx => ({ runtimeVersion: "0.11.0", env: {}, ...o });

describe("update-check", () => {
  it("a newer release: one row of its own, acted, with release_available — what the console streams", async () => {
    const d = db();
    const f = feed(release("v0.12.0"));
    expect(await run(d, ctx({ fetchFn: f.fetchFn }))).toBe(1);
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]!.sql).toMatch(/INSERT INTO runs \(component, kind, ok, started_at, finished_at, meta\)\s+VALUES \(\$1, 'routine_run', true, now\(\), now\(\), \$2\)/);
    expect(d.rows[0]!.params[0]).toBe(COMPONENT);
    expect(d.meta()).toEqual([{ outcome: "acted", current: "0.11.0", release_available: "0.12.0" }]);
    expect(f.seen[0]!.url).toBe("https://api.github.com/repos/foldedspacelabs/metistry/releases/latest");
    expect(f.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("the same version, or an older one: silent — no row of its own", async () => {
    for (const tag of ["v0.11.0", "0.10.9", "v0.11.0-rc.1"]) {
      const d = db();
      expect(await run(d, ctx({ fetchFn: feed(release(tag)).fetchFn })), tag).toBe(0);
      expect(d.rows, tag).toEqual([]);
    }
  });

  it("could not tell: a skip row naming why, and no throw — an offline Mac is not an alert", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["skipped:unreachable", () => Promise.reject(new TypeError("fetch failed"))],
      ["skipped:unreachable", () => new Response("", { status: 500 })],
      ["skipped:unreachable", () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })],
      ["skipped:no_release", () => new Response("", { status: 404 })],
      ["skipped:unreadable", release("nightly")],
      ["skipped:unreadable", () => new Response("<html>", { status: 200 })],
    ];
    for (const [outcome, answer] of cases) {
      const d = db();
      expect(await run(d, ctx({ fetchFn: feed(answer).fetchFn }))).toBe(0);
      expect(d.meta(), outcome).toHaveLength(1);
      expect(d.meta()[0]).toMatchObject({ outcome, current: "0.11.0" });
      expect(String(d.meta()[0].why).length).toBeGreaterThan(10);
      expect(d.meta()[0].release_available).toBeUndefined();
    }
  });

  it("no runtime version to compare: says so, and asks nobody", async () => {
    const d = db();
    const f = feed(release("v9.9.9"));
    expect(await run(d, { fetchFn: f.fetchFn, env: {} })).toBe(0);
    expect(f.seen).toEqual([]);
    expect(d.meta()[0]).toMatchObject({ outcome: "skipped:no_version" });
  });

  it("reads the same overrides and token `metistry update` does", async () => {
    const f = feed(release("v1.0.0"));
    await run(db(), ctx({ fetchFn: f.fetchFn, githubToken: "ghp_example", env: { METISTRY_RELEASE_REPO: "someone/fork", METISTRY_GITHUB_API: "https://ghe.example.com/api/v3/" } }));
    expect(f.seen[0]!.url).toBe("https://ghe.example.com/api/v3/repos/someone/fork/releases/latest");
    expect(f.seen[0]!.headers.authorization).toBe("Bearer ghp_example");
  });
});

describe("version precedence", () => {
  const v = (s: string) => parseVersion(s)!;
  it("orders releases and pre-releases the semver way", () => {
    const ordered = ["0.9.9", "0.10.0-alpha", "0.10.0-alpha.1", "0.10.0-alpha.beta", "0.10.0-beta", "0.10.0-beta.2", "0.10.0-beta.11", "0.10.0-rc.1", "0.10.0", "0.10.1", "1.0.0"];
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(compareVersions(v(ordered[i]!), v(ordered[i + 1]!)), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(v(ordered[i + 1]!), v(ordered[i]!))).toBeGreaterThan(0);
    }
    expect(compareVersions(v("v0.12.0"), v("0.12.0"))).toBe(0);
  });

  it("reads a version and nothing else", () => {
    expect(parseVersion("v0.12.0")?.text).toBe("0.12.0");
    for (const bad of ["", "0.12", "0.12.0.1", "0.12.0+build", "latest", "0.12.0-", "0.12.0-a..b", null, 12]) expect(parseVersion(bad), String(bad)).toBeUndefined();
  });
});
