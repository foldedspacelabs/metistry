---
"@foldedspacelabs/metistry-connections": minor
"@foldedspacelabs/metistry-core": minor
"@metistry-apps/collectors": minor
"@metistry-apps/console": minor
---

T4-17: Invitation and message requests. The eventkit, CalDAV and Google Calendar syncs raise
one `invitation` mirror per meeting still to come whose owner's answer is
needs-action and which someone else organises (R7) — a series is one card,
the same meeting on two calendars one card with both askers — cleared with a
receipt when the owner answers, it is cancelled or it passes; an ICS feed
names no owner and raises none. A new sync, `mail-messages`, reads the last
week of an IMAP inbox's headers (and Sent's, for what was answered) and
raises one `message` mirror per message that waits on the owner's reply,
inferred from the headers alone and saying so (`payload.inferred`), cleared
when the owner replies, it leaves the inbox or it is a week old. The imap
types declare `sync: mail-messages`, so their app password is delivered to
the console; `openSyncImap` / `instanceImapOpener` open the mailbox through
the IMAP host guard, and `ImapSession.readMessage` re-reads one message's
headers by reference. `POST /api/calendar/invitations/:id/respond` answers
through a connection whose provider declares `rsvp` — CalDAV or Google
Calendar — (refused with Open in Calendar where none can) and `POST /api/mail/messages/:id/draft` writes a
reply to Drafts, addressed from the message's own headers; both preview,
then confirm with a single-use token, and never send mail.
