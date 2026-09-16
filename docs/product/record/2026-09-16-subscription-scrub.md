- 2026-09-16 — **The product's path to a model is now one line of
  configuration, and nothing else.** The Claude Agent SDK and the
  claude.ai-login token path leave the repo entirely (owner's decision,
  `docs/plan-refresh-2026-09-13.md` C2/C3): one engine remains — the
  OpenAI-compatible loop — and Claude arrives through OpenRouter like any
  other cloud model, so the default install brushes no vendor's login or
  branding terms and the person's bill is theirs, itemised, from a provider
  they chose. What replaced the fixed `CLAUDE_CODE_OAUTH_TOKEN` is the real
  benefit: **compute is configurable, and the credential has no fixed name.**
  `compute.yaml` says which provider serves a turn and which Keychain item
  buys it, so the engine's environment allowlist is now "the static keys plus
  exactly the secrets THIS install's file names" (`assistantEnvKeys`) — a
  provider key sitting in the operator's shell that the file does not name
  still cannot reach the engine and spend on somebody else's account. One
  seam answers "is there an engine at all" for `metistry up` (whether the
  assistant is a supervisor child), `metistry doctor` (the `assistant` row),
  the routine runner's preflight (whether a turn would be answered) and the
  watchdog (whether a waiting queue is a fault) — core's `engineStatus`,
  taking the resolved file and the environment — so the four can no longer
  disagree, and when one of them says no it names the half that is missing
  and the command that fixes it. **An install with no engine stays a
  supported shape, not a failure**: captures, `inbox-drain`, tasks, search
  and the console all run while queued turns wait, on both deployment shapes
  now — the compose file no longer refuses to start without a credential.
  The Mac app's seventh first-run step becomes **Compute**: a provider
  template, a model, and an API key pasted into a secure field that goes to
  `metistry compute providers add`'s *stdin* — never argv, never a file the
  app writes, never a log — with the field cleared before the process runs
  and a test asserting both halves; "Skip: no engine yet" is a button with
  its consequence written beside it. The sandbox profile's outbound host list
  stops naming one vendor and is derived from the providers in the file, and
  the honest limit is restated where it lives: it is documentation until App
  Sandbox, while the engine's own `fetch` reaching exactly one base URL is
  the enforcement that is real today.
