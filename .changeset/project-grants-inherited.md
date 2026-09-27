---
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/console": minor
"@metistry-apps/macos": minor
---

**Project grants inherited (T4-7).** A crew's or external agent's effective reach is now its own grant ∪ the own grant (0032) of every project its row lists — core's new `inheritGrants` (the widest tier; its own areas first, then each project area its own do not cover; `queries` if any holds it), with the added reach reported as `via`. The console's door resolves it per request (`authenticateAgent` reads the membership and the projects' grants in one statement) and never writes it into the agent's row, so leaving a project removes what it gave on the next request. `resolveActor` takes `projectGrants` (`listProjectGrants`) and the permissions table marks each inherited entry with the new provenance `{kind: "project", project}` — *via project <slug>* in `permissionRowText`, the console's panel and MetistryKit (`PermissionProvenance.project`). A project's stored grant is re-checked fail closed; the assistant inherits nothing.
