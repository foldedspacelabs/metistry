// Usage — the gauge's popover (screen 17, T5-6), against the recorded
// fixtures (U9): `GET /api/compute` and the `spend`, `spend_by_actor` and
// `aws_costs_daily` queries, recorded from a scratch console seeded with a
// crew's call on the 1st, a routine's and chat's today, one call nothing could
// price, and two days of AWS. "Today" is the day of the recording, so it is
// read from the fixture rather than written here (X-29).
//
// The ticket's own test is the first: **no projection drawn** — the chart
// stops at today, and a row the server dates after today is not drawn.

import Foundation
import Testing

@testable import MetistryKit

enum UsageFixture {
    /// The recorder runs its console in UTC (record-client-fixtures.mjs pins
    /// TZ, and CI's Postgres is UTC); so does this.
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    static let locale = Locale(identifier: "en_US")

    static func date(_ day: Int, month: Int = 9, hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour))!
    }

    /// The day the fixtures were recorded: the spend row the console marked
    /// today.
    static let today: DateComponents = {
        let rows = (try? ConsoleFixture.load("get-api-q-spend"))?.replyJSON?["rows"]?.arrayValue ?? []
        let day = rows.first { $0["is_today"]?.boolValue == true }?["day"]?.stringValue ?? ""
        return UsageReport.calendarDay(day, calendar: calendar) ?? DateComponents(year: 1970, month: 1, day: 1)
    }()

    /// Noon on the day the fixtures were recorded.
    static let now = date(today.day!, month: today.month!)

    /// How the day axis spells the recording's month ("Sep").
    static let month: String = {
        let f = DateFormatter()
        f.locale = locale
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.dateFormat = "MMM"
        return f.string(from: now)
    }()

    @MainActor
    static func model() async throws -> (UsageModel, FixtureConsole) {
        let console = try FixtureConsole.recorded()
        let model = UsageModel(store: ConsoleStores(transport: console))
        await model.refresh(now: now, calendar: calendar)
        return (model, console)
    }

    @MainActor
    static func report() async throws -> UsageReport {
        try await model().0.report(fallback: .unknown, now: now, calendar: calendar, locale: locale)
    }
}

// MARK: - No projection drawn

@MainActor
@Test func theDayChartStopsAtTodayAndDrawsNoProjection() async throws {
    let report = try await UsageFixture.report()
    let days = try #require(report.days.value)
    let today = try #require(UsageFixture.today.day)
    try #require(today > 1, "a recording on the 1st puts the crew's call and today's on one day")
    #expect(days.count == today, "the 1st to today, and not a day more")
    #expect(days.map(\.day) == Array(1...today))
    #expect(days.last?.label == "\(UsageFixture.month) \(today)")
    #expect(days.first?.label == "\(UsageFixture.month) 1")
    #expect(abs(days[0].amount - 0.0184) < 1e-9, "the crew's call on the 1st")
    #expect(abs(days[today - 1].amount - 0.0061) < 1e-9, "chat and the routine today; the unpriced call adds $0")
    #expect(days[1..<(today - 1)].allSatisfy { $0.amount == 0 }, "a day with no rows is a day with nothing spent")
    #expect(report.peakLine == "peak $0.02 · \(UsageFixture.month) 1")

    // a row the server dates after the client's today (clocks either side of
    // midnight) is not a bar: nothing stands for a day that has not happened
    let ahead = UsageReport(
        gauge: .unknown, action: nil,
        spend: .loaded(SpendRows(rows: [
            SpendRow(day: "2026-09-27", isToday: true, isThisMonth: true, costUSD: 4),
            SpendRow(day: "2026-09-26", isToday: false, isThisMonth: true, costUSD: 1),
        ])),
        actors: .waiting, aws: .waiting, now: UsageFixture.date(26), calendar: UsageFixture.calendar, locale: UsageFixture.locale
    )
    let drawn = try #require(ahead.days.value)
    #expect(drawn.count == 26)
    #expect(drawn.map(\.amount).reduce(0, +) == 1)

    // and nothing anywhere says where the month is heading
    let words = ([report.ofLimitLine, report.todayLine ?? "", report.chartSentence, report.peakLine ?? ""] + report.facts)
        .joined(separator: " ").lowercased()
    for word in ["pace", "projected", "forecast", "expected", "end of the month"] {
        #expect(!words.contains(word), "\(word): \(words)")
    }
}

@Test func onTheLastDayTheChartIsTheWholeMonthAndOneDayIsLeft() {
    let report = UsageReport(
        gauge: UsageGauge(today: 1.84, month: 23.1, dailyLimit: nil, monthlyLimit: 60), action: .stop,
        spend: .loaded(SpendRows(rows: [])), actors: .waiting, aws: .waiting,
        now: UsageFixture.date(30), calendar: UsageFixture.calendar, locale: UsageFixture.locale
    )
    #expect(report.days.value?.count == 30)
    #expect(report.todayLine == "$1.84 today · 1 day left")
}

// MARK: - This month

@Test func theMonthReadsAgainstTheLimitInTheSpecsWords() {
    func report(_ gauge: UsageGauge, _ action: ComputeBudgetAction? = .stop, day: Int = 23) -> UsageReport {
        UsageReport(gauge: gauge, action: action, spend: .waiting, actors: .waiting, aws: .waiting,
                    now: UsageFixture.date(day), calendar: UsageFixture.calendar, locale: UsageFixture.locale)
    }
    let within = report(UsageGauge(today: 1.84, month: 23.1, dailyLimit: nil, monthlyLimit: 60))
    #expect(within.ofLimitLine == "of $60 this month")
    #expect(within.todayLine == "$1.84 today · 8 days left", "screen 17 §1.1, on the 23rd of a 30-day month")
    #expect(within.monthFraction.map { abs($0 - 23.1 / 60) < 1e-9 } == true)
    #expect(within.limitLine == nil)

    let noLimit = report(UsageGauge(today: 0.5, month: 3, dailyLimit: nil, monthlyLimit: nil), nil)
    #expect(noLimit.ofLimitLine == "this month · no monthly spending limit")
    #expect(noLimit.monthFraction == nil, "no meter without a limit to fill against")

    let daily = report(UsageGauge(today: 5.2, month: 30, dailyLimit: 5, monthlyLimit: 60))
    #expect(daily.todayLine == "$5.20 of $5 today · 8 days left")
    #expect(daily.limitLine == "Compute stopped at the $5 daily spending limit")

    // at the limit, the popover says what the engine does (C133) — the action the owner chose
    let month = UsageGauge(today: 1, month: 60.2, dailyLimit: nil, monthlyLimit: 60)
    #expect(report(month, .stop).limitLine == "Compute stopped at the $60 monthly spending limit")
    #expect(report(month, .criticalOnly).limitLine == "Only critical calls run past the $60 monthly spending limit")
    #expect(report(month, .allow).limitLine == "Past the $60 monthly spending limit — calls still run")
    #expect(report(month).monthFraction == 1, "the meter is full, never over")
}

@Test func nothingSpentThisMonthIsTheEmptyState() {
    let empty = UsageReport(
        gauge: UsageGauge(today: 0, month: 0, dailyLimit: nil, monthlyLimit: 60), action: .stop,
        spend: .loaded(SpendRows(rows: [])), actors: .loaded(SpendByActorList(rows: [])), aws: .loaded(AwsCostDays(rows: [])),
        now: UsageFixture.now, calendar: UsageFixture.calendar
    )
    #expect(empty.isEmpty)
    #expect(empty.peak == nil)
    // still loading is not empty: it is waiting, and says so
    let waiting = UsageReport(gauge: UsageGauge(today: 0, month: 0, dailyLimit: nil, monthlyLimit: nil), action: nil,
                              spend: .waiting, actors: .waiting, aws: .waiting, now: UsageFixture.now, calendar: UsageFixture.calendar)
    #expect(!waiting.isEmpty)
}

// MARK: - Where it went, and one line each

@MainActor
@Test func whereItWentRanksWhoSpentAndTheFactsSayWhatIsKnown() async throws {
    let report = try await UsageFixture.report()
    let ranked = try #require(report.whereItWent.value)
    #expect(ranked.map(\.label) == ["fixtures", "Chat", "standup"], "highest first; the chat turns are Chat, a crew its name; $0 actors are not where money went")
    #expect(report.unpricedCalls == .loaded(1))
    #expect(report.facts == [
        // cache_report's formula over this month's rows: 3,100 cached of 7,500 billed prompt tokens
        "Cache rate 41% this month",
        "AWS this month $1.78 — not compute",
        "1 call with no price — counts as $0",
    ])
}

@Test func aFactWithNoReadingIsLeftOutRatherThanGuessed() {
    let report = UsageReport(
        gauge: .unknown, action: nil,
        spend: .loaded(SpendRows(rows: [])), actors: .loaded(SpendByActorList(rows: [SpendByActor(actor: "assistant", callsUnpriced: 0, costUSD: 0.5)])),
        aws: .loaded(AwsCostDays(rows: [])), now: UsageFixture.now, calendar: UsageFixture.calendar
    )
    #expect(report.cacheRate == nil, "no prompt billed is no reading, not 0%")
    #expect(report.facts == ["Every call this month had a price"], "no AWS sync, no AWS line")
}

@Test func theWireDaysBothSpellingsLandOnTheirCalendarDay() {
    let c = UsageFixture.calendar
    #expect(UsageReport.calendarDay("2026-09-26", calendar: c) == DateComponents(year: 2026, month: 9, day: 26))
    let instant = UsageReport.calendarDay("2026-09-26T04:00:00.000Z", calendar: c)
    #expect(instant?.year == 2026 && instant?.month == 9 && instant?.day == 26, "pg's local midnight, read in the console's zone")
    #expect(UsageReport.calendarDay("yesterday", calendar: c) == nil)
    #expect(UsageReport.actorLabel("assistant") == "Chat")
    #expect(UsageReport.actorLabel("crew:reviewer") == "reviewer")
    #expect(UsageReport.actorLabel("standup") == "standup")
}

// MARK: - The reads

@MainActor
@Test func theModelAsksEachReadBackToTheFirst() async throws {
    let (model, console) = try await UsageFixture.model()
    let paths = Set(console.calls.map(\.path))
    let window = try #require(UsageFixture.today.day) - 1 // the days before today, back to the 1st
    #expect(paths == [
        "/api/compute",
        "/api/q/spend?days=\(window)",
        "/api/q/spend_by_actor?days=\(window)",
        "/api/q/aws_costs_daily?days=\(window)",
    ], "calls: \(paths.sorted())")
    #expect(console.calls.allSatisfy { $0.servedBy != nil })
    #expect(model.compute.value != nil)
    #expect(UsageReport.windowDays(now: UsageFixture.date(1), calendar: UsageFixture.calendar) == 0, "on the 1st, today alone")
}

@MainActor
@Test func aFailedRefreshKeepsTheLastAnswerAndAFirstFailureSaysWhy() async throws {
    let store = FlakyUsageStore(inner: ConsoleStores(transport: try FixtureConsole.recorded()))
    let model = UsageModel(store: store)
    store.failing = true
    await model.refresh(now: UsageFixture.now, calendar: UsageFixture.calendar)
    #expect(model.compute == .failed(FlakyUsageStore.error.localizedDescription))
    #expect(model.failure(fallback: .unknown) == FlakyUsageStore.error.localizedDescription)
    #expect(model.failure(fallback: UsageGauge(today: 1, month: 2, dailyLimit: nil, monthlyLimit: nil)) == nil, "the gauge knows the month: show it")

    store.failing = false
    await model.refresh(now: UsageFixture.now, calendar: UsageFixture.calendar)
    let loaded = try #require(model.spend.value)
    store.failing = true
    await model.refresh(now: UsageFixture.now, calendar: UsageFixture.calendar)
    #expect(model.spend.value == loaded, "C135: the last data stays on screen")
    #expect(model.compute.value != nil)
}

@MainActor
@Test func openingThePopoverMovesTheGaugeWithTheSameAnswer() async throws {
    let shell = ShellModel(stores: ConsoleStores(transport: try FixtureConsole.recorded()), defaults: UserDefaults(suiteName: "usage-\(UUID().uuidString)")!)
    #expect(shell.gauge == .unknown)
    await shell.refreshUsageDetail(now: UsageFixture.now)
    #expect(shell.gauge.month == 0.0245) // the recorder's seeded spend this month
    #expect(shell.usageDetail.report(fallback: shell.gauge).gauge == shell.gauge)
    // an instance switch drops what the last one said
    shell.adopt(stores: nil)
    #expect(shell.usageDetail.compute == .waiting)
}

@MainActor
@Test func raiseAndTheLinkOpenSettingsOnCompute() throws {
    let model = AppModel(bundleResourceURL: nil, runner: ShellNoopRunner(), defaults: UserDefaults(suiteName: "usage-\(UUID().uuidString)")!)
    model.settings.section = .instance
    RootView.showSpendingLimits(in: model.settings)
    #expect(model.settings.section == .compute, "C138: Raise leads to Settings › Compute › Spending limits")
}

// MARK: - A store that fails on demand

private final class FlakyUsageStore: UsageStore, @unchecked Sendable {
    static let error = ConsoleError.transport("connection refused")
    let inner: ConsoleStores
    private let lock = NSLock()
    private var _failing = false
    var failing: Bool {
        get { lock.withLock { _failing } }
        set { lock.withLock { _failing = newValue } }
    }

    init(inner: ConsoleStores) { self.inner = inner }

    private func gate<T>(_ body: () async -> Result<T, ConsoleError>) async -> Result<T, ConsoleError> {
        failing ? .failure(Self.error) : await body()
    }

    func compute() async -> Result<ConsoleCompute, ConsoleError> { await gate { await inner.compute() } }
    func computeModels(provider: String?) async -> Result<ComputeModelsReply, ConsoleError> { await gate { await inner.computeModels(provider: provider) } }
    func computeCatalogue(query: String?, provider: String?, refresh: Bool) async -> Result<ComputeCatalogueReply, ConsoleError> {
        await gate { await inner.computeCatalogue(query: query, provider: provider, refresh: refresh) }
    }
    func assignCompute(_ target: ComputeAssignTarget, model: String, effort: String?) async -> Result<ComputeWriteResult, ConsoleError> {
        await gate { await inner.assignCompute(target, model: model, effort: effort) }
    }
    func unassignCompute(_ target: ComputeAssignTarget) async -> Result<ComputeWriteResult, ConsoleError> {
        await gate { await inner.unassignCompute(target) }
    }
    func setComputeBudget(scope: String, daily: Double?, monthly: Double?, action: String) async -> Result<ComputeWriteResult, ConsoleError> {
        await gate { await inner.setComputeBudget(scope: scope, daily: daily, monthly: monthly, action: action) }
    }
    func testComputeProvider(_ name: String, complete: Bool) async -> Result<ComputeProviderTestReply, ConsoleError> {
        await gate { await inner.testComputeProvider(name, complete: complete) }
    }
    func spend(days: Int?) async -> Result<SpendRows, ConsoleError> { await gate { await inner.spend(days: days) } }
    func spendByActor(days: Int?) async -> Result<SpendByActorList, ConsoleError> { await gate { await inner.spendByActor(days: days) } }
    func awsCostsDaily(days: Int?) async -> Result<AwsCostDays, ConsoleError> { await gate { await inner.awsCostsDaily(days: days) } }
}

// MARK: - The largest text (§2.18.5)

#if os(macOS)
import AppKit
import SwiftUI

@MainActor
@Test func atTheLargestTextThePopoverGrowsLongerNeverWider() async throws {
    let report = try await UsageFixture.report()
    func fitting(_ size: DynamicTypeSize) -> NSSize {
        let host = NSHostingView(rootView: UsageView(report: report, showLimits: {}).environment(\.dynamicTypeSize, size))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize
    }
    let regular = fitting(.large)
    let largest = fitting(.accessibility5)
    #expect(regular.width == UsageView.width)
    #expect(largest.width == UsageView.width, "never wider: \(largest)")
    #expect(largest.height > regular.height * 1.5, "longer: \(regular.height) → \(largest.height)")
}
#endif
