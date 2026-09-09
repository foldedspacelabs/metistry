# Owner actions — the checklist only you can do

Kept current as PRs land (2026-09-08). Each item names what it unblocks.

## Release and distribution
- [ ] **Make the ghcr packages public** (`metistry-console`, `metistry-assistant`,
      `metistry-reconciler` — org → Packages → package settings → Change
      visibility). Unblocks `metistry update --channel release` on the Studio
      (`docker compose pull` currently gets 401).
- [ ] **Apple signing runbook** (`docs/ops/apple-signing.md`): Developer ID
      certificate into the login keychain; re-sign the two helpers with
      `METISTRY_SIGN_IDENTITY` set and re-grant TCC once; `notarytool
      store-credentials`; Sparkle EdDSA key pair (`bash
      ops/release/fetch-sparkle-tools.sh` then `generate_keys` — no
      Homebrew, the cask is disabled). Unblocks the DMG/appcast jobs and
      stops helper grants rotting on rebuild.
- [ ] **GitHub repo secrets** still missing for the DMG job: `NPM_TOKEN` (only if
      publishing to npm), `APPLE_CERTIFICATE_P12`,
      `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,
      `APPLE_APP_SPECIFIC_PASSWORD` (`docs/ops/releases.md`).
- [ ] **Extend `METISTRY_GITHUB_TOKEN` with `Contents: read`** (or just rely
      on `gh`, already installed and logged in on the Studio):
      `metistry update --channel release` against the private repo 403s on
      the current fine-grained PAT (Issues/Pull requests/Metadata only) —
      `gh` is used as a fallback automatically, but the PAT should carry the
      scope for the direct API path too (`docs/ops/releases.md`).

## Local install
- [ ] `brew install postgresql@17 pgvector` on the Studio. Unblocks the live
      launchd-shape trial (`METISTRY_DEPLOYMENT_SHAPE=launchd metistry up`,
      side by side with compose; `docs/ops/deployment-shapes.md`).
- [ ] **GitHub OAuth App** (Developer settings → OAuth Apps, "Enable Device
      Flow" ticked) → `METISTRY_GITHUB_OAUTH_CLIENT_ID=` in `.env`. Unblocks
      `metistry connect-repo --auth device` (the instance repo is already
      connected by hand, so this is for the app's onboarding flow).

## Integrations (each degrades absent until set)
- [ ] **AWS**: IAM user/role with only `ce:GetCostAndUsage` →
      `METISTRY_AWS_ACCESS_KEY_ID` / `METISTRY_AWS_SECRET_ACCESS_KEY` in `.env`,
      then `metistry update`. Unblocks the AWS spend panel.
- [ ] **GitHub write token** (fine-grained: Issues read/write + Metadata on the
      dispatch repo only) → `METISTRY_GITHUB_WRITE_TOKEN`,
      `METISTRY_GITHUB_DISPATCH_REPO`. Unblocks `POST /api/tasks/:id/dispatch`
      to the `github-issues` target (`docs/ops/targets.md`).
- [ ] **drey-metrics**: what to collect and from where (the last Phase 4
      collector; nothing built until specified).

## Reviews and checks
- [ ] Review **PR #75** (PWA restyle) after #74 lands; check the Feed tab and
      the composer on the phone after deploy.
- [ ] **External-agent end to end**: mint an agent token in the Agents tab,
      then from a Claude Code session `claude mcp add --transport http metistry
      https://mac-studio.tailee85c6.ts.net/mcp --header "Authorization: Bearer
      <token>"` and call `tasks_list`. The one path no agent could verify.
- [ ] Try `/note` and a 👎 with a note in chat once #78 is deployed, so the
      first `reply-review` run has something to fold.
