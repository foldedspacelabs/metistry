// Agents — the registry, what each is doing now, and the owner's hand on who
// may do what (design-build-plan §2.4, §2.16). Minting a bearer — register and
// rotate — is reach `local` (F-13): a new credential is a boundary change, so
// only the Mac makes one. Writing a definition is `metistry agents define`
// (M12); this store only reads it.

import Foundation

public protocol AgentsStore: Sendable {
    /// route: GET /api/agents
    func agents() async -> Result<AgentList, ConsoleError>
    /// route: GET /api/q/agent_presence
    func agentPresence(limit: Int?) async -> Result<AgentPresenceList, ConsoleError>
    /// route: POST /api/agents
    func registerAgent(_ registration: AgentRegistration) async -> Result<AgentCredential, ConsoleError>
    /// route: PUT /api/agents/:id/grants
    func setGrants(_ id: String, tier: String, areas: [String]?, queries: Bool?) async -> Result<AgentGrantsResult, ConsoleError>
    /// route: PUT /api/agents/:id/projects
    func setProjects(_ id: String, _ projects: [String]) async -> Result<AgentProjectsResult, ConsoleError>
    /// route: PUT /api/agents/:id/autonomy
    func setAutonomy(_ id: String, _ update: AgentAutonomyUpdate) async -> Result<AgentAutonomyResult, ConsoleError>
    /// route: POST /api/agents/:id/revoke
    func revokeAgent(_ id: String) async -> Result<AgentRevocation, ConsoleError>
    /// route: POST /api/agents/:id/rotate
    func rotateAgent(_ id: String) async -> Result<AgentCredential, ConsoleError>
    /// route: POST /api/agents/:id/approve
    func approveAgent(_ id: String) async -> Result<AgentApprovalResult, ConsoleError>
    /// route: GET /api/agents/:id/definition
    func agentDefinition(_ id: String) async -> Result<AgentDefinition, ConsoleError>
}

// MARK: - Requests

/// `POST /api/agents` — `{id, display_name, kind?, remote?}`. A `remote`
/// agent is pending until the owner approves it (S2).
public struct AgentRegistration: Sendable, Equatable {
    /// `^[a-z][a-z0-9-]{0,39}$`.
    public var id: String
    public var displayName: String
    public var kind: String?
    public var remote: Bool

    public init(id: String, displayName: String, kind: String? = nil, remote: Bool = false) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.remote = remote
    }

    var json: JSONValue {
        .fields(["id": .string(id), "display_name": .string(displayName), "kind": .text(kind), "remote": remote ? .bool(true) : nil])
    }
}

// MARK: - Replies

/// Register or rotate: `{id, token, pending?, proposal_id?}`. The bearer
/// crosses the wire ONCE, here — shown to the owner, never stored by the app.
public struct AgentCredential: Codable, Sendable, Equatable {
    public let id: String
    public let token: String
    /// A remote agent waits for Approve (S2).
    public let pending: Bool?
    /// The Needs You request its enrolment raised.
    public let proposalID: Int?

    enum CodingKeys: String, CodingKey {
        case id, token, pending
        case proposalID = "proposal_id"
    }
}

/// `PUT /api/agents/:id/grants` — `{ok, grants}`: the grant as stored.
public struct AgentGrantsResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `PUT /api/agents/:id/projects` — `{ok, projects}`.
public struct AgentProjectsResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/agents/:id/revoke` — `{revoked, access_requests?}`.
public struct AgentRevocation: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/agents/:id/definition` (T4-6): the definition an actor runs with, and the files it comes from — read-only.
public struct AgentDefinition: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Over the transport

extension ConsoleStores: AgentsStore {
    public func agents() async -> Result<AgentList, ConsoleError> { await api.agents() }
    public func agentPresence(limit: Int?) async -> Result<AgentPresenceList, ConsoleError> { await api.agentPresence(limit: limit) }

    public func registerAgent(_ registration: AgentRegistration) async -> Result<AgentCredential, ConsoleError> {
        await perform("POST", "/api/agents", registration.json)
    }

    public func setGrants(_ id: String, tier: String, areas: [String]?, queries: Bool?) async -> Result<AgentGrantsResult, ConsoleError> {
        await perform("PUT", "/api/agents/\(Self.segment(id))/grants", .fields(["tier": .string(tier), "areas": .texts(areas), "queries": queries.map(JSONValue.bool)]))
    }

    public func setProjects(_ id: String, _ projects: [String]) async -> Result<AgentProjectsResult, ConsoleError> {
        await perform("PUT", "/api/agents/\(Self.segment(id))/projects", .fields(["projects": .texts(projects)]))
    }

    public func setAutonomy(_ id: String, _ update: AgentAutonomyUpdate) async -> Result<AgentAutonomyResult, ConsoleError> {
        await api.setAutonomy(id, update)
    }

    public func revokeAgent(_ id: String) async -> Result<AgentRevocation, ConsoleError> {
        await perform("POST", "/api/agents/\(Self.segment(id))/revoke", .object([:]))
    }

    public func rotateAgent(_ id: String) async -> Result<AgentCredential, ConsoleError> {
        await perform("POST", "/api/agents/\(Self.segment(id))/rotate", .object([:]))
    }

    public func approveAgent(_ id: String) async -> Result<AgentApprovalResult, ConsoleError> { await api.approveAgent(id) }

    public func agentDefinition(_ id: String) async -> Result<AgentDefinition, ConsoleError> {
        await get("/api/agents/\(Self.segment(id))/definition")
    }
}
