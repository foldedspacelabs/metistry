---
"@metistry-apps/console": minor
---

Push and enrolment in the PWA without `alert()` (T7-5, screen 18 §6). **A
notification says the card's type and title and nothing more, and never a
secret:** the service worker reads a payload's `type`, `title` and `url`
only, blanks anything key-shaped (core's `looksLikeKey` shapes) or a run of
six digits, clips each to one line, and follows a tap only to a page on its
own origin — in the window already open when there is one. Notifications
are **asked for in context**, at the top of Needs You the first time
something waits there, never on first launch, with the permission prompt
only from the owner's tap; Not Now is remembered on the device. On iPhone in
a Safari tab the ask becomes a three-step **install sheet** (Share → Add to
Home Screen → open it); Chrome and Edge's own install prompt is offered once
from More. **Enrolment is a wall**: a Device name field instead of
`prompt()`, and every refusal — a spent link, a cancelled passkey sheet, no
connection — is a line under the buttons. Settings' Turn On and Send a Test
say their outcome on the page.
