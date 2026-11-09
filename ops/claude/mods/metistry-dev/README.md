# metistry-dev — Claude Code mod (MD-2 + MD-3 spike)

Dev-side only. **Not part of the product** and not shipped to anyone: no `apps/` or `packages/` code imports it. It is a spike from
`docs/research/2026-10-04-claude-code-mods-review.md` (§2 MD-2, MD-3) for the owner to try. Mods are early access; this directory may need
rewriting when the API moves.

## What it does

1. **MD-2 — trailer by construction.** An `attribution.text` hook rewrites the text the engine asks the model to write into a commit or
   PR, so the model is *told* the trailer and footer that `docs/ops/agent-brief.md` ("How you finish") requires:
   - `kind: 'commit'` becomes `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
   - `kind: 'pr'` becomes `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
   - `kind: 'exemption'` and `'remedy'` (sentences about the engine's own commit gate) pass through unchanged.

   If the engine's text already holds a `Co-Authored-By:` / `Generated with Claude Code` line, only that line is replaced; otherwise the
   required line is the whole text. The pure logic is `hooks/lib.ts` (`rewriteAttribution`).

   API used, from the `plugin-authoring` skill's types (`AttributionTextInput = { kind: 'commit'|'pr'|'exemption'|'remedy'; text }`,
   result `{ text }`): `on('attribution.text', ($, e, next) => ({ text }))`, with `next(e)` giving the engine's composed `{ text }`.
   The event is composed "for the Bash description, the commit skills, a PR's body, the pre-ship mandate and the commit gate's deny".
2. **MD-3 — read-only status pane.** `/metistry-status` opens a pane showing `queue.txt`, the last 12 lines of `queue.log` (both under
   `$HOME/.claude/projects/-Users-mattcolf-Development-Metistry/tools/`) and the open PRs from
   `env -u GH_TOKEN gh pr list --json number,title,mergeStateStatus`, refreshed every 30 s while the pane has been opened. Display only.

## Capability boundary (invariant 8)

`claude plugin validate ops/claude/mods/metistry-dev` (Claude Code 2.1.259 on this Mac, run 2026-10-18), verbatim:

```
Validating plugin manifest: .../ops/claude/mods/metistry-dev/.claude-plugin/plugin.json

Validating hooks: .../ops/claude/mods/metistry-dev/hooks/hooks.json

  ❯ ./register.tsx hooks: attribution.text, session.start, command.run{command=metistry-status}, ui.render{component=Pane, requestId=metistry-status}
  ❯ ./register.tsx calls: $.clock.every, $.clock.now, $.command.register, $.env.get, $.fs.read, $.process.run, $.ui.invalidate, $.ui.open, $.ui.resolve

✔ Validation passed
```

That `calls:` list is the mod's whole reach. Honest reading: `$.fs.read` and `$.process.run` are broader than what the mod does with them;
the validator lists *names*, not arguments. What narrows them is the source, and `test/lib.spec.ts` pins that: one `$.process.run` call
whose argv is the frozen constant `GH_PR_LIST_ARGV`, one `$.env.get('HOME')`, fixed read paths, and none of `$.fs.write`, `$.http`,
`$.prompt`, `$.session`, `$.mcp`, `$.model`, `$.store`, `$.settings`, `$.process.spawn`, `$.env.set`, `$.tool.call`.

## Misuse notes (what this mod must never do)

- **Never read secrets.** It reads only `queue.txt` and `queue.log` and the one env var `HOME`. No `.env`, tokens or Keychain. `gh` is run with
  `env -u GH_TOKEN` so the mod's child does not inherit that token. A mod is **not sandboxed** (review §1): it acts as the user, so this is
  held by the source and the tests above, not by the platform.
- **Never run git with write effects.** The only process is `gh pr list`; no `git`, no `gh` write verb. The attribution hook only changes text
  the model reads; it never runs anything.
- **Never send anything off-machine.** No `$.http`, no `$.mcp`, no `$.model`. (`gh pr list` itself talks to GitHub as a read, as it does
  when the coordinator runs it.)
- The pane draws text from files and `gh` output as plain `Text`; nothing from them is submitted as a prompt (`$.prompt` / `$.session` unused),
  so there is no prompt-injection path from PR titles into the session.
- Fail-open: a mod hook that throws or times out is skipped (review §1). If the mod does not load, commits simply lose this reminder; the
  `commit-msg` check (MD-1) is the gate, this is only the writer.

## Verified vs the owner's hand

**Verified (2026-10-18, this Mac):**
- `claude plugin validate` passes; output above.
- `node --test ops/claude/mods/metistry-dev/test/lib.spec.ts` : 9 pass, 0 fail (rewrite rules, exact trailer/footer strings equal to
  `agent-brief.md`, `tailLines`, `parsePrList`, `formatPr`, argv constant, source-level misuse test). Node 22 strips the types; no dependency added.

**Not verified. Needs the owner's hand:**
- **Loading it.** From a scratch session: `claude --plugin-dir /Users/mattcolf/Development/metistry-md-2/ops/claude/mods/metistry-dev`
  (or the same path in the main checkout once merged). Nothing is installed by this PR and no mod was run by the agent.
- **That the trailer lands.** In that session ask for a throwaway commit in a scratch repo and check `git log -1 --format=%B` ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; open a PR body to check the footer. Whether `attribution.text` actually
  *rewrites* the trailer the model writes (versus the model ignoring it) is the review's open question #3 and is unproven here.
- **What `e.text` looks like.** The types only say "as the engine composed it, the settings applied". The hook handles both "a bare trailer line"
  and "a sentence around one", but no real value has been seen.
- **Version floor.** The docs say mods need Claude Code 2.1.287 (released 2026-10-01); the types the engine wrote say 2.1.286; the skill on
  this machine is from 2.1.299. The `claude` on this Mac's PATH reported **2.1.259**, which *did* validate this module (so `claude plugin
  validate` exists there) but has **no `claude plugin test`** command, and warned that the `"types"` manifest key is unknown, so the mod keeps
  no `$.state` and has no types file. Whether 2.1.259 *loads* mods is unknown; use a build at or above 2.1.287.
- **Subagents.** Whether a mod loads in `claude -p` subagent processes (the review's unverified item; the trailer matters most for the agents
  that write commits) is untested. The hook `attribution.text` is listed as running under `claude -p`/SDK in the docs, not confirmed here.
- **The pane.** Not opened. Layout (sidebar needs a 144-column fullscreen terminal, else above the prompt) and the 30 s refresh are untried;
  `$.ui.invalidate('ui.render')` driving a redraw from a timer is the assumption most likely to need a fix. Not type-checked with `tsc`
  (the engine writes types on first load).
- `claude plugin test` has no test here: the engine-side hooks are thin; the logic lives in `hooks/lib.ts` and is tested with `node --test`.

## Layout

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             { "modules": ["./register.tsx"] }
hooks/register.tsx           the hooks module
hooks/lib.ts                 pure functions
test/lib.spec.ts             node --test
```

Note `$` may not be passed as an argument in a mod (validator refuses it), so the poll is a closure made in `session.start`.
