// Capture — a note or a file into the vault's `Inbox/`, and a recording's
// retention state (design-build-plan §2.15, §2.16). A recording is STARTED and
// STOPPED by the owner's hand through the local live-capture bridge
// (`LiveCaptureClient`), never through the console; what it produces arrives
// here like any capture.

import Foundation

public protocol CaptureStore: Sendable {
    /// route: POST /capture
    func capture(_ capture: CaptureDraft, idempotencyKey: String) async -> Result<CaptureReceipt, ConsoleError>
    /// route: GET /api/recordings/:id
    func recording(_ sessionID: String) async -> Result<RecordingState, ConsoleError>
}

/// What a capture carries: a note, or a file (base64) with its name.
public enum CaptureDraft: Sendable, Equatable {
    case note(String)
    case file(name: String, base64: String, note: String?)

    var json: JSONValue {
        switch self {
        case .note(let text): return .fields(["note": .string(text)])
        case .file(let name, let base64, let note): return .fields(["filename": .string(name), "content_base64": .string(base64), "note": .text(note)])
        }
    }
}

/// `POST /capture`'s `201` — `{id, path, sha256}`. A retry with the same
/// `Idempotency-Key` answers with the SAME row: the key is what makes a
/// capture safe to resend from an offline queue (T5-5), which is why the
/// store will not send one without it.
public struct CaptureReceipt: Codable, Sendable, Equatable {
    public let id: Int
    /// Relative to the instance: `Inbox/<…>.md`.
    public let path: String
    public let sha256: String
}

/// `GET /api/recordings/:id` (T8-4): whether the audio is still kept, until when, and what the transcript became.
public struct RecordingState: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

extension ConsoleStores: CaptureStore {
    public func capture(_ capture: CaptureDraft, idempotencyKey: String) async -> Result<CaptureReceipt, ConsoleError> {
        await perform("POST", "/capture", capture.json, idempotencyKey: idempotencyKey)
    }

    public func recording(_ sessionID: String) async -> Result<RecordingState, ConsoleError> {
        await get("/api/recordings/\(Self.segment(sessionID))")
    }
}
