// ek-helper — the EventKit-touching half of the eventkit bridge (Swift, D3;
// TCC-bound: runs ONLY as its own launchd service, PoC-1/9). JSON-lines on
// stdio, same shape as afm-helper:
//   {"id":1,"op":"check"}                          behavioral probe (real read)
//   {"id":2,"op":"request"}                        trigger the consent prompts
//   {"id":3,"op":"list_events","days":1}
//   {"id":4,"op":"list_reminders"}
//   {"id":5,"op":"create_event","title":"...","start":"ISO","end":"ISO"}
//   {"id":6,"op":"create_reminder","title":"...","due":"ISO?"}
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

func listEvents(days: Int) -> [[String: Any]] {
    let start = Calendar.current.startOfDay(for: Date())
    let end = Calendar.current.date(byAdding: .day, value: max(days, 1), to: start)!
    let pred = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    return store.events(matching: pred).map {
        ["id": $0.eventIdentifier ?? "", "title": $0.title ?? "", "start": iso.string(from: $0.startDate),
         "end": iso.string(from: $0.endDate), "all_day": $0.isAllDay, "location": $0.location ?? "",
         "calendar": $0.calendar.title, "attendees": ($0.attendees ?? []).map { $0.name ?? "" }]
    }
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
            let n = listEvents(days: 7).count
            return ["id": req.id, "ok": true, "probe": "read 7 days of events", "events_found": n,
                    "auth_events": status(EKEventStore.authorizationStatus(for: .event)),
                    "auth_reminders": status(EKEventStore.authorizationStatus(for: .reminder))]
        case "request": return ["id": req.id, "ok": true, "granted": request()]
        case "list_events": return ["id": req.id, "ok": true, "events": listEvents(days: req.days ?? 1)]
        case "list_reminders": return ["id": req.id, "ok": true, "reminders": listReminders()]
        case "create_event": return ["id": req.id, "ok": true, "created": try createEvent(req)]
        case "create_reminder": return ["id": req.id, "ok": true, "created": try createReminder(req)]
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
