---
"@foldedspacelabs/metistry-core": minor
---

**One type for everything that acts.** Core adds the actor model (`actor.ts`, plan §2.4): `Actor` — the instance's assistant, a crew it delegates to, or an external agent — with its definition, permissions, tools, compute and limits, plus `PermissionRow` (the permissions table's Resource × Read × Write, provenance per entry), the `agents.kind` → actor mapping table, and the `ResolveActor` signature. Types only; nothing resolves yet. The shape makes the rules that matter unrepresentable rather than merely tested: a crew's or an external agent's Knowledge row has no write cell, only the assistant has the Agents (delegate) row, a crew never has a Queries row, and an external actor carries no definition or compute. `docs/ops/actors.md` is the source mapping, field by field.
