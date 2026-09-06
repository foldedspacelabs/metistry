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
      json: async () => [
        { number: 7, title: "fix brief tz", state: "open", html_url: "", updated_at: "2026-09-01T00:00:00Z", assignee: { login: "mattcolf" } },
        { number: 9, title: "ios plan", state: "open", pull_request: {}, html_url: "", updated_at: "2026-09-02T00:00:00Z", milestone: { due_on: "2026-09-10T00:00:00Z" } },
      ],
    })) as unknown as typeof fetch;
    const n = await run(db, { githubToken: "t", githubRepos: ["foldedspacelabs/metistry"], fetchFn });
    const inserts = db.q.filter((x) => x.text.startsWith("INSERT INTO work"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.values).toContain("gh:foldedspacelabs/metistry#7");
    expect(inserts[0]!.values).toContain("issue");
    expect(inserts[1]!.values).toContain("pr");
    expect(inserts[1]!.values).toContain("2026-09-10");
    const close = db.q.find((x) => x.text.startsWith("UPDATE work"))!;
    expect(close.values[1]).toEqual(["gh:foldedspacelabs/metistry#7", "gh:foldedspacelabs/metistry#9"]);
    expect(n).toBe(3); // 2 upserts + 1 closed
  });

  it("surfaces API failure as an error (the runner records it), never silent", async () => {
    const db = fakeDb();
    const fetchFn = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(run(db, { githubToken: "bad", githubRepos: ["o/r"], fetchFn })).rejects.toThrow(/HTTP 401/);
  });
});
