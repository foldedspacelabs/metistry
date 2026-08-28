# Start here

## What's in this folder

| File | For |
|---|---|
| `BUILD-PLAN.md` | The full design. Claude Code reads this, you review it. |
| `CLAUDE.md` | Dev conventions. Copy to the repo root once it exists. |
| `poc/RESULTS.md` | Where Phase 0 findings get recorded. |

## How to use it

1. `mkdir ~/dev/metistry && cd ~/dev/metistry && git init`
2. Copy this folder's contents in.
3. `claude` from that directory.
4. Paste the prompt below.

**Do not skip to Phase 1.** The plan has four gating PoCs, and PoC-1 in
particular can invalidate the entire interaction model. An hour spent there can
save a week of building the wrong door.

---

## The kickoff prompt

```
Read BUILD-PLAN.md in full before doing anything.

Context: I'm building Metistry — a local-first personal assistant and knowledge
graph running on this Mac Studio. The assistant is named Metis. I've spent
considerable time on the design; the plan reflects decisions already made, not
suggestions. If you think something in it is wrong, say so before acting, don't
silently do it differently.

Your task this session is Phase 0 ONLY — proof of concepts. Do not scaffold the
monorepo. Do not create packages. Do not write migrations. We are testing
assumptions, and several of them can change the architecture.

Run these four, in order, stopping after each to report:

  PoC-1  MCP tool call under `claude -p` with macOS TCC permissions
  PoC-2  iMessage attachment access
  PoC-3  Apple Foundation Models from a headless launchd process
  PoC-4  Container reaching a host MCP bridge

PoC-1 is the gate. If a tool call needing Full Disk Access or Automation blocks
or fails when launched from launchd (not from my logged-in Terminal), the
iMessage door may not be viable and the plan changes. Test that specific case
explicitly — a TCC grant to Terminal.app does not transfer to another binary.

For each PoC:
  - Write throwaway code under poc/<name>/. It is scratch, not product.
  - Record the outcome in poc/RESULTS.md using the template already there.
  - State plainly whether the assumption held, partially held, or failed.
  - If it failed, describe what you observed before proposing a workaround.

Constraints for this session:
  - No dependencies beyond what a PoC needs. Ask before adding any.
  - Do not modify BUILD-PLAN.md. If a finding contradicts it, note that in
    RESULTS.md and tell me — I'll decide what changes.
  - Do not commit anything to git without asking.
  - Prefer showing me actual command output over summarising it.

Start by reading the plan, then tell me your understanding of PoC-1 and what
you'll run, before you run it.
```

---

## After Phase 0

Bring `poc/RESULTS.md` back to a planning conversation before starting Phase 1.
Two or three of these findings will likely change something structural, and it's
cheaper to revise the plan than the code.

Phase 1 is bigger than its "weekend" label suggests — it now includes
`packages/core`, which carries lazy discovery, secret redaction, preview-confirm,
and the `check()` interface. Those are the things that are painful to retrofit
across a dozen components, which is why they come first.

## Open decisions still outstanding

See §6 of the plan. Four remain, and two are worth settling before Phase 1:

- **Embedding model** — store model name and dimension per row so it stays
  reversible.
- **Metis in Docker or native** — PoC-4 decides this.

The other two (HomeKit approach, `Techniques/` folder granularity) can wait.
