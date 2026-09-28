---
"@metistry-apps/macos": patch
---

Ruling 26 (X-22): the Mac reads a question's questions from `request.questions`
— core's own `questionsOf` reading of the row — never re-derives them from
`payload` itself. A row the console still stores under v1's shape alone
(`payload.options`, no `payload.questions`) now reads exactly as core says:
one pick-one question with no *Something else…*, since those rows were
written under v1's rule that the options are the only answers. A console old
enough to send no `request` at all still falls back to `payload.title`/
`options` directly.
