# Privacy Policy — draft for metistry.ai/privacy

> **Draft, 2026-09-26.** Written to be true of the architecture as it stands
> on `main` at `0b20767`, and of the features the approved plan adds (PR #260).
> Lines in quote blocks like this one are notes for the owner and come out
> before publishing; anything in **[brackets]** is a placeholder the owner
> fills. Source for every claim: `docs/product/website-brief.md` §3 and §7,
> and the files named in the notes.

**Effective date:** [DATE]

Metistry is open-source software maintained by **[LEGAL NAME]** ("we", "us").
Questions about this policy: **[PRIVACY CONTACT EMAIL]**.

## In one minute

- **Metistry runs on your computer.** We don't run a service that receives
  your data, and there is no Metistry account.
- **We can't see your data** — not your notes, tasks, conversations, calendar,
  recordings or keys. We have no copy and no way to get one.
- **The software sends nothing to us.** No telemetry, no analytics, no crash
  reports.
- **Your data leaves your Mac only for services you choose to set up** — a
  cloud AI model, your own backup repository, a calendar — and it goes to them
  directly, under your account with them.
- **This website collects nothing** beyond the request logs its host keeps.

## What this policy covers

The websites at metistry.ai and metistry.app, and the Metistry software: the
Mac app, the `metistry` command-line tool, and the web app your own
installation serves to your phone and browser.

## This website

- No cookies, no analytics, no tracking pixels and no third-party scripts.
- The site is hosted by **[HOST]**. Like every web server, it keeps standard
  request logs — IP address, time, the page requested and your browser's name —
  for **[RETENTION PERIOD]** under [HOST]'s own privacy policy. We don't
  combine these logs with anything else or use them to identify anyone.
- Downloads are served from GitHub Releases, where GitHub's Privacy Statement
  applies. If you open an issue or contribute on GitHub, what you post there is
  public and GitHub's terms apply.

> Keep the first bullet true: if analytics are ever added, this section changes
> first. Fill [HOST] when the host is chosen (brief §9).

## The software

### Where your data lives

On your Mac, in places you control:

- **Your vault** — a folder of Markdown files, in a git repository you own.
- **A local database** beside it — an index of your notes, your tasks and a
  record of what ran.
- **The macOS Keychain** — passwords, tokens and API keys.
- **Recordings**, if you use meeting capture — kept in your installation's own
  folder and deleted on the schedule shown in Settings.

Nothing about your installation is registered with us.

> Recording is planned (plan §2.15, W3–W4): audio is kept until the meeting is
> filed plus 7 days, never more than 30; transcripts 30 days.

### What the software sends, and where

Only where you've set it up to, directly from your Mac:

| When | What is sent | To |
| --- | --- | --- |
| You choose a cloud AI model | The request your assistant is answering, with the context it needs — which can include parts of your notes, tasks, calendar or captures | The provider you configured, under your account and their terms. With a model that runs on your Mac, nothing is sent. The software marks providers that don't promise zero data retention |
| You back up your vault | Your vault's git history | The git remote you connect, such as your own private GitHub repository |
| You connect a service | What that service needs, such as listing your GitHub issues or reading your calendar | That service, with your credentials |
| You send a brief to another agent | The brief, after the software checks it against the data policy you set | That agent's service, such as Devin |
| You turn on notifications | An encrypted notification | Your browser's push service (Apple, Google or Mozilla), which cannot read its contents |
| The Mac app checks for updates | A request for the latest version; your IP address is visible to GitHub | GitHub, once a day |
| You download a model | A download request | The model's host, such as Hugging Face |

We receive none of it.

> Sources: no telemetry or analytics in the code (checked 2026-09-26); the
> assistant and the vault writer reach the network only through an allowlisting
> proxy (PRODUCT 2026-09-19); update checks are Sparkle's daily check against
> GitHub with system profiling off (`apps/macos/resources/Info.plist`); push
> payloads are encrypted by the Web Push standard (`apps/console/src/push.ts`).

### What the software never does

- It never sends telemetry, usage analytics or crash reports.
- It has no advertising identifiers and nothing is sold, rented or shared by us
  — there is nothing for us to share.
- We never train AI models on your data.

### Your phone and browser

The web app on your phone is served by your own installation, not by us.
Sign-in uses passkeys: the private key stays on your device, and your
installation stores only the public key. There are no passwords.

## Google user data

This section applies if you connect a Google Calendar.

- **What we access.** With your permission, the software reads and updates
  your Google Calendar events (the `calendar.events` scope).
- **How.** You sign in with Google in your browser, and Google sends the access
  token straight to the software on your Mac. The token is stored in your
  macOS Keychain. It never passes through us.
- **How it's used.** Only for features you see in the app: showing your day
  and your next meetings, preparing a meeting note, planning tomorrow, creating
  or moving an event after you confirm a preview, and replying to an invitation
  by changing only your own response.
- **Where it's stored.** In the local database on your Mac, and in any note
  you choose to keep in your vault.
- **Who it's shared with.** Never with us. If you have chosen a cloud AI model,
  the event details your assistant needs to answer you — such as your next
  meeting's title and time — are sent to that provider as part of the request.
  With a model that runs on your Mac, they are not sent anywhere. Google user
  data is never transferred to advertisers or data brokers, never used for
  advertising, and never used to decide creditworthiness.
- **Human access.** No one at [LEGAL NAME] can access your Google user data.
- **AI and machine learning.** We do not use Google user data to develop,
  improve or train generalized AI or machine-learning models.
- **Removing access.** Disconnect the calendar in Metistry, or revoke access
  at any time from your Google Account's security settings
  (myaccount.google.com/permissions).

**Limited Use.** Metistry's use and transfer of information received from
Google APIs to any other app will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

> Two things to settle before this section is submitted to Google (brief §7):
> (1) whether calendar content should be restricted to on-machine models, which
> would let the "Who it's shared with" bullet drop its cloud-provider sentence;
> (2) what disconnecting deletes — T4-14 should define removing the
> connection's rows from the local calendar table, so "Removing access" can
> promise it. Google Calendar through Metistry's own sign-in client is planned
> (plan §2.6, W4); calendar feeds and CalDAV come first and involve no Google
> sign-in.

## A sign-in helper we may run later

Some services — not Google — only complete sign-in through a server that holds
a secret. For those, the design includes a small open-source helper at
auth.metistry.app. **It is not built and does not run today.** If it ever
does, this policy will be updated first, and the helper will:

- hold only those services' client secrets — no accounts, no user database;
- exchange a sign-in code for tokens and refresh them, and nothing else — it
  never calls a service's data;
- see your IP address, which service and when, and — in memory, during an
  exchange — the tokens themselves, which it encrypts to your Mac and holds for
  at most five minutes until your Mac collects them;
- store and log none of that;
- be optional: you can always use your own sign-in client instead.

> Source: plan §2.6, "The token broker, auth.metistry.app — designed, not
> built in this program".

## Your choices

We hold no personal data about you beyond our website host's request logs, so
there is nothing for us to look up, correct or delete. Your data is on your
Mac: deleting your installation's folder removes your vault and, on the
standard Mac install, its database; `metistry secrets purge --instance
<folder>` removes its Keychain items; and your backup repository is yours to
delete wherever you host it. For
services you connect, their own policies and controls apply.

If you are in the EU or UK: the only personal data we process is the website
host's request logs, on the basis of our legitimate interest in running a
secure website. You may contact us about it at the address below.

## Children

Metistry isn't directed to children under 13, and we don't knowingly collect
personal data from anyone.

## Changes

If this policy changes, we'll post the new version here with a new effective
date and note it in the changelog.

## Contact

[LEGAL NAME] · [POSTAL ADDRESS] · [PRIVACY CONTACT EMAIL]
