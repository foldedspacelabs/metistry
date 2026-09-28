// Calendar object resources as a CalDAV server holds them (T4-13) — written
// from RFC 5545 and RFC 6638 in the shapes iCloud and Fastmail serve, not
// captured from a real account. CRLF, folded lines, a VTIMEZONE, an email
// alarm whose ATTENDEE is the owner (never an invitation), and invite bodies
// that must never be kept.

const crlf = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

const NY = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export const INVITE_BODY = "Agenda: the Q4 vendor numbers — confidential";

/** An invitation to the owner, organised by Dana: the owner has not answered. */
export const INVITE = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Corp//Calendar 1.0//EN",
  "CALSCALE:GREGORIAN",
  ...NY,
  "BEGIN:VEVENT",
  "UID:vendor-review-0929@example.com",
  "DTSTAMP:20260920T120000Z",
  "DTSTART;TZID=America/New_York:20260929T140000",
  "DTEND;TZID=America/New_York:20260929T150000",
  "SUMMARY:Vendor review",
  "LOCATION:Room 4\\, second floor",
  `DESCRIPTION:${INVITE_BODY}`,
  "ORGANIZER;CN=Dana Scully:mailto:dana@example.com",
  "ATTENDEE;CN=Dana Scully;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:dana@example.com",
  "ATTENDEE;CN=\"Owner, The (a name long enough that the line is folded on the w",
  " ire)\";CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;SCHEDULE-STATUS=1.2;RO",
  " LE=REQ-PARTICIPANT:mailto:me@example.com",
  "ATTENDEE;CN=\"Mulder, Fox\";PARTSTAT=TENTATIVE;RSVP=TRUE;DELEGATED-FROM=\"mail",
  " to:skinner@example.com\":mailto:fox@example.com",
  "SEQUENCE:2",
  "BEGIN:VALARM",
  "ACTION:EMAIL",
  "TRIGGER:-PT30M",
  "SUMMARY:Reminder",
  `DESCRIPTION:${INVITE_BODY}`,
  "ATTENDEE:mailto:me@example.com",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** A weekly standup the owner is invited to, with one moved occurrence the owner is also in. */
export const SERIES = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Corp//Calendar 1.0//EN",
  ...NY,
  "BEGIN:VEVENT",
  "UID:standup-7f3a@example.com",
  "DTSTAMP:20260901T120000Z",
  "DTSTART;TZID=America/New_York:20260928T093000",
  "DTEND;TZID=America/New_York:20260928T094500",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "SUMMARY:Standup",
  "ORGANIZER:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Me@Example.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-7f3a@example.com",
  "RECURRENCE-ID;TZID=America/New_York:20260930T093000",
  "DTSTAMP:20260901T120000Z",
  "DTSTART;TZID=America/New_York:20260930T113000",
  "DTEND;TZID=America/New_York:20260930T114500",
  "SUMMARY:Standup (moved)",
  "ORGANIZER:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** An event of the owner's own: nobody else in it. LF line endings, as some servers store them. */
export const OWN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Corp//Calendar 1.0//EN",
  "BEGIN:VEVENT",
  "UID:dentist-1@example.com",
  "DTSTAMP:20260920T120000Z",
  "DTSTART:20260930T170000Z",
  "DURATION:PT1H",
  "SUMMARY:Dentist",
  "SEQUENCE:3",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\n");

/** A meeting the owner organises. */
export const ORGANISED = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:planning-2@example.com",
  "DTSTAMP:20260920T120000Z",
  "DTSTART:20261001T150000Z",
  "DTEND:20261001T160000Z",
  "SUMMARY:Planning",
  "ORGANIZER:mailto:me@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:fox@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** An invitation whose organizer's client delivers replies itself — the server would not. */
export const CLIENT_AGENT = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:offsite-3@example.com",
  "DTSTAMP:20260920T120000Z",
  "DTSTART:20261002T150000Z",
  "DTEND:20261002T160000Z",
  "SUMMARY:Offsite",
  "ORGANIZER;SCHEDULE-AGENT=CLIENT:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
]);

/** An event the owner is not in (a shared calendar). */
export const NOT_MINE = crlf([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:their-4@example.com",
  "DTSTAMP:20260920T120000Z",
  "DTSTART:20261003T150000Z",
  "DTEND:20261003T160000Z",
  "SUMMARY:Their meeting",
  "ORGANIZER:mailto:dana@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED:mailto:fox@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
]);

export const ALL_EVENTS: Record<string, string> = {
  "vendor-review.ics": INVITE,
  "standup.ics": SERIES,
  "dentist.ics": OWN,
  "planning.ics": ORGANISED,
  "offsite.ics": CLIENT_AGENT,
  "their.ics": NOT_MINE,
};
