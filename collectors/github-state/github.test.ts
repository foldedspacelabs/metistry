import { describe, expect, it } from "vitest";
import { run } from "./run.js";

function fakeDb(closedRows: { id: number; external_ref: string; kind: string }[] = [{ id: 1, external_ref: "", kind: "" }]) {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("UPDATE work SET status")) return { rows: closedRows };
      return { rows: [] };
    },
  };
}

describe("github-state collector", () => {
  it("degrades absent without token/repos", async () => {
    const db = fakeDb();
    expect(await run(db, {})).toBe(0);
    expect(db.q).toHaveLength(0);
  });

  it("upserts open issues/PRs with gh: refs and closes the rest", async () => {
    const db = fakeDb();
    const fetchFn = (async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.endsWith("/user")) return { login: "samrivera" };
        if (url.endsWith("/reviews?per_page=100")) return [];
        if (url.includes("/pulls?")) return [
          { number: 9, draft: false, user: { login: "claude" }, requested_reviewers: [{ login: "samrivera" }], requested_teams: [] },
        ];
        return [
          { number: 7, title: "fix brief tz", state: "open", html_url: "https://gh/7", updated_at: "2026-09-01T00:00:00Z", user: { login: "samrivera" }, assignee: { login: "samrivera" } },
          { number: 9, title: "ios plan", state: "open", pull_request: {}, html_url: "https://gh/9", updated_at: "2026-09-02T00:00:00Z", user: { login: "claude" }, milestone: { due_on: "2026-09-10T00:00:00Z" } },
        ];
      },
    })) as unknown as typeof fetch;
    const n = await run(db, { githubToken: "t", githubRepos: ["foldedspacelabs/metistry"], fetchFn });
    const inserts = db.q.filter((x) => x.text.startsWith("INSERT INTO work"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toContain("gh:foldedspacelabs/metistry#7");
    expect(inserts[0]!.values).toContain("issue");
    expect(inserts[1]!.values).toContain("pr");
    expect(inserts[1]!.values).toContain("2026-09-10");
    expect(JSON.parse(String(inserts[0]!.values[7]))).toEqual({ author: "samrivera", url: "https://gh/7" });
    expect(JSON.parse(String(inserts[1]!.values[7]))).toEqual({
      author: "claude", url: "https://gh/9", draft: false, review_requested: ["samrivera"], review_teams: [], needs_my_review: true,
    });
    const close = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(close.values[1]).toEqual(["gh:foldedspacelabs/metistry#7", "gh:foldedspacelabs/metistry#9"]);
    expect(n).toBe(3); // 2 upserts + 1 closed
  });

  it("surfaces API failure as an error (the runner records it), never silent", async () => {
    const db = fakeDb();
    const fetchFn = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(run(db, { githubToken: "bad", githubRepos: ["o/r"], fetchFn })).rejects.toThrow(/HTTP 401/);
  });

  it("needs_my_review: open non-draft PR I haven't approved → true; my approval clears it; re-request re-opens it; draft/unknown viewer → false", async () => {
    const mk = (viewerOk: boolean, pull: any, reviews: any[]) => (async (url: string) => {
      if (url.endsWith("/user")) return { ok: viewerOk, json: async () => ({ login: "me" }) };
      if (url.includes("/reviews?")) return { ok: true, json: async () => reviews };
      return { ok: true, json: async () => (url.includes("/pulls?") ? [pull] : [
        { number: 1, title: "t", state: "open", pull_request: {}, html_url: "", updated_at: "2026-09-01T00:00:00Z", user: pull.user },
      ]) };
    }) as unknown as typeof fetch;
    const needs = async (viewerOk: boolean, pull: any, reviews: any[] = []) => {
      const db = fakeDb();
      await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: mk(viewerOk, pull, reviews) });
      return JSON.parse(String(db.q.find((x) => x.text.startsWith("INSERT"))!.values[7])).needs_my_review;
    };
    const mine = { number: 1, user: { login: "me" }, requested_reviewers: [] };
    const theirs = { number: 1, user: { login: "other" }, requested_reviewers: [] };
    const approved = [{ user: { login: "me" }, state: "APPROVED" }];
    expect(await needs(true, mine)).toBe(true); // agent-opened under my account, unreviewed
    expect(await needs(true, theirs)).toBe(true);
    expect(await needs(true, theirs, [{ user: { login: "me" }, state: "COMMENTED" }])).toBe(true); // a comment isn't an approval
    expect(await needs(true, theirs, approved)).toBe(false);
    expect(await needs(true, { ...theirs, requested_reviewers: [{ login: "me" }] }, approved)).toBe(true); // re-requested
    expect(await needs(true, { ...theirs, draft: true })).toBe(false);
    expect(await needs(false, theirs)).toBe(false); // /user degraded → never claims a review is mine
  });

  it("closed PRs are fetched for merged state; closed issues are not", async () => {
    const db = fakeDb([
      { id: 11, external_ref: "gh:o/r#5", kind: "pr" },
      { id: 12, external_ref: "gh:o/r#6", kind: "issue" },
    ]);
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/user")) return { ok: true, json: async () => ({ login: "me" }) };
      if (url.includes("/reviews?")) return { ok: true, json: async () => [] };
      if (url.includes("/pulls?")) return { ok: true, json: async () => [] }; // nothing open right now
      if (url.endsWith("/pulls/5")) return { ok: true, json: async () => ({ merged_at: "2026-09-05T00:00:00Z" }) };
      return { ok: true, json: async () => [] }; // open-issues listing: empty
    }) as unknown as typeof fetch;
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn });
    expect(calls.filter((u) => u.endsWith("/pulls/5"))).toHaveLength(1);
    expect(calls.some((u) => u.endsWith("/pulls/6"))).toBe(false); // issue: no per-PR fetch
    const metaUpdate = db.q.find((x) => x.text.startsWith("UPDATE work SET meta"));
    expect(metaUpdate!.values).toEqual([11, JSON.stringify({ merged: true, merged_at: "2026-09-05T00:00:00Z" })]);
  });

  it("closed-without-merge sets meta.merged = false", async () => {
    const db = fakeDb([{ id: 21, external_ref: "gh:o/r#8", kind: "pr" }]);
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/user")) return { ok: true, json: async () => ({ login: "me" }) };
      if (url.includes("/reviews?")) return { ok: true, json: async () => [] };
      if (url.includes("/pulls?")) return { ok: true, json: async () => [] };
      if (url.endsWith("/pulls/8")) return { ok: true, json: async () => ({ merged_at: null }) };
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch;
    await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn });
    const metaUpdate = db.q.find((x) => x.text.startsWith("UPDATE work SET meta"));
    expect(metaUpdate!.values).toEqual([21, JSON.stringify({ merged: false, merged_at: null })]);
  });
});
