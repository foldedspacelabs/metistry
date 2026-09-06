import { describe, expect, it } from "vitest";
import { run } from "./run.js";

function fakeDb() {
  const q: { text: string; values: unknown[] }[] = [];
  return {
    q,
    async query(text: string, values: unknown[] = []) {
      q.push({ text, values });
      if (text.startsWith("UPDATE work")) return { rows: [{ id: 1 }] };
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
        if (url.endsWith("/user")) return { login: "mattcolf" };
        if (url.includes("/pulls?")) return [
          { number: 9, draft: false, user: { login: "claude" }, requested_reviewers: [{ login: "mattcolf" }], requested_teams: [] },
        ];
        return [
          { number: 7, title: "fix brief tz", state: "open", html_url: "https://gh/7", updated_at: "2026-09-01T00:00:00Z", user: { login: "mattcolf" }, assignee: { login: "mattcolf" } },
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
    expect(JSON.parse(String(inserts[0]!.values[7]))).toEqual({ author: "mattcolf", url: "https://gh/7" });
    expect(JSON.parse(String(inserts[1]!.values[7]))).toEqual({
      author: "claude", url: "https://gh/9", draft: false, review_requested: ["mattcolf"], review_teams: [], needs_my_review: true,
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

  it("needs_my_review is false for drafts, own PRs, and when the viewer is unknown", async () => {
    const mk = (viewerOk: boolean, pull: any) => (async (url: string) => {
      if (url.endsWith("/user")) return { ok: viewerOk, json: async () => ({ login: "me" }) };
      return { ok: true, json: async () => (url.includes("/pulls?") ? [pull] : [
        { number: 1, title: "t", state: "open", pull_request: {}, html_url: "", updated_at: "2026-09-01T00:00:00Z", user: pull.user },
      ]) };
    }) as unknown as typeof fetch;
    const needs = async (viewerOk: boolean, pull: any) => {
      const db = fakeDb();
      await run(db, { githubToken: "t", githubRepos: ["o/r"], fetchFn: mk(viewerOk, pull) });
      return JSON.parse(String(db.q.find((x) => x.text.startsWith("INSERT"))!.values[7])).needs_my_review;
    };
    const asked = { number: 1, user: { login: "other" }, requested_reviewers: [{ login: "me" }] };
    expect(await needs(true, asked)).toBe(true);
    expect(await needs(true, { ...asked, draft: true })).toBe(false);
    expect(await needs(true, { ...asked, user: { login: "me" } })).toBe(false);
    expect(await needs(false, asked)).toBe(false); // /user degraded → never claims a review is mine
  });
});
