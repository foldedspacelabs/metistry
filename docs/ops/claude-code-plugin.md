# Claude Code plugin — capture from any session

`plugins/claude-code/` is the `metistry` Claude Code plugin (plan §4.11,
"External agents"): a skill that pushes decisions/findings/notes to
`POST /capture`, and an opt-in `SessionEnd` hook that posts a session
summary. Full usage is in `plugins/claude-code/README.md`; this page is
the operator's checklist.

## 1. Mint a capture token per machine/profile

`metistry connect claude-code` does this for you (docs/ops/cli.md): it
registers `claude-code` as an external agent, puts the bearer in the login
Keychain, and prints the two `export` lines in §2 with the account filled
in. It does **not** install the plugin — §3 still does.
`metistry connect --remove claude-code` is the way back: it revokes the row and
deletes the Keychain item (there is no file to restore — delete the `export`
lines from your profile yourself); `metistry connect claude-code` again
registers it afresh, a new token and default-deny grants. The rest of this
section is the by-hand path, and the owner-token alternative.

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
# optional, default off:
export METISTRY_CAPTURE_ON_STOP=1
```

Or per Claude Code profile in `~/.claude/settings.json` under `env`.
Nothing is read from files in the repo; the plugin ships no config.

**Instance split.** A Claude Code profile for the second context gets the
*second* instance's URL and a token minted *there*; the personal profile gets
the personal pair. The plugin cannot route to more than one instance, so a
context can only land in its own vault (§4.11, §4.16).

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
through `queries_run`; nothing reads it at session start yet, and the
consumer will be CM-1/CM-2's briefing under the caller's grant.

**Who is handed what (Context Mode Q3, ruled 2026-10-04).** A session the
fold has read goes to any agent whose grant allows it. A session still
waiting for the fold goes only to an agent in the **same project** as the
repository. The query alone cannot tell who is asking, so its default is the
safe arm (`unfolded: false`: folded sessions only), and the briefing calls
core's `recentSessionsForCaller` instead of the query:

1. `project_for_repo {remote}` (X-130) resolves the repository to the one
   project page that claims it — or none, or *ambiguous*, which is none.
2. The page's file name is the project slug (`Projects/Drey Mascot.md` →
   `drey-mascot`, core's `projectSlugForPage`); the agent is in the project
   when that slug is in its `agents.projects`.
3. Only then does it ask `recent_sessions` with `unfolded: true`, and it drops
   any row still waiting for the fold whenever step 2 did not hold. No
   remote, no page, no membership: folded sessions only.
4. Every row is copied through a fixed list of fields (`SessionHandle`:
   path, date, tool, repo, branch, turns, files, the owner's first prompt
   clipped, `folded`), so no agent-written text can ride along — not the
   `## Last response`, which has no column, and not a field an instance
   overlay might add to the query. The caller's knowledge grant narrows the
   result by path (`canSee`).

A session captured by an agent credential is on neither arm. A limit worth
knowing: a session names its checkout by basename, not by remote, so two
checkouts with the same directory name share one `repo` match; the same-project
arm is therefore as exact as the basename, and a repository the owner keeps
under two names is two repositories until a capture records its remote.

The summariser exists twice on purpose: the plugin ships as dependency-free
`.mjs` a stranger runs out of `~/.claude/plugins`, so it cannot import
`@foldedspacelabs/metistry-core`, which is what the CLI uses.
`plugins/claude-code/test/session-parity.test.ts` reads the same fixture
through both and fails the build the moment they disagree — so edit
`scripts/lib.mjs` and `packages/core/src/session-summary.ts` together.

## 5. Failure modes

- Missing env / unreachable instance: the **skill** exits 1 with a
  redacted one-line reason (Claude reports it; nothing retried). The
  **hook** exits 0 with one stderr line — it never blocks or fails the
  session.
- The token never appears in output; both scripts pass every message
  through a redactor before printing.
- `SessionEnd` hooks share a short time budget in Claude Code; the hook
  caps its own request at 8 s. A slow tailnet path means the summary is
  simply dropped, with the stderr line as the only trace.
