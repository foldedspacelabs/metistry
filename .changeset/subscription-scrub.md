---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/assistant": minor
"@metistry-apps/console": minor
"@metistry-apps/watchdog": minor
"@metistry-apps/macos": minor
"@metistry-apps/collectors": minor
"@metistry-apps/routines": minor
---

**The product no longer ships a claude.ai-login path or the Claude Agent SDK;
compute is configured in `compute.yaml`.** One engine remains — the
OpenAI-compatible loop — and Claude is reached through OpenRouter like any
other cloud model (owner's decision, `docs/plan-refresh-2026-09-13.md` C2/C3).
`@anthropic-ai/claude-agent-sdk` leaves every `package.json` and the lockfile;
`engine-sdk.ts`, the `anthropic` engine kind and `CLAUDE_CODE_OAUTH_TOKEN` are
gone from the engine, the CLI's env allowlist and secret table, the plists,
`docker-compose.yml`, `.env.example` and the docs. Version bumps are `minor`
across the fixed set rather than `major` because fixed mode moves every package
together and a major here would say something about packages this does not
touch; the behaviour change is stated here, in `docs/ops/compute.md` and in
`docs/ops/assistant-tools.md` ("Running without an engine").

**"Is there an engine" is now one seam over two facts.** `engineStatus(compute,
env)` in `packages/core/src/compute.ts` replaces `engineCredentialPresent(env)`:
an engine is an `assignments.default` *and* the key its provider names in
`providers.<name>.auth.secret`. `metistry up` (whether the assistant is a
supervisor child), `metistry doctor` (the `assistant` row), the routine
runner's preflight (`requires.engine`) and — through the supervisor's child
list — the watchdog all read it, so they cannot disagree; each refusal names
the missing half and the verb that fixes it. `makeEngine` throws a named
`NoEngineError` for a turn nothing assigns rather than inventing one, and the
drain never starts: an install with no assignment behaves exactly as #145 made
it, with captures, tasks, search and the console running and queued turns
waiting. **Both deployment shapes now run engine-less** — `docker-compose.yml`
no longer interpolates a credential as required.

**The engine's credential has no fixed name.** `ASSISTANT_ENV_KEYS` becomes
`assistantEnvKeys(compute)`: the static keys plus exactly the secrets this
install's `compute.yaml` declares, so it stays an allowlist while the variable
it admits is whatever the file names. A provider key in the operator's shell
that the file does not name still cannot reach the engine. The sandbox
profile's documented host list is derived the same way (`engineHosts`) instead
of naming one vendor; what is actually enforced is unchanged and restated —
the loop's only outbound call is `<base_url>/chat/completions` on the assigned
provider.

**The Mac app's step 7 becomes Compute.** Pick a template (OpenRouter,
OpenCode Zen, LM Studio, Ollama, bundled local), name a model, paste the key
into a secure field, and the app runs `metistry compute providers add --from
… --json` with the key on the child's **stdin** — the one exception to the
app's empty-stdin rule, and why `CommandRunner` grew a `standardInput`
parameter — then `metistry compute assign default <provider/model> --json`.
The property holding the key is cleared before the process runs, and tests
assert the key is in no argument of any call. "Skip: no engine yet" is a real
choice with its consequence on screen. Settings' "Claude Token" row becomes
**Compute**, rendering `metistry compute show --json`: the default assignment,
each provider, and whether the key each one *names* is present — never a
value.

`collectors/claude-usage` is **kept**, unchanged in behaviour: it is a local
rollup of `runs` needing no credential, so it degrades to nothing on an
engine-less install; its `claude.*` metric names are data existing installs
already carry and renaming them would be a migration with no reader benefit.
Its copy, `seed/queries/claude_usage_daily.yaml`'s description and the weekly
review's monthly block stop describing a plan's headroom and describe what the
provider billed.
