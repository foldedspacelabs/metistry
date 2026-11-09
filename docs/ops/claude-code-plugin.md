# Claude Code plugin — capture from any session

`plugins/claude-code/` is the `metistry` Claude Code plugin (plan §4.11,
"External agents"): a skill that pushes decisions/findings/notes to
`POST /capture`, and an opt-in `SessionEnd` hook that posts a session
summary. Full usage is in `plugins/claude-code/README.md`; this page is
the operator's checklist.

## 1. Mint a capture token per machine/profile

`metistry connect claude-code` does this for you (docs/ops/cli.md), in both
directions: it registers `claude-code` as an external agent, puts the bearer in
the login Keychain, registers the console's `/mcp` with Claude Code at user
scope (`claude mcp add --scope user`, the header `Bearer
${METISTRY_AGENT_TOKEN_CLAUDE_CODE}` — Claude Code expands the variable, so the
value is never written to a file) so a session can *read* the vault as well as
capture to it, and prints the `export` lines in §2 with the account filled in.
`metistry connect --list` shows both halves. It does **not** install the
plugin — §3 still does. If `claude` is not on the PATH it prints the `claude mcp
add` line instead of running it.
`metistry connect --remove claude-code` is the way back: it revokes the row,
removes the `/mcp` entry (`claude mcp remove --scope user`) and deletes the
Keychain item — delete the `export` lines from your profile yourself;
`metistry connect claude-code` again registers it afresh, a new token and
default-deny grants. The rest of this section is the by-hand path, and the
owner-token alternative.

On the Studio, one owner token per place the plugin runs — label them so
revocation is surgical:

```bash
docker compose exec -e METISTRY_ORIGIN=https://<origin> console node scripts/enroll.mjs --owner-token "claude-code mbp personal"
```

Owner tokens are capture + messages only (CRIT-7); they cannot reach
management endpoints. Revoke:

```sql
UPDATE owner_tokens SET revoked_at = now() WHERE label = 'claude-code mbp personal';
```

## 2. Configure the session's environment

```bash
export METISTRY_URL=https://<origin>
export METISTRY_OWNER_TOKEN=<token>
# the console's /mcp, if you registered it with `metistry connect claude-code`
# (the printed lines also set this one, from the same Keychain item):
export METISTRY_AGENT_TOKEN_CLAUDE_CODE=<token>
# optional, default off:
export METISTRY_CAPTURE_ON_STOP=1
```

Or per Claude Code profile in `~/.claude/settings.json` under `env`.
Nothing is read from files in the repo; the plugin ships no config.

**Instance split.** A Claude Code profile for the second context gets the
*second* instance's URL and a token minted *there*; the profile for the first
instance gets the first instance's pair. The plugin cannot route to more than
one instance, so a context can only land in its own vault (§4.11, §4.16).

## 3. Install

```
/plugin marketplace add foldedspacelabs/metistry
/plugin install metistry@metistry
```

or `claude --plugin-dir <checkout>/plugins/claude-code` while developing.
Validate a checkout with `claude plugin validate plugins/claude-code`.

## 4. What lands where

Every capture is a `POST /capture` JSON body `{ note, filename }`:
file in `Inbox/` (in the vault, where Obsidian sees it —
`docs/ops/inbox.md`), row in `inbox` (`source = 'http'`), a `runs` row
(`component: console, kind: capture`). Provenance is in the note's
frontmatter (`source: "claude-code"`, `session_id`, `host`, `repo`,
`cwd`, `captured_at`, `kind`), so Needs You and the morning brief can weight
by origin. Filenames are `claude-code-<kind>-<UTC stamp>.md`.

### The session summary is the same shape `metistry import-sessions` sends

Since 2026-09-09 the `SessionEnd` hook emits frontmatter `kind: "session"`
with an `idempotency_key`, exactly like the CLI's back-fill verb
(`docs/ops/cli.md`, "Importing Claude Code sessions") — the two doors
compute the same key for the same session state, so the server can dedupe
across them, and `inbox-drain` classifies both as `session`. Its body is the
same deterministic summary (turns, duration, tools with counts, files
touched, first prompt, last response); no model is called, and a transcript
is never posted. Filenames are
`claude-code-session-<UTC stamp>-<session id prefix>.md`.

**The return path (CM-4).** The reconciler reads every session note back
into `vault_sessions` — date, tool, repo, branch, turns, files touched and
your first prompt clipped — and the named query `recent_sessions {repo,
days}` serves them, newest first, for one checkout basename. Handles only:
the note's `## Last response` is never parsed, a session is served only
once the knowledge fold has read it, and a session an agent credential
captured is never served as yours (`docs/ops/reconciler.md`, "Project repos
and captured sessions"). The query is `expose: route` — your first prompt
and your files are owner text and vault paths — so no agent reaches it
through `queries_run`. Its consumer is the session-start briefing, `GET
/api/briefing` (X-128, `docs/ops/client-api.md`): handles plus the owner's
own text, under the caller's grant, on by default for every agent with a
read grant and opt-out per agent (`briefing: false` in its grants). The
plugin's SessionStart hook is what calls it (§5).

**Who is handed what (Context Mode Q3, ruled 2026-10-04).** A session the
fold has read goes to any agent whose grant allows it. A session still
waiting for the fold goes only to an agent in the **same project** as the
repository. The query alone cannot tell who is asking, so its default is the
safe arm (`unfolded: false`: folded sessions only), and the briefing calls
core's `recentSessionsForCaller` instead of the query:

0. **`repo` must agree with `remote`.** The checkout's basename is the last
   segment of the remote (`github.com/org/Metistry` -> `metistry`,
   case-insensitive; core's `repoAgreesWithRemote`). Membership is proved
   against the remote while sessions are selected by the basename, so
   without this tie an agent in project A could send A's remote with another
   checkout's name and be handed that checkout's waiting sessions. When they
   disagree, the function does not even resolve a project: folded sessions
   only. A checkout the owner named differently from its remote gets the
   folded arm for the same reason.
1. `project_for_repo {remote}` (X-130) resolves the repository to the one
   project page that claims it — or none, or *ambiguous*, which is none.
2. The page's file name is the project slug (`Projects/Drey Mascot.md` →
   `drey-mascot`, core's `projectSlugForPage`); the agent is in the project
   when that slug is in its `agents.projects`. **`callerProjects` must be read
   from the authenticated agent's record (`agents.projects`), never from the
   request** (body, query string, header): a caller that names its own
   projects can name any.
3. Only then does it ask `recent_sessions` with `unfolded: true`, and it drops
   any row still waiting for the fold whenever step 2 did not hold. No
   remote, no page, no membership: folded sessions only.
4. Every row is copied through a fixed list of fields (`SessionHandle`:
   path, date, tool, repo, branch, turns, files, the owner's first prompt
   clipped, `folded`), so no agent-written text can ride along — not the
   `## Last response`, which has no column, and not a field an instance
   overlay might add to the query. The caller's knowledge grant narrows the
   result by path (`canSee`).

A session captured by an agent credential is on neither arm. Limits worth
knowing: a session names its checkout by basename, not by remote, so two
checkouts with the same directory name share one `repo` match. The agreement
rule above narrows this for generic names (`app`, `web`): the unfolded arm
opens only when the remote itself ends in that name. And the slug rule folds
`Drey Mascot.md`, `Drey-Mascot.md` and `drey_mascot.md` into one project
(`drey-mascot`); the pages are owner-named, so the impact is low, and an
explicit `project:` frontmatter on the page is a candidate ruling for the
owner, not built here.

The summariser exists twice on purpose: the plugin ships as dependency-free
`.mjs` a stranger runs out of `~/.claude/plugins`, so it cannot import
`@foldedspacelabs/metistry-core`, which is what the CLI uses.
`plugins/claude-code/test/session-parity.test.ts` reads the same fixture
through both and fails the build the moment they disagree — so edit
`scripts/lib.mjs` and `packages/core/src/session-summary.ts` together.

## 5. The session-start briefing (X-129)

The plugin's `SessionStart` hook hands each new session what the instance
already knows about the project it was opened in: the project page for the
checkout, its open tasks, the owner's recent sessions there and the evening
folds that name it. The console assembles it (`GET /api/briefing`,
`docs/ops/client-api.md`, X-128) as handles plus the owner's own text, under
this agent's grant, with no model; the hook only asks and injects.

**On by default; opt out per agent.** Every agent with a read grant is served
(the owner's ruling of 2026-10-04). To opt this agent out:

```sh
metistry connect claude-code --briefing off     # --briefing on takes it back
```

The opt-out is `briefing: false` in the agent's grants **on the console**, so an
opted-out agent is answered the empty briefing and the hook injects nothing —
the plugin could be edited or stale and still not read what was withheld.
`METISTRY_BRIEFING=off` in a profile's environment silences the hook for that
profile alone, without a request. A new agent has no read grant until
`--areas` widens it, and is served nothing until then.

**What the hook does**, in `plugins/claude-code/scripts/session-start.mjs`:

1. Runs on `SessionStart` with source `startup` or `clear` (a fresh context).
   A `resume` already holds its briefing in the transcript and a `compact`
   keeps its summary, so neither asks.
2. Claims the session: an exclusive marker file under the system temp
   directory, named by a hash of the session id, so a second run for the same
   session — a re-fired hook, two panes racing — exits silently. A failed fetch
   spends the claim too: there is no retry mid-session, and the console is
   asked **once** (the cached prompt prefix is never churned).
3. Sends `GET {METISTRY_URL}/api/briefing?repo=<checkout basename>&remote=<origin>`
   with the agent bearer in the `Authorization` header — from
   `METISTRY_AGENT_TOKEN_CLAUDE_CODE`, else `METISTRY_OWNER_TOKEN` (which
   `connect`'s printed lines set to the same agent bearer; a real owner token
   is refused by the console, and the hook injects nothing). The remote has
   any `user:token@` stripped before it is sent, redirects are not followed,
   and the fetch is capped at 5 s.
4. Prints the briefing's `text` as the hook's `additionalContext`. An empty
   briefing (opted out, no read grant, nothing known) prints nothing.

A **git worktree** has the checkout name of its directory
(`metistry-x-129`), not of the repository; the console's rule that `repo` must
agree with `remote` then withholds the unfolded-sessions arm for it. Folded
sessions, tasks and the project page — found by remote — are unaffected.

Misuse tests (`plugins/claude-code/test/briefing.test.ts`) hold the hook to:
an opted-out agent's session starts with nothing injected; a console that
does not answer (refused, 401/403/500, not JSON, a redirect) injects nothing
and exits 0; the bearer is in no argv, URL, stdout or stderr — even when the
server echoes it back; the hook never delivers twice for one session id.
OpenCode gets the same briefing through its system-prompt transform
(`docs/ops/opencode.md`); Cursor and Devin do not deliver it yet.

## 6. Failure modes

- Missing env / unreachable instance: the **skill** exits 1 with a
  redacted one-line reason (Claude reports it; nothing retried). The
  **hooks** exit 0 with at most one stderr line — they never block or fail
  the session. The briefing hook is silent when `METISTRY_URL` or the token
  is not set (a profile that never ran `connect`), and logs
  `session briefing skipped: …` for a console that is down or refuses.
- The token never appears in output; both scripts pass every message
  through a redactor before printing.
- `SessionEnd` hooks share a short time budget in Claude Code; the hook
  caps its own request at 8 s. A slow tailnet path means the summary is
  simply dropped, with the stderr line as the only trace.
