# Owner actions — the checklist only you can do

Kept current as PRs land (2026-09-08). Each item names what it unblocks.

## Release and distribution
- [ ] **Make the ghcr packages public** (`metistry-console`, `metistry-assistant`,
      `metistry-reconciler` — org → Packages → package settings → Change
      visibility). Unblocks `metistry update --channel release` on the Studio
      (`docker compose pull` currently gets 401).
- [x] **Apple signing runbook** — done 2026-09-08/09: Developer ID certificate
      installed; helpers signed as bundles and TCC proven to survive rebuilds
      (#84); `notarytool` credentials stored (profile `metistry-notary`);
      Sparkle key pair generated (public key in
      `ops/release/runtime-versions.env`, private key in the Keychain and the
      `SPARKLE_PRIVATE_KEY` repo secret).
- [x] **GitHub repo secrets** for the DMG job — done 2026-09-09:
      `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`,
      `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8`,
      `SPARKLE_PRIVATE_KEY`, `SPARKLE_PUBLIC_ED_KEY` all set
      (`docs/ops/releases.md`). npm publishing needs no secret — see
      Trusted Publishing below.
- [ ] **npm Trusted Publishing, per package** — bootstrap each
      `@foldedspacelabs/metistry-*` package (npm login + `npm publish
      --access public` once from the Studio with a short-lived granular
      token), then on npmjs.com: Settings → Trusted publishing → GitHub
      Actions, org/user `foldedspacelabs`, repo `metistry`, workflow
      `release.yml`. Then flip "Require two-factor authentication and
      disallow tokens" on the org's publishing settings, and revoke the
      bootstrap token. Full steps and the package list:
      `docs/ops/releases.md` ("Publishing to npm: Trusted Publishing, no
      token"). Unblocks the `npm` job in `release.yml` for every package
      it covers.
- [x] **Extend `METISTRY_GITHUB_TOKEN` with `Contents: read`** (done 2026-09-08; or just rely
      on `gh`, already installed and logged in on the Studio):
      `metistry update --channel release` against the private repo 403s on
      the current fine-grained PAT (Issues/Pull requests/Metadata only) —
      `gh` is used as a fallback automatically, but the PAT should carry the
      scope for the direct API path too (`docs/ops/releases.md`).

## Local install
- [ ] `brew install postgresql@17 pgvector` on the Studio. Unblocks the live
      launchd-shape trial (`METISTRY_DEPLOYMENT_SHAPE=launchd metistry up`,
      side by side with compose; `docs/ops/deployment-shapes.md`).
- [x] **GitHub OAuth App** (done 2026-09-09; shipped as the product default) (Developer settings → OAuth Apps, "Enable Device
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
      https://mac-studio.example.ts.net/mcp --header "Authorization: Bearer
      <token>"` and call `tasks_list`. The one path no agent could verify.
- [ ] Try `/note` and a 👎 with a note in chat once #78 is deployed, so the
      first `reply-review` run has something to fold.
- [ ] **Answer the first access request.** Narrow an external agent's grant to
      `tier: index` in the Agents tab, have it try `knowledge_read` on a page
      outside its areas, and answer the `access_request` it raises in Needs
      You — Approve, or Revise to a narrower folder. Nothing but your hand can
      make that grant (`docs/ops/actions.md`), so nothing but your hand can
      prove the loop. Worth reading the card copy while you are there: the
      designer has not drawn this one yet. Since 2026-09-20 the card says
      what that credential holds in the **same words** the Agents panel and
      `metistry agents list` use — one triple, role · access · extras — so
      "wants Areas/Health · has titles, autonomy: observe" reads the same
      wherever you meet it (`docs/ops/auth.md`). Tell me if the sentence is
      wrong; it is one function, in one file.
- [ ] **Decline one, and watch the ladder.** After a Decline the agent is told
      the decision rather than allowed to re-file it, and may ask ONCE more
      with `escalate: true` — that row arrives flagged *asked again after a
      decline*. Decline the escalation too and the area is closed at the tool.
      Worth doing once so you know what the second card looks like before a
      real one arrives (ruled 2026-09-19).
- [ ] **Check the reason each action's mode shows** (C46/C47). `metistry
      agents autonomy <id>` now says WHY a kind is what it is, not just what
      it is: set by you, defaulted from the level, or clamped to its ceiling.
      Try it — set an agent's `level` to `propose` and `--allow comment`, then
      read it back: `comment` should show `Ask First`, marked as clamped and
      naming what you asked for (`Allow`), because `propose`'s ceiling refuses
      it. That is the one case where your own setting is being overridden, and
      it should never look like an ordinary default.
- [ ] **The assistant can now ask as well** (ruled 2026-09-19). If you have
      narrowed it with `METISTRY_ASSISTANT_AREAS`, it will raise an
      `access_request` like any other principal; approving one records the
      area in `agent_grant_overrides` so it survives the next console start,
      and revoking the assistant (unsetting `METISTRY_ASSISTANT_TOKEN`) clears
      those approvals. Narrowing the variable afterwards narrows everything
      EXCEPT what you approved — if you want an approval back, revoke once.
