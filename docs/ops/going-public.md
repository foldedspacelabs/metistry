# Going public — the runbook

The one-time procedure that takes `foldedspacelabs/metistry` from private to
public. **The owner runs every step by hand**; no agent rewrites history,
force-pushes, or changes a repository setting. The order matters: the
history is scrubbed and verified before anything is pushed, and pushed and
checked before the visibility changes.

What the cleanup PR (`chore/public-cleanup`) already did at HEAD: the tailnet
host, local paths, hostnames, timezone and personal domain became example
values; the owner's name in fixtures became a fictional owner (Sam Rivera);
the subscription-token container run and the proxy-routing research note were
removed; the premium and hosted-tier text was retired; the README was
rewritten; and the repository policy files were added. This runbook removes
the same material from **history**, which a public clone would otherwise
still carry.

## 1. Merge the cleanup PR

Merge `chore/public-cleanup` once CI is green, and anything else that should
be in the public history. Everything merged after the rewrite is ordinary
work; everything merged before it goes through the filter below.

## 2. Freeze

Nothing may land on `main`, and no clone may push, between here and step 5.

```sh
env -u GH_TOKEN gh pr list --state open            # must print nothing: merge or close every PR
env -u GH_TOKEN gh run list --workflow release.yml --limit 3   # no release run in progress
cd ~/Development/Metistry && git worktree list     # only the main checkout; for each other:
git worktree remove <path>                         #   (commit or discard its work first)
git ls-remote --heads origin                       # note every remote branch (step 5 deletes the stale ones)
```

Stop every agent session, scheduled task and loop that can push to the
repository, and do not start one until step 8. Do not enable GitHub's
immutable releases before step 5 — it locks tags, and the tags must move.

## 3. Rewrite the history, in a fresh clone

`git filter-repo` (Homebrew: `git-filter-repo`, 2.47 or later) in a
directory of its own. Never in a working checkout, never with stashes or
local branches of any kind in play.

```sh
mkdir -p ~/going-public && cd ~/going-public

# The rollback copy: a bare mirror of the repository exactly as it is now.
# Keep it, untouched, for 30 days after step 7.
git clone --mirror https://github.com/foldedspacelabs/metistry.git metistry-pre-rewrite.git

# The clone that gets rewritten.
git clone https://github.com/foldedspacelabs/metistry.git metistry-rewrite

# The rules, copied OUT of the repository before the rewrite: the rewrite
# scrubs the committed example too (see "The replace-text file" below), so
# step 4 needs this pre-rewrite copy.
cp metistry-rewrite/docs/ops/going-public.replace-text.example going-public.replace-text

# Commit authorship: the address some commits were made with becomes the
# owner's GitHub noreply address.
printf '%s\n' 'Matt Colf <1252810+mattcolf@users.noreply.github.com> <1252810+mattcolf@users.noreply.github.com>' > going-public.mailmap

cd metistry-rewrite
git filter-repo --sensitive-data-removal \
  --replace-text ../going-public.replace-text \
  --replace-message ../going-public.replace-text \
  --mailmap ../going-public.mailmap \
  --path docs/research/2026-09-agent-proxy-routing.md --invert-paths
```

- `--sensitive-data-removal` fetches every ref first (so nothing hides in a
  ref outside branches and tags), and records the first changed commits in
  `.git/filter-repo/first-changed-commits` — step 6's support request needs
  that file.
- `--replace-text` rewrites every text blob in every commit;
  `--replace-message` applies the same rules to commit messages.
- `--path … --invert-paths` removes the proxy-routing research note from every
  commit, rather than rewriting its text.

### The replace-text file

`docs/ops/going-public.replace-text.example`, one rule per line. The format
has **no comment syntax** — a line starting with `#` would itself become a
rule — so the explanation lives here, by line number. Literal rules run
first, in file order; regex rules run after them.

| line | rule | why |
| --- | --- | --- |
| 1 | the assistant's contact address on the personal domain → `metistry@example.com` | the VAPID contact in the PoC-6 write-up and script; before line 3 so the whole address is replaced as one |
| 2 | `https://` + the personal domain → `https://example.com` | PoC-6's `sub` variant |
| 3 | the personal domain → `example.com` | every other mention (RESULTS.md's gateway lines, the Devin/Cursor research) |
| 4 | the Mac's tailnet host → `mac-studio.example.ts.net` | RESULTS.md, the iPhone steps, the deployment test, the deleted owner checklist |
| 5 | the tailnet's name alone → `example` | any form line 4 does not catch |
| 6 | the Mac's `.local` hostname → `example-mac.local` | PoC-3 run logs |
| 7 | the Mac's container-side hostname → `examplemac.default.internal` | PoC-3's container run |
| 8 | the home directory → `/Users/example` | PoC scripts, plists, logs, footprints, `mcp.json` |
| 9 | the home directory in its scratchpad-path form (`-Users-…-`) → `-Users-example-` | launchd plists' log paths |
| 10 | the login name in PoC-9's session dump → `example` | `grant-run.log` |
| 11 | the local timezone → `America/New_York` | PoC-9 output and the design boards |
| 12 | the commit address from the mailmap → the GitHub noreply address | this runbook's own mailmap line, so the address does not survive in a blob either |
| 13 | regex: the PoC-13 sentence describing the missed message → "missed the highest-stakes human message in the corpus" | the message's content was personal; the finding stays |
| 14 | regex: PoC-4's "COMPLETED 2026-08-28" block, from its first line through "PoC-11's domain." → nothing | the subscription setup-token run inside a container, purged entirely |

The phrase rules (13, 14) match across line breaks (`\s+`) and are written
so that the file never contains the phrase it removes; the literal rules
(1–12) rewrite their own lines in the committed example as well. After the
rewrite the committed example is inert — which is why step 3 copies it out
first.

## 4. Verify, before anything is pushed

In `~/going-public/metistry-rewrite`. **Every count must be 0.** `grep -a`
matters: the object dump holds binary blobs, and without it `grep` treats
the whole file as binary. The three phrase patterns carry a `[ ]` so they
never match their own line in this runbook.

```sh
# every literal rule's left-hand side, and a phrase from each purged passage and the removed note
sed -n 's/==>.*//p' ../going-public.replace-text | grep -v '^regex:' > ../verify-literals
printf '%s\n' 'job[ ]offer with an explicit ask' 'with a real .claude[ ]setup-token. credential' \
  'AI-agent proxies and routing[ ]layers' > ../verify-phrases

git log -p --all > ../history.patch                           # every diff and message
git cat-file --batch-all-objects --batch > ../objects.dump    # every object, binary blobs included
while IFS= read -r s; do printf '%-44s log:%s objects:%s\n' "$s" \
  "$(grep -a -c -F -- "$s" ../history.patch)" "$(grep -a -c -F -- "$s" ../objects.dump)"; done < ../verify-literals
while IFS= read -r s; do printf '%-44s log:%s objects:%s\n' "$s" \
  "$(grep -a -c -E -- "$s" ../history.patch)" "$(grep -a -c -E -- "$s" ../objects.dump)"; done < ../verify-phrases
```

Then:

```sh
# The file is gone from every commit.
git log --all --oneline -- docs/research/2026-09-agent-proxy-routing.md   # prints nothing

# Authorship: only noreply addresses remain (the owner's and the design tool's).
git log --all --format='%an <%ae>%n%cn <%ce>' | sort | uniq -c

# Tags: the same tags, pointing at equivalent trees.
git fetch ../metistry-pre-rewrite.git 'refs/tags/*:refs/old-tags/*'
for t in $(git tag); do printf '%-10s ' "$t"; git diff --shortstat "refs/old-tags/$t" "$t" -- ':!docs' ; echo; done
git diff --stat refs/old-tags/v0.14.0 v0.14.0
```

**A tag's diff is not empty, and must not be:** each tagged tree held the
strings the rules replace, so each differs from its old self by exactly
those lines. What the check proves is that it differs by *nothing else*:

- outside `docs/`, every tag's diff touches exactly one file,
  `packages/core/test/deployment.test.ts` (the tailnet host, one line) —
  every other line of product code is byte-identical;
- `git diff refs/old-tags/v0.14.0 v0.14.0 | grep '^[-+][^-+]'` shows only the
  rule replacements, the removed PoC-4 block and the removed note.

**Release assets are unaffected**: DMGs, runtime packs, the appcast, npm
packages and images were built once and are attached to the release by tag
*name*, not by commit. `metistry.lock` records a commit next to the version,
for information only — a release install updates by version.

**Rehearsed 2026-09-27** on a local clone of the cleanup branch (18 tags,
1,835 commits, 1.4 s): every count 0; the note gone from every commit;
authors `Matt Colf <1252810+mattcolf@users.noreply.github.com>` and
`Claude Design <noreply@anthropic.com>` only; each of v0.1.0–v0.14.0 differs
from its old self in 42–48 files, all under `docs/` except that one test
line, and v0.14.0's `RESULTS.md` diff is exactly the rules plus the PoC-4
block.

If any count is not 0, or a tag's diff touches anything else: stop, fix the
rules, delete `metistry-rewrite`, and go back to step 3. Nothing has left the
machine yet.

## 5. Push `main` and the tags — nothing else

The `Main` ruleset (deletion, non-fast-forward and pull request rules on the
default branch, no bypass list) rejects a force-push to `main` wherever it is
enforced, so switch its enforcement off for the push (Settings → Rules → Rulesets →
Main → Enforcement status: Disabled), push, and switch it straight back on.

```sh
cd ~/going-public/metistry-rewrite
git remote add origin https://github.com/foldedspacelabs/metistry.git   # filter-repo removed it
git push --force --tags origin main
```

Push exactly `main` and the tags: never `--all`, `--mirror`, a local branch,
or a stash — `--sensitive-data-removal` fetched every ref, and the rewritten
copies of the stale branches are local branches here now.

Delete the stale remote branches:

```sh
for b in claude/console-owner-token claude/flexible-compute claude/phase-1-substrate \
         claude/poc15-tier-routing claude/product-instance-split claude/research-prior-art; do
  git push origin --delete "$b"
done
git ls-remote --heads origin        # must list main and nothing else; delete any leftover claude/* the same way
```

Re-enable the `Main` ruleset now.

## 6. GitHub settings — before the flip

**The pull-request refs problem.** A force-push does not reach
`refs/pull/*/head`: every merged or closed PR still points at its **old,
unscrubbed commits**, GitHub will not let anyone delete those refs, and once
the repository is public their diffs render for anyone. As of 2026-09-27,
7 PR descriptions also contain the home-directory path and 3 mention the
subscription setup-token (`gh pr list --state all --json number,body`);
review comments were not scanned. One of these, done in full, is a gate for
step 7:

- **A. Keep this repository.** Open a GitHub Support request ("remove
  sensitive data"), attach `.git/filter-repo/first-changed-commits` from step
  3, and ask for the pull-request refs and cached views of the old commits to
  be removed and the repository garbage-collected. Edit the PR descriptions
  and comments that carry the strings (find them with
  `gh pr list --state all --limit 1000 --json number,body` and
  `gh api repos/foldedspacelabs/metistry/pulls/comments --paginate`). Flip
  only once Support confirms.
- **B. A new repository.** Rename this one (for example to
  `metistry-archive`) and keep it private; create a new, empty
  `foldedspacelabs/metistry`; push the rewritten `main` and tags into it
  (step 5's commands, without the branch deletions); re-create the Releases
  by uploading the assets downloaded from the archive
  (`gh release download <tag> -R foldedspacelabs/metistry-archive`) so the
  appcast URL (`…/releases/latest/download/appcast.xml`) keeps resolving.
  Issues and PRs stay behind in the archive. Re-point npm Trusted
  Publishing at the new repository (same name, so usually nothing to do).

Then, in Settings:

1. **General → Features / Pull Requests:** allow forking.
2. **Actions → General → Fork pull request workflows from outside
   collaborators:** *Require approval for all outside collaborators*.
3. **Security → Advanced Security:** enable private vulnerability reporting
   (`SECURITY.md` sends reports there), secret scanning, and push
   protection.
4. **Rules → Rulesets → New tag ruleset** `release tags`: target `v*`;
   restrict creations, updates and deletions; bypass list: the owner only.
   Only the owner can then start `release.yml` with a tag push.
5. **Environments → New environment** `release`: required reviewer the
   owner; deployment branches and tags: tags matching `v*`. Move
   `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`,
   `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8` and `SPARKLE_PRIVATE_KEY` into it,
   then delete the repository-level copies. `release.yml`'s four signing jobs
   already declare `environment: release` (`docs/ops/releases.md`, "Secrets").
6. **Rules → Rulesets → Main:** keep deletion, non-fast-forward and
   pull-request required; add **required status checks** — `checks` and,
   because it runs only when the Mac app changes, not `macos-app`.

## 7. Flip the visibility

Settings → General → Danger Zone → Change visibility → Public.

## 8. After

- **Every clone is now stale.** The owner's checkouts, worktrees and any
  install on the git channel (`metistry.lock` `source: git`) must be
  re-cloned (or `git fetch origin && git reset --hard origin/main` in a
  checkout with no local work). A fast-forward pull fails by design.
  Release-channel installs need nothing.
- **Confirm the release path** on the next release: the appcast URL still
  answers, the DMG still auto-updates from the previous version, and npm now
  publishes **with provenance** (`release.yml` adds `--provenance` for a
  public repository; the package page shows the provenance badge).
- **Watch the first outside PR**: CI waits for approval, runs with a
  read-only token, and reads no secret.
- **Announce.**
- **Delete `~/going-public/metistry-pre-rewrite.git` after 30 days**, and
  not before.

## Rollback

Until step 7, rollback is free: nothing public has changed. After step 5,
the pre-rewrite mirror restores the old history exactly (ruleset disabled
for the push, as in step 5):

```sh
cd ~/going-public/metistry-pre-rewrite.git
git push --force origin 'refs/heads/main:refs/heads/main' 'refs/tags/*:refs/tags/*'
```

After step 7, flipping back to private stops new readers but cannot recall
clones already made — which is why steps 4 and 6 are gates.

## Open — still with the owner

- **PoC-14/15/16 fixture prompts** (fixture `D07`'s prompt, in
  `docs/poc/poc15-complexity/` and `docs/poc/poc16-local-scorer/`, and
  `afm_tier.swift`'s comment): left as they are pending the owner's ruling.
  If they change, add rules to the replace-text file before step 3.
- **`docs/research/2026-08-prior-art-review.md`'s claims about other
  vendors:** left as they are pending the owner's ruling.
- Noticed during the cleanup, not ruled on:
  - `CLAUDE.md`'s "Feed the product record" bullet still says "a premium
    candidate identified" — left for the owner's own hand, as a change to
    the conventions file.
  - The subscription setup-token still appears, as history rather than
    instruction, in `metistry-build-plan.md`, `docs/plan-refresh-2026-09-13.md`,
    `docs/product/desktop-app-plan.md`, `docs/product/PRODUCT.md`'s log and
    the changelogs; the history purge covers only PoC-4's block.
  - The PoC-13 message categories removed at HEAD (and the removed
    owner checklist, `docs/ops/owner-actions.md`) stay in history unless rules
    or an `--invert-paths` are added for them.
  - The runtime pack ships licence files for Node and llama.cpp only;
    PostgreSQL, pgvector and git (GPL-2.0, which also needs a source offer)
    should ship theirs in the DMG before launch.
  - `drey` appears throughout tests as the sample project name.
