// Card detail — the popover that opens from any card (design-build-plan T6-7;
// screen-14-card-detail.md, corrected 2026-09-23; C84, C85, C37).
//
// ONE LAYOUT, TWO KINDS OF TASK. The lead mark says which before anything is
// read — the board glyph in `agent` for a work row, a checkbox for the owner's
// own line — then the title and the six facets in their fixed order
// (facet-row.swift).
//
//   * A WORK ROW — an agent holds it. Description (C85: set by whoever created
//     the row, editable by the owner), Held by, Waiting on (the blocked-by the
//     board serves, C37), the Thread with **Open Room →**, and the review
//     artifact it was cut from in the footer. Verbs: **Comment · Open On
//     Board**. It is not the owner's to complete.
//   * A MARKDOWN TASK — a line in the owner's note. *In its file*: the heading
//     above the line and its neighbours, the line itself highlighted, the path
//     beside the label; the note is the description. Verbs: **Complete · Open
//     in Obsidian · Delegate** — Today's verbs, in Today's order.
//
// WHAT IS NOT DRAWN, AND WHY. `history` and `depends_on` are on the `work`
// row but not on `board`'s, and no route serves one task: the History section
// waits for a read that carries them rather than inventing one (reported with
// T6-7). Delegate has no door yet, so it is dimmed with that fact (C138).
//
// STATES (components-03 §2): a card moved elsewhere while open says where and
// by whom, with **Open in <column>**; a save that fails keeps the edit and
// offers **Try Again**.

import Foundation
import Observation
import SwiftUI

// MARK: - What the popover shows

public enum CardSubject: Sendable, Equatable {
    case work(BoardCard)
    case task(TodayTask)
}

/// The note around a markdown task: the heading above it and its neighbours.
public struct NoteContext: Sendable, Equatable {
    public let heading: String?
    /// The lines around the task, in order; `taskIndex` is the task's own.
    public let lines: [String]
    public let taskIndex: Int?

    /// Finds the task's line in the note — the checkbox line whose text is the
    /// task's — and keeps up to two lines either side, inside its section.
    public static func around(_ text: String, in content: String, reach: Int = 2) -> NoteContext {
        let all = content.components(separatedBy: "\n")
        guard let at = all.firstIndex(where: { Self.isTaskLine($0) && $0.contains(text) }) else {
            return NoteContext(heading: nil, lines: [], taskIndex: nil)
        }
        let headingAt = all[..<at].lastIndex { $0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
        let sectionEnd = all[(at + 1)...].firstIndex { $0.trimmingCharacters(in: .whitespaces).hasPrefix("#") } ?? all.count
        let lower = max((headingAt.map { $0 + 1 }) ?? 0, at - reach)
        let upper = min(sectionEnd, at + reach + 1)
        var lines: [String] = []
        var taskIndex: Int?
        for i in lower..<upper {
            let line = all[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if i == at { taskIndex = lines.count }
            lines.append(line)
        }
        let heading = headingAt.map { all[$0].trimmingCharacters(in: .whitespaces).drop { $0 == "#" }.trimmingCharacters(in: .whitespaces) }
        return NoteContext(heading: heading, lines: lines, taskIndex: taskIndex)
    }

    static func isTaskLine(_ line: String) -> Bool {
        line.range(of: #"^\s*[-*+]\s\[[ xX\-]\]\s"#, options: .regularExpression) != nil
    }
}

/// Where a card is now, against where it was when the popover opened.
public enum CardWhereabouts: Sendable, Equatable {
    case here
    /// *Done, by collator* — and **Open in Done**.
    case moved(column: String, by: String?)
    /// Not on the board as it is filtered now.
    case gone
}

public enum CardWords {
    public static let description = "Description"
    public static let heldBy = "Held By"
    public static let waitingOn = "Waiting On"
    public static let thread = "Thread"
    public static let inItsFile = "In Its File"
    public static let noDescription = "No description."
    public static let edit = "Edit"
    public static let save = "Save"
    public static let cancel = "Cancel"
    public static let openRoom = "Open Room →"
    public static let comment = "Comment"
    public static let openOnBoard = "Open On Board"
    public static let complete = "Complete"
    public static let openInObsidian = "Open in Obsidian"
    public static let delegate = "Delegate"
    public static let delegateNotYet = "Delegate has no door in this build yet"
    public static let artifact = "Cut from"
    public static let noRoom = "Nothing said yet — a message here reaches whoever works on it."
    public static let notYours = "An agent's row — not yours to complete."
}

// MARK: - The model

@MainActor
@Observable
public final class CardDetailModel {
    public private(set) var subject: CardSubject
    /// The description being edited; nil when not editing.
    public var editing: String?
    public private(set) var isSaving = false
    /// A save or a tick that did not land — the console's sentence. The edit is kept.
    public private(set) var problem: String?
    /// The room's last message, when the card has a room.
    public private(set) var lastMessage: RoomMessage?
    /// The note around a markdown task.
    public private(set) var context: NoteContext?
    public private(set) var contextProblem: String?
    /// The line was ticked from here.
    public private(set) var completed = false

    @ObservationIgnored weak var session: ConsoleSession?

    public init(_ subject: CardSubject, session: ConsoleSession) {
        self.subject = subject
        self.session = session
    }

    public var workCard: BoardCard? {
        if case .work(let card) = subject { return card }
        return nil
    }

    /// Re-anchors the popover on the card as it stands now (*Open in Done*).
    public func follow(_ card: BoardCard) {
        subject = .work(card)
    }

    /// Where the card is now, given the board's latest rows. No rows — the
    /// popover opened off the board — says nothing about where it is.
    public func whereabouts(in board: [BoardCard]) -> CardWhereabouts {
        guard let card = workCard, !board.isEmpty else { return .here }
        guard let now = board.first(where: { $0.id == card.id }) else { return .gone }
        guard now.column != card.column else { return .here }
        let by: String? = switch now.column {
        case "done", "in_progress": BoardRules.holder(now) ?? BoardRules.holder(card)
        case "assigned": now.owner
        default: nil
        }
        return .moved(column: now.column, by: by)
    }

    /// What the popover reads when it opens: the room's last message, or the note.
    public func load() async {
        guard let session else { return }
        switch subject {
        case .work(let card):
            guard card.hasThread else { return }
            if case .success(let room) = await session.stores.taskRoom(card.id) {
                lastMessage = RoomReading(room).messages.last
            }
        case .task(let task):
            guard !task.path.isEmpty else { return }
            switch await session.stores.knowledgePage(path: task.path) {
            case .success(let page): context = NoteContext.around(task.text, in: page.content)
            case .failure(let error): contextProblem = BoardModel.sentence(error)
            }
        }
    }

    // MARK: The description (C85) — the owner's to rewrite

    public func beginEditing() {
        guard let card = workCard else { return }
        problem = nil
        editing = card.description ?? ""
    }

    public func cancelEditing() {
        editing = nil
        problem = nil
    }

    /// `PATCH /api/tasks/:id {description}` — a board-arm field, so no claim is
    /// needed and a card a crew holds can still be described. On failure the
    /// edit stays on screen with the console's reason and Try Again.
    @discardableResult
    public func save() async -> Bool {
        guard let session, let card = workCard, let text = editing, !isSaving else { return false }
        isSaving = true
        problem = nil
        let answer = await session.stores.updateTask(card.id, .describing(text))
        isSaving = false
        switch answer {
        case .success:
            editing = nil
            return true
        case .failure(let error):
            problem = BoardModel.sentence(error)
            return false
        }
    }

    // MARK: A markdown task's verbs

    /// Complete — the Tick door, with the line as it was shown. A line that
    /// changed under the owner is `409 stale` and nothing is written.
    public func complete() async {
        guard let session, case .task(let task) = subject, !completed else { return }
        problem = nil
        let answer = await session.stores.check(task.key, checked: true, seenText: task.text, idempotencyKey: "tick-\(UUID().uuidString)")
        switch answer {
        case .success: completed = true
        case .failure(let error): problem = BoardModel.sentence(error)
        }
    }
}

// MARK: - The view

public struct CardDetailView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: CardDetailModel
    let assistantName: String?
    /// The board's rows as they stand, to say a card moved elsewhere. Empty off the board.
    let board: [BoardCard]
    let now: Date
    let clock: ClockTime
    let onOpenRoom: ((Int) -> Void)?
    let onOpenOnBoard: ((Int) -> Void)?
    let onOpenPath: ((String) -> Void)?

    public init(
        model: CardDetailModel, assistantName: String?, board: [BoardCard] = [], now: Date = Date(), clock: ClockTime = ClockTime(),
        onOpenRoom: ((Int) -> Void)? = nil, onOpenOnBoard: ((Int) -> Void)? = nil, onOpenPath: ((String) -> Void)? = nil
    ) {
        self.model = model
        self.assistantName = assistantName
        self.board = board
        self.now = now
        self.clock = clock
        self.onOpenRoom = onOpenRoom
        self.onOpenOnBoard = onOpenOnBoard
        self.onOpenPath = onOpenPath
    }

    static let ground: MetistryColorRole = .elevated

    public var body: some View {
        let p = Palette(scheme)
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                switch model.subject {
                case .work(let card): work(card, p)
                case .task(let task): markdown(task, p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: 440, alignment: .leading)
        }
        .frame(minWidth: 0, idealWidth: 440, maxWidth: 480, minHeight: 0, idealHeight: 520)
        .background(p[Self.ground])
        .accessibilityElement(children: .contain)
        .task { await model.load() }
    }

    // MARK: A work row

    @ViewBuilder
    private func work(_ card: BoardCard, _ p: Palette) -> some View {
        let whereabouts = model.whereabouts(in: board)
        if whereabouts != .here { movedBand(whereabouts, p) }
        titleRow(glyph: "square.grid.3x2", ink: .agent, title: card.title, spokenKind: "work row")
        FacetRow(Self.facets(card, now: now), today: Self.today(now), on: Self.ground)

        section(CardWords.description) {
            if let draft = model.editing {
                TextEditor(text: Binding(get: { draft }, set: { model.editing = $0 }))
                    .metistryFont(.body)
                    .frame(minHeight: 72)
                    .scrollContentBackground(.hidden)
                    .padding(MetistrySpace.s1)
                    .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(p[.borderControl], lineWidth: 1))
                    .accessibilityLabel(Text(verbatim: CardWords.description))
                if let problem = model.problem {
                    MarkView(Mark("Not saved — \(problem). Your edit is still here.", glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: Self.ground))
                }
                HStack(spacing: MetistrySpace.s2) {
                    ControlButton(ControlSpec(model.problem == nil ? CardWords.save : StateWords.tryAgain, role: .primary, disabledBecause: model.isSaving ? "" : nil)) {
                        Task { await model.save() }
                    }
                    ControlButton(ControlSpec(CardWords.cancel, role: .secondary)) { model.cancelEditing() }
                }
            } else {
                if let text = card.description, !text.isEmpty {
                    Text(verbatim: text)
                        .metistryFont(.body)
                        .foregroundStyle(p[.textPrimary])
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    MarkView(Mark(CardWords.noDescription, style: .body, ink: .textSecondary, on: Self.ground))
                }
                ControlButton(ControlSpec(CardWords.edit, glyph: .edit, role: .plain, name: "Edit the description")) { model.beginEditing() }
            }
        }

        section(CardWords.heldBy) {
            MarkView(Mark(Self.heldBy(card, now: now, assistantName: assistantName), style: .body, ink: .textPrimary, on: Self.ground))
        }

        if card.blockedBy != nil {
            section(CardWords.waitingOn) {
                MarkView(Mark(BoardCardFacets.blockedReason(card).text, style: .body, ink: .textPrimary, on: Self.ground))
            }
        }

        section(CardWords.thread) {
            if card.hasThread {
                MarkView(Mark("\(card.threadCount) \(card.threadCount == 1 ? "message" : "messages")", style: .subhead, ink: .textSecondary, on: Self.ground))
                if let last = model.lastMessage {
                    MarkView(Mark("\(BoardCardFacets.name(last.author, assistantName: assistantName)): \(last.body)", style: .body, design: last.isAgent ? .serif : .sans, ink: .textPrimary, on: Self.ground))
                        .lineLimit(3)
                }
            } else {
                MarkView(Mark(CardWords.noRoom, style: .subhead, ink: .textSecondary, on: Self.ground))
            }
            if let onOpenRoom {
                ControlButton(ControlSpec(CardWords.openRoom, role: .secondary)) { onOpenRoom(card.id) }
            }
        }

        HStack(spacing: MetistrySpace.s2) {
            if let onOpenRoom {
                ControlButton(ControlSpec(CardWords.comment, role: .secondary)) { onOpenRoom(card.id) }
            }
            if let onOpenOnBoard {
                ControlButton(ControlSpec(CardWords.openOnBoard, role: .secondary)) { onOpenOnBoard(card.id) }
            }
        }

        if let artifact = card.artifact {
            Divider()
            HStack(spacing: MetistrySpace.s2) {
                MarkView(Mark(CardWords.artifact, style: .caption1, ink: .textSecondary, on: Self.ground))
                MarkView(Mark(artifact, style: .caption1, design: .mono, ink: .textPrimary, on: Self.ground, spoken: "the review artifact \(artifact)"))
            }
        }
    }

    private func movedBand(_ whereabouts: CardWhereabouts, _ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            switch whereabouts {
            case .moved(let column, let by):
                let text = "Moved elsewhere: \(Board.label(for: column))" + (by.map { ", by \(BoardCardFacets.name($0, assistantName: assistantName))" } ?? "")
                MarkView(Mark(text, style: .subhead, ink: .textPrimary, on: .accentQuiet))
                Spacer(minLength: 0)
                if let current = board.first(where: { $0.id == model.workCard?.id }) {
                    ControlButton(ControlSpec("Open in \(Board.label(for: column))", role: .plain)) { model.follow(current) }
                }
            case .gone:
                MarkView(Mark("No longer on the board as it is filtered now.", style: .subhead, ink: .textPrimary, on: .accentQuiet))
                Spacer(minLength: 0)
            case .here:
                EmptyView()
            }
        }
        .padding(MetistrySpace.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.accentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    // MARK: A markdown task

    @ViewBuilder
    private func markdown(_ task: TodayTask, _ p: Palette) -> some View {
        titleRow(glyph: model.completed || task.checked ? MetistryGlyph.checkboxOn.rawValue : MetistryGlyph.checkbox.rawValue, ink: .textSecondary, title: task.text, spokenKind: model.completed || task.checked ? "your task, done" : "your task")
        FacetRow(TaskFacets(vaultTask: task.row), today: Self.today(now), on: Self.ground)

        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Text(verbatim: CardWords.inItsFile)
                    .metistryFont(.subhead, weight: .semibold)
                    .foregroundStyle(p[.textSecondary])
                    .accessibilityAddTraits(.isHeader)
                MarkView(Mark(task.path, style: .caption1, design: .mono, ink: .textSecondary, on: Self.ground))
            }
            if let context = model.context, context.taskIndex != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let heading = context.heading {
                        MarkView(Mark(heading, style: .subhead, weight: .semibold, ink: .textPrimary, on: .surface))
                    }
                    ForEach(Array(context.lines.enumerated()), id: \.offset) { item in
                        let isTask = item.offset == context.taskIndex
                        MarkView(Mark(item.element, style: .callout, design: .mono, ink: .textPrimary, plate: isTask ? .accentQuiet : nil, on: .surface, shape: .band, spoken: isTask ? "this task: \(item.element)" : nil))
                    }
                }
                .padding(MetistrySpace.s2)
                .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
            } else if let why = model.contextProblem {
                MarkView(Mark("Couldn't read the note — \(why)", glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: Self.ground))
            } else if model.context != nil {
                MarkView(Mark("The line is no longer in this note.", style: .subhead, ink: .textSecondary, on: Self.ground))
            }
        }

        if let problem = model.problem {
            MarkView(Mark(problem, glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: Self.ground))
        }
        HStack(spacing: MetistrySpace.s2) {
            ControlButton(ControlSpec(CardWords.complete, glyph: .approve, role: .primary, shortcut: ShellCommand.complete.shortcut?.spoken, disabledBecause: model.completed || task.checked ? "" : nil)) {
                Task { await model.complete() }
            }
            ControlButton(ControlSpec(CardWords.openInObsidian, role: .secondary, shortcut: ShellCommand.openInObsidian.shortcut?.spoken, disabledBecause: onOpenPath == nil ? "No vault folder on this Mac" : nil)) {
                onOpenPath?(task.path)
            }
            ControlButton(ControlSpec(CardWords.delegate, glyph: .spark, role: .secondary, shortcut: ShellCommand.handToAgent.shortcut?.spoken, disabledBecause: CardWords.delegateNotYet)) {}
        }
        MarkView(Mark(CardWords.delegateNotYet, glyph: .lock, style: .footnote, ink: .textSecondary, on: Self.ground))
    }

    // MARK: Pieces

    private func titleRow(glyph: String, ink: MetistryColorRole, title: String, spokenKind: String) -> some View {
        let p = Palette(scheme)
        return HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Image(systemName: glyph)
                .foregroundStyle(p[ink])
                .accessibilityHidden(true)
            Text(verbatim: title)
                .metistryFont(.title3, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(title), \(spokenKind)"))
        .accessibilityAddTraits(.isHeader)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        let p = Palette(scheme)
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(verbatim: title)
                .metistryFont(.subhead, weight: .semibold)
                .foregroundStyle(p[.textSecondary])
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Words

    /// *Held by build-crew · 4m left · In Progress* — or who it is for.
    static func heldBy(_ card: BoardCard, now: Date, assistantName: String?) -> String {
        var parts: [String] = []
        if let holder = BoardRules.holder(card) {
            parts.append(holder == BoardRules.owner ? "You hold it" : "Held by \(BoardCardFacets.name(holder, assistantName: assistantName))")
            if let lease = BoardCardFacets.lease(card, now: now) { parts.append(lease.text) }
        } else if let owner = card.owner {
            parts.append("Nobody holds it — it is for \(BoardCardFacets.name(owner, assistantName: assistantName))")
        } else {
            parts.append("Nobody holds it")
        }
        parts.append(Board.label(for: card.column))
        return parts.joined(separator: " · ")
    }

    /// The six facets for a work row, from what `board` serves: its due date,
    /// who it is for, its project and number, and its state.
    static func facets(_ card: BoardCard, now: Date) -> TaskFacets {
        var links: [FacetLink] = []
        if let project = card.project { links.append(.project(project)) }
        links.append(.work(card.id))
        if let ref = card.externalRef, !ref.hasPrefix("vault:") { links.append(.external(ref)) }
        var states: [FacetState] = []
        if card.escalated, BoardRules.escalationLabel(card, now: now) == "Overdue" { states.append(.overdue) }
        if card.status == "blocked" { states.append(.blocked) }
        return TaskFacets(due: TaskDay(card.due), people: card.owner.map { [$0 == BoardRules.owner ? "you" : $0] } ?? [], links: links, states: states)
    }

    static func today(_ now: Date) -> TaskDay {
        let d = Calendar(identifier: .gregorian).dateComponents(in: .current, from: now)
        return TaskDay(String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1))!
    }
}
