// Work — the board and its drags, projects, dispatch to a target, a task's
// room, and the pull-request doors (design-build-plan §2.16). A task is moved
// by the owner's hand here and by an agent's tools elsewhere; assignment
// (`owner`) exists only on this side.

import Foundation

public protocol WorkStore: Sendable {
    /// route: GET /api/q/board
    func board(project: String?, limit: Int?) async -> Result<Board, ConsoleError>
    /// route: GET /api/q/rooms
    func rooms(state: String?, project: String?, anchor: String?, limit: Int?) async -> Result<RoomList, ConsoleError>
    /// route: GET /api/projects
    func projects() async -> Result<ProjectList, ConsoleError>
    /// route: PUT /api/projects/:slug
    func updateProject(_ slug: String, _ update: ProjectUpdate) async -> Result<ProjectUpdateResult, ConsoleError>
    /// route: GET /api/targets
    func targets() async -> Result<TargetList, ConsoleError>
    /// route: POST /api/tasks/:id/dispatch
    func dispatchTask(_ id: Int, _ dispatch: TaskDispatch) async -> Result<TaskDispatchResult, ConsoleError>
    /// route: PATCH /api/tasks/:id
    func updateTask(_ id: Int, _ patch: TaskPatch) async -> Result<TaskMutation, ConsoleError>
    /// route: POST /api/tasks/:id/claim
    func claimTask(_ id: Int, leaseSeconds: Int?) async -> Result<TaskMutation, ConsoleError>
    /// route: POST /api/tasks/:id/release
    func releaseTask(_ id: Int, note: String?) async -> Result<TaskMutation, ConsoleError>
    /// route: POST /api/tasks/:id/renew
    func renewTask(_ id: Int, note: String?, leaseSeconds: Int?) async -> Result<TaskMutation, ConsoleError>
    /// route: GET /api/work/:id/thread
    func taskRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError>
    /// route: POST /api/work/:id/comments
    func comment(onTask workID: Int, _ body: String) async -> Result<RoomComment, ConsoleError>
    /// route: POST /api/work/:id/thread/resolve
    func resolveRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError>
    /// route: POST /api/work/:id/thread/reopen
    func reopenRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError>
    /// route: POST /api/github/pulls/:owner/:repo/:number/review
    func review(_ pull: PullRequestRef, _ review: PullRequestReview) async -> Result<PullRequestResult, ConsoleError>
    /// route: POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply
    func reply(_ pull: PullRequestRef, thread: String, body: String, headSHA: String) async -> Result<PullRequestResult, ConsoleError>
    /// route: POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve
    func resolve(_ pull: PullRequestRef, thread: String, headSHA: String) async -> Result<PullRequestResult, ConsoleError>
}

// MARK: - Replies

/// `GET /api/projects` — `{projects, as_of}`: each with its mode, budget, caps and rollup.
public struct ProjectList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `PUT /api/projects/:slug` — `{ok, project}`.
public struct ProjectUpdateResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/targets` — `{targets, as_of}`: each target's transport, data policy and live `check`.
public struct TargetList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// A task's room: its state, participants and comments. Resolve and reopen answer with the room as it now stands.
public struct TaskRoom: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/work/:id/comments` — `{comment, demoted}`.
public struct RoomComment: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// The pull-request doors (T2-13): what was posted. A head that moved is `409 stale`, and nothing is sent.
public struct PullRequestResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// `PUT /api/projects/:slug` — only the keys given change.
public struct ProjectUpdate: Sendable, Equatable {
    /// `autonomous` or `review` — the kill switch.
    public var mode: String?
    public var dailyBudgetUSD: Double?
    public var maxOpenBundles: Int?
    public var title: String?
    public var area: String?

    public init(mode: String? = nil, dailyBudgetUSD: Double? = nil, maxOpenBundles: Int? = nil, title: String? = nil, area: String? = nil) {
        self.mode = mode
        self.dailyBudgetUSD = dailyBudgetUSD
        self.maxOpenBundles = maxOpenBundles
        self.title = title
        self.area = area
    }

    var json: JSONValue {
        .fields(["mode": .text(mode), "daily_budget_usd": .double(dailyBudgetUSD), "max_open_bundles": .int(maxOpenBundles), "title": .text(title), "area": .text(area)])
    }
}

/// `POST /api/tasks/:id/dispatch` — `{target, brief, sources?, purpose?, max_acu?}`.
/// `target` and `brief` are both required by the route.
public struct TaskDispatch: Sendable, Equatable {
    /// A name from `GET /api/targets`.
    public var target: String
    /// The instruction sent to it — checked against the target's data policy before it leaves.
    public var brief: String
    public var sources: [String]?
    public var purpose: String?
    public var maxACU: Double?

    public init(target: String, brief: String, sources: [String]? = nil, purpose: String? = nil, maxACU: Double? = nil) {
        self.target = target
        self.brief = brief
        self.sources = sources
        self.purpose = purpose
        self.maxACU = maxACU
    }

    var json: JSONValue {
        .fields(["target": .string(target), "brief": .string(brief), "sources": .texts(sources), "purpose": .text(purpose), "max_acu": .double(maxACU)])
    }
}

/// `owner/repo#number`.
public struct PullRequestRef: Sendable, Equatable {
    public var owner: String
    public var repo: String
    public var number: Int

    public init(owner: String, repo: String, number: Int) {
        self.owner = owner
        self.repo = repo
        self.number = number
    }

    var path: String { "/api/github/pulls/\(ConsoleStores.segment(owner))/\(ConsoleStores.segment(repo))/\(number)" }
}

/// A review (T2-13): the verdict, the body, and the head SHA the owner was
/// shown — a pull request that moved since is refused, never reviewed blind.
public struct PullRequestReview: ConsoleRequestBody {
    /// `approve`, `request_changes` or `comment`.
    public var event: String
    public var body: String
    public var headSHA: String

    public init(event: String, body: String, headSHA: String) {
        self.event = event
        self.body = body
        self.headSHA = headSHA
    }

    public var json: JSONValue { .fields(["event": .string(event), "body": .string(body), "head_sha": .string(headSHA)]) }
}

// MARK: - Over the transport

extension ConsoleStores: WorkStore {
    public func board(project: String?, limit: Int?) async -> Result<Board, ConsoleError> { await api.board(project: project, limit: limit) }

    public func rooms(state: String?, project: String?, anchor: String?, limit: Int?) async -> Result<RoomList, ConsoleError> {
        await api.rooms(state: state, project: project, anchor: anchor, limit: limit)
    }

    public func projects() async -> Result<ProjectList, ConsoleError> { await get("/api/projects") }

    public func updateProject(_ slug: String, _ update: ProjectUpdate) async -> Result<ProjectUpdateResult, ConsoleError> {
        await perform("PUT", "/api/projects/\(Self.segment(slug))", update.json)
    }

    public func targets() async -> Result<TargetList, ConsoleError> { await get("/api/targets") }

    /// Not `ConsoleAPI.dispatchTask`, which sends `target` alone — the route
    /// refuses a dispatch without a `brief`, so that one can only ever be a 400.
    public func dispatchTask(_ id: Int, _ dispatch: TaskDispatch) async -> Result<TaskDispatchResult, ConsoleError> {
        await perform("POST", "/api/tasks/\(id)/dispatch", dispatch.json)
    }

    public func updateTask(_ id: Int, _ patch: TaskPatch) async -> Result<TaskMutation, ConsoleError> { await api.updateTask(id, patch) }
    public func claimTask(_ id: Int, leaseSeconds: Int?) async -> Result<TaskMutation, ConsoleError> { await api.claimTask(id, leaseSeconds: leaseSeconds) }
    public func releaseTask(_ id: Int, note: String?) async -> Result<TaskMutation, ConsoleError> { await api.releaseTask(id, note: note) }

    public func renewTask(_ id: Int, note: String?, leaseSeconds: Int?) async -> Result<TaskMutation, ConsoleError> {
        await api.renewTask(id, note: note, leaseSeconds: leaseSeconds)
    }

    public func taskRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError> { await get("/api/work/\(workID)/thread") }

    public func comment(onTask workID: Int, _ body: String) async -> Result<RoomComment, ConsoleError> {
        await perform("POST", "/api/work/\(workID)/comments", .fields(["body": .string(body)]))
    }

    public func resolveRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError> {
        await perform("POST", "/api/work/\(workID)/thread/resolve", .object([:]))
    }

    public func reopenRoom(_ workID: Int) async -> Result<TaskRoom, ConsoleError> {
        await perform("POST", "/api/work/\(workID)/thread/reopen", .object([:]))
    }

    public func review(_ pull: PullRequestRef, _ review: PullRequestReview) async -> Result<PullRequestResult, ConsoleError> {
        await perform("POST", pull.path + "/review", review.json)
    }

    public func reply(_ pull: PullRequestRef, thread: String, body: String, headSHA: String) async -> Result<PullRequestResult, ConsoleError> {
        await perform("POST", pull.path + "/threads/\(Self.segment(thread))/reply", .fields(["body": .string(body), "head_sha": .string(headSHA)]))
    }

    public func resolve(_ pull: PullRequestRef, thread: String, headSHA: String) async -> Result<PullRequestResult, ConsoleError> {
        await perform("POST", pull.path + "/threads/\(Self.segment(thread))/resolve", .fields(["head_sha": .string(headSHA)]))
    }
}
