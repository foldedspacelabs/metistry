// The Calendar API v3's answers for the owner's primary calendar (T4-14) —
// fixtures in the shape `events.list` and `events.get` return (Google,
// *Calendar API reference: Events*), written from that reference, not
// captured from Google: no test, and no agent building this, contacts
// Google. Each carries what a real answer carries beside the fields this
// provider asks for — `description`, `hangoutLink`, `conferenceData`,
// `creator`, `htmlLink` — because the fixture server ignores `fields=` as a
// careless server might: the provider must never read them anyway.
//
// Monday 28 September 2026, the owner (me@example.com) in New York.

export type RecordedEvent = Record<string, unknown>;

export const OWNER = "me@example.com";
/** A dial-in code in an invite body: it must never reach a row. */
export const INVITE_BODY = "Dial-in 555-0100, passcode 918273";

const extras = (id: string) => ({
  kind: "calendar#event",
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  created: "2026-09-20T15:00:00.000Z",
  updated: "2026-09-21T15:00:00.000Z",
  creator: { email: "alice@example.com" },
  sequence: 0,
  reminders: { useDefault: true },
});

/** An invitation the owner has not answered: Alice organises, Bob and a room are in it. */
export const INVITE: RecordedEvent = {
  ...extras("inv0design0review0001"),
  id: "inv0design0review0001",
  etag: '"3371000000000101"',
  status: "confirmed",
  summary: "Design review",
  description: INVITE_BODY,
  location: "Room 4",
  hangoutLink: "https://meet.google.com/abc-defg-hij",
  conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555-0100", pin: "918273" }] },
  start: { dateTime: "2026-09-28T10:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-28T11:00:00-04:00", timeZone: "America/New_York" },
  iCalUID: "inv0design0review0001@google.com",
  eventType: "default",
  organizer: { email: "alice@example.com", displayName: "Alice Chen" },
  attendees: [
    { email: "alice@example.com", displayName: "Alice Chen", organizer: true, responseStatus: "accepted" },
    { email: OWNER, self: true, responseStatus: "needsAction" },
    { email: "bob@example.com", displayName: "Bob Ortiz", responseStatus: "accepted", optional: true },
    { email: "c_room4@resource.calendar.google.com", displayName: "Room 4", resource: true, responseStatus: "accepted" },
  ],
};

/** The owner's own focus block: organised by the owner, nobody else in it. */
export const OWN: RecordedEvent = {
  ...extras("own0focus0block00001"),
  creator: { email: OWNER, self: true },
  id: "own0focus0block00001",
  etag: '"3371000000000202"',
  status: "confirmed",
  summary: "Focus",
  start: { dateTime: "2026-09-28T14:00:00-04:00" },
  end: { dateTime: "2026-09-28T15:30:00-04:00" },
  iCalUID: "own0focus0block00001@google.com",
  eventType: "default",
  organizer: { email: OWNER, self: true },
};

/** One occurrence of a weekly standup the owner accepted. */
export const STANDUP: RecordedEvent = {
  ...extras("stand0up0series00001_20260928T133000Z"),
  id: "stand0up0series00001_20260928T133000Z",
  etag: '"3371000000000303"',
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-09-28T09:30:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-28T09:45:00-04:00", timeZone: "America/New_York" },
  recurringEventId: "stand0up0series00001",
  originalStartTime: { dateTime: "2026-09-28T09:30:00-04:00", timeZone: "America/New_York" },
  iCalUID: "stand0up0series00001@google.com",
  eventType: "default",
  organizer: { email: "alice@example.com", displayName: "Alice Chen" },
  attendees: [
    { email: "alice@example.com", displayName: "Alice Chen", organizer: true, responseStatus: "accepted" },
    { email: OWNER, self: true, responseStatus: "accepted" },
  ],
};

/** The series itself, as `events.get` returns it for the series id. */
export const STANDUP_SERIES: RecordedEvent = {
  ...extras("stand0up0series00001"),
  creator: { email: OWNER, self: true },
  id: "stand0up0series00001",
  etag: '"3371000000000300"',
  status: "confirmed",
  summary: "Standup (mine)",
  start: { dateTime: "2026-09-07T09:30:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-09-07T09:45:00-04:00", timeZone: "America/New_York" },
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
  iCalUID: "stand0up0series00001@google.com",
  eventType: "default",
  organizer: { email: OWNER, self: true },
};

/** A cancelled occurrence of the standup — Google lists it with singleEvents. */
export const CANCELLED: RecordedEvent = {
  kind: "calendar#event",
  id: "stand0up0series00001_20261005T133000Z",
  etag: '"3371000000000304"',
  status: "cancelled",
  recurringEventId: "stand0up0series00001",
  originalStartTime: { dateTime: "2026-10-05T09:30:00-04:00", timeZone: "America/New_York" },
};

/** An all-day offsite of the owner's own, Wednesday. */
export const OFFSITE: RecordedEvent = {
  ...extras("off0site0all0day0001"),
  creator: { email: OWNER, self: true },
  id: "off0site0all0day0001",
  etag: '"3371000000000404"',
  status: "confirmed",
  summary: "Offsite",
  start: { date: "2026-09-30" },
  end: { date: "2026-10-01" },
  transparency: "transparent",
  iCalUID: "off0site0all0day0001@google.com",
  eventType: "default",
  organizer: { email: OWNER, self: true },
};

/** Where the owner works on Tuesday — not a meeting. */
export const WORKING_LOCATION: RecordedEvent = {
  ...extras("work0loc0tue00000001"),
  id: "work0loc0tue00000001",
  etag: '"3371000000000505"',
  status: "confirmed",
  summary: "Home",
  start: { date: "2026-09-29" },
  end: { date: "2026-09-30" },
  eventType: "workingLocation",
  workingLocationProperties: { type: "homeOffice", homeOffice: {} },
  organizer: { email: OWNER, self: true },
};

/** A meeting the owner organises, with Carol in it — no reply is the owner's, and write_own may not touch it. */
export const HOSTED: RecordedEvent = {
  ...extras("host0one0on0one00001"),
  creator: { email: OWNER, self: true },
  id: "host0one0on0one00001",
  etag: '"3371000000000606"',
  status: "confirmed",
  summary: "1:1 Carol",
  start: { dateTime: "2026-09-29T16:00:00-04:00" },
  end: { dateTime: "2026-09-29T16:30:00-04:00" },
  iCalUID: "host0one0on0one00001@google.com",
  eventType: "default",
  organizer: { email: OWNER, self: true },
  attendees: [
    { email: OWNER, self: true, organizer: true, responseStatus: "accepted" },
    { email: "carol@example.com", displayName: "Carol Ng", responseStatus: "needsAction" },
  ],
};

/** `events.list` over the two weeks, two pages (maxResults cut after four items). */
export const LIST_PAGES: RecordedEvent[][] = [
  [STANDUP, INVITE, OWN, CANCELLED],
  [HOSTED, WORKING_LOCATION, OFFSITE],
];

/** Every event `events.get` answers, fresh per fixture server. */
export function eventsById(): Map<string, RecordedEvent> {
  const all = [INVITE, OWN, STANDUP, STANDUP_SERIES, OFFSITE, WORKING_LOCATION, HOSTED];
  return new Map(all.map((e) => [String(e.id), structuredClone(e)]));
}
