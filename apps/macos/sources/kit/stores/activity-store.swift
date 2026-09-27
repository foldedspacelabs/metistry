// Activity — the timeline, a run in full, and the audit ledger as the export
// reads it (design-build-plan §2.16). There is no `runs` list route: the
// timeline is the `activity_feed` named query.

import Foundation

public protocol ActivityStore: Sendable {
    /// route: GET /api/q/activity_feed
    func activityFeed(hours: Int?, limit: Int?, kind: String?, project: String?, agent: String?, since: String?, turnID: String?) async -> Result<ActivityFeed, ConsoleError>
    /// route: GET /api/runs/:id
    func run(_ id: Int) async -> Result<RunDetailReply, ConsoleError>
    /// route: GET /api/runs/export
    func exportRuns(since: String?, until: String?, component: String?, limit: Int?) async -> Result<RunExport, ConsoleError>
}

public extension ActivityStore {
    func activityFeed(hours: Int? = nil) async -> Result<ActivityFeed, ConsoleError> {
        await activityFeed(hours: hours, limit: nil, kind: nil, project: nil, agent: nil, since: nil, turnID: nil)
    }

    /// The calls one reply made (`turn_id`), inside the window — a turn's
    /// disclosure, whole, however many of them fell past the list's `limit`.
    func activityTurn(_ turnID: String, hours: Int?) async -> Result<ActivityFeed, ConsoleError> {
        await activityFeed(hours: hours, limit: nil, kind: nil, project: nil, agent: nil, since: nil, turnID: turnID)
    }
}

/// `GET /api/runs/export` — NDJSON, oldest first, one ledger row per line,
/// each carrying the `cursor` to resume from. Not one JSON document, so it is
/// read line by line rather than decoded whole.
public struct RunExport: Sendable, Equatable {
    public let rows: [JSONValue]

    /// The last line's `cursor`: what the next export's `since` is.
    public var cursor: String? { rows.last?["cursor"]?.stringValue }

    /// Every non-empty line is one JSON object; a line that is not is a
    /// contract disagreement, and the whole export is refused rather than
    /// silently shortened.
    ///
    /// One exception, read for what it is: a whole body that is ONE object,
    /// however many lines it spans. `metistry console call --json` (the
    /// fallback transport) pretty-prints any body that parses as JSON, and a
    /// one-row export does — so that row arrives over several lines.
    public init(ndjson data: Data) throws {
        if let whole = try? JSONDecoder().decode(JSONValue.self, from: data), case .object = whole {
            self.rows = [whole]
            return
        }
        let text = String(decoding: data, as: UTF8.self)
        var rows: [JSONValue] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) where !line.allSatisfy(\.isWhitespace) {
            rows.append(try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)))
        }
        self.rows = rows
    }
}

extension ConsoleStores: ActivityStore {
    public func activityFeed(hours: Int?, limit: Int?, kind: String?, project: String?, agent: String?, since: String?, turnID: String?) async -> Result<ActivityFeed, ConsoleError> {
        await api.activityFeed(hours: hours, limit: limit, kind: kind, project: project, agent: agent, since: since, turnID: turnID)
    }

    public func run(_ id: Int) async -> Result<RunDetailReply, ConsoleError> { await api.run(id) }

    public func exportRuns(since: String?, until: String?, component: String?, limit: Int?) async -> Result<RunExport, ConsoleError> {
        let path = "/api/runs/export" + ConsoleAPI.queryString(["since": since, "until": until, "component": component, "limit": limit.map(String.init)])
        switch await data("GET", path, nil, idempotencyKey: nil) {
        case .failure(let error):
            return .failure(error)
        case .success(let data):
            do {
                return .success(try RunExport(ndjson: data))
            } catch {
                return .failure(.undecodable("GET /api/runs/export printed a line that is not JSON: \(Self.describe(error))"))
            }
        }
    }
}
