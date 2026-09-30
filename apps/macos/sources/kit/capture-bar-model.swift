// The floating bar's model (screen 11 §2–§7; design-build-plan T8-5). The
// bar is Metistry's second interface: a 34px glass rail docked to a screen
// edge — the mark, then Ask · Note · To-do, then Record — present at all
// times while the live-capture bridge is installed, minimal at rest and
// breathing while a session runs. Its panel (capture-bar-panel.swift, the
// app target) only draws what this model decides.
//
// WHAT IT HOLDS AND WHAT IT DOES NOT.
//
//   * The recorder's state, read from the bridge on this Mac
//     (`LiveCaptureClient`) — never inferred (P5). The senses under the mark
//     are the streams the recorder says are OPEN, not what was asked for.
//   * Note and To-do go through the composer's own capture path
//     (`CaptureComposerModel.jot`): the same `POST /capture`, one key minted
//     once, the same offline queue. During a session each jot also carries
//     the session id and its offset in seconds (C77), which the meeting's
//     proposal rewrites to the note's path when it lands (T8-7).
//   * Ask is the tail of THE conversation (`ChatModel`), not a second one:
//     the same thread, the same draft, the same send (ruled 2026-09-22).
//   * Record opens the sheet; the sheet's start names a MODE and two
//     switches, never a window or display — the macOS picker the recorder
//     presents is the only chooser (T8-3). *Audio only* names bundle ids.
//
// THE BRIDGE DECIDES WHETHER THERE IS A BAR. No bridge → no bar, no items lit
// (screen 11 §8, "absent, not off"). A bridge this Mac holds no working key
// for → the bar, with Record off and the reason in words; Ask, Note and To-do
// still work, because they go through the console, not the recorder.
//
// Nothing here starts a recording on its own, and nothing here retries a
// refused key: a key problem is shown until the owner acts (*Try Again*).

import Foundation
import Observation
import SwiftUI

// MARK: - Values the view draws

/// What opens beside the rail. One at a time.
public enum CaptureBarPanelKind: String, Sendable, Equatable, CaseIterable {
    case ask, note, todo, record
}

public enum CaptureJotKind: String, Sendable, Equatable {
    case note, todo

    /// The one-second confirmation's words (screen 11 §2.1; the board).
    public var savedWords: String { self == .note ? "Noted" : "To-do added" }
    public var fieldName: String { self == .note ? "Note" : "To-do" }
}

/// Where a jot made during a recording sits: the session and the offset in
/// seconds from Record (C77). The meeting's file does not exist yet, so this
/// is the only stable anchor there is at write time.
public struct CaptureJotAnchor: Sendable, Equatable {
    public let sessionID: String
    public let offsetSeconds: Int

    public init(sessionID: String, offsetSeconds: Int) {
        self.sessionID = sessionID
        self.offsetSeconds = offsetSeconds
    }
}

/// One jot, as the note `POST /capture` carries. The inbox drain reads the
/// shape without a model (collectors/inbox-drain/run.ts): at rest a To-do
/// leads with `- [ ] `, the explicit cue it already knows. During a session
/// both carry the jot anchor T8-7 reads and promotes (packages/core
/// `jotAnchorOf`, C77) — `kind: "jot"`, `jot: "note"|"todo"`,
/// `capture_session` and `offset_s`, seconds from Record — plus a `title`,
/// the drain's own titling key. Scalars only, JSON-quoted, one per line.
public struct CaptureJot: Sendable, Equatable {
    public let kind: CaptureJotKind
    public let text: String
    public let anchor: CaptureJotAnchor?

    public init(kind: CaptureJotKind, text: String, anchor: CaptureJotAnchor?) {
        self.kind = kind
        self.text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self.anchor = anchor
    }

    /// The drain titles a capture from its first 80 characters.
    static let titleLimit = 80

    public var noteText: String {
        guard let anchor else { return kind == .todo ? "- [ ] \(text)" : text }
        let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let lines = [
            "---",
            "kind: \(Self.quoted("jot"))",
            "jot: \(Self.quoted(kind.rawValue))",
            "title: \(Self.quoted(String(firstLine.prefix(Self.titleLimit))))",
            "capture_session: \(Self.quoted(anchor.sessionID))",
            "offset_s: \(anchor.offsetSeconds)",
            "---",
            text,
        ]
        return lines.joined(separator: "\n")
    }

    /// A JSON string literal — the same quoting the transcript's frontmatter uses.
    static func quoted(_ s: String) -> String {
        let data = (try? JSONEncoder().encode(s)) ?? Data("\"\"".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}

/// The one-second line after Return: the words, the time, then nothing.
public struct CaptureJotConfirmation: Sendable, Equatable {
    public let kind: CaptureJotKind
    public let at: Date
    /// No answer yet — kept with its key and resent; said, never hidden.
    public let queued: Bool

    public func text(clock: ClockTime) -> String {
        queued ? "Queued \(clock.time(at)) — will send when the instance is reachable" : "\(kind.savedWords) \(clock.time(at))"
    }
}

/// An app *Audio only* may tap: what the sheet lists.
public struct CaptureBarApp: Sendable, Equatable, Identifiable, Hashable {
    public let bundleID: String
    public let name: String
    public var id: String { bundleID }

    public init(bundleID: String, name: String) {
        self.bundleID = bundleID
        self.name = name
    }
}

/// The record sheet: a target and two toggles (screen 11 §5).
public struct CaptureRecordSheet: Sendable, Equatable {
    /// *Window* first: a meeting is a window plus its audio (the owner's ask).
    public var mode: LiveCaptureMode = .window
    /// *Audio only*'s apps, as bundle ids.
    public var apps: [String] = []
    /// On by default (ruled 2026-09-22).
    public var appAudio = true
    public var microphone = true

    public init() {}

    /// The segments, in the drawing's order.
    public static let modes: [LiveCaptureMode] = [.screen, .window, .audioOnly]

    public static func title(_ mode: LiveCaptureMode) -> String {
        switch mode {
        case .screen: return "Screen"
        case .window: return "Window"
        case .audioOnly: return "Audio only"
        }
    }

    /// The label names what it takes: *app audio* for a window, *system
    /// audio* for the screen or audio only — and nothing else is said.
    public var audioLabel: String { mode == .window ? "App audio" : "System audio" }

    /// The one line a picture mode says, once, in place (screen 11 §6): the
    /// picker makes the choice, and the grant is not per-window.
    public var pickerLine: String? {
        switch mode {
        case .window: return "macOS picks the window, not us. Its screen permission covers every window."
        case .screen: return "macOS picks the display, not us. Its screen permission covers every window."
        case .audioOnly: return nil
        }
    }

    /// Why Record is off, in words — nil when it can go.
    public var cannotStartBecause: String? {
        if mode == .audioOnly {
            if apps.isEmpty { return "Choose an app to hear." }
            if apps.count > LiveCaptureStart.maxApps { return "At most \(LiveCaptureStart.maxApps) apps." }
        }
        if !appAudio && !microphone && mode == .audioOnly { return "Turn on \(audioLabel.lowercased()), the microphone, or both." }
        return nil
    }

    /// The start this sheet sends — built from the mode's case, so a picture
    /// start can carry nothing but its mode and the two switches.
    public var start: LiveCaptureStart? {
        guard cannotStartBecause == nil else { return nil }
        switch mode {
        case .window: return LiveCaptureStart(scope: .window, appAudio: appAudio, microphone: microphone)
        case .screen: return LiveCaptureStart(scope: .screen, appAudio: appAudio, microphone: microphone)
        case .audioOnly: return LiveCaptureStart(scope: .audioOnly(bundleIDs: apps), appAudio: appAudio, microphone: microphone)
        }
    }

    /// What Record would take, as VoiceOver says it after *Start recording.*
    public var spokenTarget: String {
        let first: String
        switch mode {
        case .window: first = "Window"
        case .screen: first = "Screen"
        case .audioOnly: first = appAudio ? "System audio" : ""
        }
        return CaptureBarWords.join([first, microphone ? "microphone" : ""])
    }
}

/// Whether there is a bar, and whether it can record.
public enum CaptureBarAvailability: Sendable, Equatable {
    /// Not asked yet: nothing drawn.
    case unknown
    /// No bridge on this Mac: nothing drawn, nothing lit.
    case absent
    /// The bar, and Record works.
    case ready
    /// The bar, with Record off and why — a key problem, or a recorder that
    /// did not answer. Ask, Note and To-do still work.
    case recordingOff(String)
}

/// A session that ended by itself, said once beside the rail (C137).
public struct CaptureBarEnded: Sendable, Equatable {
    public let reason: String
    public let words: String

    /// nil for the owner's own Stop, and for a start that never started.
    public static func words(for reason: String?) -> String? {
        switch reason {
        case "picture_lost": return "The recording stopped — the window closed or screen access was withdrawn. Everything up to then is saved."
        case "max_duration": return "The recording stopped at 10 hours. Everything is saved."
        case "disk_full": return "The recording stopped — under 5 GB free. Everything up to then is saved."
        case "resume_failed": return "The recording stopped after the Mac woke — it could not pick up again. Everything before the sleep is saved."
        case "crashed": return "The recorder stopped unexpectedly. Everything up to then is saved."
        default: return nil
        }
    }
}

public enum CaptureBarWords {
    /// The group VoiceOver names (components-02 §3).
    public static let group = "Metistry capture bar"
    public static let stop = "Stop recording"
    public static let keepGoing = "Keep Going"
    public static let recordAgain = "Record Again"
    public static let openInChat = "Open in Chat"
    public static let audioOnly = "Audio Only"
    public static let openSystemSettings = "Open System Settings"
    public static let screenNotAllowed = "Metistry can't see your screen yet."

    /// "Window and microphone" — the parts that are present, joined, the first capitalised.
    static func join(_ parts: [String]) -> String {
        let present = parts.filter { !$0.isEmpty }
        guard let first = present.first else { return "" }
        let head = first.prefix(1).uppercased() + first.dropFirst()
        return ([head] + present.dropFirst()).joined(separator: " and ")
    }

    /// *13m 42s* — a duration, and it says so (review 01 correction).
    public static func elapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        let h = s / 3600, m = (s % 3600) / 60, r = s % 60
        if h > 0 { return "\(h)h \(String(format: "%02d", m))m" }
        return "\(m)m \(String(format: "%02d", r))s"
    }

    /// *4 minutes* — what VoiceOver says for the same.
    public static func spokenElapsed(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        let h = s / 3600, m = (s % 3600) / 60
        func unit(_ n: Int, _ word: String) -> String { "\(n) \(word)\(n == 1 ? "" : "s")" }
        if h > 0 { return m > 0 ? "\(unit(h, "hour")) \(unit(m, "minute"))" : unit(h, "hour") }
        if m > 0 { return unit(m, "minute") }
        return "less than a minute"
    }
}

/// One turn of the conversation's tail, as the Ask panel draws it.
public struct CaptureBarTurn: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case yours
        /// Not sent, with the reason — Chat's *Not sent · Retry*.
        case notSent(reason: String, turnID: UUID)
        case reply
    }

    public let id: String
    public let kind: Kind
    public let text: String
    /// Past four lines at the panel's measure: drawn to four, with *Open in Chat*.
    public let opensInChat: Bool
}

// MARK: - The model

@MainActor
@Observable
public final class CaptureBarModel {
    // What the view draws
    public private(set) var availability: CaptureBarAvailability = .unknown
    public private(set) var recorder: LiveCaptureState?
    /// When `recorder` was read — the elapsed count runs on from it.
    public private(set) var readAt: Date?
    public private(set) var panel: CaptureBarPanelKind?
    /// The owner's *Hide Capture Bar*, for this launch (placement and the
    /// on/off switch are Settings ▸ Live Capture's, screen 11 §8).
    public private(set) var isHidden = false
    /// The decoration's idle fade (review 01): after ten seconds the shadow
    /// and the specular edge fade; the scrim and the ink never do. Never
    /// while recording, never with a panel open.
    public private(set) var decorationFaded = false

    public var jotText = ""
    public private(set) var jotKind: CaptureJotKind = .note
    public private(set) var jotConfirmation: CaptureJotConfirmation?
    public private(set) var jotProblem: String?
    /// Jots made during the running session, by kind — the Ask panel's one line.
    public private(set) var sessionJots: (notes: Int, todos: Int) = (0, 0)

    public var sheet = CaptureRecordSheet()
    public private(set) var runningApps: [CaptureBarApp] = []
    /// The picker is open, or a start is on its way.
    public private(set) var isStarting = false
    public private(set) var startProblem: String?
    /// A picture start failed and the recorder says the Screen Recording grant is not given.
    public private(set) var screenNotAllowed = false
    public private(set) var ended: CaptureBarEnded?
    public private(set) var actionProblem: String?

    // Seams
    /// Posts a VoiceOver announcement. Injected so a test can hear it.
    @ObservationIgnored public var announce: @MainActor (String) -> Void = { text in
        AccessibilityNotification.Announcement(text).post()
    }
    @ObservationIgnored public var now: @MainActor () -> Date = { Date() }
    /// Runs `work` after `delay` seconds. Injected so a test decides when.
    @ObservationIgnored public var schedule: @MainActor (TimeInterval, @escaping @MainActor () async -> Void) -> Void = { delay, work in
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            await work()
        }
    }
    /// The apps *Audio only* may list — the platform's running regular apps.
    @ObservationIgnored public var listApps: @MainActor () -> [CaptureBarApp] = { [] }
    /// *Open in Chat*: the window, on Chat.
    @ObservationIgnored public var openChat: @MainActor () -> Void = {}
    /// *Open System Settings* for the Screen Recording grant.
    @ObservationIgnored public var openScreenSettings: @MainActor () -> Void = {}
    /// Which Capture-menu items the bar lights, and what each does. `AppModel`
    /// writes these into `ShellModel.captureActions`.
    @ObservationIgnored public var onActions: @MainActor ([ShellCommand: @MainActor () -> Void]) -> Void = { _ in }
    /// The assistant's configured name, for *Ask <name>* (nil → *Ask*).
    @ObservationIgnored public var assistantName: @MainActor () -> String? = { nil }
    /// A shortcut in any app, spoken after a control's name when one is on
    /// (C120 — T6-16 fills this; nothing registers here).
    @ObservationIgnored public var shortcut: @MainActor (ShellCommand) -> String? = { _ in nil }

    @ObservationIgnored private let client: any LiveCaptureClient
    @ObservationIgnored private weak var composer: CaptureComposerModel?
    @ObservationIgnored private weak var chat: ChatModel?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var polling = false
    @ObservationIgnored private var activity = 0
    @ObservationIgnored private var announcedSession: String?
    @ObservationIgnored private var jotSession: String?

    /// While a session runs or the picker is open: often enough that the
    /// count and the senses keep their word.
    public static let liveInterval: TimeInterval = 2
    /// At rest.
    public static let restInterval: TimeInterval = 15
    /// No bridge: whether one has appeared (`metistry up` after launch).
    public static let absentInterval: TimeInterval = 60
    /// The decoration fades after this long with nothing happening.
    public static let idleAfter: TimeInterval = 10
    /// The jot confirmation's life.
    public static let confirmationFor: TimeInterval = 1
    /// The Ask panel's measure (C72) and the tail it shows.
    public static let askWidth: CGFloat = 328
    public static let tailTurns = 4
    /// A reply past this many lines is drawn to them, with *Open in Chat*.
    public nonisolated static let replyLines = 4
    /// Characters per line at the Ask panel's measure — 12.5pt serif across
    /// 328 less the padding and the 2px rule.
    public nonisolated static let charactersPerLine = 46

    public init(client: any LiveCaptureClient, composer: CaptureComposerModel?, chat: ChatModel?) {
        self.client = client
        self.composer = composer
        self.chat = chat
    }

    // MARK: Reading

    /// Whether anything is drawn at all.
    public var isShown: Bool {
        guard !isHidden else { return false }
        switch availability {
        case .ready, .recordingOff: return true
        case .unknown, .absent: return false
        }
    }

    public var isRecording: Bool { recorder?.isRunning ?? false }

    /// Why Record is off, when it is.
    public var recordingOffBecause: String? {
        if case .recordingOff(let why) = availability { return why }
        return nil
    }

    /// Seconds since Record, counted on from the last read.
    public func elapsed(at date: Date) -> TimeInterval? {
        guard let recorder, recorder.isRunning, let base = recorder.elapsed else { return nil }
        guard recorder.phase == .recording, let readAt else { return base }
        return base + max(0, date.timeIntervalSince(readAt))
    }

    /// What is open now, in words: *Screen and microphone*.
    public var sensesWords: String {
        guard let recorder else { return "" }
        let senses = recorder.senses
        var parts: [String] = []
        if senses.display {
            parts.append(recorder.session?.mode == .window ? "Window" : "Screen")
        } else if senses.appAudio {
            parts.append(recorder.session?.mode == .window ? "App audio" : "System audio")
        }
        if senses.microphone { parts.append("microphone") }
        return CaptureBarWords.join(parts)
    }

    /// The status VoiceOver hears once: *Recording, 4 minutes. Screen and microphone*.
    public func spokenStatus(at date: Date) -> String {
        guard let recorder, recorder.isRunning else { return "" }
        let head = recorder.phase == .paused ? "Recording paused" : "Recording"
        let time = elapsed(at: date).map { ", \(CaptureBarWords.spokenElapsed($0))" } ?? ""
        let senses = sensesWords
        return senses.isEmpty ? "\(head)\(time)" : "\(head)\(time). \(senses)"
    }

    /// The rail's controls: name, glyph, and why one is off.
    public var railControls: [ControlSpec] {
        let ask = ShellCommand.ask.title(assistantName: assistantName())
        var controls = [
            ControlSpec("", role: .plain, shortcut: shortcut(.ask), name: ask),
            ControlSpec("", role: .plain, shortcut: shortcut(.note), name: "Note"),
            ControlSpec("", role: .plain, shortcut: shortcut(.todo), name: "To-do"),
        ]
        if isRecording {
            controls.append(ControlSpec("", role: .plain, shortcut: shortcut(.stopRecording), name: CaptureBarWords.stop))
        } else {
            let target = sheet.spokenTarget
            let name = target.isEmpty ? "Start recording" : "Start recording. \(target)"
            // Record stays pressable while recording is off: it opens the
            // sheet, which says why and offers *Try Again*.
            controls.append(ControlSpec("", role: .plain, shortcut: shortcut(.startRecording), name: name))
        }
        return controls
    }

    /// The conversation's tail: the last few turns, the owner's and the replies.
    public var askTail: [CaptureBarTurn] {
        guard let chat else { return [] }
        let turns: [CaptureBarTurn] = chat.rows(calendar: .current).compactMap { row in
            switch row {
            case .yours(let y):
                if let local = y.local, case .notSent(let reason, _) = local.state {
                    return CaptureBarTurn(id: y.id, kind: .notSent(reason: reason, turnID: local.id), text: y.text, opensInChat: false)
                }
                return CaptureBarTurn(id: y.id, kind: .yours, text: y.text, opensInChat: false)
            case .reply(let m):
                return CaptureBarTurn(id: m.id, kind: .reply, text: m.text, opensInChat: Self.exceedsReplyLines(m.text))
            case .day, .activity:
                return nil
            }
        }
        return Array(turns.suffix(Self.tailTurns))
    }

    /// The chat's draft is the bar's too: one conversation, one draft.
    public var askDraft: String {
        get { chat?.draft ?? "" }
        set { chat?.draft = newValue }
    }

    public var askIsWorking: Bool { chat?.isWorking ?? false }
    public var askUnavailableBecause: String? { chat?.sendingUnavailableReason }

    /// *This session · 2 notes, 1 to-do* — nil before the first jot.
    public var sessionJotLine: String? {
        let (n, t) = sessionJots
        guard isRecording, n + t > 0 else { return nil }
        var parts: [String] = []
        if n > 0 { parts.append("\(n) note\(n == 1 ? "" : "s")") }
        if t > 0 { parts.append("\(t) to-do\(t == 1 ? "" : "s")") }
        return "This session · " + parts.joined(separator: ", ")
    }

    /// Whether a reply runs past four lines at the panel's measure.
    public nonisolated static func exceedsReplyLines(_ text: String) -> Bool {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { total, paragraph in
            total + max(1, Int((Double(paragraph.count) / Double(charactersPerLine)).rounded(.up)))
        }
        return lines > replyLines
    }

    /// The reminder beside the rail: *Still recording · 2 hours*.
    public var reminderLine: String? {
        guard let hours = recorder?.reminderDueHours, isRecording else { return nil }
        return "Still recording · \(hours) hour\(hours == 1 ? "" : "s")"
    }

    public var diskLine: String? {
        guard let free = recorder?.diskLowFreeBytes, isRecording else { return nil }
        let gb = Double(free) / 1_000_000_000
        return "Disk low · \(String(format: "%.0f", gb)) GB free — the recording stops at 5 GB"
    }

    // MARK: Following the recorder

    /// Starts following the recorder. Called once by the app, never from
    /// `init`: a model built by a test asks nothing until it says so.
    public func start() {
        guard !polling else { return }
        polling = true
        runningApps = listApps()
        Task { await self.poll(generation) }
    }

    /// An instance switch: the key read for the last instance is dropped, and
    /// everything the bar knew is asked again.
    public func adopt() {
        generation += 1
        availability = .unknown
        recorder = nil
        readAt = nil
        panel = nil
        ended = nil
        startProblem = nil
        actionProblem = nil
        jotProblem = nil
        sessionJots = (0, 0)
        jotSession = nil
        controlRefusal = nil
        let gen = generation
        Task {
            await client.forgetKey()
            guard polling, gen == generation else { return }
            await poll(gen)
        }
    }

    private func poll(_ gen: Int) async {
        guard gen == generation else { return }
        await refresh()
        guard gen == generation else { return }
        let delay: TimeInterval
        switch availability {
        case .absent, .unknown: delay = Self.absentInterval
        case .recordingOff where !(recordingOffIsTransient): return   // until the owner acts
        default: delay = isRecording || isStarting || recorder?.phase == .choosing ? Self.liveInterval : Self.restInterval
        }
        schedule(delay) { [weak self] in await self?.poll(gen) }
    }

    /// A recorder that did not answer may answer next time; a key problem waits for the owner.
    @ObservationIgnored private var recordingOffIsTransient = false
    /// Why a control route refused this Mac's key, kept until the owner acts.
    @ObservationIgnored private var controlRefusal: String?

    /// One read of the recorder.
    public func refresh() async {
        let gen = generation
        let result = await client.state()
        guard gen == generation else { return }
        switch result {
        case .success(let state):
            recordingOffIsTransient = false
            // A key refused for a start stays said, even though the same key
            // may still read `/status` — until the owner's *Try Again*.
            availability = controlRefusal.map(CaptureBarAvailability.recordingOff) ?? .ready
            apply(state)
        case .failure(let error):
            switch error {
            case .absent:
                availability = .absent
                recorder = nil
                panel = nil
            case .unreachable:
                recordingOffIsTransient = true
                availability = .recordingOff(error.errorDescription ?? "The recorder did not answer.")
            case .noKey, .keyRefused, .notControlKey, .refused:
                recordingOffIsTransient = false
                availability = .recordingOff(error.errorDescription ?? "The recorder refused.")
            }
        }
        publishActions()
    }

    private func apply(_ state: LiveCaptureState) {
        let was = recorder
        recorder = state
        readAt = now()
        if state.isRunning, let id = state.session?.sessionID {
            if jotSession != id {
                jotSession = id
                sessionJots = (0, 0)
            }
            ended = nil
            if announcedSession != id {
                announcedSession = id
                announce(spokenStatus(at: now()))
            }
        } else if was?.isRunning == true, let session = state.session, let words = CaptureBarEnded.words(for: session.endedReason) {
            ended = CaptureBarEnded(reason: session.endedReason ?? "", words: words)
            announce(words)
        }
        if !state.isRunning { noteActivity() }
    }

    // MARK: Opening and closing

    public func open(_ kind: CaptureBarPanelKind) {
        isHidden = false
        noteActivity()
        if panel == kind {
            panel = nil
            return
        }
        panel = kind
        jotProblem = nil
        switch kind {
        case .note: jotKind = .note
        case .todo: jotKind = .todo
        case .ask: Task { await chat?.refresh() }
        case .record:
            runningApps = listApps()
            startProblem = nil
            screenNotAllowed = false
        }
    }

    /// Esc, Cancel, or the same button again. A jot's words stay in the field.
    public func close() {
        panel = nil
        noteActivity()
    }

    public func toggleHidden() {
        isHidden.toggle()
        if isHidden { panel = nil }
        publishActions()
    }

    public func dismissEnded() {
        ended = nil
    }

    // MARK: Note and To-do

    /// Return: the jot goes, the field closes, a one-second line with the
    /// time. A refusal keeps the words in the field, with the console's reason.
    public func saveJot() async {
        let text = jotText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let composer else { return }
        let kind = jotKind
        let at = now()
        let anchor: CaptureJotAnchor? = {
            guard let recorder, recorder.isRunning, let id = recorder.session?.sessionID, let offset = elapsed(at: at) else { return nil }
            return CaptureJotAnchor(sessionID: id, offsetSeconds: Int(offset))
        }()
        let jot = CaptureJot(kind: kind, text: text, anchor: anchor)
        jotProblem = nil
        jotText = ""
        panel = nil
        switch await composer.jot(jot.noteText) {
        case .captured:
            confirm(CaptureJotConfirmation(kind: kind, at: at, queued: false), counting: anchor != nil)
        case .queued:
            confirm(CaptureJotConfirmation(kind: kind, at: at, queued: true), counting: anchor != nil)
        case .failed(let reason):
            jotText = text
            jotKind = kind
            jotProblem = reason
            panel = kind == .note ? .note : .todo
            announce("\(kind.fieldName) not saved: \(reason)")
        }
    }

    private func confirm(_ confirmation: CaptureJotConfirmation, counting: Bool) {
        if counting {
            if confirmation.kind == .note { sessionJots.notes += 1 } else { sessionJots.todos += 1 }
        }
        jotConfirmation = confirmation
        announce(confirmation.text(clock: ClockTime()))
        schedule(Self.confirmationFor) { [weak self] in
            guard let self, self.jotConfirmation == confirmation else { return }
            self.jotConfirmation = nil
        }
    }

    // MARK: Ask

    public func sendAsk() async {
        guard let chat else { return }
        await chat.send()
    }

    public func retryAsk(_ turnID: UUID) async {
        await chat?.retry(turnID)
    }

    public func openInChat() {
        panel = nil
        openChat()
    }

    // MARK: Record, Stop, Keep Going

    /// The sheet's Record. *Window* and *Screen* then wait on the macOS
    /// picker, which the recorder presents; the bar says so and waits.
    public func beginRecording() async {
        guard availability == .ready, !isRecording, !isStarting, let start = sheet.start else { return }
        isStarting = true
        startProblem = nil
        screenNotAllowed = false
        let result = await client.start(start)
        isStarting = false
        switch result {
        case .success:
            panel = nil
            ended = nil
            await refresh()
        case .failure(let error):
            if error == .absent {
                availability = .absent
                publishActions()
                return
            }
            if error.isAboutTheKey {
                // Said once, in place, and not tried again: a key the
                // recorder refused for a start is not asked again until the
                // owner acts — even if the same key still reads `/status`.
                recordingOffIsTransient = false
                controlRefusal = error.errorDescription ?? LiveCaptureWords.noKey
                availability = .recordingOff(controlRefusal!)
                publishActions()
                return
            }
            startProblem = error.errorDescription
            if start.scope.mode.takesPicture, case .success(let grants) = await client.grants(), grants["screen_recording"] != "granted" {
                screenNotAllowed = true
            }
            announce(startProblem ?? "")
        }
        publishActions()
    }

    public func stopRecording() async {
        guard isRecording else { return }
        actionProblem = nil
        switch await client.stop() {
        case .success:
            announce("Recording stopped")
        case .failure(let error):
            actionProblem = error.errorDescription
        }
        await refresh()
    }

    public func keepGoing() async {
        actionProblem = nil
        if case .failure(let error) = await client.keepGoing() { actionProblem = error.errorDescription }
        await refresh()
    }

    /// *Audio Only* on the no-screen line: the act with a kernel-enforced scope.
    public func switchToAudioOnly() {
        sheet.mode = .audioOnly
        screenNotAllowed = false
        startProblem = nil
    }

    public func toggleApp(_ bundleID: String) {
        if let i = sheet.apps.firstIndex(of: bundleID) {
            sheet.apps.remove(at: i)
        } else {
            sheet.apps.append(bundleID)
        }
    }

    /// The owner's *Try Again* after fixing the key: read it afresh and ask.
    public func tryAgain() async {
        controlRefusal = nil
        await client.forgetKey()
        let gen = generation
        await refresh()
        if polling, gen == generation, availability == .ready { schedule(Self.restInterval) { [weak self] in await self?.poll(gen) } }
    }

    // MARK: The idle fade

    /// The pointer came near, or something happened: the decoration returns,
    /// and fades again after ten quiet seconds.
    public func noteActivity() {
        decorationFaded = false
        activity += 1
        let mark = activity
        schedule(Self.idleAfter) { [weak self] in
            guard let self, self.activity == mark, self.panel == nil, !self.isRecording else { return }
            self.decorationFaded = true
        }
    }

    // MARK: The Capture menu

    /// Lights the bar's Capture items — only while there is a bar.
    public func publishActions() {
        var lit: [ShellCommand: @MainActor () -> Void] = [:]
        if isShown || (isHidden && (availability == .ready || recordingOffBecause != nil)) {
            lit[.ask] = { [weak self] in self?.open(.ask) }
            lit[.note] = { [weak self] in self?.open(.note) }
            lit[.todo] = { [weak self] in self?.open(.todo) }
            if !isHidden { lit[.hideCaptureBar] = { [weak self] in self?.toggleHidden() } }
            if isRecording {
                lit[.stopRecording] = { [weak self] in Task { await self?.stopRecording() } }
            } else if availability == .ready && !isStarting {
                lit[.startRecording] = { [weak self] in self?.open(.record) }
            }
        }
        onActions(lit)
    }

    /// The Capture items the bar may light — every other is someone else's.
    public static let menuItems: [ShellCommand] = [.ask, .note, .todo, .startRecording, .stopRecording, .hideCaptureBar]
}
