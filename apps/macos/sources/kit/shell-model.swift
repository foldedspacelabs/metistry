// The shell's state (design-build-plan T5-2): where the owner is and has been,
// whether Needs You has a row, what the Dock says, what the Usage gauge reads,
// and the configured name every label templates.
//
// LOCAL TO THE SHELL, ON PURPOSE. It reads three F-7 protocols — `NeedsYouStore`
// for the count, `SettingsStore` for the identity, `UsageStore` for the compute
// report — and holds no client, no transport and no other screen's state. The
// screens' own models are theirs (T5-1, T6); this one is the frame around them.
//
// THE NEEDS YOU ROW (C110, screen-03 §13.3). It is drawn above Today only while
// something waits, and it carries the product's one badge. Two rules decide
// when it leaves, and they are one mechanism here: the row leaves **on the next
// navigation after the count reaches zero** — so answering the last request
// never pulls the floor out from under the owner (the view says *Nothing needs
// you* and the row stays), and a count that drops while the owner is elsewhere
// never shifts the sidebar under a pointer that is about to click. A count that
// could not be read is not zero: the row, the badge and the Dock keep the last
// answer the console gave.
//
// THE NAME. The assistant's name lives in `identity.yaml` and arrives here from
// `GET /api/identity`. A label that needs it asks `assistantName`, which is nil
// until the console has said — and a nil name is left out of the label, never
// replaced by a default or by the word "assistant" (CLAUDE.md: a hardcoded name
// is a bug; C88: "assistant" is never a label).

import Foundation
import Observation
import SwiftUI

// MARK: - Where the owner can be

/// The sidebar's eight rows, in the order C57 and C113 fixed. Not customisable:
/// the same rows in the same order are what stop the owner learning the product
/// twice (design-system P6). Pinned is below them and is the owner's.
public enum ShellSection: String, CaseIterable, Identifiable, Sendable {
    case today
    case chat
    case activity
    case work
    case knowledge
    case agents
    case scheduled

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .today: return "Today"
        case .chat: return "Chat"
        case .activity: return "Activity"
        case .work: return "Work"
        case .knowledge: return "Knowledge"
        case .agents: return "Agents"
        case .scheduled: return "Scheduled"
        }
    }

    /// SF Symbols from brand-kit.md's row table; Today and Scheduled from the
    /// round-0 boards (`sidebar8`: the calendar and the repeat glyph).
    public var symbolName: String {
        switch self {
        case .today: return "calendar"
        case .chat: return "bubble.left.and.bubble.right"
        case .activity: return "waveform.path.ecg"
        case .work: return "checklist"
        case .knowledge: return "text.book.closed"
        case .agents: return "person.2"
        case .scheduled: return "repeat"
        }
    }

    /// ⌘1 … ⌘7, in sidebar order (C119). ⌘0 is Needs You; ⌘9 is retired.
    public var digit: Int { (Self.allCases.firstIndex(of: self) ?? 0) + 1 }

    /// Where Go ▸ this section lands. Work has no screen of its own — Board,
    /// Projects and Artifacts are the screens — so it lands on its first child.
    public var landing: Destination {
        switch self {
        case .today: return .today
        case .chat: return .chat
        case .activity: return .activity
        case .work: return .board
        case .knowledge: return .knowledge
        case .agents: return .agents
        case .scheduled: return .scheduled
        }
    }

    /// The rows a disclosure group holds. Work's are fixed (C89 removed Rooms);
    /// no other section has children in this build.
    public var children: [Destination] {
        self == .work ? [.board, .projects, .artifacts] : []
    }
}

/// One place in the window. A closed set: a screen that is not here is not
/// reachable from the sidebar, the Go menu or history.
public enum Destination: Hashable, Sendable, Identifiable {
    /// The conditional row (C110).
    case needsYou
    case today
    case chat
    case activity
    case board
    case projects
    case artifacts
    case knowledge
    case agents
    case scheduled
    /// A shortcut the owner pinned (pinned-items.swift).
    case pinned(PinnedItem)

    public var id: String {
        switch self {
        case .pinned(let item): return "pinned:\(item.id)"
        default: return title
        }
    }

    public var title: String {
        switch self {
        case .needsYou: return "Needs You"
        case .today: return "Today"
        case .chat: return "Chat"
        case .activity: return "Activity"
        case .board: return "Board"
        case .projects: return "Projects"
        case .artifacts: return "Artifacts"
        case .knowledge: return "Knowledge"
        case .agents: return "Agents"
        case .scheduled: return "Scheduled"
        case .pinned(let item): return item.displayName
        }
    }

    public var symbolName: String {
        switch self {
        case .needsYou: return "bell"
        case .board: return "square.grid.3x2"
        case .projects: return "folder"
        case .artifacts: return "doc.richtext"
        case .pinned(let item): return item.kind.symbolName
        default: return section?.symbolName ?? "circle"
        }
    }

    /// The top-level row this destination belongs to; nil for Needs You and a pin.
    public var section: ShellSection? {
        switch self {
        case .needsYou, .pinned: return nil
        case .today: return .today
        case .chat: return .chat
        case .activity: return .activity
        case .board, .projects, .artifacts: return .work
        case .knowledge: return .knowledge
        case .agents: return .agents
        case .scheduled: return .scheduled
        }
    }
}

// MARK: - The one badge

/// The Needs You count as a badge (screen-03 §1): nothing at zero — no zero,
/// no dimmed dot — the number from 1 to 99, and `99+` past it. The same label
/// goes on the sidebar row and the Dock (N9); the spoken form says the real
/// number.
public enum NeedsYouBadge {
    public static func label(_ waiting: Int) -> String? {
        guard waiting > 0 else { return nil }
        return waiting > 99 ? "99+" : String(waiting)
    }

    /// components-02 §3: *Needs You, 10 waiting*.
    public static func spoken(_ waiting: Int) -> String {
        waiting > 0 ? "Needs You, \(waiting) waiting" : "Needs You, nothing waiting"
    }
}

// MARK: - The Usage gauge

/// The toolbar gauge (screen 17 §2) — no badge, three states — read from
/// `GET /api/compute`: the instance's spend and its spending limits. What the
/// popover does with the rest is T5-6's.
public struct UsageGauge: Sendable, Equatable {
    public enum Level: Sendable, Equatable {
        case within
        /// Over 90% of a limit: the needle moves.
        case high
        /// A limit reached: compute stops (C133).
        case reached
    }

    /// Nil when the `spend` query is not loaded — never a guessed zero.
    public let today: Double?
    public let month: Double?
    public let dailyLimit: Double?
    public let monthlyLimit: Double?

    public init(today: Double?, month: Double?, dailyLimit: Double?, monthlyLimit: Double?) {
        self.today = today
        self.month = month
        self.dailyLimit = dailyLimit.flatMap { $0 > 0 ? $0 : nil }
        self.monthlyLimit = monthlyLimit.flatMap { $0 > 0 ? $0 : nil }
    }

    public init(compute: ConsoleCompute) {
        self.init(
            today: compute.spend?.instance.daily,
            month: compute.spend?.instance.monthly,
            dailyLimit: compute.facts.instanceBudget?.dailyUSD,
            monthlyLimit: compute.facts.instanceBudget?.monthlyUSD
        )
    }

    /// Before the console has answered.
    public static let unknown = UsageGauge(today: nil, month: nil, dailyLimit: nil, monthlyLimit: nil)

    public var dailyFraction: Double? {
        guard let today, let dailyLimit else { return nil }
        return today / dailyLimit
    }

    public var monthlyFraction: Double? {
        guard let month, let monthlyLimit else { return nil }
        return month / monthlyLimit
    }

    /// The nearer limit decides the state: either one stops compute.
    public var level: Level {
        let worst = [dailyFraction, monthlyFraction].compactMap { $0 }.max() ?? 0
        if worst >= 1 { return .reached }
        if worst > 0.9 { return .high }
        return .within
    }

    public var symbolName: String { level == .within ? "gauge.medium" : "gauge.high" }

    /// Secondary ink within the limits, primary over 90%, the warning tint at a limit.
    public var inkRole: MetistryColorRole {
        switch level {
        case .within: return .textSecondary
        case .high: return .textPrimary
        case .reached: return .degraded
        }
    }

    /// components-02 §3's row — *Usage, $1.84 today, 37% of the day's budget* —
    /// in C130's words: budgets are *spending limits* now, so it says
    /// *37% of the daily spending limit*. The percentage is the day's when a
    /// daily limit is set, else the month's; with no limit and no spend read,
    /// the control is just *Usage*.
    public var spokenLabel: String {
        var parts = ["Usage"]
        if let today { parts.append("\(Self.dollars(today)) today") }
        if let fraction = dailyFraction {
            parts.append("\(Self.percent(fraction)) of the daily spending limit")
        } else if let fraction = monthlyFraction {
            parts.append("\(Self.percent(fraction)) of the monthly spending limit")
        }
        return parts.joined(separator: ", ")
    }

    static func dollars(_ value: Double) -> String { String(format: "$%.2f", value) }
    static func percent(_ fraction: Double) -> String { "\(Int((fraction * 100).rounded()))%" }
}

// MARK: - Motion

/// The one animation the shell owns. Under Reduce Motion the Needs You row
/// appears without sliding (C122): no animation at all, so it is simply there.
public enum ShellMotion {
    public static func needsYouRow(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: 0.2)
    }
}

// MARK: - The model

@MainActor
@Observable
public final class ShellModel {
    /// How long the history remembers: enough for a morning, not a record.
    public static let historyLimit = 50

    public private(set) var selection: Destination = .today
    private var backStack: [Destination] = []
    private var forwardStack: [Destination] = []
    /// Work's disclosure. In memory only: the app persists pointers and nothing
    /// else (app-preferences.swift), and an expanded group is not a pointer.
    public var isWorkExpanded = false

    /// The last count the console reported; nil until it has reported one.
    public private(set) var waiting: Int?
    public private(set) var showsNeedsYouRow = false
    public private(set) var identity: ConsoleIdentity?
    public private(set) var gauge: UsageGauge = .unknown
    /// The gauge's popover (screen 17, usage-view.swift): the month's reads,
    /// on the same store as the gauge.
    public let usageDetail: UsageModel
    /// The sidebar's Pinned area, filed under the identity's instance id.
    public private(set) var pins: PinnedItems

    /// What later features plug into the Capture menu and the toolbar's +: the
    /// composer (T5-5), the capture bar (T8), shortcuts in any app (T6-16). A
    /// command with no entry is dimmed. The key is a `ShellCommand`, so a
    /// feature can light up an item that exists and can never add one.
    public var captureActions: [ShellCommand: @MainActor () -> Void] = [:]

    /// Posts a VoiceOver announcement. Injected so a test can hear it.
    @ObservationIgnored public var announce: @MainActor (String) -> Void = { text in
        AccessibilityNotification.Announcement(text).post()
    }

    @ObservationIgnored private var needsYou: (any NeedsYouStore)?
    @ObservationIgnored private var settings: (any SettingsStore)?
    @ObservationIgnored private var usage: (any UsageStore)?
    @ObservationIgnored private let defaults: UserDefaults
    /// Bumped on every adopt, so an answer about the last instance is dropped.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var lastCountAttempt: Date?
    @ObservationIgnored private var countFailures = 0
    @ObservationIgnored private var lastIdentityAttempt: Date?
    @ObservationIgnored private var lastUsageAttempt: Date?
    /// The live-changes subscription, once `follow` is called (T5-7).
    @ObservationIgnored private weak var events: LiveEvents?
    /// A resync said the count may have moved: ask at the next tick.
    @ObservationIgnored private var countInvalidated = false

    /// Usage moves at the pace of spend, not of a queue.
    static let usagePolicy = RefreshPolicy(interval: 60)
    /// Until the name is known it is asked again at the requests' pace; once
    /// known, at configuration's.
    static let identityRetryPolicy = RefreshPolicy.requests

    public init(
        needsYou: (any NeedsYouStore)?,
        settings: (any SettingsStore)?,
        usage: (any UsageStore)?,
        defaults: UserDefaults = .standard
    ) {
        self.needsYou = needsYou
        self.settings = settings
        self.usage = usage
        self.defaults = defaults
        self.pins = PinnedItems(instanceID: nil, defaults: defaults)
        self.usageDetail = UsageModel(store: usage)
    }

    /// One `ConsoleStores` serves all three.
    public convenience init(stores: ConsoleStores?, defaults: UserDefaults = .standard) {
        self.init(needsYou: stores, settings: stores, usage: stores, defaults: defaults)
    }

    /// An instance switch: everything the last instance said is dropped, the
    /// owner starts on Today, and the next poll asks the new one.
    public func adopt(stores: ConsoleStores?) {
        adopt(needsYou: stores, settings: stores, usage: stores)
    }

    public func adopt(needsYou: (any NeedsYouStore)?, settings: (any SettingsStore)?, usage: (any UsageStore)?) {
        generation += 1
        self.needsYou = needsYou
        self.settings = settings
        self.usage = usage
        usageDetail.adopt(usage)
        waiting = nil
        showsNeedsYouRow = false
        identity = nil
        gauge = .unknown
        pins = PinnedItems(instanceID: nil, defaults: defaults)
        selection = .today
        backStack.removeAll()
        forwardStack.removeAll()
        lastCountAttempt = nil
        countFailures = 0
        countInvalidated = false
        lastIdentityAttempt = nil
        lastUsageAttempt = nil
    }

    // MARK: Words

    /// The configured name, or nil until the console has said it.
    public var assistantName: String? {
        guard let name = identity?.name.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }

    /// The Dock's label and the row's — nil at zero.
    public var badgeLabel: String? { NeedsYouBadge.label(waiting ?? 0) }

    public var needsYouSpokenLabel: String { NeedsYouBadge.spoken(waiting ?? 0) }

    // MARK: Navigation

    public var canGoBack: Bool { backStack.contains(where: isAvailable) }
    public var canGoForward: Bool { forwardStack.contains(where: isAvailable) }

    /// Whether a destination can be selected right now: Needs You only while
    /// its row is drawn, a pin only while it is pinned.
    public func isAvailable(_ destination: Destination) -> Bool {
        switch destination {
        case .needsYou: return showsNeedsYouRow
        case .pinned(let item): return pins.isPinned(item)
        default: return true
        }
    }

    /// The sidebar, a Go item, a pin. Selecting where you already are is not a
    /// navigation, so it neither writes history nor settles the Needs You row.
    public func navigate(to destination: Destination) {
        guard destination != selection, isAvailable(destination) else { return }
        backStack.append(selection)
        if backStack.count > Self.historyLimit { backStack.removeFirst(backStack.count - Self.historyLimit) }
        forwardStack.removeAll()
        arrive(at: destination)
    }

    public func go(to section: ShellSection) {
        navigate(to: section.landing)
    }

    /// ⌘0 — only while the row is shown.
    public func goToNeedsYou() {
        navigate(to: .needsYou)
    }

    /// ⌘[ — skips anything no longer there (a row that left, an unpinned pin).
    public func goBack() {
        while let previous = backStack.popLast() {
            guard isAvailable(previous), previous != selection else { continue }
            forwardStack.append(selection)
            arrive(at: previous)
            return
        }
    }

    /// ⌘]
    public func goForward() {
        while let next = forwardStack.popLast() {
            guard isAvailable(next), next != selection else { continue }
            backStack.append(selection)
            arrive(at: next)
            return
        }
    }

    private func arrive(at destination: Destination) {
        selection = destination
        if destination.section == .work { isWorkExpanded = true }
        // C110: this is "the next navigation after zero". The row leaves now,
        // unless the owner has just arrived on it.
        if destination != .needsYou, (waiting ?? 0) == 0 {
            showsNeedsYouRow = false
        }
    }

    // MARK: Pins

    /// Unpin from the sidebar's context menu. A pin the owner is standing on
    /// takes them to Today rather than leaving a selection with no row.
    public func unpin(_ item: PinnedItem) {
        pins.unpin(item)
        if selection == .pinned(item) { navigate(to: .today) }
    }

    // MARK: The count

    /// A count, from a poll or (T5-7) a `needs_you.changed` event.
    public func apply(waiting count: Int) {
        let previous = waiting
        waiting = max(0, count)
        if count > 0 { showsNeedsYouRow = true }
        // The badge announces a change once — never the first reading, never
        // the same number twice, and not while the owner is on Needs You,
        // where the list itself is what changed (C121).
        if let previous, previous != waiting, selection != .needsYou {
            announce(NeedsYouBadge.spoken(waiting ?? 0))
        }
    }

    // MARK: Live changes (T5-7)

    /// Take the count, the name and the gauge from the stream. The session's
    /// subscription outlives an instance switch, so this is called once.
    public func follow(_ events: LiveEvents) {
        self.events = events
        events.watch([.needsYou, .usage, .identity]) { [weak self] event in
            guard let self else { return false }
            self.receive(event)
            return true
        }
    }

    /// `needs_you.changed` carries the count the badge shows — the same
    /// filter `GET /api/needs-you/count` applies — so it is applied as it
    /// stands, with no refetch. Anything else marks its read due.
    func receive(_ event: ConsoleEvent) {
        if case .needsYouChanged(let count) = event.change {
            countFailures = 0
            countInvalidated = false
            apply(waiting: count)
            return
        }
        let topics = event.change.topics
        if topics.contains(.needsYou) { countInvalidated = true }
        if topics.contains(.identity) { lastIdentityAttempt = nil }
        if topics.contains(.usage) { lastUsageAttempt = nil }
    }

    /// Whether the count comes from the stream right now. While it does, the
    /// count is asked only on `whileLive`'s slow clock.
    public var countIsLive: Bool { events?.isLive == true }

    // MARK: Reading the console

    public func refreshCount() async {
        guard let needsYou else { return }
        let asked = generation
        let result = await needsYou.waitingCount()
        guard asked == generation else { return }
        switch result {
        case .success(let count):
            countFailures = 0
            apply(waiting: count.waiting)
        case .failure:
            // Unreachable is not zero: keep what is on screen.
            countFailures += 1
        }
    }

    public func refreshIdentity() async {
        guard let settings else { return }
        let asked = generation
        let result = await settings.identity()
        guard asked == generation, case .success(let value) = result else { return }
        identity = value
        if pins.instanceID != value.instanceID {
            pins = PinnedItems(instanceID: value.instanceID, defaults: defaults)
            if case .pinned(let item) = selection, !pins.isPinned(item) { arrive(at: .today) }
        }
    }

    public func refreshUsage() async {
        guard let usage else { return }
        let asked = generation
        let result = await usage.compute()
        guard asked == generation, case .success(let compute) = result else { return }
        gauge = UsageGauge(compute: compute)
    }

    /// The popover's reads, and the gauge from the same answer — so the
    /// toolbar and the popover it opens never disagree about the month.
    public func refreshUsageDetail(now: Date = Date()) async {
        let asked = generation
        await usageDetail.refresh(now: now)
        guard asked == generation, let compute = usageDetail.compute.value else { return }
        gauge = UsageGauge(compute: compute)
    }

    /// Everything, now: on launch and after an instance switch.
    public func refresh() async {
        await refreshIdentity()
        await refreshCount()
        await refreshUsage()
    }

    /// One tick of the poll: each read when its policy says it is due. While
    /// the event stream is live the count comes from `needs_you.changed` and
    /// is asked only on the slow `whileLive` clock; while it is down, this is
    /// how the row and the Dock move.
    public func refreshDue(now: Date = Date()) async {
        let identityPolicy = identity == nil ? Self.identityRetryPolicy : .configuration
        if identityPolicy.isDue(lastAttemptAt: lastIdentityAttempt, now: now) {
            lastIdentityAttempt = now
            await refreshIdentity()
        }
        let countPolicy = countIsLive ? RefreshPolicy.requests.whileLive : .requests
        if countInvalidated || countPolicy.isDue(lastAttemptAt: lastCountAttempt, consecutiveFailures: countFailures, now: now) {
            lastCountAttempt = now
            countInvalidated = false
            await refreshCount()
        }
        if Self.usagePolicy.isDue(lastAttemptAt: lastUsageAttempt, now: now) {
            lastUsageAttempt = now
            await refreshUsage()
        }
    }

    /// Starts the poll for the app's lifetime — not a window's, because the
    /// Dock badge is read with every window closed. Idempotent.
    public func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshDue()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Calls `apply` with the badge label now and on every change — how the
    /// app target keeps the Dock tile in step without a view having to exist.
    public func observeBadge(_ apply: @escaping @MainActor (String?) -> Void) {
        let label = withObservationTracking { badgeLabel } onChange: { [weak self] in
            Task { @MainActor [weak self] in self?.observeBadge(apply) }
        }
        apply(label)
    }

    // MARK: Commands the shell owns

    /// Whether a shell-owned command can run now. Screen and item commands are
    /// answered by whichever screen has focus (shell-commands.swift).
    public func canPerform(_ command: ShellCommand) -> Bool {
        guard command.owner == .shell else { return false }
        switch command {
        case .needsYou: return showsNeedsYouRow
        case .back: return canGoBack
        case .forward: return canGoForward
        default:
            if command.section != nil { return true }
            // Only a Capture item can be lit by `captureActions`.
            return command.menu == .capture && captureActions[command] != nil
        }
    }

    /// Runs a shell-owned command. Refuses, rather than trusting a menu's
    /// dimming, anything `canPerform` says no to.
    public func perform(_ command: ShellCommand) {
        guard canPerform(command) else { return }
        switch command {
        case .needsYou: goToNeedsYou()
        case .back: goBack()
        case .forward: goForward()
        default:
            if let section = command.section {
                go(to: section)
            } else {
                captureActions[command]?()
            }
        }
    }
}
