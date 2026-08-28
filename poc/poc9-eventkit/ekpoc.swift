// PoC-9 — EventKit from a headless process.
// Subcommands: status | request | test-events | test-reminders | cleanup | sync-artifact
// Build: see build.sh (Info.plist must be embedded via -sectcreate for TCC consent).

import Foundation
import EventKit

let POC_NAME = "Metistry PoC"
let EVENT_TITLE = "PoC-9 test event"
let EVENT_TITLE_2 = "PoC-9 test event (updated)"
let REM_TITLE = "PoC-9 test reminder"
let REM_TITLE_2 = "PoC-9 test reminder (updated)"
let SYNC_TITLE = "PoC-9 sync check — delete me"

// ---------- machine readable output ----------

var stepIndex = 0
func step(_ name: String, _ ok: Bool, _ detail: String = "") {
    stepIndex += 1
    let status = ok ? "OK" : "FAIL"
    print("STEP \(stepIndex) \(name) \(status) \(detail)")
    fflush(stdout)
}
func info(_ k: String, _ v: String) {
    print("INFO \(k) \(v)")
    fflush(stdout)
}
func fail(_ msg: String) -> Never {
    print("RESULT FAIL \(msg)")
    fflush(stdout)
    exit(1)
}
func done() -> Never {
    print("RESULT PASS")
    fflush(stdout)
    exit(0)
}

func statusName(_ s: EKAuthorizationStatus) -> String {
    switch s.rawValue {
    case 0:  return "notDetermined(0)"
    case 1:  return "restricted(1)"
    case 2:  return "denied(2)"
    case 3:  return "fullAccess/authorized(3)"
    case 4:  return "writeOnly(4)"
    default: return "unknown(\(s.rawValue))"
    }
}

func env(_ k: String) -> String { ProcessInfo.processInfo.environment[k] ?? "<unset>" }

// Consent can sit on a GUI prompt for a long time. Configurable so the binary
// never has to be rebuilt after a grant exists (rebuilding changes the ad-hoc
// cdhash, which is the TCC identity of an unsigned-by-a-team CLI binary).
let WAIT_SECS: Double = Double(ProcessInfo.processInfo.environment["EKPOC_WAIT"] ?? "") ?? 900.0

// ---------- context banner ----------

func banner() {
    info("pid", "\(ProcessInfo.processInfo.processIdentifier)")
    info("ppid", "\(getppid())")
    info("binary", CommandLine.arguments[0])
    info("uid", "\(getuid())")
    info("env.XPC_SERVICE_NAME", env("XPC_SERVICE_NAME"))
    info("env.TERM", env("TERM"))
    info("env.SSH_TTY", env("SSH_TTY"))
    info("tty.stdin", isatty(0) == 1 ? "yes" : "no")
    let bundlePlist = Bundle.main.infoDictionary
    info("infoPlist.embedded", bundlePlist == nil ? "nil" : "yes keys=\(bundlePlist!.keys.sorted().joined(separator: ","))")
}

// ---------- source selection ----------

func pickSource(_ store: EKEventStore, entity: EKEntityType) -> EKSource? {
    let usable = store.sources.filter { src in
        !src.calendars(for: entity).isEmpty || src.sourceType == .local || src.sourceType == .calDAV
    }
    // prefer the source that already owns the default calendar (that's the one that syncs)
    let def = entity == .event ? store.defaultCalendarForNewEvents
                               : store.defaultCalendarForNewReminders()
    if let s = def?.source { return s }
    if let icloud = usable.first(where: { $0.sourceType == .calDAV && $0.title.lowercased().contains("icloud") }) { return icloud }
    if let cal = usable.first(where: { $0.sourceType == .calDAV }) { return cal }
    if let local = usable.first(where: { $0.sourceType == .local }) { return local }
    return store.sources.first
}

func dumpSources(_ store: EKEventStore, entity: EKEntityType) {
    for s in store.sources {
        let n = s.calendars(for: entity).count
        info("source", "type=\(s.sourceType.rawValue) title=\(s.title) calendars(\(entity == .event ? "event" : "reminder"))=\(n)")
    }
}

func findPoCCalendar(_ store: EKEventStore, entity: EKEntityType) -> EKCalendar? {
    return store.calendars(for: entity).first { $0.title == POC_NAME }
}

func ensureCalendar(_ store: EKEventStore, entity: EKEntityType) throws -> EKCalendar {
    if let existing = findPoCCalendar(store, entity: entity) {
        info("calendar.reused", "\(existing.calendarIdentifier) source=\(existing.source.title)")
        return existing
    }
    let cal = EKCalendar(for: entity, eventStore: store)
    cal.title = POC_NAME
    guard let src = pickSource(store, entity: entity) else {
        throw NSError(domain: "poc9", code: 10, userInfo: [NSLocalizedDescriptionKey: "no usable EKSource"])
    }
    cal.source = src
    try store.saveCalendar(cal, commit: true)
    info("calendar.created", "\(cal.calendarIdentifier) source=\(src.title) type=\(src.sourceType.rawValue)")
    return cal
}

func tomorrowAt(hour: Int, minute: Int) -> Date {
    let cal = Calendar.current
    let tomorrow = cal.date(byAdding: .day, value: 1, to: Date())!
    var c = cal.dateComponents([.year, .month, .day], from: tomorrow)
    c.hour = hour; c.minute = minute; c.second = 0
    return cal.date(from: c)!
}

// ---------- authorization ----------

func authStatuses() -> (EKAuthorizationStatus, EKAuthorizationStatus) {
    return (EKEventStore.authorizationStatus(for: .event),
            EKEventStore.authorizationStatus(for: .reminder))
}

func cmdStatus() {
    banner()
    let (e, r) = authStatuses()
    info("auth.event", statusName(e))
    info("auth.reminder", statusName(r))
    print("RESULT PASS")
    exit(0)
}

func cmdRequest() {
    banner()
    let (e0, r0) = authStatuses()
    info("auth.event.before", statusName(e0))
    info("auth.reminder.before", statusName(r0))

    info("waitSeconds", "\(WAIT_SECS)")
    let store = EKEventStore()

    let sem1 = DispatchSemaphore(value: 0)
    var eventGranted = false
    var eventErr: String = "none"
    info("calling", "requestFullAccessToEvents")
    let t0 = Date()
    store.requestFullAccessToEvents { granted, error in
        eventGranted = granted
        if let error = error { eventErr = "\(error)" }
        sem1.signal()
    }
    let w1 = sem1.wait(timeout: .now() + WAIT_SECS)
    info("elapsed.events", String(format: "%.1fs", Date().timeIntervalSince(t0)))
    step("request.events", w1 == .success, "granted=\(eventGranted) err=\(eventErr) wait=\(w1 == .success ? "returned" : "TIMEOUT")")

    let store2 = EKEventStore()
    let sem2 = DispatchSemaphore(value: 0)
    var remGranted = false
    var remErr: String = "none"
    info("calling", "requestFullAccessToReminders")
    let t1 = Date()
    store2.requestFullAccessToReminders { granted, error in
        remGranted = granted
        if let error = error { remErr = "\(error)" }
        sem2.signal()
    }
    let w2 = sem2.wait(timeout: .now() + WAIT_SECS)
    info("elapsed.reminders", String(format: "%.1fs", Date().timeIntervalSince(t1)))
    step("request.reminders", w2 == .success, "granted=\(remGranted) err=\(remErr) wait=\(w2 == .success ? "returned" : "TIMEOUT")")

    let (e1, r1) = authStatuses()
    info("auth.event.after", statusName(e1))
    info("auth.reminder.after", statusName(r1))
    if eventGranted && remGranted { done() }
    fail("not fully granted (events=\(eventGranted) reminders=\(remGranted))")
}

// ---------- events CRUD ----------

func cmdTestEvents() {
    banner()
    let (e, _) = authStatuses()
    info("auth.event", statusName(e))
    let store = EKEventStore()
    dumpSources(store, entity: .event)

    do {
        let cal = try ensureCalendar(store, entity: .event)
        step("events.calendar", true, "title=\(cal.title) id=\(cal.calendarIdentifier) source=\(cal.source.title) allowsMod=\(cal.allowsContentModifications)")

        // create
        let ev = EKEvent(eventStore: store)
        ev.title = EVENT_TITLE
        ev.startDate = tomorrowAt(hour: 10, minute: 0)
        ev.endDate = tomorrowAt(hour: 10, minute: 30)
        ev.calendar = cal
        ev.notes = "created by PoC-9"
        try store.save(ev, span: .thisEvent, commit: true)
        let evID = ev.eventIdentifier ?? "<nil>"
        step("events.create", evID != "<nil>", "id=\(evID) start=\(ev.startDate!) end=\(ev.endDate!)")

        // read back (by identifier)
        guard let got = store.event(withIdentifier: evID) else {
            step("events.read", false, "event(withIdentifier:) returned nil")
            fail("read-back failed")
        }
        step("events.read", got.title == EVENT_TITLE, "title=\(got.title ?? "<nil>") start=\(got.startDate!)")

        // read back via predicate too (proves it is queryable in the calendar)
        let pred = store.predicateForEvents(withStart: tomorrowAt(hour: 0, minute: 0),
                                            end: tomorrowAt(hour: 23, minute: 59),
                                            calendars: [cal])
        let found = store.events(matching: pred).filter { $0.title == EVENT_TITLE }
        step("events.query", found.count == 1, "matches=\(found.count)")

        // update
        got.title = EVENT_TITLE_2
        try store.save(got, span: .thisEvent, commit: true)
        step("events.update", true, "newTitle=\(EVENT_TITLE_2)")

        guard let got2 = store.event(withIdentifier: evID) else {
            step("events.read2", false, "nil after update")
            fail("read-back-2 failed")
        }
        step("events.read2", got2.title == EVENT_TITLE_2, "title=\(got2.title ?? "<nil>")")

        // delete
        try store.remove(got2, span: .thisEvent, commit: true)
        let gone = store.event(withIdentifier: evID)
        let found2 = store.events(matching: pred).filter { $0.title.hasPrefix("PoC-9") }
        step("events.delete", gone == nil && found2.isEmpty, "byIdentifier=\(gone == nil ? "gone" : "STILL PRESENT") byQuery=\(found2.count)")

        done()
    } catch {
        step("events.exception", false, "\(error)")
        fail("\(error)")
    }
}

// ---------- reminders CRUD ----------

func fetchReminders(_ store: EKEventStore, _ cal: EKCalendar) -> [EKReminder] {
    let pred = store.predicateForReminders(in: [cal])
    let sem = DispatchSemaphore(value: 0)
    var out: [EKReminder] = []
    store.fetchReminders(matching: pred) { rems in
        out = rems ?? []
        sem.signal()
    }
    if sem.wait(timeout: .now() + 30) != .success {
        info("reminders.fetch", "TIMEOUT")
    }
    return out
}

func cmdTestReminders() {
    banner()
    let (_, r) = authStatuses()
    info("auth.reminder", statusName(r))
    let store = EKEventStore()
    dumpSources(store, entity: .reminder)

    do {
        let cal = try ensureCalendar(store, entity: .reminder)
        step("reminders.list", true, "title=\(cal.title) id=\(cal.calendarIdentifier) source=\(cal.source.title) allowsMod=\(cal.allowsContentModifications)")

        // create
        let rem = EKReminder(eventStore: store)
        rem.title = REM_TITLE
        rem.calendar = cal
        rem.notes = "created by PoC-9"
        let due = tomorrowAt(hour: 10, minute: 0)
        rem.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
        try store.save(rem, commit: true)
        let remID = rem.calendarItemIdentifier
        step("reminders.create", !remID.isEmpty, "id=\(remID) due=\(due)")

        // read back
        let all1 = fetchReminders(store, cal)
        let got = all1.first { $0.calendarItemIdentifier == remID }
        step("reminders.read", got != nil && got?.title == REM_TITLE,
             "count=\(all1.count) title=\(got?.title ?? "<nil>") due=\(String(describing: got?.dueDateComponents))")
        guard let got = got else { fail("read-back failed") }

        // update
        got.title = REM_TITLE_2
        try store.save(got, commit: true)
        let all2 = fetchReminders(store, cal)
        let got2 = all2.first { $0.calendarItemIdentifier == remID }
        step("reminders.update", got2?.title == REM_TITLE_2, "title=\(got2?.title ?? "<nil>")")
        guard let got2 = got2 else { fail("read-back-2 failed") }

        // complete
        got2.isCompleted = true
        try store.save(got2, commit: true)
        let all3 = fetchReminders(store, cal)
        let got3 = all3.first { $0.calendarItemIdentifier == remID }
        step("reminders.complete", got3?.isCompleted == true,
             "isCompleted=\(String(describing: got3?.isCompleted)) completionDate=\(String(describing: got3?.completionDate))")
        guard let got3 = got3 else { fail("read-back-3 failed") }

        // delete
        try store.remove(got3, commit: true)
        let all4 = fetchReminders(store, cal)
        let still = all4.contains { $0.calendarItemIdentifier == remID }
        step("reminders.delete", !still, "remaining=\(all4.count) stillPresent=\(still)")

        done()
    } catch {
        step("reminders.exception", false, "\(error)")
        fail("\(error)")
    }
}

// ---------- cleanup ----------

func cmdCleanup() {
    banner()
    let store = EKEventStore()
    var removed = 0
    var errs: [String] = []
    for entity in [EKEntityType.event, EKEntityType.reminder] {
        for cal in store.calendars(for: entity) where cal.title == POC_NAME {
            do {
                try store.removeCalendar(cal, commit: true)
                removed += 1
                info("removed.calendar", "\(entity == .event ? "event" : "reminder") \(cal.calendarIdentifier) source=\(cal.source.title)")
            } catch {
                errs.append("\(cal.calendarIdentifier): \(error)")
            }
        }
    }
    step("cleanup", errs.isEmpty, "removed=\(removed) errors=\(errs.joined(separator: " | "))")
    let leftE = store.calendars(for: .event).filter { $0.title == POC_NAME }.count
    let leftR = store.calendars(for: .reminder).filter { $0.title == POC_NAME }.count
    step("cleanup.verify", leftE == 0 && leftR == 0, "remainingEventCals=\(leftE) remainingReminderCals=\(leftR)")
    if errs.isEmpty && leftE == 0 && leftR == 0 { done() }
    fail("cleanup incomplete")
}

// ---------- sync artifact ----------

func cmdSyncArtifact() {
    banner()
    let store = EKEventStore()
    do {
        let cal = try ensureCalendar(store, entity: .reminder)
        let existing = fetchReminders(store, cal)
        for r in existing where r.title == SYNC_TITLE {
            try store.remove(r, commit: true)
        }
        let rem = EKReminder(eventStore: store)
        rem.title = SYNC_TITLE
        rem.calendar = cal
        rem.notes = "PoC-9 left this behind so you can confirm it appears on the iPhone. Safe to delete."
        try store.save(rem, commit: true)
        step("sync.artifact", true, "list=\(cal.title) source=\(cal.source.title) id=\(rem.calendarItemIdentifier) title=\(SYNC_TITLE)")
        let after = fetchReminders(store, cal)
        step("sync.verify", after.contains { $0.title == SYNC_TITLE }, "itemsInList=\(after.count) titles=[\(after.map { $0.title ?? "" }.joined(separator: "; "))]")
        let evCals = store.calendars(for: .event).filter { $0.title == POC_NAME }
        step("sync.noEventCalendar", evCals.isEmpty, "eventCalendarsNamed'\(POC_NAME)'=\(evCals.count)")
        done()
    } catch {
        step("sync.exception", false, "\(error)")
        fail("\(error)")
    }
}

// ---------- main ----------

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("usage: ekpoc <status|request|test-events|test-reminders|cleanup|sync-artifact>")
    exit(2)
}
print("=== ekpoc \(args[1]) @ \(ISO8601DateFormatter().string(from: Date())) ===")
switch args[1] {
case "status":         cmdStatus()
case "request":        cmdRequest()
case "test-events":    cmdTestEvents()
case "test-reminders": cmdTestReminders()
case "cleanup":        cmdCleanup()
case "sync-artifact":  cmdSyncArtifact()
default:
    print("unknown subcommand \(args[1])")
    exit(2)
}
