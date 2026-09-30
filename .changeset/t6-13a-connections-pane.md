---
"@metistry-apps/macos": minor
---

Settings ▸ Connections replaces its interim pane (T6-13a, screen 9 §10.1–§10.4): the list — status, the name with its type's glyph, Type, Used By (*Nobody yet* is a real value, *Key expired* first in the failed ink) and a shield when it is offered to agents — and one connection: how Metistry reaches it, each secret as a `{{ secret.name }}` reference with its *Sent only to* hosts, **What it sends** (a secret headed for a host outside its *Sent only to* list, not granted, or with no Keychain item blocks the preview, worked out the way core's egress door does), the offer switch, the tools by what they do with *Allow · Ask First · Never*, Used By, and Test with Replace Key. Read only from `GET /api/connections(/:name)` and `GET /api/secrets`; every change is a §2.2 verb confirmed with its exact command — `metistry connections policy|test` (M13), `metistry secrets hosts|grant` (M7). No new route.
