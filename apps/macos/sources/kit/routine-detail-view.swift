// One routine, and one sync (design-build-plan T6-6; screen-08-routines.md
// §10.2, §11): the detail beside Scheduled's list (scheduled-view.swift).
//
// A ROUTINE (§10.2). Its name, the **default** tag, *Run by …*, **Run Now**
// and **Pause**; then four sections, each a heading:
//
//   * **Schedule** — the weekday toggles and the time, each with where it came
//     from (*default* · *from your profile* · *yours*, §2.5), the time zone,
//     and the next three runs. Saving is `PUT …/schedule`; a day set left
//     alone stays named, so a routine that follows the profile keeps following
//     it. An interval routine is a segmented cadence instead.
//   * **What It's Asked to Do** — a product routine's settings as its
//     manifest (or the owner) set them; a New Routine's task, appended to its
//     agent's own definition and never replacing it (§5.1). Editing the task
//     is reach `local`: the editor exists only on the local owner's client and
//     calls `PUT …/assignment` (scheduled-model.swift says how the tool refuses).
//   * **Reads and Writes** — the per-run read grants, said as grants that
//     exist only during the run (§5.2); per-run grants are read-only (owner
//     ruling, W1).
//   * **History** — the latest run opened to its steps (its calls, the model
//     call with its tokens, the file it wrote, each with its time), older runs
//     one line each, a skip with its why. Three failures in a row is a stop
//     (T3-12), and says where its one request waits.
//
// Then the foot: *Shipped with Metistry; everything above is yours to
// change.* and **Reset to Default**, which asks nothing (§10.2).
//
// A SYNC (§11). *Reads from* its connection, **Sync Now**, **Pause**, *Every*
// as a segmented cadence and *What reaches Needs You* as toggles. A sync's
// connection is never set here — the connection setup flow writes it (ruled
// 2026-09-27) — so a sync with none says how it gets one and offers nothing
// that the door would refuse.
//
// O3. Every control here is a decision: while the console is unreachable it
// is off and the gate's sentence is printed under it (components-01 §1.3).

import SwiftUI

// MARK: - One routine

struct RoutineDetailView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let name: String
    let assistantName: String?
    let onOpenPath: ((String) -> Void)?
    let onGoToAgents: (() -> Void)?
    let onGoToNeedsYou: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        if let routine = model.routine(name) {
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                    header(routine)
                    DetailSection(title: "Schedule") {
                        RoutineScheduleEditor(model: model, routine: routine)
                    }
                    DetailSection(title: "What It's Asked to Do") {
                        RoutineTaskSection(model: model, routine: routine, onOpenPath: onOpenPath, onGoToAgents: onGoToAgents)
                    }
                    DetailSection(title: "Reads and Writes") {
                        readsAndWrites(routine)
                    }
                    DetailSection(title: "History") {
                        RoutineHistory(model: model, name: name, nextRun: routine.nextRun, onOpenPath: onOpenPath, onGoToNeedsYou: onGoToNeedsYou)
                    }
                    if !routine.isAssignment {
                        foot(routine)
                    }
                }
                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                .padding(MetistrySpace.s5)
            }
            .background(p[.surface])
        } else if case .failed(let why)? = model.routineDetails[name] {
            StatePanel(StatePanelModel(.failed, title: "Couldn't Read This Routine", sentence: "Its schedule and history weren't answered.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.loadDetail(isSync: false, name: name, force: true) }
            }
        } else {
            PlaceholderRows(count: 4, waitingFor: nil).padding(MetistrySpace.s4)
        }
    }

    private func header(_ routine: ScheduledRoutine) -> some View {
        let p = Palette(scheme)
        let runBy = routine.actor ?? assistantName
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s1) {
                Text(verbatim: routine.title)
                    .metistryFont(.title2, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                if routine.isDefault { ScheduledTag(text: "default") }
            }
            if let runBy {
                Text(verbatim: "Run by \(runBy)")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
            }
            if let held = routine.held {
                MarkView(Mark(held, glyph: .absent, style: .footnote, ink: .absent, on: .surface, spoken: "Held: \(held)"))
            } else if let refused = routine.nextRefused {
                MarkView(Mark(refused, glyph: .absent, style: .footnote, ink: .absent, on: .surface, spoken: "Can't be placed: \(refused)"))
            }
            DecisionRow(model: model, name: name, controls: [
                (ControlSpec(ScheduledWords.runNow, role: .primary, shortcut: "⌘R", disabledBecause: model.decisionsUnavailableReason), { Task { await model.runNow(routine: name) } }),
                (ControlSpec(routine.isPaused ? ScheduledWords.resume : ScheduledWords.pause, role: .secondary, shortcut: "⌥⌘P", disabledBecause: model.decisionsUnavailableReason), { Task { await model.togglePause(routine: name) } }),
            ])
        }
    }

    @ViewBuilder
    private func readsAndWrites(_ routine: ScheduledRoutine) -> some View {
        let p = Palette(scheme)
        if routine.isAssignment {
            let actor = routine.actor ?? "its agent"
            if routine.readGrants.isEmpty {
                DetailLine(label: "Reads", value: "Nothing beyond \(actor)'s own permissions")
            } else {
                DetailLine(label: "Reads", value: routine.readGrants.joined(separator: " · "), mono: true)
                Text(verbatim: "Only during this routine — outside it, \(actor) can't read \(routine.readGrants.joined(separator: " or ")).")
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize(horizontal: false, vertical: true)
            }
            DetailLine(label: "Writes", value: "Nothing a run is granted — per-run grants are read-only")
        } else {
            Text(verbatim: "What it reads and writes is its own, under its own name, and isn't changed here.")
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func foot(_ routine: ScheduledRoutine) -> some View {
        let p = Palette(scheme)
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Divider()
            Text(verbatim: ScheduledWords.productFoot)
                .metistryFont(.footnote)
                .foregroundStyle(p[.textSecondary])
            if routine.isDefault {
                Text(verbatim: "It's at its default.")
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textTertiary])
            } else {
                ControlButton(ControlSpec(ScheduledWords.resetToDefault, role: .secondary, disabledBecause: model.decisionsUnavailableReason)) {
                    Task { await model.resetToDefault(routine: name) }
                }
            }
        }
    }
}

// MARK: - Schedule

struct RoutineScheduleEditor: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let routine: ScheduledRoutine
    /// The owner's edits, until saved. Nil: untouched.
    @State private var draftDays: [String]?
    @State private var draftTimes: [String]?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            switch routine.schedule.value {
            case .timeOfDay(let days, let at, let tz):
                timeOfDay(days: days, at: at, tz: tz)
            case .interval(let every):
                OriginLabel(label: "Every", origin: routine.schedule.origin)
                Picker("Every", selection: Binding(get: { every }, set: { code in
                    Task { await model.setSchedule(routine: routine.name, .interval(code)) }
                })) {
                    ForEach(ScheduledWords.cadences, id: \.self) { Text(verbatim: ScheduledWords.cadence($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .disabled(!model.allowsDecisions)
            case .unreadable(let text):
                DetailLine(label: "Schedule", value: text, mono: true)
                Text(verbatim: "Its manifest's own schedule, shown as written.")
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
            }
            let next = ScheduledCalendar.upcoming(routine, count: 3, now: model.now(), fallbackZone: model.zone)
            if !next.isEmpty {
                DetailLine(label: "Next runs", value: next.map { model.clock.moment($0, now: model.now()) }.joined(separator: " · "))
            } else if routine.isPaused {
                DetailLine(label: "Next runs", value: "None while it's paused")
            }
        }
    }

    @ViewBuilder
    private func timeOfDay(days: DaySet, at: [String], tz: String?) -> some View {
        let p = Palette(scheme)
        let resolved = routine.days?.value ?? days.wire
        let chosen = draftDays ?? resolved
        let times = draftTimes ?? at
        OriginLabel(label: "Days · \(ScheduledWords.days(draftDays.map(DaySet.weekdays) ?? days))", origin: draftDays == nil ? (routine.days?.origin ?? routine.schedule.origin) : .yours)
        FlowLayout(spacing: MetistrySpace.s1, lineSpacing: MetistrySpace.s1) {
            ForEach(ScheduledWords.weekdayCodes.indices, id: \.self) { i in
                let code = ScheduledWords.weekdayCodes[i]
                Toggle(isOn: Binding(get: { chosen.contains(code) }, set: { on in
                    var next = chosen.filter { $0 != code }
                    if on { next.append(code) }
                    draftDays = ScheduledWords.weekdayCodes.filter(next.contains)
                })) {
                    Text(verbatim: ScheduledWords.weekdayShort[i])
                }
                .toggleStyle(.button)
                .accessibilityLabel(Text(verbatim: Calendar(identifier: .gregorian).weekdaySymbols[i]))
                .disabled(!model.allowsDecisions)
            }
        }
        OriginLabel(label: "At", origin: draftTimes == nil ? routine.schedule.origin : .yours)
        ForEach(times.indices, id: \.self) { i in
            DatePicker(
                times.count == 1 ? "Time" : "Time \(i + 1)",
                selection: Binding(get: { Self.date(times[i]) }, set: { date in
                    var next = times
                    next[i] = Self.hhmm(date)
                    draftTimes = next
                }),
                displayedComponents: .hourAndMinute
            )
            .fixedSize()
            .environment(\.timeZone, Self.utc)
            .disabled(!model.allowsDecisions)
        }
        if let zone = routine.timeZone {
            OriginLabel(label: "Time zone · \(zone.value)", origin: zone.origin)
        }
        if draftDays != nil || draftTimes != nil {
            let empty = chosen.isEmpty
            HStack(spacing: MetistrySpace.s2) {
                ControlButton(ControlSpec("Save Schedule", role: .primary, disabledBecause: empty ? "Choose at least one day" : model.decisionsUnavailableReason)) {
                    let schedule = RoutineSchedule.timeOfDay(days: draftDays ?? days.wire, at: times, tz: tz)
                    Task {
                        await model.setSchedule(routine: routine.name, schedule)
                        draftDays = nil
                        draftTimes = nil
                    }
                }
                ControlButton(ControlSpec("Revert", role: .plain)) {
                    draftDays = nil
                    draftTimes = nil
                }
            }
            if empty {
                Text(verbatim: "Choose at least one day")
                    .metistryFont(.footnote)
                    .foregroundStyle(p[.textSecondary])
            }
        }
    }

    // A time of day is wall-clock `HH:MM` in the routine's zone; the picker
    // edits it on a fixed UTC day so no zone moves it.
    static let utc = TimeZone(identifier: "UTC")!

    static func date(_ hhmm: String) -> Date {
        let (h, m) = ScheduledWords.parse(hhmm) ?? (0, 0)
        return Date(timeIntervalSince1970: TimeInterval(h * 3600 + m * 60))
    }

    static func hhmm(_ date: Date) -> String {
        let s = Int(date.timeIntervalSince1970) % 86_400
        let seconds = s < 0 ? s + 86_400 : s
        return String(format: "%02d:%02d", seconds / 3600, seconds % 3600 / 60)
    }
}

// MARK: - The task

struct RoutineTaskSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let routine: ScheduledRoutine
    let onOpenPath: ((String) -> Void)?
    let onGoToAgents: (() -> Void)?
    @State private var editing = false
    @State private var actor = ""
    @State private var task = ""
    @State private var reads = ""

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            if routine.isAssignment {
                let actorID = routine.actor ?? "its agent"
                if editing && model.reach.changesWhatRuns {
                    editor
                } else {
                    Text(verbatim: routine.task ?? "No task yet.")
                        .metistryFont(.body)
                        .foregroundStyle(p[.textPrimary])
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(MetistrySpace.s3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                    Text(verbatim: "Added to \(actorID)'s own definition — it never replaces it.")
                        .metistryFont(.footnote)
                        .foregroundStyle(p[.textSecondary])
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: MetistrySpace.s2) {
                        // The editor is the Mac's alone: absent, not dimmed, anywhere else (§2.3).
                        if model.reach.changesWhatRuns {
                            ControlButton(ControlSpec("Edit Task", glyph: .edit, role: .secondary, disabledBecause: model.decisionsUnavailableReason)) {
                                actor = routine.actor ?? ""
                                task = routine.task ?? ""
                                reads = routine.readGrants.joined(separator: ", ")
                                editing = true
                            }
                        }
                        if let onGoToAgents {
                            ControlButton(ControlSpec("Edit \(actorID) on Agents", role: .plain), action: onGoToAgents)
                        }
                    }
                    if !model.reach.changesWhatRuns {
                        Text(verbatim: ScheduledWords.onlyTheMac)
                            .metistryFont(.footnote)
                            .foregroundStyle(p[.textSecondary])
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if routine.config.isEmpty {
                Text(verbatim: "Its task is its own, and isn't changed here.")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
            } else {
                ForEach(routine.config) { field in
                    VStack(alignment: .leading, spacing: 2) {
                        DetailLine(label: field.label, value: field.value, mono: field.value.contains("/"), origin: field.origin)
                        if field.value.hasSuffix(".md"), let onOpenPath {
                            ControlButton(ControlSpec("Open in Obsidian", role: .plain)) { onOpenPath(field.value) }
                        }
                    }
                }
            }
        }
    }

    private var editor: some View {
        let p = Palette(scheme)
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            TextField("Agent", text: $actor)
                .textFieldStyle(.roundedBorder)
            Text(verbatim: "Task")
                .metistryFont(.footnote, weight: .semibold)
                .foregroundStyle(p[.textSecondary])
            TextEditor(text: $task)
                .metistryFont(.body)
                .frame(minHeight: 90)
                .scrollContentBackground(.hidden)
                .padding(MetistrySpace.s1)
                .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                .accessibilityLabel(Text(verbatim: "Task"))
            TextField("Reads, for this routine only (comma separated)", text: $reads)
                .textFieldStyle(.roundedBorder)
            Text(verbatim: "Per-run grants are read-only.")
                .metistryFont(.footnote)
                .foregroundStyle(p[.textSecondary])
            HStack(spacing: MetistrySpace.s2) {
                let blank = actor.trimmingCharacters(in: .whitespaces).isEmpty || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ControlButton(ControlSpec("Save Task", role: .primary, disabledBecause: blank ? "An agent and a task are both needed" : model.decisionsUnavailableReason)) {
                    let grants = reads.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    Task {
                        if await model.saveAssignment(routine: routine.name, actor: actor.trimmingCharacters(in: .whitespaces), task: task, reads: grants) {
                            editing = false
                        }
                    }
                }
                ControlButton(ControlSpec("Cancel", role: .plain)) { editing = false }
            }
        }
    }
}

// MARK: - History

struct RoutineHistory: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let name: String
    let nextRun: Date?
    let onOpenPath: ((String) -> Void)?
    let onGoToNeedsYou: (() -> Void)?
    @State private var latestOpen = true

    var body: some View {
        let p = Palette(scheme)
        let history = model.routineDetails[name]?.value?.history
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            if let history {
                if history.isEmpty {
                    Text(verbatim: "Hasn't run yet.")
                        .metistryFont(.subhead, weight: .medium)
                        .foregroundStyle(p[.textPrimary])
                    if let nextRun {
                        Text(verbatim: "Its first run is \(model.clock.moment(nextRun, now: model.now())). Run Now runs it sooner.")
                            .metistryFont(.subhead)
                            .foregroundStyle(p[.textSecondary])
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    if model.isStopped(history) {
                        StoppedNote(onGoToNeedsYou: onGoToNeedsYou, retry: ScheduledWords.runNow)
                    }
                    let latest = history[0]
                    DisclosureGroup(isExpanded: $latestOpen) {
                        RunStepsView(model: model, run: latest, onOpenPath: onOpenPath)
                            .padding(.leading, MetistrySpace.s2)
                    } label: {
                        HistoryLine(run: latest, clock: model.clock, now: model.now())
                    }
                    ForEach(history.dropFirst()) { run in
                        HistoryLine(run: run, clock: model.clock, now: model.now())
                    }
                }
            } else if case .failed(let why)? = model.routineDetails[name] {
                MarkView(Mark(why, glyph: .failed, style: .footnote, ink: .failed, on: .surface, spoken: "Couldn't read its history: \(why)"))
            } else {
                Text(verbatim: "Reading its history…")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
            }
        }
    }
}

/// One run on one line: when, what it came to (the error verbatim), what it cost.
struct HistoryLine: View {
    @Environment(\.colorScheme) private var scheme
    let run: ScheduledRun
    let clock: ClockTime
    let now: Date

    var body: some View {
        let p = Palette(scheme)
        let when = run.at.map { clock.moment($0, now: now) } ?? "—"
        let extras = [run.trigger == "run_now" ? "Run Now" : nil, run.costUSD.map(ScheduledWords.cost)].compactMap { $0 }
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            if let (glyph, ink) = run.result.glyph {
                Image(systemName: glyph.rawValue).foregroundStyle(p[ink]).metistryFont(.footnote)
            }
            Text(verbatim: when)
                .metistryFont(.subhead, weight: .medium)
                .monospacedDigit()
                .foregroundStyle(p[.textPrimary])
            Text(verbatim: ([run.result.sentence] + extras).joined(separator: " · "))
                .metistryFont(.subhead)
                .foregroundStyle(p[run.result.isFailure ? .failed : .textSecondary])
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: ([when, run.result.sentence] + extras).joined(separator: ", ")))
    }
}

/// History's latest run, opened: its calls, the model call, the write.
struct RunStepsView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let run: ScheduledRun
    let onOpenPath: ((String) -> Void)?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            if let id = run.numericID {
                switch model.steps[id] {
                case .loaded(let steps)?:
                    ForEach(steps.calls) { call in
                        step(call.tool, [call.durationMs.map(ScheduledWords.duration(ms:)), call.ok == false ? "failed\(call.error.map { " — \($0)" } ?? "")" : nil].compactMap { $0 }, failed: call.ok == false)
                    }
                    if steps.callsTotal > steps.calls.count {
                        step("\(steps.callsTotal - steps.calls.count) more calls not listed", [], failed: false)
                    }
                    if let modelName = steps.model {
                        let tokens = [steps.tokensIn.map { "\($0) in" }, steps.tokensOut.map { "\($0) out" }].compactMap { $0 }.joined(separator: ", ")
                        step("Model call · \(modelName)", [tokens.isEmpty ? nil : tokens, steps.durationMs.map(ScheduledWords.duration(ms:)), steps.costUSD.map(ScheduledWords.cost)].compactMap { $0 }, failed: false)
                    } else if let ms = steps.durationMs {
                        step("Ran without a model", [ScheduledWords.duration(ms: ms)], failed: false)
                    }
                    if let path = steps.path {
                        HStack(spacing: MetistrySpace.s2) {
                            step("Wrote \(path)", [], failed: false)
                            if let onOpenPath {
                                ControlButton(ControlSpec("Open in Obsidian", role: .plain)) { onOpenPath(path) }
                            }
                        }
                    }
                    if let why = steps.why, !why.isEmpty {
                        step("Why: \(why)", [], failed: false)
                    }
                    if steps.calls.isEmpty && steps.model == nil && steps.path == nil && (steps.why ?? "").isEmpty {
                        step(run.result == .nothingToDo ? "Found nothing to do, and wrote nothing" : "No steps were recorded", [], failed: false)
                    }
                case .failed(let why)?:
                    MarkView(Mark(why, glyph: .failed, style: .footnote, ink: .failed, on: .surface, spoken: "Couldn't read its steps: \(why)"))
                default:
                    Text(verbatim: "Reading its steps…")
                        .metistryFont(.footnote)
                        .foregroundStyle(p[.textSecondary])
                }
            } else {
                step("No steps were recorded", [], failed: false)
            }
        }
    }

    private func step(_ what: String, _ facts: [String], failed: Bool) -> some View {
        let p = Palette(scheme)
        let line = ([what] + facts).joined(separator: " · ")
        return Text(verbatim: line)
            .metistryFont(.footnote, design: what.contains("/") ? .mono : .sans)
            .foregroundStyle(p[failed ? .failed : .textSecondary])
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(Text(verbatim: line))
    }
}

/// Three failures in a row (T3-12): it stopped, and one request says so.
struct StoppedNote: View {
    @Environment(\.colorScheme) private var scheme
    let onGoToNeedsYou: (() -> Void)?
    let retry: String

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            MarkView(Mark(
                "Stopped after \(ScheduledWords.strikes) failures in a row. One request waits in Needs You; \(retry) checks a fix.",
                glyph: .failed, style: .subhead, ink: .failed, on: .failedQuiet,
                spoken: "Failed. Stopped after \(ScheduledWords.strikes) failures in a row. One request waits in Needs You; \(retry) checks a fix."
            ))
            if let onGoToNeedsYou {
                ControlButton(ControlSpec("Go to Needs You", role: .plain), action: onGoToNeedsYou)
            }
        }
        .padding(MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.failedQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
    }
}

// MARK: - One sync

struct SyncDetailView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let name: String
    let onGoToNeedsYou: (() -> Void)?

    var body: some View {
        let p = Palette(scheme)
        if let sync = model.sync(name) {
            let connected = sync.connection != nil
            let blocked = connected ? model.decisionsUnavailableReason : ScheduledWords.noConnection
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s5) {
                    VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                        FlowLayout(spacing: MetistrySpace.s2, lineSpacing: MetistrySpace.s1) {
                            Text(verbatim: sync.title)
                                .metistryFont(.title2, weight: .semibold)
                                .foregroundStyle(p[.textPrimary])
                                .accessibilityAddTraits(.isHeader)
                            if sync.isDefault { ScheduledTag(text: "default") }
                        }
                        if let connection = sync.connection {
                            Text(verbatim: "Reads from \(connection)")
                                .metistryFont(.subhead)
                                .foregroundStyle(p[.textSecondary])
                        } else {
                            MarkView(Mark(ScheduledWords.noConnection, glyph: .absent, style: .subhead, ink: .absent, on: .surface, spoken: "Not configured. \(ScheduledWords.noConnection)"))
                        }
                        if let held = sync.held {
                            MarkView(Mark(held, glyph: .absent, style: .footnote, ink: .absent, on: .surface, spoken: "Held: \(held)"))
                        }
                        DecisionRow(model: model, name: name, controls: [
                            (ControlSpec(ScheduledWords.syncNow, role: .primary, shortcut: "⌘R", disabledBecause: model.decisionsUnavailableReason), { Task { await model.runNow(sync: name) } }),
                            (ControlSpec(sync.isPaused ? ScheduledWords.resume : ScheduledWords.pause, role: .secondary, shortcut: "⌥⌘P", disabledBecause: blocked), { Task { await model.togglePause(sync: name) } }),
                        ])
                    }
                    DetailSection(title: "Every") {
                        OriginLabel(label: "Checked", origin: sync.every.origin)
                        if let every = sync.every.value {
                            Picker("Every", selection: Binding(get: { every }, set: { code in Task { await model.setEvery(sync: name, code) } })) {
                                ForEach(ScheduledWords.cadences, id: \.self) { Text(verbatim: ScheduledWords.cadence($0)).tag($0) }
                            }
                            .pickerStyle(.segmented)
                            .fixedSize()
                            .disabled(blocked != nil)
                        } else {
                            Text(verbatim: "On its manifest's own schedule.")
                                .metistryFont(.subhead)
                                .foregroundStyle(p[.textSecondary])
                        }
                        if let last = sync.lastRun {
                            HistoryLine(run: last, clock: model.clock, now: model.now())
                        }
                    }
                    DetailSection(title: "What Reaches Needs You") {
                        if sync.raise.isEmpty {
                            Text(verbatim: "It raises nothing — it only brings changes in.")
                                .metistryFont(.subhead)
                                .foregroundStyle(p[.textSecondary])
                        }
                        ForEach(sync.raise) { rule in
                            Toggle(isOn: Binding(get: { rule.on.value }, set: { on in Task { await model.setRaise(sync: name, rule: rule.rule, on) } })) {
                                HStack(spacing: MetistrySpace.s2) {
                                    Text(verbatim: rule.label).metistryFont(.body)
                                    ScheduledTag(text: rule.on.origin.label)
                                }
                            }
                            .toggleStyle(.switch)
                            .accessibilityLabel(Text(verbatim: "\(rule.label), \(rule.on.origin.label)"))
                            .disabled(blocked != nil)
                        }
                    }
                    DetailSection(title: "History") {
                        syncHistory
                    }
                }
                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
                .padding(MetistrySpace.s5)
            }
            .background(p[.surface])
        } else if case .failed(let why)? = model.syncDetails[name] {
            StatePanel(StatePanelModel(.failed, title: "Couldn't Read This Sync", sentence: "Its cadence and history weren't answered.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.loadDetail(isSync: true, name: name, force: true) }
            }
        } else {
            PlaceholderRows(count: 4, waitingFor: nil).padding(MetistrySpace.s4)
        }
    }

    @ViewBuilder
    private var syncHistory: some View {
        let p = Palette(scheme)
        if let history = model.syncDetails[name]?.value?.history {
            if history.isEmpty {
                Text(verbatim: "Hasn't run yet.")
                    .metistryFont(.subhead)
                    .foregroundStyle(p[.textSecondary])
            } else {
                if model.isStopped(history) {
                    StoppedNote(onGoToNeedsYou: onGoToNeedsYou, retry: ScheduledWords.syncNow)
                }
                ForEach(history) { run in
                    HistoryLine(run: run, clock: model.clock, now: model.now())
                }
            }
        } else {
            Text(verbatim: "Reading its history…")
                .metistryFont(.subhead)
                .foregroundStyle(p[.textSecondary])
        }
    }
}

// MARK: - Pieces

/// A detail section: its heading (§2.18.3: each detail section a heading), then its lines.
struct DetailSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: title)
                .metistryFont(.headline)
                .foregroundStyle(Palette(scheme)[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

/// A label and where its value came from: *Days · Working days  from your profile*.
struct OriginLabel: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let origin: FieldOrigin

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: label)
                .metistryFont(.subhead, weight: .medium)
                .foregroundStyle(Palette(scheme)[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
            ScheduledTag(text: origin.label)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(label), \(origin.label)"))
    }
}

struct DetailLine: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    var mono = false
    var origin: FieldOrigin?

    var body: some View {
        let p = Palette(scheme)
        FlowLayout(spacing: MetistrySpace.s2, lineSpacing: 2) {
            Text(verbatim: label)
                .metistryFont(.subhead, weight: .medium)
                .foregroundStyle(p[.textPrimary])
            Text(verbatim: value)
                .metistryFont(.subhead, design: mono ? .mono : .sans)
                .foregroundStyle(p[.textSecondary])
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let origin { ScheduledTag(text: origin.label) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: [label, value, origin?.label].compactMap { $0 }.joined(separator: ", ")))
    }
}

/// Run Now and Pause, the gate's sentence when they are off, and what the last one came to.
struct DecisionRow: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: ScheduledModel
    let name: String
    let controls: [(ControlSpec, () -> Void)]

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(spacing: MetistrySpace.s2) {
                ForEach(controls.indices, id: \.self) { i in
                    ControlButton(controls[i].0, action: controls[i].1)
                        .disabled(model.busy.contains(name))
                }
            }
            if let reason = controls.compactMap(\.0.disabledBecause).first {
                FactNote(FactNoteModel(reason))
            }
            if let note = model.notes[name] {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Text(verbatim: note.text)
                        .metistryFont(.footnote)
                        .foregroundStyle(p[note.kind == .failed ? .failed : .textSecondary])
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    ControlButton(ControlSpec("", glyph: .decline, role: .plain, name: "Dismiss")) { model.dismissNote(name) }
                }
            }
        }
    }
}

// MARK: - Words for runs

extension ScheduledWords {
    /// *0.8s* · *4m 12s*.
    static func duration(ms: Int) -> String {
        ms < 60_000 ? String(format: "%.1fs", Double(ms) / 1000) : ClockTime.duration(Double(ms) / 1000)
    }

    /// *$0.0042* under a cent, *$1.84* over it.
    static func cost(_ usd: Double) -> String {
        usd > 0 && usd < 0.01 ? String(format: "$%.4f", usd) : String(format: "$%.2f", usd)
    }
}
