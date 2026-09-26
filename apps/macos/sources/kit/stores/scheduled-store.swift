// Scheduled — everything recurring, in one place: routines and syncs, their
// timing, and Run Now (design-build-plan §2.5, §2.16). Timing is inside the
// boundary, so a phone may change it; WHAT runs — a routine's actor, its task
// and its per-run grants, and a New Routine — is reach `local`, the Mac only.
//
// The bodies are `.metistry/scheduled.yaml`'s own entries, whose schema F-4
// froze (`packages/core/src/scheduled.ts`): a schedule is `{days, at, tz?}` or
// `{every}`; an assignment is `{actor, task, grants?, schedule, paused?}`; a
// sync is `{every?, paused?, raise?}`. Every route is T3-3's (New Routine is
// T3-8's), frozen ahead of it with a contract fixture it must match.

import Foundation

public protocol ScheduledStore: Sendable {
    /// route: GET /api/scheduled
    func scheduled() async -> Result<ScheduledList, ConsoleError>
    /// route: GET /api/scheduled/routines/:name
    func routine(_ name: String) async -> Result<RoutineDetail, ConsoleError>
    /// route: GET /api/scheduled/syncs/:name
    func sync(_ name: String) async -> Result<SyncDetail, ConsoleError>
    /// route: PUT /api/scheduled/routines/:name/schedule
    func setSchedule(routine name: String, _ schedule: RoutineSchedule) async -> Result<RoutineDetail, ConsoleError>
    /// route: POST /api/scheduled/routines/:name/pause
    func pause(routine name: String) async -> Result<RoutineDetail, ConsoleError>
    /// route: POST /api/scheduled/routines/:name/resume
    func resume(routine name: String) async -> Result<RoutineDetail, ConsoleError>
    /// route: POST /api/scheduled/routines/:name/run
    func runNow(routine name: String) async -> Result<RoutineRunResult, ConsoleError>
    /// route: DELETE /api/scheduled/routines/:name
    func resetToDefault(routine name: String) async -> Result<RoutineDetail, ConsoleError>
    /// route: PUT /api/scheduled/routines/:name/assignment
    func setAssignment(routine name: String, _ assignment: RoutineAssignment) async -> Result<RoutineDetail, ConsoleError>
    /// route: POST /api/scheduled/routines
    func newRoutine(_ name: String, _ assignment: RoutineAssignment) async -> Result<RoutineDetail, ConsoleError>
    /// route: PUT /api/scheduled/syncs/:name
    func updateSync(_ name: String, _ settings: SyncSettings) async -> Result<SyncDetail, ConsoleError>
    /// route: POST /api/scheduled/syncs/:name/run
    func runNow(sync name: String) async -> Result<RoutineRunResult, ConsoleError>
}

// MARK: - Replies

/// `GET /api/scheduled`: every routine and sync, each field with the layer it came from (`default`, `profile`, `yours`).
public struct ScheduledList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// One routine as it resolves, with its last runs. Every routine write answers with the routine as it now stands.
public struct RoutineDetail: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// One sync as it resolves.
public struct SyncDetail: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// Run Now: the run started — or why it did not (a paused routine, a budget stop).
public struct RoutineRunResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// When a routine runs: a time of day on some days, or an interval from the closed set.
public enum RoutineSchedule: Sendable, Equatable {
    /// `days` is `working_days`, `eve_of_working_days`, or weekday names; `at` is `HH:MM` times; `tz` an IANA zone.
    case timeOfDay(days: [String], at: [String], tz: String?)
    /// `every` from the closed set (`5m`, `1h`, …).
    case interval(String)

    var json: JSONValue {
        switch self {
        case .timeOfDay(let days, let at, let tz):
            let daysValue: JSONValue = days.count == 1 && (days[0] == "working_days" || days[0] == "eve_of_working_days") ? .string(days[0]) : .array(days.map(JSONValue.string))
            return .fields(["days": daysValue, "at": .texts(at), "tz": .text(tz)])
        case .interval(let every):
            return .fields(["every": .string(every)])
        }
    }
}

/// What a routine runs (reach `local`): an actor, a task appended to its
/// definition — never replacing it — per-run grants, and a schedule.
public struct RoutineAssignment: ConsoleRequestBody {
    public var actor: String
    public var task: String
    public var read: [String]
    public var write: [String]
    public var schedule: RoutineSchedule
    public var paused: Bool?

    public init(actor: String, task: String, read: [String] = [], write: [String] = [], schedule: RoutineSchedule, paused: Bool? = nil) {
        self.actor = actor
        self.task = task
        self.read = read
        self.write = write
        self.schedule = schedule
        self.paused = paused
    }

    public var json: JSONValue {
        let grants: JSONValue? = read.isEmpty && write.isEmpty ? nil : .fields(["read": read.isEmpty ? nil : .texts(read), "write": write.isEmpty ? nil : .texts(write)])
        return .fields(["actor": .string(actor), "task": .string(task), "grants": grants, "schedule": schedule.json, "paused": paused.map(JSONValue.bool)])
    }
}

/// A sync's cadence, pause and raise toggles — never its connection.
public struct SyncSettings: ConsoleRequestBody {
    public var every: String?
    public var paused: Bool?
    public var raise: [String: Bool]?

    public init(every: String? = nil, paused: Bool? = nil, raise: [String: Bool]? = nil) {
        self.every = every
        self.paused = paused
        self.raise = raise
    }

    public var json: JSONValue {
        .fields(["every": .text(every), "paused": paused.map(JSONValue.bool), "raise": raise.map { .object($0.mapValues(JSONValue.bool)) }])
    }
}

// MARK: - Over the transport

extension ConsoleStores: ScheduledStore {
    private func routinePath(_ name: String) -> String { "/api/scheduled/routines/\(Self.segment(name))" }
    private func syncPath(_ name: String) -> String { "/api/scheduled/syncs/\(Self.segment(name))" }

    public func scheduled() async -> Result<ScheduledList, ConsoleError> { await get("/api/scheduled") }
    public func routine(_ name: String) async -> Result<RoutineDetail, ConsoleError> { await get(routinePath(name)) }
    public func sync(_ name: String) async -> Result<SyncDetail, ConsoleError> { await get(syncPath(name)) }

    public func setSchedule(routine name: String, _ schedule: RoutineSchedule) async -> Result<RoutineDetail, ConsoleError> {
        await perform("PUT", routinePath(name) + "/schedule", schedule.json)
    }

    public func pause(routine name: String) async -> Result<RoutineDetail, ConsoleError> {
        await perform("POST", routinePath(name) + "/pause", .object([:]))
    }

    public func resume(routine name: String) async -> Result<RoutineDetail, ConsoleError> {
        await perform("POST", routinePath(name) + "/resume", .object([:]))
    }

    public func runNow(routine name: String) async -> Result<RoutineRunResult, ConsoleError> {
        await perform("POST", routinePath(name) + "/run", .object([:]))
    }

    public func resetToDefault(routine name: String) async -> Result<RoutineDetail, ConsoleError> {
        await perform("DELETE", routinePath(name), nil)
    }

    public func setAssignment(routine name: String, _ assignment: RoutineAssignment) async -> Result<RoutineDetail, ConsoleError> {
        await perform("PUT", routinePath(name) + "/assignment", assignment.json)
    }

    public func newRoutine(_ name: String, _ assignment: RoutineAssignment) async -> Result<RoutineDetail, ConsoleError> {
        var body = assignment.json
        if case .object(var o) = body {
            o["name"] = .string(name)
            body = .object(o)
        }
        return await perform("POST", "/api/scheduled/routines", body)
    }

    public func updateSync(_ name: String, _ settings: SyncSettings) async -> Result<SyncDetail, ConsoleError> {
        await perform("PUT", syncPath(name), settings.json)
    }

    public func runNow(sync name: String) async -> Result<RoutineRunResult, ConsoleError> {
        await perform("POST", syncPath(name) + "/run", .object([:]))
    }
}
