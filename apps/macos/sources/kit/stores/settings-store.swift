// The instance, this owner's devices, the console's own health, and what is
// configured — the reads Settings is made of (design-build-plan §2.16, §2.3).
//
// Every write behind these panes that changes the BOUNDARY — a secret, a
// connection, a variable, a linked instance — is a CLI verb, not a route
// (§2.2, `ManagementRunner`). What is here is read-only, plus the two acts a
// remote client may also do: revoke a device, and purge the session archive
// (`local` reach: the Mac only).

import Foundation

public protocol SettingsStore: Sendable {
    /// route: GET /health
    func health() async -> Result<ConsoleHealth, ConsoleError>
    /// route: GET /api/identity
    func identity() async -> Result<ConsoleIdentity, ConsoleError>
    /// route: GET /api/whoami
    func whoami() async -> Result<ConsoleWhoamiReply, ConsoleError>
    /// route: GET /api/devices
    func devices() async -> Result<DeviceList, ConsoleError>
    /// route: POST /api/devices/:id/revoke
    func revokeDevice(_ sessionID: Int) async -> Result<DeviceRevocation, ConsoleError>
    /// route: GET /api/status
    func status() async -> Result<ConsoleStatus, ConsoleError>
    /// route: GET /api/instances
    func instances() async -> Result<InstanceList, ConsoleError>
    /// route: GET /api/connections
    func connections() async -> Result<ConnectionList, ConsoleError>
    /// route: GET /api/connections/:name
    func connection(_ name: String) async -> Result<ConnectionDetail, ConsoleError>
    /// route: GET /api/secrets
    func secrets() async -> Result<SecretList, ConsoleError>
    /// route: GET /api/variables
    func variables() async -> Result<VariableList, ConsoleError>
    /// route: POST /api/sessions/purge
    func purgeSessions(_ request: SessionPurge) async -> Result<SessionPurgeResult, ConsoleError>
}

// MARK: - Replies

/// `GET /health` — `{ok, api_version}`. The one reply a client reads before
/// anything else: a console below the app's minimum `api_version` is refused
/// with an upgrade sentence, never a crash (§2.1).
public struct ConsoleHealth: Codable, Sendable, Equatable {
    public let ok: Bool
    public let apiVersion: Int?

    enum CodingKeys: String, CodingKey {
        case ok
        case apiVersion = "api_version"
    }
}

/// `GET /api/devices` — `{devices: […]}`: each session, its passkey's label, and whether it is revoked.
public struct DeviceList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/devices/:id/revoke` — `{revoked: true}`.
public struct DeviceRevocation: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/status` — `{checks, as_of}`: the console's own probes in `check()` shape. Everything else is `metistry doctor` (M6).
public struct ConsoleStatus: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/instances` — `{instances, as_of}`: the peer registry (`instances.yaml`), read-only here (M11).
public struct InstanceList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/connections` — status, tools and *used by* per connection (T4-8a). Every write is `metistry connections` (M13).
public struct ConnectionList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/connections/:name` — one connection (T4-8a).
public struct ConnectionDetail: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/secrets` — names, hosts, grants, last used; **never a value** (T4-1).
public struct SecretList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/variables` — the variables agents read (T4-4). Set and unset are `metistry variables` (M14).
public struct VariableList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/sessions/purge` — what was purged, or the unfolded sessions the confirm names (T3-9).
public struct SessionPurgeResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// Purge Now (T3-9, reach `local`): irreversible, so the first call is a
/// preview naming the sessions not yet folded into knowledge, and only a
/// confirmed call purges. T3-9 freezes the remaining fields.
public struct SessionPurge: ConsoleRequestBody {
    public var confirm: Bool

    public init(confirm: Bool) {
        self.confirm = confirm
    }

    public var json: JSONValue { .fields(["confirm": .bool(confirm)]) }
}

// MARK: - Over the transport

extension ConsoleStores: SettingsStore {
    public func health() async -> Result<ConsoleHealth, ConsoleError> { await get("/health") }
    public func identity() async -> Result<ConsoleIdentity, ConsoleError> { await api.identity() }
    public func whoami() async -> Result<ConsoleWhoamiReply, ConsoleError> { await api.whoami() }
    public func devices() async -> Result<DeviceList, ConsoleError> { await get("/api/devices") }

    public func revokeDevice(_ sessionID: Int) async -> Result<DeviceRevocation, ConsoleError> {
        await perform("POST", "/api/devices/\(sessionID)/revoke", .object([:]))
    }

    public func status() async -> Result<ConsoleStatus, ConsoleError> { await get("/api/status") }
    public func instances() async -> Result<InstanceList, ConsoleError> { await get("/api/instances") }
    public func connections() async -> Result<ConnectionList, ConsoleError> { await get("/api/connections") }

    public func connection(_ name: String) async -> Result<ConnectionDetail, ConsoleError> {
        await get("/api/connections/\(Self.segment(name))")
    }

    public func secrets() async -> Result<SecretList, ConsoleError> { await get("/api/secrets") }
    public func variables() async -> Result<VariableList, ConsoleError> { await get("/api/variables") }

    public func purgeSessions(_ request: SessionPurge) async -> Result<SessionPurgeResult, ConsoleError> {
        await perform("POST", "/api/sessions/purge", request.json)
    }
}
