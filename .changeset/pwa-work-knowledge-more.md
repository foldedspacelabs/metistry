---
"@metistry-apps/console": minor
---

The PWA's Work, Knowledge and More ▸ Agents (T7-3b, screen 18 §5), each in its
own module (`web/work.js`, `web/knowledge.js`, `web/more.js`) instead of inside
`app.js`. **Board** is one column at a time on a phone, picked by chips that
carry each column's count; from 600px the columns snap side by side, and at
900px it is the Mac's board, drags and all. **Every tap opens the card**
(C84), pushed full-screen with its description, where it is, who holds it and
its room — a push from the card. A drag becomes **Move to…**: an action sheet
listing every other column, where a move the service would accept is a button
saying what it does and one it would refuse is listed disabled with the reason
(Done and Release are offered only on a card you hold — the holder arm would
refuse them anywhere else). **Projects** rows carry the mode chip in the
glossary's words (Autonomous · Review · Review · over budget) and the day's
spend bar; the kill switch is on the pushed project. An **artifact's
comments** become counts on their highlighted lines, opening a sheet with
reply and Resolve. **Knowledge** replaces the placeholder: the fold, then Needs
Your Eye (drafts), then Areas, with search; an area pushes its pages and a page
its note and links. **More ▸ Agents** groups Yours and Connected; an agent's
permissions are one row per resource with Read and Write lines, its actions in
Allow · Ask First · Never, and Edit Permissions opens the grants form.
Registering an agent and rotating its token (reach `local`) are no longer
offered on the phone — they are defined on the Mac. `md.js` gains
`renderMarkdownBlocks` (each block with its source lines).
