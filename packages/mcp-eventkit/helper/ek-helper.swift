// ek-helper — the EventKit-touching half of the eventkit bridge (Swift, D3;
// TCC-bound: runs ONLY as its own launchd service, PoC-1/9). JSON-lines on
// stdio, same shape as afm-helper:
//   {"id":1,"op":"check"}                          behavioral probe (real read)
//   {"id":2,"op":"request"}                        trigger the consent prompts
//   {"id":3,"op":"list_events","days":1}          add "notes":true for the invite bodies
//   {"id":4,"op":"list_reminders"}
//   {"id":5,"op":"create_event","title":"...","start":"ISO","end":"ISO"}
//   {"id":6,"op":"create_reminder","title":"...","due":"ISO?"}
//   {"id":7,"op":"get_event","event_id":"..."}     one occurrence by the bridge's key (never its notes)
//   {"id":8,"op":"move_event","event_id":"...","start":"ISO","end":"ISO"}
//                                                  this occurrence only; the bridge gates it (T2-12)
// Info.plist is embedded at link time (usage descriptions) so tccd will
// prompt; the binary must be its own responsible process for that.

import Foundation
import EventKit

struct Req: Decodable {
    let id: Int
    let op: String
    let days: Int?
    let title: String?
    let start: String?
    let end: String?
    let due: String?
    let notes: Bool?
    let event_id: String?
}

func emit(_ o: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { print(s) }
}

let iso = ISO8601DateFormatter()
func status(_ s: EKAuthorizationStatus) -> String {
    switch s {
    case .fullAccess: return "full_access"
    case .writeOnly: return "write_only"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not_determined"
    }
}

let store = EKEventStore()

func request() -> [String: Any] {
    let g1 = DispatchSemaphore(value: 0); var ev = false
    store.requestFullAccessToEvents { granted, _ in ev = granted; g1.signal() }
    _ = g1.wait(timeout: .now() + 900)
    let g2 = DispatchSemaphore(value: 0); var rm = false
    store.requestFullAccessToReminders { granted, _ in rm = granted; g2.signal() }
    _ = g2.wait(timeout: .now() + 900)
    return ["events": ev, "reminders": rm]
}

// A participant's status, role and kind, spelled the way the bridge and the
// calendar_events table spell them (lowercase, snake_case) — never EventKit's
// raw integers, which are an enum's order and not a contract.
func participantStatus(_ s: EKParticipantStatus) -> String {
    switch s {
    case .pending: return "pending"
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .delegated: return "delegated"
    case .completed: return "completed"
    case .inProcess: return "in_process"
    default: return "unknown"
    }
}
func participantRole(_ r: EKParticipantRole) -> String {
    switch r {
    case .required: return "required"
    case .optional: return "optional"
    case .chair: return "chair"
    case .nonParticipant: return "non_participant"
    default: return "unknown"
    }
}
func participantType(_ t: EKParticipantType) -> String {
    switch t {
    case .person: return "person"
    case .room: return "room"
    case .resource: return "resource"
    case .group: return "group"
    default: return "unknown"
    }
}

// The address a participant is reached at: EventKit hands a `mailto:` URL,
// so this is that URL's address, percent-decoded, and nil for anything that
// is not a mailto (a `urn:uuid:` for a room, say). Lowercasing is the
// reader's business (the sync normalises exactly as people_emails does).
func participantEmail(_ p: EKParticipant) -> Any {
    let u = p.url
    guard u.scheme?.lowercased() == "mailto" else { return NSNull() }
    let raw = u.absoluteString.dropFirst("mailto:".count)
    let addr = String(raw).removingPercentEncoding ?? String(raw)
    return addr.isEmpty ? NSNull() : addr
}

func participant(_ p: EKParticipant) -> [String: Any] {
    ["name": p.name ?? NSNull(), "email": participantEmail(p), "status": participantStatus(p.participantStatus),
     "role": participantRole(p.participantRole), "type": participantType(p.participantType), "self": p.isCurrentUser]
}

// UTC, basic format: the stable suffix a recurring occurrence's key carries.
// All-day occurrences are floating (EKEvent.h: "returned in the default time
// zone"), so they carry the local calendar day instead — the same instant
// read in another zone would otherwise be another key.
let occurrenceUTC: DateFormatter = {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"; return f
}()
let occurrenceDay: DateFormatter = {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current; f.dateFormat = "yyyyMMdd"; return f
}()

// The occurrence key the bridge serves as `event_id` (events.ts `eventKey`,
// the one spelling): the identifier, plus the ORIGINAL date for an
// occurrence of a recurring event. Computed here too only so `get_event` and
// `move_event` can find the one occurrence a key names.
func occurrenceSuffix(_ e: EKEvent) -> String? {
    let recurring = e.hasRecurrenceRules || e.isDetached
    guard recurring, let d = e.occurrenceDate else { return nil }
    return e.isAllDay ? occurrenceDay.string(from: d) : occurrenceUTC.string(from: d)
}
func eventKey(_ e: EKEvent) -> String? {
    guard let id = e.eventIdentifier, !id.isEmpty else { return nil }
    return occurrenceSuffix(e).map { "\(id)_\($0)" } ?? id
}

// One event as `list_events` and `get_event` report it. `notes` is the
// invite body — dial-in codes, confidential agendas — and is read ONLY when
// the request asks for it; the eventkit bridge never does (its routes strip
// the field even if it arrives), so nothing it serves carries one.
func eventDict(_ e: EKEvent, notes: Bool = false) -> [String: Any] {
    let recurring = e.hasRecurrenceRules || e.isDetached
    var o: [String: Any] = [
        "id": e.eventIdentifier ?? "", "title": e.title ?? "", "start": iso.string(from: e.startDate),
        "end": iso.string(from: e.endDate), "all_day": e.isAllDay, "location": e.location ?? "",
        "calendar": e.calendar.title,
        // names only, as before: morning-brief and weekly-review read this list as strings
        "attendees": (e.attendees ?? []).map { $0.name ?? "" },
        "participants": (e.attendees ?? []).map(participant),
        "organizer": e.organizer.map(participant) ?? NSNull(),
        "ical_uid": e.calendarItemExternalIdentifier ?? NSNull(),
        "recurring": recurring,
        "occurrence": occurrenceSuffix(e) ?? NSNull(),
        "writable": e.calendar.allowsContentModifications,
    ]
    if notes { o["notes"] = e.notes ?? NSNull() }
    return o
}

// The events window: local midnight today, for `days` days.
func listEvents(days: Int, notes: Bool = false) -> (events: [[String: Any]], start: Date, end: Date) {
    let start = Calendar.current.startOfDay(for: Date())
    let end = Calendar.current.date(byAdding: .day, value: max(days, 1), to: start)!
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events: [[String: Any]] = store.events(matching: pred).map { eventDict($0, notes: notes) }
    return (events, start, end)
}

// The one occurrence a key names, or nil. A one-off event's key is its
// identifier, which EventKit looks up directly. An occurrence's key carries
// its ORIGINAL date, which stays put when that occurrence is moved, so the
// search is the series' occurrences within a month either side of it —
// matched on the whole key, never on the identifier alone (which is every
// occurrence of the series).
let OCCURRENCE_SEARCH_DAYS = 31.0 // limit: fixed — an occurrence moved more than a month from its original date is not found, and the move is refused, never guessed
func findEvent(_ key: String) -> EKEvent? {
    if let e = store.event(withIdentifier: key), eventKey(e) == key { return e }
    guard let us = key.lastIndex(of: "_") else { return nil }
    let id = String(key[..<us]), occ = String(key[key.index(after: us)...])
    guard let when = occurrenceUTC.date(from: occ) ?? occurrenceDay.date(from: occ) else { return nil }
    let span = OCCURRENCE_SEARCH_DAYS * 86_400
    let pred = store.predicateForEvents(withStart: when.addingTimeInterval(-span), end: when.addingTimeInterval(span), calendars: nil)
    return store.events(matching: pred).first { $0.eventIdentifier == id && eventKey($0) == key }
}

func getEvent(_ r: Req) throws -> Any {
    guard let key = r.event_id, !key.isEmpty else {
        throw NSError(domain: "ek", code: 3, userInfo: [NSLocalizedDescriptionKey: "event_id required"])
    }
    return findEvent(key).map { eventDict($0) } ?? NSNull()
}

// Moves THIS occurrence only (`.thisEvent`): a series is never re-timed by
// moving one Monday. Who may ask is the bridge's decision, made before this
// runs (index.ts: a confirm for an event with others in it needs the owner
// door's token); this function only refuses what EventKit cannot do.
func moveEvent(_ r: Req) throws -> [String: Any] {
    guard let key = r.event_id, !key.isEmpty, let s = r.start.flatMap(iso.date), let e = r.end.flatMap(iso.date), e > s else {
        throw NSError(domain: "ek", code: 4, userInfo: [NSLocalizedDescriptionKey: "event_id/start/end required (ISO8601), end after start"])
    }
    guard let ev = findEvent(key) else {
        throw NSError(domain: "ek", code: 5, userInfo: [NSLocalizedDescriptionKey: "no event with this key"])
    }
    guard ev.calendar.allowsContentModifications else {
        throw NSError(domain: "ek", code: 6, userInfo: [NSLocalizedDescriptionKey: "the event's calendar is read-only"])
    }
    ev.startDate = s; ev.endDate = e
    try store.save(ev, span: .thisEvent, commit: true)
    return eventDict(ev)
}

func listReminders() -> [[String: Any]] {
    let sem = DispatchSemaphore(value: 0); var out: [[String: Any]] = []
    let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
    store.fetchReminders(matching: pred) { rs in
        out = (rs ?? []).map {
            ["id": $0.calendarItemIdentifier, "title": $0.title ?? "", "list": $0.calendar.title,
             "due": $0.dueDateComponents.flatMap { Calendar.current.date(from: $0) }.map { iso.string(from: $0) } ?? ""]
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 30)
    return out
}

func createEvent(_ r: Req) throws -> [String: Any] {
    guard let t = r.title, let s = r.start.flatMap(iso.date), let e = r.end.flatMap(iso.date) else {
        throw NSError(domain: "ek", code: 1, userInfo: [NSLocalizedDescriptionKey: "title/start/end required (ISO8601)"])
    }
    let ev = EKEvent(eventStore: store)
    ev.title = t; ev.startDate = s; ev.endDate = e
    ev.calendar = store.defaultCalendarForNewEvents
    try store.save(ev, span: .thisEvent, commit: true)
    return ["id": ev.eventIdentifier ?? ""]
}

func createReminder(_ r: Req) throws -> [String: Any] {
    guard let t = r.title else { throw NSError(domain: "ek", code: 2, userInfo: [NSLocalizedDescriptionKey: "title required"]) }
    let rem = EKReminder(eventStore: store)
    rem.title = t
    rem.calendar = store.defaultCalendarForNewReminders()
    if let d = r.due.flatMap(iso.date) {
        rem.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
    }
    try store.save(rem, commit: true)
    return ["id": rem.calendarItemIdentifier]
}

func handle(_ line: String) -> [String: Any] {
    guard let d = line.data(using: .utf8), let req = try? JSONDecoder().decode(Req.self, from: d) else {
        return ["id": -1, "ok": false, "error": "bad request line"]
    }
    do {
        switch req.op {
        case "check":
            // behavioral probe (hard req 3): a real read; unauthorized returns an
            // empty world with no error, so report the auth status alongside
            let n = listEvents(days: 7).events.count
            return ["id": req.id, "ok": true, "probe": "read 7 days of events", "events_found": n,
                    "auth_events": status(EKEventStore.authorizationStatus(for: .event)),
                    "auth_reminders": status(EKEventStore.authorizationStatus(for: .reminder))]
        case "request": return ["id": req.id, "ok": true, "granted": request()]
        case "list_events":
            let r = listEvents(days: req.days ?? 1, notes: req.notes == true)
            // the window read, so a sync can tell "cancelled" from "outside what was asked"
            return ["id": req.id, "ok": true, "events": r.events,
                    "window": ["start": iso.string(from: r.start), "end": iso.string(from: r.end)]]
        case "list_reminders": return ["id": req.id, "ok": true, "reminders": listReminders()]
        case "create_event": return ["id": req.id, "ok": true, "created": try createEvent(req)]
        case "create_reminder": return ["id": req.id, "ok": true, "created": try createReminder(req)]
        case "get_event": return ["id": req.id, "ok": true, "event": try getEvent(req)]
        case "move_event": return ["id": req.id, "ok": true, "moved": try moveEvent(req)]
        default: return ["id": req.id, "ok": false, "error": "unknown op \(req.op)"]
        }
    } catch {
        return ["id": req.id, "ok": false, "error": "\(error)"]
    }
}

func encode(_ o: [String: Any]) -> String {
    (try? JSONSerialization.data(withJSONObject: o)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}

// ---- transport: TCC attributes to the launchd job's ROOT binary (PoC-1), so
// this helper runs as its own service and serves a Unix socket; the node
// bridge connects to it. stdio mode remains for one-shot use (consent).
if let sockPath = ProcessInfo.processInfo.environment["METISTRY_EK_SOCKET"] {
    unlink(sockPath)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutablePointer(to: &addr.sun_path) { p in
        p.withMemoryRebound(to: CChar.self, capacity: 104) { _ = strlcpy($0, sockPath, 104) }
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }) == 0,
          listen(fd, 8) == 0 else { FileHandle.standardError.write("bind/listen failed on \(sockPath)\n".data(using: .utf8)!); exit(1) }
    chmod(sockPath, 0o600) // owner-only: the socket is the bridge's private channel
    print("ek-helper serving \(sockPath) events=\(status(EKEventStore.authorizationStatus(for: .event))) reminders=\(status(EKEventStore.authorizationStatus(for: .reminder)))")
    fflush(stdout)
    while true {
        let client = accept(fd, nil, nil)
        if client < 0 { continue }
        let h = FileHandle(fileDescriptor: client, closeOnDealloc: true)
        var buf = Data()
        while true {
            let chunk = h.availableData
            if chunk.isEmpty { break }
            buf.append(chunk)
            while let nl = buf.firstIndex(of: 0x0A) {
                let lineData = buf.subdata(in: buf.startIndex..<nl)
                buf.removeSubrange(buf.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                    h.write((encode(handle(line)) + "\n").data(using: .utf8)!)
                }
            }
        }
    }
} else {
    setvbuf(stdout, nil, _IOLBF, 0)
    emit(["id": 0, "ok": true, "ready": true,
          "events": status(EKEventStore.authorizationStatus(for: .event)),
          "reminders": status(EKEventStore.authorizationStatus(for: .reminder))])
    while let line = readLine(strippingNewline: true) { emit(handle(line)) }
}
