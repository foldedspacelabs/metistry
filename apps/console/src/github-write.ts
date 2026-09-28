// The owner's GitHub client — the only thing in the product that writes to
// GitHub (plan §2.11's PR review row; ticket T2-13).
//
// It holds the owner's `github_write` secret: a fine-grained PAT with
// pull-request write the owner minted and stored (§3.4). Who can reach it is
// the whole of its security, so it is decided by construction, not by care:
//
//   * **Only the owner's PR doors hold it.** `main.ts` builds one and hands
//     it to `makeServer` as `cfg.githubWrite`; the only code that reads that
//     field is `github-pulls-route.ts`, reached behind the console's gate at
//     reach `owner` — an agent bearer and the capture owner token are refused
//     before it runs, and the MCP mount (`/mcp`) is handed nothing of it. The
//     `github-state` sync reads GitHub with its own read-only token and never
//     sees this one (collectors/github-state/run.ts).
//   * **One host.** Every call goes to https://api.github.com, built here from
//     a path — no caller hands it a URL — with `redirect: "manual"`, and a
//     redirect is refused rather than followed with the token on it.
//   * **The secret's own policy still binds.** The value is filled only while
//     `.metistry/secrets.yaml` lists `api.github.com` on `github_write`'s
//     *Sent only to* list (§2.14), read afresh per call; without it nothing is
//     sent. It has no *Who may use it* line to check: that list grants a
//     secret to connections and agents, and this is neither — it is the
//     owner's own secret, posting as the owner, through the owner's door
//     (Settings ▸ Secrets draws it "GitHub · you only").
//   * **Where the value comes from.** The console never reads the Keychain:
//     `metistry secrets sync --to env` delivers `github_write` as
//     `METISTRY_SECRET_GITHUB_WRITE` when `secrets.yaml` names it, exactly as
//     it delivers a sync-read connection's key (packages/connections
//     `envSecretSource`). Read per call, so a replaced secret lands on the
//     next restart without code.
//   * **Nothing of it comes back.** Every message that leaves this file — a
//     refusal, GitHub's own error text — goes through a `SecretRedactor` that
//     has learned the value.

import {
  GITHUB_API_ORIGIN,
  GITHUB_WRITE_SECRET,
  SecretRedactor,
  egressDestination,
  type ErrorCode,
  type SecretSource,
  type SecretsFile,
} from "@foldedspacelabs/metistry-core";

/** A refusal from this client or from GitHub, as the door answers it. Its message is redacted. */
export class GithubWriteError extends Error {
  override readonly name = "GithubWriteError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** whether the secret left before this refusal — GitHub saw it (Settings ▸ Secrets' *last used*) */
    readonly sent = false,
    /** GitHub's own HTTP status, when it was GitHub that refused */
    readonly upstream?: number,
  ) {
    super(message);
  }
}

export interface GithubWriteOptions {
  /** where `github_write`'s value comes from — the console's environment (`envSecretSource(process.env)`) */
  secrets: SecretSource;
  /** `.metistry/secrets.yaml` as it stands now; undefined = this deployment has no instance to read one from */
  policy: () => Promise<SecretsFile | undefined>;
  /** the base fetch (a test's fake GitHub; default global fetch) */
  fetch?: typeof fetch | undefined;
}

/** A pull request as a door checks it before it posts. */
export interface PullState {
  state: string; // open | closed
  merged: boolean;
  head_sha: string;
  url: string | null;
}

/** A review thread as a door checks it: which PR it belongs to, and that PR's head now. */
export interface ThreadState {
  id: string;
  resolved: boolean;
  repo: string;
  number: number;
  state: string; // the PR's: OPEN | CLOSED | MERGED
  head_sha: string;
}

const HOST = new URL(GITHUB_API_ORIGIN).host;
const MESSAGE_CHARS = 300; // limit: fixed — GitHub's own words in a refusal, never a page of them
const TIMEOUT_MS = 30_000; // limit: fixed — a door the owner is waiting on

const NOT_DELIVERED =
  `${GITHUB_WRITE_SECRET} is not delivered to this console — store it (\`metistry secrets set ${GITHUB_WRITE_SECRET} --hosts ${HOST}\`, a fine-grained token with pull-request write), ` +
  "then `metistry secrets sync --to env` and restart the console";

/** The one GraphQL document that reads a thread before a door writes to it. */
export const THREAD_STATE_QUERY = `query MetistryThreadState($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id isResolved
      pullRequest { number state headRefOid repository { nameWithOwner } }
    }
  }
}`;
export const REPLY_MUTATION = `mutation MetistryThreadReply($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { databaseId url } }
}`;
export const RESOLVE_MUTATION = `mutation MetistryThreadResolve($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

export class GithubWriteClient {
  private readonly redactor = new SecretRedactor();
  private readonly base: typeof fetch;

  constructor(private readonly opts: GithubWriteOptions) {
    this.base = opts.fetch ?? fetch;
  }

  /** `GET /repos/{repo}/pulls/{n}` — the PR as it stands, to check the head the owner was shown. */
  async pull(repo: string, number: number): Promise<PullState> {
    const j = (await this.rest("GET", `/repos/${repo}/pulls/${number}`)) as { state?: unknown; merged?: unknown; merged_at?: unknown; head?: { sha?: unknown }; html_url?: unknown };
    if (typeof j.head?.sha !== "string" || typeof j.state !== "string") throw new GithubWriteError("not_available", `GitHub's answer for ${repo}#${number} has no head`, true);
    return { state: j.state, merged: j.merged === true || typeof j.merged_at === "string", head_sha: j.head.sha, url: typeof j.html_url === "string" ? j.html_url : null };
  }

  /** `POST /repos/{repo}/pulls/{n}/reviews`, pinned to `commit_id` — GitHub reviews that commit or refuses. */
  async review(repo: string, number: number, review: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }): Promise<{ id: number; url: string | null }> {
    const j = (await this.rest("POST", `/repos/${repo}/pulls/${number}/reviews`, review)) as { id?: unknown; html_url?: unknown };
    if (typeof j.id !== "number") throw new GithubWriteError("not_available", "GitHub's answer to the review has no id", true);
    return { id: j.id, url: typeof j.html_url === "string" ? j.html_url : null };
  }

  /** A review thread by its node id, with its PR's head — null when there is no such thread this token can see. */
  async thread(id: string): Promise<ThreadState | null> {
    const d = (await this.graphql(THREAD_STATE_QUERY, { id }, { missingIsNull: true })) as {
      node?: { id?: unknown; isResolved?: unknown; pullRequest?: { number?: unknown; state?: unknown; headRefOid?: unknown; repository?: { nameWithOwner?: unknown } } } | null;
    } | null;
    const n = d?.node;
    const pr = n?.pullRequest;
    if (!n || typeof n.id !== "string" || !pr || typeof pr.number !== "number" || typeof pr.headRefOid !== "string" || typeof pr.repository?.nameWithOwner !== "string") return null;
    return { id: n.id, resolved: n.isResolved === true, repo: pr.repository.nameWithOwner, number: pr.number, state: typeof pr.state === "string" ? pr.state : "OPEN", head_sha: pr.headRefOid };
  }

  async replyToThread(id: string, body: string): Promise<{ comment_id: number | null; url: string | null }> {
    const d = (await this.graphql(REPLY_MUTATION, { id, body })) as { addPullRequestReviewThreadReply?: { comment?: { databaseId?: unknown; url?: unknown } | null } | null } | null;
    const c = d?.addPullRequestReviewThreadReply?.comment;
    return { comment_id: typeof c?.databaseId === "number" ? c.databaseId : null, url: typeof c?.url === "string" ? c.url : null };
  }

  async resolveThread(id: string): Promise<{ resolved: boolean }> {
    const d = (await this.graphql(RESOLVE_MUTATION, { id })) as { resolveReviewThread?: { thread?: { isResolved?: unknown } | null } | null } | null;
    return { resolved: d?.resolveReviewThread?.thread?.isResolved === true };
  }

  // ---- the one way out ------------------------------------------------------

  private async rest(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.send(method, path, body);
    return this.json(res, path);
  }

  private async graphql(query: string, variables: Record<string, unknown>, o: { missingIsNull?: boolean } = {}): Promise<unknown> {
    const res = await this.send("POST", "/graphql", { query, variables });
    const j = (await this.json(res, "/graphql")) as { data?: unknown; errors?: { type?: string; message?: string }[] };
    if (j.errors?.length) {
      if (o.missingIsNull && j.errors.every((e) => e.type === "NOT_FOUND")) return null;
      const words = j.errors.map((e) => e.message ?? e.type ?? "error").join("; ");
      throw new GithubWriteError(j.errors.some((e) => e.type === "NOT_FOUND") ? "not_found" : "invalid_request", this.say(`GitHub refused it: ${words}`), true);
    }
    return j.data ?? null;
  }

  /** The secret's *Sent only to* list, read now: `api.github.com` must be on it, or nothing leaves. */
  private async sendable(): Promise<void> {
    const file = await this.opts.policy();
    const policy = file && Object.hasOwn(file.secrets, GITHUB_WRITE_SECRET) ? file.secrets[GITHUB_WRITE_SECRET] : undefined;
    if (!policy) throw new GithubWriteError("not_available", NOT_DELIVERED);
    const dest = egressDestination(GITHUB_API_ORIGIN)!.entry;
    if (!policy.hosts.includes(dest)) {
      throw new GithubWriteError("not_available", `${GITHUB_WRITE_SECRET} may not be sent to ${dest} — it is not on the secret's *Sent only to* list (\`metistry secrets hosts ${GITHUB_WRITE_SECRET} ${dest}\`); nothing was sent`);
    }
  }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    await this.sendable();
    const token = await this.opts.secrets.value(GITHUB_WRITE_SECRET);
    if (!token) throw new GithubWriteError("not_available", NOT_DELIVERED);
    this.redactor.learn(GITHUB_WRITE_SECRET, token);
    const url = new URL(path, GITHUB_API_ORIGIN);
    if (url.origin !== GITHUB_API_ORIGIN) throw new GithubWriteError("invalid_request", "not a GitHub API path"); // a path is built here, never handed in; belt and braces
    let res: Response;
    try {
      res = await this.base(url.href, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "metistry-console",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GithubWriteError("not_available", this.say(`GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`), true);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new GithubWriteError("not_available", `GitHub answered with a redirect (HTTP ${res.status}) — a redirect is not followed with the token on it; nothing more was sent`, true, res.status);
    }
    return res;
  }

  private async json(res: Response, path: string): Promise<unknown> {
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let words = "";
      try {
        const j = JSON.parse(text) as { message?: unknown; errors?: { message?: unknown }[] };
        words = [typeof j.message === "string" ? j.message : "", ...(j.errors ?? []).map((e) => (typeof e.message === "string" ? e.message : ""))].filter(Boolean).join("; ");
      } catch {
        // not JSON: say the status only
      }
      const said = this.say(words ? `GitHub refused it (HTTP ${res.status}): ${words}` : `GitHub refused it (HTTP ${res.status})`);
      throw new GithubWriteError(codeFor(res), res.status === 401 ? `${said} — the ${GITHUB_WRITE_SECRET} token was not accepted: \`metistry secrets replace ${GITHUB_WRITE_SECRET}\`` : said, true, res.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GithubWriteError("not_available", `GitHub's answer to ${path} is not JSON`, true, res.status);
    }
  }

  /** Redacted and clipped: GitHub's words may quote what they were sent. */
  private say(message: string): string {
    const m = this.redactor.redactText(message);
    return m.length > MESSAGE_CHARS ? `${m.slice(0, MESSAGE_CHARS - 1)}…` : m;
  }
}

/** GitHub's status, as the door's own code: its 404 and 422 are the request's; a refused or missing credential, a limit or an outage is the deployment's. */
function codeFor(res: Response): ErrorCode {
  if (res.status === 404) return "not_found";
  if (res.status === 422 || res.status === 400) return "invalid_request";
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return "rate_limited";
  return "not_available";
}
