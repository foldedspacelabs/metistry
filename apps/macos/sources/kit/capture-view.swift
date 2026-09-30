// The capture composer (design-build-plan T5-5; screen-04-capture.md): the
// toolbar's + and ⌘N open it, a field and one **Capture** button, and the
// receipt under them. Not a screen — there is no Capture row and no Capture
// destination (§3.8): a place you navigate to contradicts a five-second promise.
//
// TEXT ONLY, BY RULING. Live capture (audio, screen) is the floating bar's
// (capture-bar-model.swift, T8-5 — the #253 hold lifted by Q28), and this
// ticket's spec is the note: the attachment chip, ⌘⇧A and the drop target are
// not here. The Capture menu's Ask · Note · To-do and the recording pair are
// lit by the bar while the live-capture bridge answers; the bar's Note and
// To-do capture through `jot(_:)` below, on this model's key and queue.
//
// THE FOUR PROMISES, EACH KEPT BY THE MODEL RATHER THAN BY THE VIEW:
//
//   * **Esc keeps the draft.** The draft is `CaptureComposerModel.draft`, held
//     by `AppModel` for the app's lifetime — not by the popover, which is
//     rebuilt every time it opens. Closing it, by Esc or a click elsewhere,
//     changes nothing but `isPresented`. A draft survives until it is sent.
//   * **The key is minted once.** Pressing Capture mints ONE `Idempotency-Key`
//     for that capture (`PendingCapture.idempotencyKey`, a `let`), and every
//     resend — the offline queue's, Retry's, a Capture pressed again on a
//     failure's unchanged words — carries that same key. `POST /capture`
//     answers a key it has seen with the ORIGINAL response, so a capture whose
//     reply was lost is never written twice (screen 4 §6 fault 2, C24).
//   * **The receipt is what came back.** `captured → inbox #418 ·
//     Inbox/….md` — the 201's `id` and `path`, nothing inferred. A replay is
//     the original response, so it renders as the same capture with the same
//     id, because from the owner's side it is (C23).
//   * **Offline is a state, not an error.** A capture that got no answer — no
//     process, no connection, no door — is QUEUED with its key and resent on a
//     backoff, when the popover opens, and as soon as the console is heard from
//     again. A capture is an append (O3): `ReachabilityGate` lets it through
//     while decisions are held, so the resend is never refused before it goes.
//     A console that ANSWERED with a refusal is a failure, not a queue: the
//     server's words, the text back in the field, and a Retry with the same key.
//
// THE POPOVER DOES NOT WAIT FOR 201 (§3). ⌘↩ moves the words out of the field
// and into a pending capture, and the line reads *capturing… you can close
// this*; closing cancels nothing. Clearing the field is not a claim it worked
// (P5): the words live in the pending capture until the server answers, and on
// a failure they come back. One line reports every capture in flight (§6 fault
// 5): a failure always wins it; otherwise the oldest unresolved, with a count.
//
// AN INSTANCE SWITCH. A capture belongs to the instance it was written for. A
// switch never sends a queued or failed capture to the new one: its words come
// back into the field, with a line saying why, and nothing is typed twice. One
// already in flight lands where it was going.
//
// THE QUEUE SURVIVES A RELAUNCH (ruling 19, 2026-09-27). A capture still
// queued — offline, no answer yet — is written to `stores/capture-store.swift`'s
// `JSONCaptureQueueStore` the moment it becomes queued, and read back at
// `init`, so quitting the app is not a way to lose it. It resends through the
// same gate and the same key as any other queued capture — a replay dedupes
// on the console exactly as it would have if the app had stayed open. Nothing
// but a QUEUED capture is ever written there: a sent one is gone the instant
// it lands, a failed one lives in the field, not on disk, and an instance
// switch's `returnToField` clears its bucket the same moment it clears the
// words from `captures` — the file for another instance is never touched by
// either.
//
// ACCESSIBILITY (§2.18). The field says *Note*; the button *Capture,
// Command-Return*; the receipt line speaks as one element and is announced
// when it changes to a result; the composer is one group named *New Capture*.
// Nothing moves, so Reduce Motion has nothing to stop; every step is a
// `metistryFont`, and the popover's width is fixed so the largest text grows it
// longer, never wider.

import Foundation
import Observation
import SwiftUI

// MARK: - One capture, from Capture to its receipt

/// A capture the owner pressed Capture on and the console has not yet
/// accepted. Its words, and the one key every attempt carries.
public struct PendingCapture: Identifiable, Sendable, Equatable {
    public enum State: Sendable, Equatable {
        /// On the wire now.
        case sending
        /// No answer came back — kept, with its key, to resend. The transport's words.
        case queued(String)
        /// The console answered with a refusal. Its words, verbatim.
        case failed(String)
    }

    public let id: UUID
    /// What was in the field when Capture was pressed, as typed.
    public let text: String
    /// Minted once, when Capture was pressed. Never re-minted: a resend that
    /// carried a new key would be a second capture if the first had landed.
    public let idempotencyKey: String
    /// The session generation (the instance) it was written for.
    let generation: Int
    /// The instance's stable id, for the queue file (`PersistedCapture`) — a
    /// generation resets every launch, so it cannot be what a resend on disk
    /// is grouped by. `nil` with no identity read yet: nothing this capture
    /// does is persisted, same as any instance with no id (`PinnedItems`).
    let instanceID: String?
    /// When this capture was minted — the queue file's `createdAt`.
    let createdAt: Date
    public internal(set) var state: State
    /// How many times it has been put on the wire.
    public internal(set) var attempts: Int
    /// Whether a refusal puts its words back in the composer's field. A jot
    /// from the capture bar (T8-5) keeps its words in the bar's own field
    /// instead — the composer's draft is the owner's other thought.
    var returnsToField = true

    var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    var isUnresolved: Bool { !isFailed }
}

// MARK: - The receipt line

/// The one line under the field (screen 4 §4, §6 fault 5).
public enum CaptureLine: Sendable, Equatable {
    case none
    /// The oldest unresolved capture is on the wire; `count` are unresolved.
    case sending(count: Int)
    /// The oldest unresolved capture is waiting for the instance; `count` are unresolved.
    case queued(count: Int)
    /// The last capture the console accepted — replayed or not, its original row.
    case captured(CaptureReceipt)
    /// A refusal, in the server's words. Always wins the line.
    case failed(reason: String)

    /// §3.8's own words for the queued chip.
    public static let queuedWords = "queued — will send when the instance is reachable"

    /// The words drawn.
    public var text: String {
        switch self {
        case .none: return ""
        case .sending(let count): return count > 1 ? "capturing… (\(count))" : "capturing… you can close this"
        case .queued(let count): return count > 1 ? "\(Self.queuedWords) (\(count))" : Self.queuedWords
        case .captured(let receipt): return "captured → inbox #\(receipt.id) · \(receipt.path)"
        case .failed(let reason): return reason
        }
    }

    /// What VoiceOver says — the arrow and the pound sign in words.
    public var spoken: String {
        switch self {
        case .none: return ""
        case .sending(let count): return count > 1 ? "Capturing, \(count) in flight" : "Capturing. You can close this"
        case .queued(let count): return count > 1 ? "Queued, \(count) captures. Will send when the instance is reachable" : "Queued. Will send when the instance is reachable"
        case .captured(let receipt): return "Captured, inbox \(receipt.id), \(receipt.path)"
        case .failed(let reason): return "Capture failed: \(reason)"
        }
    }

    /// The line as a mark on `ground`: queued is the `degraded` chip, failed
    /// carries its own glyph, so neither differs from the rest by colour alone.
    public func mark(on ground: MetistryColorRole) -> Mark? {
        switch self {
        case .none:
            return nil
        case .sending:
            return Mark(text, style: .callout, ink: .textSecondary, on: ground, spoken: spoken)
        case .queued:
            return Mark(text, glyph: .degraded, style: .callout, ink: .degraded, plate: .degradedQuiet, on: ground, shape: .chip, spoken: spoken)
        case .captured:
            return Mark(text, style: .callout, ink: .textSecondary, on: ground, spoken: spoken)
        case .failed:
            return Mark(text, glyph: .failed, style: .callout, ink: .failed, on: ground, spoken: spoken)
        }
    }
}

/// What a jot from the capture bar came to (`CaptureComposerModel.jot`).
public enum CaptureJotOutcome: Sendable, Equatable {
    /// The console took it: its row.
    case captured(CaptureReceipt)
    /// No answer — kept with its key, resent on the composer's backoff.
    case queued
    /// The console refused it, in its words. Nothing was written.
    case failed(String)
}

// MARK: - The model

@MainActor
@Observable
public final class CaptureComposerModel {
    /// The field. Kept across every close — Esc included — until it is sent.
    public var draft: String = ""
    /// Whether the popover is open. Closing it is all Esc does.
    public var isPresented = false
    /// Every capture not yet accepted, oldest first.
    public private(set) var captures: [PendingCapture] = []
    /// The last capture the console accepted, on this instance.
    public private(set) var lastReceipt: CaptureReceipt?
    /// A sentence the composer owes the owner that is not a capture's state:
    /// words returned to the field by an instance switch.
    public private(set) var notice: String?

    /// Offline resends: every 10 s at first, backing off to a minute.
    public static let retryPolicy = RefreshPolicy(interval: 10, backoffCeiling: 60)

    /// Posts a VoiceOver announcement. Injected so a test can hear it.
    @ObservationIgnored public var announce: @MainActor (String) -> Void = { text in
        AccessibilityNotification.Announcement(text).post()
    }
    /// Mints a capture's key. Injected so a test can name it.
    @ObservationIgnored public var mintKey: @MainActor () -> String = { UUID().uuidString.lowercased() }
    /// The active instance's stable id, for the queue file — `AppModel` wires
    /// this to `InstanceBookmarks.active?.path` (the same pointer
    /// `METISTRY_INSTANCE_DIR` and every recents list use), because that
    /// resolves at launch with no round trip, unlike `metistry identity`'s
    /// instance id. `nil` — no active instance — persists nothing, the same
    /// gate `PinnedItems` uses. Injected so a test can name it.
    @ObservationIgnored public var currentInstanceID: @MainActor () -> String? = { nil }
    /// Runs `work` after `delay` seconds. Injected so a test decides when.
    @ObservationIgnored public var scheduleRetry: @MainActor (TimeInterval, @escaping @MainActor () async -> Void) -> Void = { delay, work in
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            await work()
        }
    }

    @ObservationIgnored private weak var session: ConsoleSession?
    /// The failed capture whose words were put back into the field.
    @ObservationIgnored private var restoredFailure: UUID?
    @ObservationIgnored private var retryScheduled = false
    @ObservationIgnored private var offlineAttempts = 0
    @ObservationIgnored private var watchingReachability = false
    /// Where a queued capture survives a relaunch (ruling 19). A test that
    /// does not pass one gets `NullCaptureQueueStore` — nothing persisted,
    /// on disk or anywhere else — so every existing test keeps its in-memory
    /// behaviour unchanged; `AppModel` is the only production caller that
    /// passes a real `JSONCaptureQueueStore`.
    @ObservationIgnored private let queueStore: any CaptureQueuePersistence

    public init(session: ConsoleSession, queueStore: any CaptureQueuePersistence = NullCaptureQueueStore()) {
        self.session = session
        self.queueStore = queueStore
        session.register { [weak self] in
            guard let self else { return false }
            self.instanceChanged()
            return true
        }
    }

    /// Reads the queue file for `currentInstanceID()` and resumes each entry
    /// as a queued capture, retried on the same backoff as any other. Called
    /// once by the app (`AppModel`), after `currentInstanceID` and
    /// `queueStore` are wired — never from `init`: a model built by a test
    /// starts nothing until it asks (same rule as `AppModel.startShell`).
    public func loadPersistedQueue() {
        guard let session, let instanceID = currentInstanceID() else { return }
        let restored = queueStore.load()
            .filter { $0.instanceID == instanceID }
            .sorted { $0.createdAt < $1.createdAt }
        guard !restored.isEmpty else { return }
        captures.append(contentsOf: restored.map {
            PendingCapture(
                id: UUID(),
                text: $0.text,
                idempotencyKey: $0.idempotencyKey,
                generation: session.generation,
                instanceID: $0.instanceID,
                createdAt: $0.createdAt,
                state: .queued(CaptureLine.queuedWords),
                attempts: 0
            )
        })
        scheduleNextRetry()
        watchReachability()
    }

    // MARK: Reading

    /// Whether Capture has anything to send. The empty field is the owner's own
    /// state, so the button dims without a line under it (components-01 §1.3).
    public var canCapture: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The receipt line: a failure wins; else the oldest unresolved capture,
    /// with a count; else the last receipt.
    public var line: CaptureLine {
        if let failed = captures.first(where: \.isFailed), case .failed(let reason) = failed.state {
            return .failed(reason: reason)
        }
        let unresolved = captures.filter(\.isUnresolved)
        if let oldest = unresolved.first {
            if case .queued = oldest.state { return .queued(count: unresolved.count) }
            return .sending(count: unresolved.count)
        }
        if let lastReceipt { return .captured(lastReceipt) }
        return .none
    }

    /// Whether the line offers Retry: only a failure does. A queued capture
    /// resends itself.
    public var offersRetry: Bool { captures.contains(where: \.isFailed) }

    // MARK: Opening and closing

    /// The + and ⌘N. Opening is also a moment to try the queue again.
    public func present() {
        isPresented = true
        notice = nil
        if captures.contains(where: { if case .queued = $0.state { return true } else { return false } }) {
            Task { await flushQueue() }
        }
    }

    /// Esc, or a click outside. The draft stays exactly as it is.
    public func dismiss() {
        isPresented = false
    }

    // MARK: Capturing

    /// ⌘↩. The words leave the field for a pending capture with a key minted
    /// now — unless they are a failed capture's words, back in the field and
    /// unchanged, in which case this IS that capture's retry, with its key.
    public func capture() async {
        guard canCapture, let session else { return }
        let text = draft
        notice = nil
        if let failedID = restoredFailure, let failed = captures.first(where: { $0.id == failedID }), failed.isFailed {
            restoredFailure = nil
            if failed.text == text {
                draft = ""
                await send(failedID)
                return
            }
            // Edited: the owner's new words supersede the refused ones, which
            // were never written (a refusal writes nothing), so a new key is right.
            captures.removeAll { $0.id == failedID }
        }
        let pending = PendingCapture(id: UUID(), text: text, idempotencyKey: mintKey(), generation: session.generation, instanceID: currentInstanceID(), createdAt: Date(), state: .sending, attempts: 0)
        captures.append(pending)
        draft = ""
        await send(pending.id)
    }

    /// A jot from the capture bar (T8-5): the same capture, the same key
    /// minted once and the same offline queue as ⌘↩ — only its words never
    /// pass through the draft. What happened comes back so the bar can say
    /// it in its one line; a refused jot is dropped from this model's list
    /// (its words stay in the bar's field) so it never takes this line.
    public func jot(_ text: String) async -> CaptureJotOutcome {
        guard let session, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .failed("nothing to capture") }
        var pending = PendingCapture(id: UUID(), text: text, idempotencyKey: mintKey(), generation: session.generation, instanceID: currentInstanceID(), createdAt: Date(), state: .sending, attempts: 0)
        pending.returnsToField = false
        captures.append(pending)
        await send(pending.id)
        guard let now = captures.first(where: { $0.id == pending.id }) else {
            return lastReceipt.map(CaptureJotOutcome.captured) ?? .queued
        }
        switch now.state {
        case .failed(let reason):
            captures.removeAll { $0.id == pending.id }
            return .failed(reason)
        case .queued, .sending:
            return .queued
        }
    }

    /// The line's Retry: the oldest failed capture, exactly as it was sent, with its key.
    public func retry() async {
        guard let failed = captures.first(where: \.isFailed) else { return }
        if restoredFailure == failed.id {
            restoredFailure = nil
            if draft == failed.text { draft = "" }
        }
        await send(failed.id)
    }

    /// Resend every queued capture, oldest first, stopping at the first that
    /// still gets no answer. Safe to call at any time: each carries its key.
    public func flushQueue() async {
        for id in captures.filter({ if case .queued = $0.state { return true } else { return false } }).map(\.id) {
            await send(id)
            if let c = captures.first(where: { $0.id == id }), case .queued = c.state { break }
        }
    }

    private func send(_ id: UUID) async {
        guard let session, let index = captures.firstIndex(where: { $0.id == id }) else { return }
        let capture = captures[index]
        defer { persistQueue(alsoClearing: capture.instanceID) }
        guard capture.generation == session.generation else {
            returnToField([capture])
            return
        }
        captures[index].state = .sending
        captures[index].attempts += 1
        let result = await session.stores.capture(.note(capture.text), idempotencyKey: capture.idempotencyKey)
        guard let now = captures.firstIndex(where: { $0.id == id }) else { return }
        let sameInstance = capture.generation == session.generation

        switch result {
        case .success(let receipt):
            captures.remove(at: now)
            // A capture that landed on the instance it was written for is this
            // instance's receipt; one that landed after a switch is not.
            guard sameInstance else { return }
            offlineAttempts = 0
            lastReceipt = receipt
            announce(CaptureLine.captured(receipt).spoken)
        case .failure(let error):
            guard sameInstance else {
                returnToField([captures[now]])
                return
            }
            if Self.gotNoAnswer(error) {
                let wasQueued: Bool
                if case .queued = capture.state { wasQueued = true } else { wasQueued = false }
                captures[now].state = .queued(error.errorDescription ?? "no answer")
                if !wasQueued { announce(CaptureLine.queued(count: 1).spoken) }
                scheduleNextRetry()
                watchReachability()
            } else {
                let reason = Self.reason(error)
                captures[now].state = .failed(reason)
                // Nothing is ever typed twice: the words come back, unless the
                // owner has already started the next thought in the field.
                if capture.returnsToField && draft.isEmpty {
                    draft = capture.text
                    restoredFailure = id
                }
                announce(CaptureLine.failed(reason: reason).spoken)
            }
        }
    }

    // MARK: Offline

    /// True when the request got no HTTP answer at all — the only case where
    /// "try again later" is the truth. A console that answered, even with a
    /// 401 or a 503, said something the owner should read, so it is a failure.
    nonisolated static func gotNoAnswer(_ error: ConsoleError) -> Bool {
        switch error {
        case .http, .undecodable: return false
        case .transport, .cliUnavailable, .notConfigured, .badOrigin: return true
        }
    }

    /// The server's words, verbatim, where it gave any.
    nonisolated static func reason(_ error: ConsoleError) -> String {
        if case .http(_, let envelope?) = error { return envelope.message }
        return error.errorDescription ?? "the capture was not accepted"
    }

    private func scheduleNextRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        let delay = Self.retryPolicy.nextDelay(consecutiveFailures: offlineAttempts)
        offlineAttempts += 1
        scheduleRetry(delay) { [weak self] in
            guard let self else { return }
            self.retryScheduled = false
            await self.flushQueue()
        }
    }

    /// The moment anything else hears the console again, the queue goes.
    private func watchReachability() {
        guard !watchingReachability, let session else { return }
        watchingReachability = true
        let gate = session.gate
        withObservationTracking {
            _ = gate.reachability
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.watchingReachability = false
                guard self.captures.contains(where: { if case .queued = $0.state { return true } else { return false } }) else { return }
                if case .unreachable = gate.reachability {
                    self.watchReachability()
                } else {
                    await self.flushQueue()
                }
            }
        }
    }

    // MARK: The queue file (ruling 19)

    /// Rewrites `instanceID`'s bucket in the queue file to exactly the
    /// captures now `.queued` for it — nothing else in the file is read back
    /// or rewritten. `alsoClearing` names an id to write as empty even when
    /// nothing in `captures` mentions it any more (a capture that just
    /// succeeded, failed, or was returned to the field by an instance switch
    /// is gone from `captures` before this runs, so it would otherwise never
    /// get cleared).
    private func persistQueue(alsoClearing instanceID: String?) {
        var touched = Set([instanceID].compactMap { $0 })
        let queued = captures.filter { if case .queued = $0.state { return true } else { return false } }
        touched.formUnion(queued.compactMap(\.instanceID))
        for id in touched {
            let mine = queued
                .filter { $0.instanceID == id }
                .map { PersistedCapture(text: $0.text, idempotencyKey: $0.idempotencyKey, instanceID: id, createdAt: $0.createdAt) }
            queueStore.replace(instanceID: id, with: mine)
        }
    }

    // MARK: Switching instance

    private func instanceChanged() {
        lastReceipt = nil
        watchingReachability = false
        let waiting = captures.filter { $0.state != .sending }
        returnToField(waiting)
        restoredFailure = nil
        // The words are back in the field, not queued any more — the file
        // agrees. Every OTHER instance's bucket is untouched (ruling 19):
        // `persistQueue` rewrites only the ids named here.
        for instanceID in Set(waiting.compactMap(\.instanceID)) {
            persistQueue(alsoClearing: instanceID)
        }
    }

    /// Words that cannot go where they were written for come back to the field
    /// — except a failure's, which are there already.
    private func returnToField(_ items: [PendingCapture]) {
        guard !items.isEmpty else { return }
        let ids = Set(items.map(\.id))
        captures.removeAll { ids.contains($0.id) }
        let words = items.filter { $0.id != restoredFailure }.map(\.text)
        draft = ([draft].filter { !$0.isEmpty } + words).joined(separator: "\n\n")
        notice = items.count == 1
            ? "Not sent — the instance changed. The words are back in the field."
            : "\(items.count) captures not sent — the instance changed. The words are back in the field."
        announce(notice ?? "")
    }
}

// MARK: - The view

/// The composer the + opens: the field, Capture, and the receipt line.
public struct CaptureComposerView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable private var model: CaptureComposerModel
    @FocusState private var fieldFocused: Bool

    /// The popover's one width. The largest text grows it longer, never wider (§2.18.5).
    public static let width: CGFloat = 360
    /// The button's shortcut, as it is bound and as it is spoken.
    public static let captureShortcut = MenuShortcut(.return, [.command])

    public init(model: CaptureComposerModel) {
        self.model = model
    }

    /// The Capture button: primary, its shortcut spoken after its name.
    public static let captureControl = ControlSpec("Capture", role: .primary, shortcut: captureShortcut.spoken)
    public static let retryControl = ControlSpec("Retry", role: .secondary)

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            // Lowercase on purpose: a prompt, not a label (screen 4 §2). No
            // title field, nothing that suggests or completes.
            TextField("Note", text: $model.draft, prompt: Text(verbatim: "note…"), axis: .vertical)
                .lineLimit(3...12)
                .textFieldStyle(.plain)
                .labelsHidden()
                .metistryFont(.body)
                .foregroundStyle(p[.textPrimary])
                .focused($fieldFocused)
                .padding(MetistrySpace.s2)
                .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(p[fieldFocused ? .focusRing : .borderControl], lineWidth: fieldFocused ? 2 : 1))
                .accessibilityLabel(Text(verbatim: "Note"))

            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Spacer(minLength: 0)
                ControlButton(Self.captureControl) { Task { await model.capture() } }
                    .keyboardShortcut(Self.captureShortcut.keyboardShortcut)
                    .disabled(!model.canCapture)
            }

            if let mark = model.line.mark(on: .elevated) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    MarkView(mark)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.offersRetry {
                        ControlButton(Self.retryControl) { Task { await model.retry() } }
                    }
                }
            }
            if let notice = model.notice {
                Text(verbatim: notice)
                    .metistryFont(.callout)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MetistrySpace.s4)
        .frame(width: Self.width, alignment: .leading)
        .background(p[.elevated])
        .onAppear { fieldFocused = true }
        #if os(macOS)
        // Esc closes and keeps the draft: the draft is the model's, not the popover's.
        .onExitCommand { model.dismiss() }
        #endif
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: ShellCommand.newCapture.title(assistantName: nil)))
    }
}
