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

// MARK: - The offline queue, persisted (ruling 19)

// T5-5 built the queue in memory only: a capture still queued when the app
// quit was gone. Ruling 19 (2026-09-27) approved a store beyond
// `app-preferences.swift`'s allowlist for exactly this — the queue is not a
// SETTING, it is unsent work, and losing it silently would break the offline
// promise capture-view.swift documents at its head. `capture-queue.json`
// under this app's own Application Support directory is that store, named in
// `app-preferences.swift`'s `AppFileStore` so the two lists — what's a
// default, what isn't — are read together.

/// One capture the composer minted a key for and has not yet been told it was
/// accepted, as it survives a relaunch. Everything a resend needs, and
/// nothing else: `CaptureComposerModel` decides how it resends and when.
public struct PersistedCapture: Codable, Sendable, Equatable {
    public let text: String
    public let idempotencyKey: String
    /// The instance it was written for — never sent to another one
    /// (capture-view.swift's `instanceChanged`), and the key this store
    /// groups its file by.
    public let instanceID: String
    public let createdAt: Date

    public init(text: String, idempotencyKey: String, instanceID: String, createdAt: Date) {
        self.text = text
        self.idempotencyKey = idempotencyKey
        self.instanceID = instanceID
        self.createdAt = createdAt
    }
}

/// Reads and replaces the queue file. `replace` touches only the one
/// instance's entries — "an instance switch keeps other instances' queued
/// items untouched" (ruling 19) is this method's contract, not a promise kept
/// by whoever calls it.
///
/// Named `…Persistence`, not `…Store`: `store-fixtures-tests.swift` requires
/// every `…Store` protocol's requirement to name a console `/// route:` —
/// this one is a local file, not a route, so it is deliberately outside that
/// naming convention rather than an unannotated hole in it.
public protocol CaptureQueuePersistence: Sendable {
    /// Every capture still queued, across every instance. Read once, at
    /// launch; a missing or corrupt file is an EMPTY queue, never a crash —
    /// unsent work lost to a bad file is a bug to fix, not a launch to stop.
    func load() -> [PersistedCapture]
    /// Replace `instanceID`'s entries with exactly `items` (empty clears
    /// them — "never persist a sent one" is `items` simply not naming it).
    /// Every other instance's entries in the file are left as they were.
    func replace(instanceID: String, with items: [PersistedCapture])
}

/// A test double that persists nothing — the default for every
/// `CaptureComposerModel` a test builds, so a test that does not ask for
/// persistence gets none, on disk or otherwise (`capture-view-tests.swift`).
public struct NullCaptureQueueStore: CaptureQueuePersistence {
    public init() {}
    public func load() -> [PersistedCapture] { [] }
    public func replace(instanceID: String, with items: [PersistedCapture]) {}
}

/// The production store: one JSON file under this app's own Application
/// Support directory — never the owner's instance directory, which is a
/// vault, not app state. `AppModel` is the only production caller; a test
/// passes its own `url` (see `apps/macos/tests/kit/capture-view-tests.swift`'s
/// `tempQueueStore()`) rather than touch the real one.
public struct JSONCaptureQueueStore: CaptureQueuePersistence {
    /// `~/Library/Application Support/<bundle id>/capture-queue.json` by
    /// default. Falls back to `resources/Info.plist`'s own
    /// `CFBundleIdentifier` with no `Bundle.main` identifier (a raw `.build/`
    /// executable), so the path is still this app's own folder and nobody
    /// else's.
    public static func defaultURL(
        bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "com.foldedspacelabs.metistry",
        applicationSupport: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
    ) -> URL {
        applicationSupport
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent(AppFileStore.captureQueueFilename, isDirectory: false)
    }

    private let url: URL

    /// `FileManager` is not itself `Sendable`, so it is never a stored
    /// property here — only `.default` is used, at the point of each call,
    /// same as `PinnedItems` and every other on-disk store in this app.
    public init(url: URL = JSONCaptureQueueStore.defaultURL()) {
        self.url = url
    }

    public func load() -> [PersistedCapture] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([PersistedCapture].self, from: data)) ?? []
    }

    public func replace(instanceID: String, with items: [PersistedCapture]) {
        var all = load()
        all.removeAll { $0.instanceID == instanceID }
        all.append(contentsOf: items)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            let data = try JSONEncoder().encode(all)
            // `.atomic` writes to a temp file and renames it in, so the file
            // that lands takes the umask's permissions, not this call's —
            // the mode has to be set again, on the file itself, after every
            // write. It holds raw capture text, so it is owner-only, like the
            // watchdog's control socket.
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // Best-effort, like every other write this app makes to its own
            // preferences: a failed write loses at most this change, never
            // crashes the composer over a full disk or a sandboxed folder.
        }
    }
}
