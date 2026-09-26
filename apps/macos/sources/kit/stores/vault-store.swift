// The vault's git — sync status, a file's history, one file at one commit, a
// restore, a conflict settled, a rollback (design-build-plan §2.21, §2.16).
// Restore and rollback never write on their own: each raises a Needs You
// request, and Approve does the write as `user`. Rollback is reach `local` —
// history and the remote are the boundary — and the git policy itself is
// `metistry vault settings` (M18), not a route.

import Foundation

public protocol VaultStore: Sendable {
    /// route: GET /api/vault/status
    func vaultStatus() async -> Result<VaultStatus, ConsoleError>
    /// route: GET /api/knowledge/history
    func history(path: String) async -> Result<FileHistory, ConsoleError>
    /// route: GET /api/knowledge/version
    func version(path: String, sha: String) async -> Result<FileVersion, ConsoleError>
    /// route: POST /api/knowledge/restore
    func restore(path: String, sha: String, seenSHA: String) async -> Result<RestoreRequested, ConsoleError>
    /// route: POST /api/knowledge/conflicts/resolve
    func resolveConflict(path: String, keep: ConflictSide, seenSHA: String) async -> Result<ConflictResolved, ConsoleError>
    /// route: POST /api/vault/rollback
    func rollback(_ target: RollbackTarget) async -> Result<RollbackRequested, ConsoleError>
}

// MARK: - Replies

/// `GET /api/vault/status` (T10-2): branch, ahead and behind, last commit, last push, any conflict.
public struct VaultStatus: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/knowledge/history?path=` (T10-4): the file's commits, newest first.
public struct FileHistory: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/knowledge/version?path=&sha=` (T10-4): the file as it was at one commit.
public struct FileVersion: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/knowledge/restore` (T10-5): the Needs You request it raised.
public struct RestoreRequested: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/knowledge/conflicts/resolve` (T2-10): the file as settled.
public struct ConflictResolved: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/vault/rollback` (T10-6): the Needs You request, carrying the preview.
public struct RollbackRequested: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// Which side of a conflicted file to keep (T2-10).
public enum ConflictSide: String, Sendable, Equatable {
    case mine
    case theirs
}

/// What a rollback reverts (T10-6): one commit, everything since a date, or one file.
public enum RollbackTarget: Sendable, Equatable {
    case commit(String)
    /// `YYYY-MM-DD`.
    case to(String)
    case file(String)

    var json: JSONValue {
        switch self {
        case .commit(let sha): return .fields(["commit": .string(sha)])
        case .to(let day): return .fields(["to": .string(day)])
        case .file(let path): return .fields(["file": .string(path)])
        }
    }
}

// MARK: - Over the transport

extension ConsoleStores: VaultStore {
    public func vaultStatus() async -> Result<VaultStatus, ConsoleError> { await get("/api/vault/status") }
    public func history(path: String) async -> Result<FileHistory, ConsoleError> { await get("/api/knowledge/history", ["path": path]) }

    public func version(path: String, sha: String) async -> Result<FileVersion, ConsoleError> {
        await get("/api/knowledge/version", ["path": path, "sha": sha])
    }

    public func restore(path: String, sha: String, seenSHA: String) async -> Result<RestoreRequested, ConsoleError> {
        await perform("POST", "/api/knowledge/restore", .fields(["path": .string(path), "sha": .string(sha), "seen_sha": .string(seenSHA)]))
    }

    public func resolveConflict(path: String, keep: ConflictSide, seenSHA: String) async -> Result<ConflictResolved, ConsoleError> {
        await perform("POST", "/api/knowledge/conflicts/resolve", .fields(["path": .string(path), "keep": .string(keep.rawValue), "seen_sha": .string(seenSHA)]))
    }

    public func rollback(_ target: RollbackTarget) async -> Result<RollbackRequested, ConsoleError> {
        await perform("POST", "/api/vault/rollback", target.json)
    }
}
