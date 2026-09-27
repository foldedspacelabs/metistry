// Usage — the gauge's popover (screen 17; design-build-plan T5-6). 400 points
// wide, on `elevated`, like Needs You's. Top to bottom:
//
//   1. This month against the spending limit: the amount, *of $60 this month*,
//      a meter, then *$1.84 today · 8 days left*. At the limit, what the
//      engine is doing about it (C133) and **Raise**.
//   2. Each day: one bar per day from the 1st to today, the peak on the
//      heading, *Sep 1* and *today* under the axis; hovering a bar says its
//      day's amount.
//   3. Where it went: agents, routines and chat ranked by this month's spend.
//   4. One line each: the cache rate, AWS this month (*not compute*), and the
//      calls nothing could price (*count as $0*).
//   5. Spending Limits in Settings — the limits are set and enforced there
//      (C130, C133); this is where they are read.
//
// NO PROJECTION. Nothing here draws or says where the month is heading: an
// "on pace for" figure is an inference, and P5 reports state. The chart stops
// at today, and no bar or line stands for a day that has not happened.
//
// WHERE THE NUMBERS COME FROM. The month, today and the limits are
// `GET /api/compute` — the same windows the engine checks before every call,
// and the same read the toolbar gauge makes, so the popover and the gauge
// cannot disagree. The days and the cache rate are the `spend` query's rows
// (cache rate is `cache_report`'s own formula, cache reads over billed prompt
// tokens, over this month's rows); *Where it went* and the unpriced calls are
// `spend_by_actor`; AWS is `aws_costs_daily`, never added to compute.
//
// WORDS. *Spending limit*, never *budget* (C130's table). The actor the chat
// turns are filed under is shown as *Chat*; the configured name is not
// needed here and the internal one never appears.
//
// ACCESSIBILITY (§2.18). Each section is a heading; the chart speaks one
// sentence and carries its table for the rotor (an `AXChartDescriptor`); a
// ranked row speaks its name and amount as one element; nothing animates;
// text is semantic styles, so the largest text size makes the popover longer,
// never wider.

import Accessibility
import SwiftUI

// MARK: - A read, in one of three states

/// What one of the popover's reads has come back with. `waiting` is only ever
/// the first load: a refresh that fails keeps the last answer (C135).
public enum UsageRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case waiting
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }
}

// MARK: - The report — everything the popover says, decided here

public struct UsageReport: Sendable, Equatable {
    public struct Day: Sendable, Equatable, Identifiable {
        /// Day of the month, 1-based.
        public let day: Int
        public let date: Date
        public let amount: Double
        /// *Sep 14*.
        public let label: String
        public var id: Int { day }
    }

    public struct Actor: Sendable, Equatable, Identifiable {
        public let label: String
        public let amount: Double
        public var id: String { label }
    }

    /// The month, today and the limits — the gauge's own reading.
    public let gauge: UsageGauge
    /// What the engine does at the instance's limit, when a limit is set.
    public let action: ComputeBudgetAction?
    /// Days of this month still to come, today included.
    public let daysLeft: Int
    /// The 1st through today, one entry per day, a day with nothing at $0.
    public let days: UsageRead<[Day]>
    /// Ranked by spend this month; actors that spent nothing are not listed.
    public let whereItWent: UsageRead<[Actor]>
    /// Cache reads over billed prompt tokens this month; nil with no prompt billed.
    public let cacheRate: Double?
    /// AWS's own bill this month; nil when no AWS spend is recorded (no sync).
    public let aws: UsageRead<Double?>
    /// Calls priced `unknown` this month — recorded at $0.
    public let unpricedCalls: UsageRead<Int>

    public init(
        gauge: UsageGauge,
        action: ComputeBudgetAction?,
        spend: UsageRead<SpendRows>,
        actors: UsageRead<SpendByActorList>,
        aws: UsageRead<AwsCostDays>,
        now: Date,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) {
        self.gauge = gauge
        self.action = action
        let today = calendar.component(.day, from: now)
        let month = calendar.dateComponents([.year, .month], from: now)
        let daysInMonth = calendar.range(of: .day, in: .month, for: now)?.count ?? today
        daysLeft = max(daysInMonth - today + 1, 1)
        let format = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day()
        let firstOfMonth = calendar.date(from: month) ?? now

        func inThisMonth(_ day: DateComponents?) -> Int? {
            guard let day, day.year == month.year, day.month == month.month, let d = day.day, (1...today).contains(d) else { return nil }
            return d
        }

        switch spend {
        case .waiting:
            days = .waiting
            cacheRate = nil
        case .failed(let reason):
            days = .failed(reason)
            cacheRate = nil
        case .loaded(let reply):
            var totals = [Int: Double]()
            var prompt = 0.0
            var cached = 0.0
            for row in reply.rows where row.isThisMonth != false {
                guard let d = inThisMonth(Self.calendarDay(row.day, calendar: calendar)) else { continue }
                totals[d, default: 0] += row.costUSD ?? 0
                prompt += row.tokensIn ?? 0
                cached += row.cacheRead ?? 0
            }
            days = .loaded((1...today).map { d in
                let date = calendar.date(byAdding: .day, value: d - 1, to: firstOfMonth) ?? firstOfMonth
                return Day(day: d, date: date, amount: totals[d] ?? 0, label: date.formatted(format))
            })
            cacheRate = prompt > 0 ? min(cached / prompt, 1) : nil
        }

        switch actors {
        case .waiting:
            whereItWent = .waiting
            unpricedCalls = .waiting
        case .failed(let reason):
            whereItWent = .failed(reason)
            unpricedCalls = .failed(reason)
        case .loaded(let reply):
            var byLabel = [String: Double]()
            for row in reply.rows { byLabel[Self.actorLabel(row.actor), default: 0] += row.costUSD ?? 0 }
            whereItWent = .loaded(byLabel.filter { $0.value > 0 }
                .map { Actor(label: $0.key, amount: $0.value) }
                .sorted { $0.amount != $1.amount ? $0.amount > $1.amount : $0.label < $1.label })
            unpricedCalls = .loaded(reply.rows.reduce(0) { $0 + ($1.callsUnpriced ?? 0) })
        }

        switch aws {
        case .waiting: self.aws = .waiting
        case .failed(let reason): self.aws = .failed(reason)
        case .loaded(let reply):
            let rows = reply.rows.filter { inThisMonth(Self.calendarDay($0.day, calendar: calendar)) != nil }
            self.aws = .loaded(rows.isEmpty ? nil : rows.reduce(0) { $0 + ($1.usd ?? 0) })
        }
    }

    /// How many trailing days the queries must read to reach back to the 1st.
    public static func windowDays(now: Date, calendar: Calendar = .current) -> Int {
        calendar.component(.day, from: now) - 1
    }

    /// A `date` column as it crosses the wire: `2026-09-26`, or the instant of
    /// that day's local midnight (`2026-09-26T04:00:00.000Z`) — read in the
    /// calendar's own zone, which on the Mac is the console's.
    static func calendarDay(_ text: String, calendar: Calendar) -> DateComponents? {
        if text.count == 10 {
            let parts = text.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            return DateComponents(year: parts[0], month: parts[1], day: parts[2])
        }
        guard let instant = WireTime.date(text) else { return nil }
        return calendar.dateComponents([.year, .month, .day], from: instant)
    }

    /// The runs ledger's `component`, as the owner knows it: the chat turns
    /// are *Chat*, a crew is its name.
    static func actorLabel(_ actor: String) -> String {
        if actor == "assistant" { return "Chat" }
        if actor.hasPrefix("crew:") { return String(actor.dropFirst("crew:".count)) }
        if actor.isEmpty { return "Unattributed" }
        return actor
    }

    // MARK: Words

    static func dollars(_ value: Double) -> String { UsageGauge.dollars(value) }
    static func limit(_ value: Double) -> String { "$" + ComputeBudgetFacts.money(value) }

    /// *of $60 this month*, or what stands in for a limit that is not set.
    public var ofLimitLine: String {
        guard let limit = gauge.monthlyLimit else { return "this month · no monthly spending limit" }
        return "of \(Self.limit(limit)) this month"
    }

    /// *$1.84 today · 8 days left*, with the daily limit when one is set.
    public var todayLine: String? {
        guard let today = gauge.today else { return nil }
        let amount = gauge.dailyLimit.map { "\(Self.dollars(today)) of \(Self.limit($0)) today" } ?? "\(Self.dollars(today)) today"
        return "\(amount) · \(daysLeft) \(daysLeft == 1 ? "day" : "days") left"
    }

    /// The meter's fill, 0…1, when there is a monthly limit to fill against.
    public var monthFraction: Double? {
        gauge.monthlyFraction.map { min(max($0, 0), 1) }
    }

    /// At a limit: what the engine is doing about it (C133), in its words.
    public var limitLine: String? {
        guard gauge.level == .reached else { return nil }
        let which: String
        if let fraction = gauge.monthlyFraction, fraction >= 1, let limit = gauge.monthlyLimit {
            which = "the \(Self.limit(limit)) monthly spending limit"
        } else if let limit = gauge.dailyLimit {
            which = "the \(Self.limit(limit)) daily spending limit"
        } else {
            which = "the spending limit"
        }
        switch action ?? .allow {
        case .stop: return "Compute stopped at \(which)"
        case .criticalOnly: return "Only critical calls run past \(which)"
        case .allow: return "Past \(which) — calls still run"
        }
    }

    /// Nothing spent this month (components-03 §2, Usage's empty state).
    public var isEmpty: Bool {
        guard let days = days.value else { return false }
        return (gauge.month ?? 0) == 0 && days.allSatisfy { $0.amount == 0 }
    }

    /// The highest day, when any day spent anything.
    public var peak: Day? {
        guard let days = days.value, let top = days.max(by: { $0.amount < $1.amount }), top.amount > 0 else { return nil }
        return top
    }

    /// *peak $3.20 · Sep 14*, on the section heading.
    public var peakLine: String? {
        peak.map { "peak \(Self.dollars($0.amount)) · \($0.label)" }
    }

    /// The chart's one spoken sentence (§2.18.3); its table is in the rotor.
    public var chartSentence: String {
        guard let days = days.value, let first = days.first else { return "Spend each day this month" }
        let span = days.count == 1 ? "today" : "\(first.label) to today"
        guard let peak else { return "Spend each day, \(span): nothing spent" }
        return "Spend each day, \(span): highest \(Self.dollars(peak.amount)) on \(peak.label)"
    }

    /// The one-line facts, in the spec's order; a fact with no reading is left out.
    public var facts: [String] {
        var lines: [String] = []
        if let cacheRate { lines.append("Cache rate \(UsageGauge.percent(cacheRate)) this month") }
        switch aws {
        case .loaded(let total?): lines.append("AWS this month \(Self.dollars(total)) — not compute")
        case .failed(let reason): lines.append("AWS this month couldn't be read: \(reason)")
        default: break
        }
        if case .loaded(let n) = unpricedCalls {
            lines.append(n == 0
                ? "Every call this month had a price"
                : "\(n) \(n == 1 ? "call" : "calls") with no price — \(n == 1 ? "counts" : "count") as $0")
        }
        return lines
    }
}

// MARK: - The model

/// The popover's reads. Owned by the shell, re-pointed on an instance switch,
/// refreshed each time the popover opens — the last answer stays on screen
/// while the next one is asked (C135: first paint is the last data).
@MainActor
@Observable
public final class UsageModel {
    public private(set) var compute: UsageRead<ConsoleCompute> = .waiting
    public private(set) var spend: UsageRead<SpendRows> = .waiting
    public private(set) var actors: UsageRead<SpendByActorList> = .waiting
    public private(set) var aws: UsageRead<AwsCostDays> = .waiting

    @ObservationIgnored private var store: (any UsageStore)?
    @ObservationIgnored private var generation = 0

    public init(store: (any UsageStore)?) {
        self.store = store
    }

    public func adopt(_ store: (any UsageStore)?) {
        generation += 1
        self.store = store
        compute = .waiting
        spend = .waiting
        actors = .waiting
        aws = .waiting
    }

    /// The four reads, together. A read that fails over an earlier answer
    /// keeps that answer; with none, it says why.
    public func refresh(now: Date = Date(), calendar: Calendar = .current) async {
        guard let store else {
            let reason = "There's no console to ask on this install yet."
            compute = compute.value.map(UsageRead.loaded) ?? .failed(reason)
            return
        }
        let asked = generation
        let days = UsageReport.windowDays(now: now, calendar: calendar)
        async let c = store.compute()
        async let s = store.spend(days: days)
        async let a = store.spendByActor(days: days)
        async let w = store.awsCostsDaily(days: days)
        let (computeResult, spendResult, actorsResult, awsResult) = await (c, s, a, w)
        guard asked == generation else { return }
        compute = Self.merge(compute, computeResult)
        spend = Self.merge(spend, spendResult)
        actors = Self.merge(actors, actorsResult)
        aws = Self.merge(aws, awsResult)
    }

    static func merge<T>(_ old: UsageRead<T>, _ result: Result<T, ConsoleError>) -> UsageRead<T> {
        switch result {
        case .success(let value): return .loaded(value)
        case .failure(let error):
            if case .loaded = old { return old }
            return .failed(error.localizedDescription)
        }
    }

    /// Everything the popover says. Until compute has answered, the gauge the
    /// toolbar already holds stands in for the month (first paint).
    public func report(fallback: UsageGauge, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> UsageReport {
        let loaded = compute.value
        return UsageReport(
            gauge: loaded.map(UsageGauge.init(compute:)) ?? fallback,
            action: loaded?.facts.instanceBudget?.action,
            spend: spend, actors: actors, aws: aws,
            now: now, calendar: calendar, locale: locale
        )
    }

    /// Compute failed and nothing is known about the month: the popover's panel.
    public func failure(fallback: UsageGauge) -> String? {
        guard case .failed(let reason) = compute, fallback.month == nil else { return nil }
        return reason
    }
}

// MARK: - The view

public struct UsageView: View {
    @Environment(\.colorScheme) private var scheme
    let report: UsageReport
    let failure: String?
    let showLimits: () -> Void
    let retry: () -> Void

    /// The popover's width (screen 17).
    public static let width: CGFloat = 400

    public init(report: UsageReport, failure: String? = nil, showLimits: @escaping () -> Void, retry: @escaping () -> Void = {}) {
        self.report = report
        self.failure = failure
        self.showLimits = showLimits
        self.retry = retry
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            if let failure {
                StatePanel(
                    StatePanelModel(.failed, title: "Couldn't Read Spend", sentence: "The console didn't say what this month has cost.", reason: failure, action: StateWords.tryAgain),
                    on: .elevated,
                    onAction: retry
                )
            } else {
                monthSection(p)
                if report.isEmpty {
                    StatePanel(StatePanelModel(.empty, title: "Nothing Spent This Month", sentence: "Calls that cost money show here, by day and by who made them."), on: .elevated)
                } else {
                    Divider()
                    daysSection(p)
                    Divider()
                    whereSection(p)
                    factsSection(p)
                }
            }
            Divider()
            limitsLink(p)
        }
        .padding(MetistrySpace.s4)
        .frame(width: Self.width, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(p[.elevated])
    }

    // MARK: 1 · This month

    @ViewBuilder
    private func monthSection(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("This month")
                .usageText(.headline, p)
                .accessibilityAddTraits(.isHeader)
            if let month = report.gauge.month {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Text(UsageReport.dollars(month))
                        .usageText(.title2, p)
                        .monospacedDigit()
                    Text(report.ofLimitLine)
                        .usageText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                if let fraction = report.monthFraction {
                    UsageMeter(fraction: fraction, ink: meterInk)
                        .accessibilityElement()
                        .accessibilityLabel("Spent of the monthly spending limit")
                        .accessibilityValue(UsageGauge.percent(fraction))
                }
                if let today = report.todayLine {
                    Text(today)
                        .usageText(.callout, p, .textSecondary)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Reading this month's spend…")
                    .usageText(.body, p, .textSecondary)
            }
            if let line = report.limitLine {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Text(line)
                        .usageText(.callout, p, .degraded)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: MetistrySpace.s2)
                    ControlButton(ControlSpec("Raise", role: .primary), action: showLimits)
                }
            }
        }
    }

    private var meterInk: MetistryColorRole {
        switch report.gauge.level {
        case .within: return .accent
        case .high: return .textPrimary
        case .reached: return .degraded
        }
    }

    // MARK: 2 · Each day

    @ViewBuilder
    private func daysSection(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text("Each day")
                    .usageText(.headline, p)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: MetistrySpace.s2)
                if let peak = report.peakLine {
                    Text(peak)
                        .usageText(.caption1, p, .textSecondary)
                        .monospacedDigit()
                        // the chart's sentence says it; the rotor has the table
                        .accessibilityHidden(true)
                }
            }
            switch report.days {
            case .waiting:
                Text("Reading each day's spend…").usageText(.callout, p, .textSecondary)
            case .failed(let reason):
                Text("Couldn't read each day's spend: \(reason)")
                    .usageText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .loaded(let days):
                UsageDayChart(days: days, peak: report.peak?.amount ?? 0, sentence: report.chartSentence)
            }
        }
    }

    // MARK: 3 · Where it went

    /// The first five, then the rest as one line.
    static let ranked = 5

    @ViewBuilder
    private func whereSection(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("Where it went")
                .usageText(.headline, p)
                .accessibilityAddTraits(.isHeader)
            switch report.whereItWent {
            case .waiting:
                Text("Reading who spent it…").usageText(.callout, p, .textSecondary)
            case .failed(let reason):
                Text("Couldn't read who spent it: \(reason)")
                    .usageText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            case .loaded(let actors):
                ForEach(actors.prefix(Self.ranked)) { actor in
                    rankedRow(actor.label, actor.amount, p)
                }
                if actors.count > Self.ranked {
                    let rest = actors.dropFirst(Self.ranked)
                    rankedRow("\(rest.count) more", rest.reduce(0) { $0 + $1.amount }, p, ink: .textSecondary)
                }
            }
        }
    }

    private func rankedRow(_ label: String, _ amount: Double, _ p: Palette, ink: MetistryColorRole = .textPrimary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: label)
                .usageText(.body, p, ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: MetistrySpace.s2)
            Text(UsageReport.dollars(amount))
                .usageText(.body, p, ink)
                .monospacedDigit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(label), \(UsageReport.dollars(amount))"))
    }

    // MARK: 4 · One line each

    @ViewBuilder
    private func factsSection(_ p: Palette) -> some View {
        let facts = report.facts
        if !facts.isEmpty {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                ForEach(facts, id: \.self) { line in
                    Text(verbatim: line)
                        .usageText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: 5 · The way to the limits

    private func limitsLink(_ p: Palette) -> some View {
        Button(action: showLimits) {
            HStack(spacing: MetistrySpace.s1) {
                Text(UsageView.limitsLinkTitle)
                Image(systemName: "arrow.right").accessibilityHidden(true)
            }
        }
        .buttonStyle(MetistryButtonStyle(role: .plain))
        .accessibilityLabel(Text(UsageView.limitsLinkTitle))
        .help("Settings › Compute › Spending limits")
    }

    /// Title Case: a control label (C3).
    public static let limitsLinkTitle = "Spending Limits in Settings"
}

// MARK: - The popover, as the toolbar opens it

/// The gauge's popover: the shell's gauge at once (first paint), then the
/// month's reads, asked again each time it opens.
public struct UsagePopover: View {
    let shell: ShellModel
    let showLimits: () -> Void

    public init(shell: ShellModel, showLimits: @escaping () -> Void) {
        self.shell = shell
        self.showLimits = showLimits
    }

    public var body: some View {
        let detail = shell.usageDetail
        UsageView(
            report: detail.report(fallback: shell.gauge),
            failure: detail.failure(fallback: shell.gauge),
            showLimits: showLimits,
            retry: { Task { await shell.refreshUsageDetail() } }
        )
        .task { await shell.refreshUsageDetail() }
    }
}

// MARK: - Text that grows

extension View {
    /// `metistryText`, on the type step that follows the text size on the Mac
    /// too (component-kit.swift, "The largest text"): the popover grows longer
    /// at the largest size, never wider (§2.18.5).
    fileprivate func usageText(_ style: MetistryTextStyle, _ p: Palette, _ role: MetistryColorRole = .textPrimary) -> some View {
        metistryFont(style).foregroundStyle(p[role])
    }
}

// MARK: - The meter

struct UsageMeter: View {
    @Environment(\.colorScheme) private var scheme
    let fraction: Double
    let ink: MetistryColorRole

    var body: some View {
        let p = Palette(scheme)
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(p[.sunken])
                Capsule().fill(p[ink]).frame(width: proxy.size.width * fraction)
            }
        }
        .frame(height: 6)
    }
}

// MARK: - The day chart

/// One series, magnitude → one hue: `chart-3` in light, `chart-2` in dark
/// (screen 17 §3). No legend; the values are in text ink, on hover and in the
/// rotor. Bars stop at today.
struct UsageDayChart: View {
    @Environment(\.colorScheme) private var scheme
    let days: [UsageReport.Day]
    let peak: Double
    let sentence: String

    static let height: CGFloat = 72
    static let gap: CGFloat = 2
    static let widest: CGFloat = 24
    /// The popover's width less its padding.
    static let span: CGFloat = UsageView.width - 2 * MetistrySpace.s4

    static func barWidth(count: Int) -> CGFloat {
        guard count > 0 else { return widest }
        return min(widest, (span - CGFloat(count - 1) * gap) / CGFloat(count))
    }

    var body: some View {
        let p = Palette(scheme)
        let width = Self.barWidth(count: days.count)
        let ink = p[scheme == .dark ? .chart2 : .chart3]
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .bottom, spacing: Self.gap) {
                ForEach(days) { day in
                    Rectangle()
                        .fill(ink)
                        .frame(width: width, height: peak > 0 ? max(Self.height * day.amount / peak, day.amount > 0 ? 1 : 0) : 0)
                        .frame(height: Self.height, alignment: .bottom)
                        .contentShape(Rectangle())
                        .help("\(day.label): \(UsageReport.dollars(day.amount))")
                }
            }
            .overlay(alignment: .bottom) {
                Rectangle().fill(p[.border]).frame(height: 1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: sentence))
            .accessibilityChartDescriptor(UsageChartDescriptor(days: days, sentence: sentence))
            HStack(spacing: MetistrySpace.s2) {
                if days.count > 1, let first = days.first {
                    Text(verbatim: first.label)
                }
                Spacer(minLength: 0)
                Text("today")
            }
            .usageText(.caption1, p, .textSecondary)
            .accessibilityHidden(true)
        }
    }
}

/// The chart's table for the rotor and Audio Graphs (§2.18.3).
struct UsageChartDescriptor: AXChartDescriptorRepresentable {
    let days: [UsageReport.Day]
    let sentence: String

    func makeChartDescriptor() -> AXChartDescriptor {
        let top = max(days.map(\.amount).max() ?? 0, 0.01)
        let x = AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: days.map(\.label))
        let y = AXNumericDataAxisDescriptor(title: "Spend", range: 0...top, gridlinePositions: []) { UsageGauge.dollars($0) }
        let series = AXDataSeriesDescriptor(name: "Spend", isContinuous: false, dataPoints: days.map { AXDataPoint(x: $0.label, y: $0.amount) })
        return AXChartDescriptor(title: "Each day", summary: sentence, xAxis: x, yAxis: y, additionalAxes: [], series: [series])
    }
}
