// Collectors become syncs bound to a connection and its secret (T4-11):
// github-state reads the `github` connection, devin-sessions and
// devin-knowledge the `devin` one — each through the console's own opener
// (`instanceSyncOpener`) over a scratch instance under os.tmpdir(), so the
// token is a `{{ secret.x }}` reference filled at the connection's egress
// door for its listed hosts, granted to `connection:<name>`, and never
// handed to the collector. The legacy env keys still work, for one release,
// when no connection is there — and are ignored when one is.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { instanceSyncOpener } from "@foldedspacelabs/metistry-connections";
import { githubAccess, run as githubRun } from "../github-state/run.js";
import { devinAccess, run as knowledgeRun } from "../devin-knowledge/run.js";
import { run as sessionsRun } from "../devin-sessions/run.js";

const SEED_DIR = fileURLToPath(new URL("../../seed", import.meta.url));
// key shapes built at run time, so no key-shaped literal is in the tree
const GH_KEY = ["gh" + "p", "Tr5Wq8Zx2Cv7Bn4Ml1Kj6Hg3Fd9Sa0Po2"].join("_");
const DEVIN_KEY = ["cog", "Tr5Wq8Zx2Cv7Bn4Ml1Kj6Hg3Fd9Sa0Po2"].join("_");
const ENV = { METISTRY_SECRET_GITHUB_TOKEN: GH_KEY, METISTRY_SECRET_DEVIN_API_KEY: DEVIN_KEY };

const GITHUB = (url = "https://api.github.com", repos = "o/r") => `name: github
type: tracker
provider: github
reach:
  http:
    url: ${url}
    auth: { scheme: bearer, secret: github_token }
secrets: [github_token]
config: { repos: "${repos}" }
`;
const DEVIN = `name: devin
type: agent
provider: devin
reach:
  http:
    url: https://api.devin.ai
    auth: { scheme: bearer, secret: devin_api_key }
secrets: [devin_api_key]
config: { org: org-abc, repos: "o/wiki" }
`;
const SECRETS = (githubGrant = "on") => `secrets:
  github_token:
    hosts: [api.github.com]
    grants: { "connection:github": ${githubGrant} }
  devin_api_key:
    hosts: [api.devin.ai, mcp.devin.ai]
    grants: { "connection:devin": on }
`;

function instance(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "metistry-connection-syncs-"));
  mkdirSync(join(dir, ".metistry", "connections"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, ".metistry", rel), text);
  return dir;
}

interface Sent {
  method: string;
  url: string;
  authorization: string | null;
}

function fakeServices(sent: Sent[]) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ method: init.method ?? "GET", url, authorization: new Headers(init.headers).get("authorization") });
    if (url.endsWith("/user")) return Response.json({ login: "owner" });
    if (url.includes("/issues?state=open")) return Response.json([{ number: 7, title: "a thing", state: "open", html_url: "https://github.com/o/r/issues/7", updated_at: "2026-09-30T00:00:00Z", user: { login: "someone" } }]);
    if (url.includes("/knowledge/notes")) return Response.json({ items: [], has_next_page: false });
    if (url.includes("/sessions/")) return Response.json({ session_id: "s-1", status: "running", status_detail: "working" });
    return Response.json({});
  }) as typeof fetch;
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const q: string[] = [];
  return {
    q,
    async query(text: string) {
      q.push(text);
      if (text.includes("FROM work") && text.includes("LIKE $1") && text.includes("in_progress")) return { rows };
      if (text.startsWith("INSERT INTO work")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

const opener = (dir: string, sent: Sent[]) => instanceSyncOpener({ instanceDir: dir, seedDir: SEED_DIR, env: ENV, fetch: fakeServices(sent) });

describe("github-state reads the github connection", () => {
  it("the token is filled at the door for api.github.com, the repos are the connection's — and the legacy env token is not used", async () => {
    const sent: Sent[] = [];
    const dir = instance({ "connections/github.yaml": GITHUB(), "secrets.yaml": SECRETS() });
    const db = fakeDb();
    // a legacy token and repo beside it: the connection wins
    const n = await githubRun(db, { openSync: opener(dir, sent), githubToken: "legacy-token", githubRepos: ["legacy/repo"] });
    expect(n).toBeGreaterThan(0);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(new URL(s.url).origin).toBe("https://api.github.com");
      expect(s.authorization).toBe(`Bearer ${GH_KEY}`);
      expect(s.method).toBe("GET");
    }
    expect(sent.some((s) => s.url.includes("/repos/o/r/issues"))).toBe(true);
    expect(sent.some((s) => s.url.includes("legacy/repo"))).toBe(false);
  });

  it("a token not granted to the connection sends nothing and fails the run — it never falls back to the env token", async () => {
    const sent: Sent[] = [];
    const dir = instance({ "connections/github.yaml": GITHUB(), "secrets.yaml": SECRETS("off") });
    await expect(githubRun(fakeDb(), { openSync: opener(dir, sent), githubToken: "legacy-token", githubRepos: ["o/r"] })).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it("a connection pointed anywhere but api.github.com, or a repo that is not owner/repo, is refused before anything is sent", async () => {
    const sent: Sent[] = [];
    await expect(githubRun(fakeDb(), { openSync: opener(instance({ "connections/github.yaml": GITHUB("https://github.example"), "secrets.yaml": SECRETS() }), sent) })).rejects.toThrow(/reached at https:\/\/api\.github\.com and nowhere else/);
    await expect(githubAccess({ openSync: opener(instance({ "connections/github.yaml": GITHUB(undefined, "o/r, ../x"), "secrets.yaml": SECRETS() }), sent) })).rejects.toThrow(/config\.repos must be owner\/repo/);
    expect(sent).toEqual([]);
  });

  it("no github connection: the legacy env token still reads, for one release", async () => {
    const sent: Sent[] = [];
    const a = await githubAccess({ openSync: opener(instance({}), sent), githubToken: "legacy-token", githubRepos: ["o/r"] });
    expect(a).toMatchObject({ authorization: "Bearer legacy-token", repos: ["o/r"] });
    expect(a?.connection).toBeUndefined();
    expect(await githubAccess({ openSync: opener(instance({}), sent) })).toBeNull(); // nothing at all: degrades absent
  });
});

describe("devin-sessions and devin-knowledge read the devin connection", () => {
  it("both syncs find the one Devin connection; its org and repos are its config; the key is filled at the door", async () => {
    const sent: Sent[] = [];
    const dir = instance({ "connections/devin.yaml": DEVIN, "secrets.yaml": SECRETS() });
    const k = await devinAccess({ openSync: opener(dir, sent), devinApiKey: "legacy" }, "devin-knowledge", ["https://mcp.devin.ai"]);
    expect(k).toMatchObject({ connection: "devin", orgId: "org-abc", repos: ["o/wiki"], base: "https://api.devin.ai", authorization: "Bearer {{ secret.devin_api_key }}" });
    // the wikis' origin is reachable because this code names it; the key is filled there too
    await k!.fetch("https://mcp.devin.ai/mcp", { headers: { authorization: k!.authorization } });
    expect(sent.at(-1)).toMatchObject({ url: "https://mcp.devin.ai/mcp", authorization: `Bearer ${DEVIN_KEY}` });
    const s = await devinAccess({ openSync: opener(dir, sent) }, "devin-sessions");
    expect(s?.connection).toBe("devin");
    // the sessions poller names no further origin, so it reaches api.devin.ai alone
    await expect(s!.fetch("https://mcp.devin.ai/mcp", { headers: { authorization: s!.authorization } })).rejects.toMatchObject({ code: "other_host" });
  });

  it("devin-knowledge lists notes through the door", async () => {
    const sent: Sent[] = [];
    const dir = instance({ "connections/devin.yaml": DEVIN.replace('repos: "o/wiki"', 'repos: ""'), "secrets.yaml": SECRETS() });
    await knowledgeRun(fakeDb(), { openSync: opener(dir, sent), inboxDir: mkdtempSync(join(tmpdir(), "metistry-inbox-")) });
    expect(sent.map((s) => [s.url.split("?")[0], s.authorization])).toEqual([["https://api.devin.ai/v3/organizations/org-abc/knowledge/notes", `Bearer ${DEVIN_KEY}`]]);
  });

  it("devin-sessions polls a session with the connection it was dispatched through — and leaves another connection's rows alone", async () => {
    const sent: Sent[] = [];
    const dir = instance({ "connections/devin.yaml": DEVIN, "secrets.yaml": SECRETS() });
    const row = (id: number, connection?: string) => ({
      id,
      title: `t${id}`,
      external_ref: `devin:s-${id}`,
      meta: { devin: { session_id: `s-${id}`, org: "org-abc", url: "u", max_acu: 5, purpose: "work", target: connection ?? "devin-sessions", dispatch_run_id: 1, ...(connection ? { connection } : {}) } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await sessionsRun(fakeDb([row(1, "devin"), row(2, "other-devin"), row(3)]) as never, { openSync: opener(dir, sent) });
    expect(sent.map((s) => s.url)).toEqual(["https://api.devin.ai/v3/organizations/org-abc/sessions/s-1", "https://api.devin.ai/v3/organizations/org-abc/sessions/s-3"]);
    expect(sent.every((s) => s.authorization === `Bearer ${DEVIN_KEY}`)).toBe(true);
  });
});
