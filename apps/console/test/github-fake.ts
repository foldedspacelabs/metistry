// A fake api.github.com for the pull request doors (T2-13): the REST and
// GraphQL calls `GithubWriteClient` makes, answered from a state a test moves,
// and every request recorded — so a test can say "nothing was posted" by
// counting, and read exactly what would have been. Never a network.
import { parseSecretsFile, type SecretsFile } from "@foldedspacelabs/metistry-core";
import { GithubWriteClient } from "../src/github-write.js";

export interface FakePull {
  repo: string;
  number: number;
  head: string;
  state: "open" | "closed";
  merged?: boolean;
}

export interface FakeThread {
  id: string;
  repo: string;
  number: number;
  resolved: boolean;
}

export interface SentCall {
  method: string;
  path: string;
  authorization: string | null;
  body: any;
}

export interface FakeGithub {
  pulls: Map<string, FakePull>;
  threads: Map<string, FakeThread>;
  calls: SentCall[];
  /** the next write GitHub refuses, with its status and message */
  refuseNext: { status: number; message: string } | null;
  fetch: typeof fetch;
  /** the writes only — a review, a reply, a resolve */
  writes(): SentCall[];
}

export function fakeGithub(): FakeGithub {
  const g: FakeGithub = {
    pulls: new Map(),
    threads: new Map(),
    calls: [],
    refuseNext: null,
    writes: () => g.calls.filter((c) => (c.method === "POST" && c.path !== "/graphql") || (c.path === "/graphql" && /^\s*mutation/.test(String(c.body?.query ?? "")))),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const call: SentCall = { method: init?.method ?? "GET", path: url.pathname, authorization: headers.get("authorization"), body };
      g.calls.push(call);
      const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (url.origin !== "https://api.github.com") return json(599, { message: "not GitHub" });
      const refuse = () => {
        const r = g.refuseNext;
        g.refuseNext = null;
        return r ? json(r.status, { message: r.message }) : null;
      };
      const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/reviews)?$/.exec(url.pathname);
      if (m) {
        const pr = g.pulls.get(`${m[1]}#${m[2]}`);
        if (!pr) return json(404, { message: "Not Found" });
        if (!m[3]) return json(200, { number: pr.number, state: pr.state, merged: pr.merged ?? false, head: { sha: pr.head }, html_url: `https://github.com/${pr.repo}/pull/${pr.number}` });
        if (call.method !== "POST") return json(405, { message: "no" });
        const refused = refuse();
        if (refused) return refused;
        if (body?.commit_id !== pr.head) return json(422, { message: "Unprocessable Entity", errors: [{ message: "commit_id is not part of the pull request" }] });
        return json(200, { id: 991, state: body.event === "APPROVE" ? "APPROVED" : body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", html_url: `https://github.com/${pr.repo}/pull/${pr.number}#pullrequestreview-991` });
      }
      if (url.pathname === "/graphql") {
        const q = String(body?.query ?? "");
        const v = (body?.variables ?? {}) as Record<string, string>;
        const t = v.id ? g.threads.get(v.id) : undefined;
        if (/^\s*query/.test(q)) {
          if (!t) return json(200, { data: { node: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${v.id}'` }] });
          const pr = g.pulls.get(`${t.repo}#${t.number}`)!;
          return json(200, { data: { node: { id: t.id, isResolved: t.resolved, pullRequest: { number: pr.number, state: pr.state === "open" ? "OPEN" : pr.merged ? "MERGED" : "CLOSED", headRefOid: pr.head, repository: { nameWithOwner: pr.repo } } } } });
        }
        const refused = refuse();
        if (refused) return refused;
        if (!t) return json(200, { data: null, errors: [{ type: "NOT_FOUND", message: "no such thread" }] });
        if (/addPullRequestReviewThreadReply/.test(q)) return json(200, { data: { addPullRequestReviewThreadReply: { comment: { databaseId: 5512, url: `https://github.com/${t.repo}/pull/${t.number}#discussion_r5512` } } } });
        if (/resolveReviewThread/.test(q)) {
          t.resolved = true;
          return json(200, { data: { resolveReviewThread: { thread: { id: t.id, isResolved: true } } } });
        }
      }
      return json(404, { message: "Not Found" });
    }) as typeof fetch,
  };
  return g;
}

/** `secrets.yaml` with `github_write` sent to `hosts`. */
export const writePolicy = (hosts: string[] = ["api.github.com"]): SecretsFile =>
  parseSecretsFile(`secrets:\n  github_write:\n    hosts: [${hosts.join(", ")}]\n`);

/** The owner's client over the fake, with a token and a policy a test can move. */
export function fakeWriteClient(g: FakeGithub, o: { token?: () => string | undefined; policy?: () => SecretsFile | undefined } = {}): GithubWriteClient {
  return new GithubWriteClient({
    secrets: { value: async (name) => (name === "github_write" ? (o.token ? o.token() : TOKEN) : undefined) },
    policy: async () => (o.policy ? o.policy() : writePolicy()),
    fetch: g.fetch,
  });
}

/** The owner's github_write value in these tests — never on any response. */
export const TOKEN = "github_pat_11FAKEFAKEFAKE0123456789abcdefFAKEtoken";
