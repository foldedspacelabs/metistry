---
"@metistry-apps/console": minor
---

Add a Phone, the phone's half (X-78, design-build-plan §2.22 *The phone, in order*). The PWA reads the enrolment link's `#enroll=<code>` **once and takes it out of the address bar and history** (`history.replaceState` of the same entry) before anything else runs, so Add to Home Screen never saves a spent code and it never sits in Safari's history; a **standalone launch reads no code and shows sign-in, never the enrolment wall** — the ceremony happens in Safari, and the installed app signs in with the passkey it made there (a login ceremony, not a second enrolment). After a successful enrolment in an iPhone's or iPad's Safari the wall **hands on to T7-5's install sheet** (Share → Add to Home Screen → open it), by `installOffer`'s own rule — no second sheet; the sheet's last line now says notifications are asked the first time something needs you, never during setup. Refusals keep `AUTH_WORDS`; no route changed.
