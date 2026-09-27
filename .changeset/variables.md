---
"@foldedspacelabs/metistry-core": minor
"@foldedspacelabs/metistry-cli": minor
"@metistry-apps/console": minor
---

**Variables (plan §2.14, M14).** Plain shared values in
`.metistry/variables.yaml`, referenced as `{{ variable.name }}` in connection
files and agents' instructions. Core adds `parseVariablesFile`,
`fillVariableRefs` (all or nothing, one pass, `{{ secret.x }}` left for the
egress fill), `describeVariables` and the refusals: a key-shaped value (*Store
as Secret*), a secret's name, a value that templates, and — ruling 2 — a
schedule or a time, by name or by value. They hold at the parse, so a
hand-edited file carrying one does not load anywhere, and a refusal names the
variable, never the value. The CLI adds `metistry variables set|unset|list`
(set also refuses a value equal to one of the instance's own secrets); the
console serves `GET /api/variables` — name, value, read by, used in — to the
owner. `INSTANCE_LAYOUT.variables` and redact's `isSecretKeyName` are new.
