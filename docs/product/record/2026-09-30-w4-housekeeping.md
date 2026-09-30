- 2026-09-30 — **Wave 4 landed: the Settings panes, the recorder's screen and
  bar, connections for calendars, mail and agents.** Twenty-two tickets merged
  in one day (PRs #460–#482, with X-7's #437): the Mac's Compute, Connections,
  Secrets and Variables, Live Capture and Sessions panes and its hot keys;
  the PWA's Settings; the recorder's screen and window, floating bar,
  retention and re-review, and meeting groups; Google Calendar through
  Metistry's client, IMAP mail, invitation and message requests, and
  targets folded into connections; and the five CI-stability candidates the
  owner promoted (X-24, X-29, X-31, X-32, X-41). T9-4 waits on its eval bar.
  Safety mechanisms that shipped: an **owner-door secret refuses a
  connection or agent grant** at the server, so `github_write` can never be
  handed to something that is not the owner's hand; the **recorder's control
  token** is read from the login Keychain only and the bar reaches the
  recorder on loopback alone; a **message card is inferred from headers
  only** — the body is not read until §4.12's on-device reduction exists, and
  the card says so; and **an agent's outside services are connections**, each
  a door with its own grants and *Sent only to* list, so an agent's key never
  sits on a request the agent writes. The coordinator's fourteen in-flight
  calls and nine questions for the owner are in `decisions-log.md` (*W4*);
  twenty-three follow-ups became candidates X-80…X-102.
