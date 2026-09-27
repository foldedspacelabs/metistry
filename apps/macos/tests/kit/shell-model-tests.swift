// The shell's state, driven through the recorded fixtures (F-7): the Needs You
// row's one rule (C110), the badge and the Dock, the announcement, the gauge,
// history, and an instance switch. Nothing here runs a console, spawns a CLI
// or touches the network — every answer is a fixture, and the Needs You count
// is the fixture's own body with one number changed.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - The row: it leaves only on the next navigation after zero

@MainActor
@Test func theNeedsYouRowLeavesOnlyOnTheNextNavigationAfterZero() async throws {
    let console = try CountingConsole(waiting: 3)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())

    await shell.refreshCount()
    #expect(shell.showsNeedsYouRow)
    shell.navigate(to: .needsYou)
    #expect(shell.selection == .needsYou)

    // The owner answers the last request. The floor stays where it is.
    console.waiting = 0
    await shell.refreshCount()
    #expect(shell.waiting == 0)
    #expect(shell.showsNeedsYouRow, "the row left while the owner was on it")
    #expect(shell.selection == .needsYou)
    #expect(shell.badgeLabel == nil, "a count of nothing is not a badge")

    // More polls at zero, and re-selecting where they already are, are not navigations.
    await shell.refreshCount()
    await shell.refreshCount()
    shell.navigate(to: .needsYou)
    #expect(shell.showsNeedsYouRow)

    // The next navigation is when it leaves.
    shell.navigate(to: .today)
    #expect(!shell.showsNeedsYouRow)
    #expect(!shell.isAvailable(.needsYou))
    #expect(!shell.canPerform(.needsYou), "⌘0 is only while the row is shown")
    shell.goToNeedsYou()
    #expect(shell.selection == .today, "⌘0 with no row goes nowhere")

    // And from elsewhere: a count that reaches zero while the owner is on Chat
    // leaves the row where it is until they next move.
    console.waiting = 2
    await shell.refreshCount()
    shell.navigate(to: .chat)
    console.waiting = 0
    await shell.refreshCount()
    #expect(shell.showsNeedsYouRow, "the row left before the next navigation")
    shell.navigate(to: .agents)
    #expect(!shell.showsNeedsYouRow, "the row outlived the next navigation")
}

@MainActor
@Test func aCountThatDropsWhileTheOwnerIsElsewhereWaitsForTheirNextNavigationToo() async throws {
    let console = try CountingConsole(waiting: 2)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    await shell.refreshCount()
    shell.navigate(to: .chat)

    // Answered on the phone: the sidebar does not shift under a pointer that is about to click.
    console.waiting = 0
    await shell.refreshCount()
    #expect(shell.showsNeedsYouRow)

    // Going TO Needs You is a navigation that keeps it — the owner is now on it.
    shell.navigate(to: .needsYou)
    #expect(shell.showsNeedsYouRow)
    shell.navigate(to: .activity)
    #expect(!shell.showsNeedsYouRow)
}

@MainActor
@Test func theRowIsNeverDrawnForNothingAndAppearsWithTheFirstRequest() async throws {
    let console = try CountingConsole(waiting: 0)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    #expect(!shell.showsNeedsYouRow, "nothing is drawn before the console has answered")
    await shell.refreshCount()
    #expect(!shell.showsNeedsYouRow)
    #expect(shell.waiting == 0)

    console.waiting = 1
    await shell.refreshCount()
    #expect(shell.showsNeedsYouRow)
    #expect(shell.badgeLabel == "1")
    #expect(shell.needsYouSpokenLabel == "Needs You, 1 waiting")
}

@MainActor
@Test func aCountThatCannotBeReadIsNotZero() async throws {
    let console = try CountingConsole(waiting: 4)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    await shell.refreshCount()
    console.waiting = nil   // the console stops answering
    await shell.refreshCount()
    shell.navigate(to: .chat)
    #expect(shell.waiting == 4, "an unreadable count kept what was on screen")
    #expect(shell.showsNeedsYouRow, "unreachable is not zero, so the next navigation keeps the row")
    #expect(shell.badgeLabel == "4")
}

// MARK: - The one badge

@Test func theBadgeIsTheCountToNinetyNineThenNinetyNinePlusAndNothingAtZero() {
    #expect(NeedsYouBadge.label(0) == nil)
    #expect(NeedsYouBadge.label(-1) == nil)
    #expect(NeedsYouBadge.label(1) == "1")
    #expect(NeedsYouBadge.label(99) == "99")
    #expect(NeedsYouBadge.label(100) == "99+")
    // the spoken form says the real number (components-02 §3)
    #expect(NeedsYouBadge.spoken(10) == "Needs You, 10 waiting")
    #expect(NeedsYouBadge.spoken(150) == "Needs You, 150 waiting")
    #expect(NeedsYouBadge.spoken(0) == "Needs You, nothing waiting")
}

@MainActor
@Test func theDockCarriesTheSameLabelAndFollowsEveryChange() async throws {
    let console = try CountingConsole(waiting: 3)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    let dock = Recorder<String?>()
    shell.observeBadge { dock.append($0) }
    #expect(dock.values == [nil], "the Dock is set at once, to nothing before the console has answered")

    await shell.refreshCount()
    await Task.yield()
    #expect(dock.values.last == "3")

    console.waiting = 120
    await shell.refreshCount()
    await Task.yield()
    #expect(dock.values.last == "99+")

    console.waiting = 0
    await shell.refreshCount()
    await Task.yield()
    #expect(dock.values.last == .some(nil), "the Dock clears at zero even while the row waits for a navigation")
}

@MainActor
@Test func theBadgeAnnouncesAChangeOnceAndNotWhileTheOwnerIsOnNeedsYou() async throws {
    let console = try CountingConsole(waiting: 3)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    let heard = Recorder<String>()
    shell.announce = { heard.append($0) }

    await shell.refreshCount()
    #expect(heard.values.isEmpty, "the first reading is not a change")

    await shell.refreshCount()
    #expect(heard.values.isEmpty, "the same number twice is not a change")

    console.waiting = 4
    await shell.refreshCount()
    await shell.refreshCount()
    #expect(heard.values == ["Needs You, 4 waiting"], "announced once")

    shell.navigate(to: .needsYou)
    console.waiting = 5
    await shell.refreshCount()
    #expect(heard.values == ["Needs You, 4 waiting"], "not while the owner is on it")
}

// MARK: - Built from the fixtures

@MainActor
@Test func theShellIsBuiltFromTheRecordedFixturesWithNoConsoleRunning() async throws {
    let console = try FixtureConsole.recorded()
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    await shell.refresh()

    #expect(console.calls.map(\.servedBy) == ["get-api-identity", "get-api-needs-you-count", "get-api-compute"])
    // the configured name, from GET /api/identity
    #expect(shell.assistantName == "Aide")
    #expect(ShellCommand.ask.title(assistantName: shell.assistantName) == "Ask Aide")
    // the fixture's four waiting
    #expect(shell.waiting == 4)
    #expect(shell.showsNeedsYouRow)
    #expect(shell.badgeLabel == "4")
    // the compute fixture: spend with no limit set
    #expect(shell.gauge.level == .within)
    #expect(shell.gauge.spokenLabel == "Usage, $0.00 today")
    // pins are filed under the identity's instance id — read off the recording, which mints a new one each time
    let identity = try ConsoleFixture.load("get-api-identity")
    #expect(shell.pins.instanceID == identity.replyJSON?["instance_id"]?.stringValue)
}

@MainActor
@Test func withNoConsoleTheShellDrawsNoRowNoBadgeAndNoName() async {
    let shell = ShellModel(stores: nil, defaults: shellDefaults())
    await shell.refresh()
    #expect(!shell.showsNeedsYouRow)
    #expect(shell.badgeLabel == nil)
    #expect(shell.assistantName == nil)
    #expect(ShellCommand.ask.title(assistantName: shell.assistantName) == "Ask")
    #expect(shell.gauge == .unknown)
    #expect(shell.gauge.spokenLabel == "Usage")
}

@MainActor
@Test func anInstanceSwitchForgetsEverythingTheLastInstanceSaid() async throws {
    let shell = ShellModel(stores: ConsoleStores(transport: try FixtureConsole.recorded()), defaults: shellDefaults())
    await shell.refresh()
    shell.navigate(to: .agents)
    #expect(shell.showsNeedsYouRow && shell.assistantName != nil)

    shell.adopt(stores: nil)
    #expect(shell.selection == .today)
    #expect(!shell.canGoBack)
    #expect(!shell.showsNeedsYouRow)
    #expect(shell.waiting == nil)
    #expect(shell.assistantName == nil)
    #expect(shell.gauge == .unknown)
    #expect(shell.pins.instanceID == nil)
}

// MARK: - Navigation

@MainActor
@Test func goToWorkLandsOnBoardAndOpensTheGroup() {
    let shell = ShellModel(stores: nil, defaults: shellDefaults())
    #expect(!shell.isWorkExpanded)
    shell.perform(.work)
    #expect(shell.selection == .board)
    #expect(shell.isWorkExpanded)
    // every Go item lands on its section's row
    for section in ShellSection.allCases {
        shell.go(to: section)
        #expect(shell.selection.section == section)
    }
}

@MainActor
@Test func backAndForwardRetraceAndSkipWhatIsNoLongerThere() async throws {
    let console = try CountingConsole(waiting: 1)
    let shell = ShellModel(stores: ConsoleStores(transport: console), defaults: shellDefaults())
    await shell.refreshCount()

    shell.navigate(to: .chat)
    shell.navigate(to: .needsYou)
    shell.navigate(to: .agents)
    #expect(shell.canGoBack && !shell.canGoForward)
    shell.perform(.back)
    #expect(shell.selection == .needsYou)
    shell.perform(.forward)
    #expect(shell.selection == .agents)

    // The row leaves; Back skips the place it was.
    console.waiting = 0
    await shell.refreshCount()
    shell.navigate(to: .scheduled)
    #expect(!shell.showsNeedsYouRow)
    shell.goBack()
    #expect(shell.selection == .agents)
    shell.goBack()
    #expect(shell.selection == .chat, "Needs You was skipped: its row has gone")
}

@MainActor
@Test func unpinningWhereYouStandTakesYouToToday() {
    let shell = ShellModel(stores: nil, defaults: shellDefaults())
    let pin = PinnedItem.project("lease", displayName: "Lease Renewal")
    shell.pins.pin(pin)
    shell.navigate(to: .pinned(pin))
    #expect(shell.selection == .pinned(pin))
    shell.unpin(pin)
    #expect(shell.selection == .today)
    #expect(!shell.isAvailable(.pinned(pin)))
}

// MARK: - The gauge

@Test func theGaugeReadsTheNearerLimitInItsThreeStates() {
    let within = UsageGauge(today: 1.84, month: 20, dailyLimit: 5, monthlyLimit: 60)
    #expect(within.level == .within)
    #expect(within.symbolName == "gauge.medium")
    #expect(within.inkRole == .textSecondary)
    #expect(within.spokenLabel == "Usage, $1.84 today, 37% of the day's budget")

    let high = UsageGauge(today: 1, month: 55, dailyLimit: 5, monthlyLimit: 60)
    #expect(high.level == .high, "over 90% of the month moves the needle")
    #expect(high.symbolName == "gauge.high")
    #expect(high.inkRole == .textPrimary)

    let reached = UsageGauge(today: 5, month: 30, dailyLimit: 5, monthlyLimit: nil)
    #expect(reached.level == .reached)
    #expect(reached.inkRole == .degraded)

    let monthOnly = UsageGauge(today: 2, month: 30, dailyLimit: nil, monthlyLimit: 60)
    #expect(monthOnly.spokenLabel == "Usage, $2.00 today, 50% of the month's budget")

    // a limit of zero is no limit, not a division
    #expect(UsageGauge(today: 1, month: 1, dailyLimit: 0, monthlyLimit: nil).level == .within)
}

@Test func underReduceMotionTheRowAppearsWithoutSliding() {
    #expect(ShellMotion.needsYouRow(reduceMotion: true) == nil)
    #expect(ShellMotion.needsYouRow(reduceMotion: false) != nil)
}

// MARK: - The app wires it

@MainActor
@Test func theAppModelOwnsOneShellAndAModelBuiltByATestStartsNothing() {
    let name = "com.foldedspacelabs.metistry.tests.shell.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { UserDefaults.standard.removePersistentDomain(forName: name) }
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: defaults)
    #expect(model.shell.selection == .today)
    #expect(!model.shell.showsNeedsYouRow)
    // no runtime, so no stores and no guessed count
    #expect(model.shell.waiting == nil)
}

// MARK: - Helpers

func shellDefaults() -> UserDefaults {
    UserDefaults(suiteName: "com.foldedspacelabs.metistry.tests.shell.\(UUID().uuidString)")!
}

@MainActor
final class Recorder<Value> {
    private(set) var values: [Value] = []
    func append(_ value: Value) { values.append(value) }
}

/// The recorded fixtures, with `GET /api/needs-you/count` answering whatever
/// `waiting` says — the fixture's own body with the number changed — or, at
/// nil, failing the way an unreachable console does.
final class CountingConsole: ConsoleCallTransport, @unchecked Sendable {
    private let fixtures: FixtureConsole
    private let countBody: [String: Any]
    private let lock = NSLock()
    private var _waiting: Int?

    var waiting: Int? {
        get { lock.withLock { _waiting } }
        set { lock.withLock { _waiting = newValue } }
    }

    init(waiting: Int?) throws {
        fixtures = try FixtureConsole.recorded()
        let fixture = try ConsoleFixture.load("get-api-needs-you-count")
        countBody = try #require(try JSONSerialization.jsonObject(with: fixture.reply) as? [String: Any])
        _waiting = waiting
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        guard method == "GET", path == "/api/needs-you/count" else {
            return await fixtures.call(method, path, body: body, idempotencyKey: idempotencyKey)
        }
        guard let waiting else { return .failure(.transport("the console is not answering")) }
        var reply = countBody
        reply["waiting"] = waiting
        if waiting == 0 { reply["oldest_ts"] = NSNull() }
        return .success((try? JSONSerialization.data(withJSONObject: reply)) ?? Data())
    }
}

struct ShellNoopRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}
