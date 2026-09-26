// Artifacts — published versions, their files and diffs, comment threads, and
// a review dispatched to an agent (design-build-plan §2.16; §4.21 of the build
// plan). One artifacts service behind every door: agents reach it through
// `artifact_*` tools, the owner through these routes.

import Foundation

public protocol ArtifactsStore: Sendable {
    /// route: GET /api/artifacts
    func artifacts(project: String?, limit: Int?) async -> Result<ArtifactList, ConsoleError>
    /// route: POST /api/artifacts
    func publish(_ publication: ArtifactPublication) async -> Result<ArtifactPublished, ConsoleError>
    /// route: GET /api/artifacts/:id
    func artifact(_ id: String) async -> Result<ArtifactDetail, ConsoleError>
    /// route: GET /api/artifacts/:id/versions
    func versions(ofArtifact id: String) async -> Result<ArtifactVersionList, ConsoleError>
    /// route: GET /api/artifacts/:id/versions/:version
    func version(_ version: String, ofArtifact id: String) async -> Result<ArtifactVersion, ConsoleError>
    /// route: GET /api/artifacts/:id/versions/:version/file
    func file(_ path: String, version: String, ofArtifact id: String) async -> Result<ArtifactFile, ConsoleError>
    /// route: GET /api/artifacts/:id/diff
    func diff(ofArtifact id: String, from: String, to: String?) async -> Result<ArtifactDiff, ConsoleError>
    /// route: GET /api/artifacts/:id/comments
    func comments(onArtifact id: String, version: String) async -> Result<ArtifactThreads, ConsoleError>
    /// route: POST /api/artifacts/:id/comments
    func comment(onArtifact id: String, _ comment: ArtifactComment) async -> Result<ArtifactCommentResult, ConsoleError>
    /// route: POST /api/artifacts/:id/comments/:comment/resolve
    func resolveComment(_ commentID: String, onArtifact id: String) async -> Result<ArtifactCommentResult, ConsoleError>
    /// route: POST /api/artifacts/:id/comments/:comment/reopen
    func reopenComment(_ commentID: String, onArtifact id: String) async -> Result<ArtifactCommentResult, ConsoleError>
    /// route: POST /api/dispatches
    func requestReview(_ request: ReviewRequest) async -> Result<ReviewDispatched, ConsoleError>
    /// route: GET /api/dispatches/:id
    func reviewStatus(_ workID: Int) async -> Result<ReviewStatus, ConsoleError>
}

// MARK: - Replies

/// `GET /api/artifacts` — `{artifacts, as_of}`, newest first.
public struct ArtifactList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/artifacts` — `{artifact, version, links, deduplicated}`; a retry with the same key hands back the first.
public struct ArtifactPublished: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/artifacts/:id`.
public struct ArtifactDetail: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/artifacts/:id/versions` — `{versions}`.
public struct ArtifactVersionList: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/artifacts/:id/versions/:version` — the version and its manifest.
public struct ArtifactVersion: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `…/file?path=` — `{path, kind, sha256, bytes, content | content_base64}`. The raw bytes (`raw=1`) are a browser's, not the kit's.
public struct ArtifactFile: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/artifacts/:id/diff?from=&to=`.
public struct ArtifactDiff: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/artifacts/:id/comments?version=` — `{threads}`, each with its replies.
public struct ArtifactThreads: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// A comment written, resolved or reopened — `{comment}`.
public struct ArtifactCommentResult: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `POST /api/dispatches` — the review task it made (`route`, `work`).
public struct ReviewDispatched: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/dispatches/:id` — a review bundle's status: its threads, and whether every one is addressed.
public struct ReviewStatus: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

// MARK: - Requests

/// Publish a version: idempotent on `idempotencyKey`, and a compare-and-swap
/// on `expectedCurrentVersion` (`nil` — the artifact must be new).
public struct ArtifactPublication: Sendable, Equatable {
    public struct File: Sendable, Equatable {
        public var path: String
        public var content: String

        public init(path: String, content: String) {
            self.path = path
            self.content = content
        }
    }

    public var project: String
    public var slug: String
    public var idempotencyKey: String
    public var message: String
    public var files: [File]
    public var kind: String?
    public var expectedCurrentVersion: String?

    public init(project: String, slug: String, idempotencyKey: String, message: String, files: [File], kind: String? = nil, expectedCurrentVersion: String?) {
        self.project = project
        self.slug = slug
        self.idempotencyKey = idempotencyKey
        self.message = message
        self.files = files
        self.kind = kind
        self.expectedCurrentVersion = expectedCurrentVersion
    }

    var json: JSONValue {
        .fields([
            "project": .string(project),
            "slug": .string(slug),
            "idempotency_key": .string(idempotencyKey),
            "message": .string(message),
            "files": .array(files.map { .fields(["path": .string($0.path), "content": .string($0.content)]) }),
            "kind": .text(kind),
            // null is meaningful here — "must be new" — so it is sent, never left out
            "expected_current_version": .some(expectedCurrentVersion.map(JSONValue.string) ?? .null),
        ])
    }
}

/// A new thread on a version (optionally at a path and an anchor), or a reply to one.
public enum ArtifactComment: Sendable, Equatable {
    case thread(version: String, body: String, path: String?, line: Int?)
    case reply(parent: String, body: String)

    var json: JSONValue {
        switch self {
        case .thread(let version, let body, let path, let line):
            return .fields(["version": .string(version), "body": .string(body), "path": .text(path), "anchor": line.map { .fields(["line": .int($0)]) }])
        case .reply(let parent, let body):
            return .fields(["parent": .string(parent), "body": .string(body)])
        }
    }
}

/// `POST /api/dispatches` — send open threads on a version to an agent as one review task.
public struct ReviewRequest: Sendable, Equatable {
    public var artifact: String
    public var version: String
    public var threadIDs: [String]
    public var toAgent: String
    public var message: String?
    public var idempotencyKey: String?

    public init(artifact: String, version: String, threadIDs: [String], toAgent: String, message: String? = nil, idempotencyKey: String? = nil) {
        self.artifact = artifact
        self.version = version
        self.threadIDs = threadIDs
        self.toAgent = toAgent
        self.message = message
        self.idempotencyKey = idempotencyKey
    }

    var json: JSONValue {
        .fields([
            "artifact": .string(artifact), "version": .string(version), "thread_ids": .texts(threadIDs),
            "to_agent": .string(toAgent), "message": .text(message), "idempotency_key": .text(idempotencyKey),
        ])
    }
}

// MARK: - Over the transport

extension ConsoleStores: ArtifactsStore {
    private func artifactPath(_ id: String) -> String { "/api/artifacts/\(Self.segment(id))" }

    public func artifacts(project: String?, limit: Int?) async -> Result<ArtifactList, ConsoleError> {
        await get("/api/artifacts", ["project": project, "limit": limit.map(String.init)])
    }

    public func publish(_ publication: ArtifactPublication) async -> Result<ArtifactPublished, ConsoleError> {
        await perform("POST", "/api/artifacts", publication.json)
    }

    public func artifact(_ id: String) async -> Result<ArtifactDetail, ConsoleError> { await get(artifactPath(id)) }
    public func versions(ofArtifact id: String) async -> Result<ArtifactVersionList, ConsoleError> { await get(artifactPath(id) + "/versions") }

    public func version(_ version: String, ofArtifact id: String) async -> Result<ArtifactVersion, ConsoleError> {
        await get(artifactPath(id) + "/versions/\(Self.segment(version))")
    }

    public func file(_ path: String, version: String, ofArtifact id: String) async -> Result<ArtifactFile, ConsoleError> {
        await get(artifactPath(id) + "/versions/\(Self.segment(version))/file", ["path": path])
    }

    public func diff(ofArtifact id: String, from: String, to: String?) async -> Result<ArtifactDiff, ConsoleError> {
        await get(artifactPath(id) + "/diff", ["from": from, "to": to])
    }

    public func comments(onArtifact id: String, version: String) async -> Result<ArtifactThreads, ConsoleError> {
        await get(artifactPath(id) + "/comments", ["version": version])
    }

    public func comment(onArtifact id: String, _ comment: ArtifactComment) async -> Result<ArtifactCommentResult, ConsoleError> {
        await perform("POST", artifactPath(id) + "/comments", comment.json)
    }

    public func resolveComment(_ commentID: String, onArtifact id: String) async -> Result<ArtifactCommentResult, ConsoleError> {
        await perform("POST", artifactPath(id) + "/comments/\(Self.segment(commentID))/resolve", .object([:]))
    }

    public func reopenComment(_ commentID: String, onArtifact id: String) async -> Result<ArtifactCommentResult, ConsoleError> {
        await perform("POST", artifactPath(id) + "/comments/\(Self.segment(commentID))/reopen", .object([:]))
    }

    public func requestReview(_ request: ReviewRequest) async -> Result<ReviewDispatched, ConsoleError> {
        await perform("POST", "/api/dispatches", request.json)
    }

    public func reviewStatus(_ workID: Int) async -> Result<ReviewStatus, ConsoleError> { await get("/api/dispatches/\(workID)") }
}
