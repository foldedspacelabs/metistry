// Work ▸ Board (design-build-plan T6-7; screen-06-board.md, corrected
// 2026-09-23; docs/ops/board.md). The model — the rules, the columns, the
// moves — is board-model.swift; this file draws it.
//
// FIVE COLUMNS, FOUR OF THEM THE BOARD. Backlog, Assigned, In Progress and
// Blocked share the width; Done is fixed at 168 pt with compact rows and
// collapses to a strip at a narrow window. Each column shows the facet that
// column is about (screen 6 §2), and everything else on a card is a mark: the
// speech bubble and its count when the card has a room, the note glyph in
// `entity-note` when it was promoted from the vault. Nothing is red: a lapsed
// lease, an overdue card and a blocked row are `degraded` — attention, not
// failure (C36).
//
// DRAGS. A card that can move is draggable; a closed one is not. A column
// draws a drop target only where `BoardRules` says the service would accept
// the move — the drop delegate refuses the rest, so no target is drawn and no
// drop lands there. Each drop is one route. A refused move puts the card back
// and the server's own sentence is shown under the board, with Try Again
// (components-03 §2).
//
// KEYBOARD — components-02 §1, the one map. ← → between columns, ↑ ↓ within
// one, **Item ▸ Move… (M)** opens Move… for the focused card — the same
// targets and the same refusals, a refused one listed dimmed with its reason
// — and **Item ▸ Open (↩)** opens the card. Esc closes a picker. No key here
// is bound outside the menu table (C119): the arrows are the focused list's.
//
// ACCESSIBILITY (§2.18). A card is one element that says its title, its
// column, its facet, anything exceptional, its room and its note mark; a
// column's header says its count and how many want you; the move list reads
// each refusal with its row. Nothing slides (§2.18.4). Text is semantic
// styles only, so the largest size grows cards longer, never wider.

import Foundation
import SwiftUI
import UniformTypeIdentifiers

public enum BoardWords {
    public static let title = "Board"
    public static let allProjects = "All Projects"
    public static let hasThread = "Has Thread"
    public static let project = "Project"
    public static let emptyTitle = "Nothing on the Board"
    public static let emptySentence = "No task or review is on the board yet."
    public static let captureTask = "Capture a Task"
    public static let failedTitle = "Couldn't Read the Board"
    public static let failedSentence = "The console answered, and the answer was an error."
    public static let moveTitle = "Move to…"
    public static let assignTitle = "Assign to…"
    public static let me = "Me"
    public static let dismiss = "Dismiss"
    public static let noneWithThread = "No card here has a room."
}

public struct BoardView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: BoardModel
    let assistantName: String?
    let tick: Duration
    let onCapture: (() -> Void)?
    @FocusState private var focus: Int?
    @State private var doneExpanded = false

    public init(model: BoardModel, assistantName: String?, tick: Duration = .seconds(2), onCapture: (() -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.tick = tick
        self.onCapture = onCapture
    }

    /// Below this width Done folds to a strip.
    static let narrow: CGFloat = 760
    static let doneWidth: CGFloat = 168
    static let stripWidth: CGFloat = 44
    static let ground: MetistryColorRole = .bg
    static let columnGround: MetistryColorRole = .sunken
    static let cardGround: MetistryColorRole = .surface

    public var body: some View {
        let p = Palette(scheme)
        ZStack {
            VStack(alignment: .leading, spacing: 0) {
                BoardHeader(model: model)
                    .padding(.horizontal, MetistrySpace.s4)
                    .padding(.top, MetistrySpace.s3)
                    .padding(.bottom, MetistrySpace.s2)
                content(p)
                if let refusal = model.refusal { refusalBand(refusal, p) }
            }
            .accessibilityHidden(model.room != nil)
            if let room = model.room {
                RoomPane(model: room, assistantName: assistantName, clock: model.clock) { model.closeRoom() }
            }
        }
        // Flexible down to nothing: the columns scroll, and the window's
        // minimum is the shell's to set (#392).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[Self.ground])
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        switch model.panel {
        case .placeholders(let waiting):
            PlaceholderRows(count: 6, waitingFor: waiting)
                .padding(MetistrySpace.s4)
            Spacer(minLength: 0)
        case .failed(let why):
            StatePanel(StatePanelModel(.failed, title: BoardWords.failedTitle, sentence: BoardWords.failedSentence, reason: why, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                Task { await model.load() }
            }
            Spacer(minLength: 0)
        case .empty:
            StatePanel(StatePanelModel(.empty, title: BoardWords.emptyTitle, sentence: BoardWords.emptySentence, action: onCapture == nil ? nil : BoardWords.captureTask), now: model.now(), clock: model.clock) {
                onCapture?()
            }
            Spacer(minLength: 0)
        case .board(let staleSince):
            if let staleSince {
                StaleBand(StaleBandModel("Showing the board", asOf: staleSince, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                    Task { await model.load() }
                }
            }
            columns(p)
        }
    }

    // MARK: The columns

    private func columns(_ p: Palette) -> some View {
        GeometryReader { geo in
            let narrow = geo.size.width < Self.narrow
            let columns = model.columns
            HStack(alignment: .top, spacing: MetistrySpace.s2) {
                ForEach(columns) { column in
                    if column.key == "done" {
                        if narrow && !doneExpanded {
                            doneStrip(column, p)
                        } else {
                            columnView(column, compact: true, p)
                                .frame(width: Self.doneWidth)
                        }
                    } else {
                        columnView(column, compact: false, p)
                            .frame(minWidth: 0, maxWidth: .infinity)
                    }
                }
            }
            .padding(.horizontal, MetistrySpace.s3)
            .padding(.bottom, MetistrySpace.s3)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
        .frame(minWidth: 0, minHeight: 0)
        .onChange(of: focus) { _, id in if let id { model.selection = id } }
        .onKeyPress(.leftArrow) { step(columns: -1) }
        .onKeyPress(.rightArrow) { step(columns: 1) }
        .onKeyPress(.upArrow) { step(rows: -1) }
        .onKeyPress(.downArrow) { step(rows: 1) }
        .shellListFocus()
        .shellItemActions(itemActions)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: BoardWords.title))
    }

    private func columnView(_ column: BoardColumnView, compact: Bool, _ p: Palette) -> some View {
        let dragged = model.card(model.dragging)
        let isTarget = dragged.map { model.dropTargets(for: $0).contains(column.key) } ?? false
        return VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            BoardColumnHeader(column: column)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    if column.cards.isEmpty, model.hasThreadOnly {
                        MarkView(Mark(BoardWords.noneWithThread, style: .footnote, ink: .textSecondary, on: Self.columnGround))
                    }
                    ForEach(column.cards) { card in
                        cardView(card, compact: compact)
                    }
                }
                .padding(.bottom, MetistrySpace.s2)
            }
        }
        .padding(MetistrySpace.s2)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(p[Self.columnGround], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        // The target is drawn only where the service would accept the drop.
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(isTarget ? p[.accent] : .clear, lineWidth: 2))
        .onDrop(of: [UTType.text], delegate: ColumnDrop(column: column.key, model: model))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: column.spoken))
    }

    private func doneStrip(_ column: BoardColumnView, _ p: Palette) -> some View {
        Button {
            doneExpanded = true
        } label: {
            VStack(spacing: MetistrySpace.s2) {
                Text(verbatim: column.label)
                    .metistryFont(.subhead, weight: .semibold)
                    .foregroundStyle(p[.textSecondary])
                    .fixedSize()
                    .rotationEffect(.degrees(-90))
                    .frame(width: Self.stripWidth - MetistrySpace.s2, height: 72)
                Text(verbatim: column.countText)
                    .metistryFont(.caption1)
                    .monospacedDigit()
                    .foregroundStyle(p[.textSecondary])
                Spacer(minLength: 0)
            }
            .padding(.vertical, MetistrySpace.s2)
            .frame(width: Self.stripWidth)
            .frame(maxHeight: .infinity)
            .background(p[Self.columnGround], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        }
        .buttonStyle(.plain)
        .onDrop(of: [UTType.text], delegate: ColumnDrop(column: column.key, model: model))
        .accessibilityLabel(Text(verbatim: "\(column.spoken), folded"))
        .accessibilityHint(Text(verbatim: "Activates to show the column"))
    }

    // MARK: A card

    private func cardView(_ card: BoardCard, compact: Bool) -> some View {
        let movable = model.allowsMoves && BoardRules.isMovable(card) && model.inFlight[card.id] == nil
        return BoardCardView(card: card, compact: compact, selected: model.selection == card.id, now: model.now(), assistantName: assistantName)
            .focusable()
            .focused($focus, equals: card.id)
            .onTapGesture { model.open(card) }
            .accessibilityAction { model.open(card) }
            .accessibilityAction(named: Text(verbatim: ShellCommand.move.title(assistantName: nil).replacingOccurrences(of: "…", with: ""))) { model.showMoves(card) }
            .modifier(Draggable(enabled: movable) {
                model.dragging = card.id
                return NSItemProvider(object: String(card.id) as NSString)
            })
            .popover(isPresented: binding(for: card.id, \.openCard, close: { model.closeDetail() }), arrowEdge: .trailing) {
                if let detail = model.detail {
                    CardDetailView(
                        model: detail, assistantName: assistantName, board: model.section.value?.rows ?? [], now: model.now(), clock: model.clock,
                        onOpenRoom: { model.openRoom($0) }
                    )
                }
            }
            .popover(isPresented: binding(for: card.id, \.movingCard, close: { model.movingCard = nil }), arrowEdge: .trailing) {
                MoveList(moves: model.moves(for: card)) { move in
                    model.movingCard = nil
                    Task { await model.drop(card, on: move.column) }
                }
            }
            .popover(isPresented: binding(for: card.id, \.assigningCard, close: { model.assigningCard = nil }), arrowEdge: .trailing) {
                AssignList(names: model.assignees, current: card.owner, assistantName: assistantName) { who in
                    Task { await model.assign(card, to: who) }
                }
            }
    }

    private func binding(for id: Int, _ key: ReferenceWritableKeyPath<BoardModel, Int?>, close: @escaping () -> Void) -> Binding<Bool> {
        Binding(get: { model[keyPath: key] == id }, set: { if !$0 { close() } })
    }

    // MARK: Under the board

    private func refusalBand(_ refusal: BoardRefusal, _ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            MarkView(Mark(refusal.sentence, glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: .failedQuiet, spoken: "failed. \(refusal.sentence)"))
            Spacer(minLength: 0)
            if refusal.canRetry {
                ControlButton(ControlSpec(StateWords.tryAgain, role: .plain)) { Task { await model.retry() } }
            }
            ControlButton(ControlSpec(BoardWords.dismiss, role: .plain)) { model.dismissRefusal() }
        }
        .padding(.horizontal, MetistrySpace.s4)
        .padding(.vertical, MetistrySpace.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.failedQuiet])
        .accessibilityElement(children: .contain)
    }

    // MARK: Keys

    /// Item ▸ Open (↩) and Item ▸ Move… (M), for the focused card.
    private var itemActions: ShellActionTable {
        guard let card = model.card(model.selection) else { return [:] }
        return [.open: { model.open(card) }, .move: { model.showMoves(card) }]
    }

    private func step(columns delta: Int) -> KeyPress.Result {
        let cols = model.columns.filter { !$0.cards.isEmpty }
        guard !cols.isEmpty else { return .ignored }
        let current = model.card(model.selection).map { model.drawnColumn($0) }
        let at = current.flatMap { key in cols.firstIndex { $0.key == key } }
        let row = model.card(model.selection).flatMap { card in at.flatMap { cols[$0].cards.firstIndex { $0.id == card.id } } } ?? 0
        let next = at.map { min(max($0 + delta, 0), cols.count - 1) } ?? 0
        let target = cols[next].cards[min(row, cols[next].cards.count - 1)]
        model.selection = target.id
        focus = target.id
        return .handled
    }

    private func step(rows delta: Int) -> KeyPress.Result {
        guard let card = model.card(model.selection), let column = model.columns.first(where: { $0.key == model.drawnColumn(card) }),
              let at = column.cards.firstIndex(where: { $0.id == card.id }) else { return .ignored }
        let next = min(max(at + delta, 0), column.cards.count - 1)
        guard next != at else { return .handled }
        model.selection = column.cards[next].id
        focus = column.cards[next].id
        return .handled
    }
}

// MARK: - The header

struct BoardHeader: View {
    @Environment(\.colorScheme) private var scheme
    let model: BoardModel

    var body: some View {
        let p = Palette(scheme)
        FlowLayout(spacing: MetistrySpace.s3, lineSpacing: MetistrySpace.s2) {
            Text(verbatim: BoardWords.title)
                .metistryFont(.title2, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            Picker(selection: Binding(get: { model.project ?? "" }, set: { choice in Task { await model.choose(project: choice.isEmpty ? nil : choice) } })) {
                Text(verbatim: BoardWords.allProjects).tag("")
                ForEach(model.projects, id: \.self) { Text(verbatim: $0).tag($0) }
            } label: {
                Text(verbatim: BoardWords.project)
            }
            .labelsHidden()
            .fixedSize()
            .accessibilityLabel(Text(verbatim: BoardWords.project))
            ControlButton(ControlSpec(BoardWords.hasThread, role: .secondary, selected: model.hasThreadOnly)) {
                model.setHasThreadOnly(!model.hasThreadOnly)
            }
        }
    }
}

struct BoardColumnHeader: View {
    @Environment(\.colorScheme) private var scheme
    let column: BoardColumnView

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: column.label)
                .metistryFont(.subhead, weight: .semibold)
                .foregroundStyle(p[.textPrimary])
            Text(verbatim: column.countText)
                .metistryFont(.caption1)
                .monospacedDigit()
                .foregroundStyle(p[.textSecondary])
            if column.escalations > 0 {
                // `degraded`, never red: attention, not failure (C36).
                MarkView(Mark("\(column.escalations)", glyph: .degraded, style: .caption1, ink: .degraded, on: BoardView.columnGround))
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: column.spoken))
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - A card

struct BoardCardView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isFocused) private var focused
    let card: BoardCard
    let compact: Bool
    let selected: Bool
    let now: Date
    let assistantName: String?

    static func marks(_ facets: BoardCardFacets, on ground: MetistryColorRole) -> [Mark] {
        [facets.facet, facets.exception].compactMap { $0 }.map { chip in
            switch chip.tone {
            case .quiet: return Mark(chip.text, style: .caption1, ink: .textSecondary, on: ground, spoken: chip.spoken)
            case .agent: return Mark(chip.text, style: .caption1, design: .mono, ink: .agent, plate: .agentQuiet, on: ground, shape: .chip, spoken: chip.spoken)
            case .degraded: return Mark(chip.text, style: .caption1, ink: .textPrimary, plate: .degradedQuiet, on: ground, shape: .chip, spoken: chip.spoken)
            case .report: return Mark(chip.text, style: .caption1, ink: .textPrimary, plate: .entityNoteQuiet, on: ground, shape: .chip, spoken: chip.spoken)
            }
        }
    }

    var body: some View {
        let p = Palette(scheme)
        let ground = BoardView.cardGround
        let facets = BoardCardFacets(card, now: now, assistantName: assistantName)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s1) {
                Image(systemName: card.kind == "review" ? MetistryGlyph.edit.rawValue : "square.grid.3x2")
                    .foregroundStyle(p[.agent])
                    .accessibilityHidden(true)
                Text(verbatim: card.title)
                    .metistryFont(compact ? .footnote : .subhead, weight: .medium)
                    .foregroundStyle(p[.textPrimary])
                    .lineLimit(compact ? 2 : 4)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if facets.fromNote {
                    Image(systemName: "doc.text")
                        .foregroundStyle(p[.entityNote])
                        .accessibilityHidden(true)
                }
                if let n = facets.threadCount {
                    HStack(spacing: 2) {
                        Image(systemName: "bubble.left").accessibilityHidden(true)
                        Text(verbatim: "\(n)").monospacedDigit()
                    }
                    .metistryFont(.caption1)
                    .foregroundStyle(p[.textSecondary])
                }
            }
            FlowLayout(spacing: MetistrySpace.s1, lineSpacing: MetistrySpace.s1) {
                ForEach(Array(Self.marks(facets, on: ground).enumerated()), id: \.offset) { MarkView($0.element) }
            }
        }
        .padding(compact ? MetistrySpace.s2 : MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[ground], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(selected ? p[.accent] : p[.border], lineWidth: selected ? 2 : 1))
        // Full Keyboard Access: the accent ring on every custom control (§2.18.6).
        .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).inset(by: -3).strokeBorder(focused ? p[.focusRing] : .clear, lineWidth: 2))
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: BoardCardFacets.spoken(card, now: now, assistantName: assistantName)))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// Picked up only where it can move: a closed card gets no grab at all.
private struct Draggable: ViewModifier {
    let enabled: Bool
    let provider: () -> NSItemProvider

    func body(content: Content) -> some View {
        if enabled {
            content.onDrag(provider)
        } else {
            content
        }
    }
}

/// A column's drop: validated against the rules, so a column the service
/// would refuse is never a target and a drop there never lands.
struct ColumnDrop: DropDelegate {
    let column: String
    let model: BoardModel

    @MainActor
    private var card: BoardCard? { model.card(model.dragging) }

    func validateDrop(info: DropInfo) -> Bool {
        MainActor.assumeIsolated {
            guard let card else { return false }
            return model.dropTargets(for: card).contains(column)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        MainActor.assumeIsolated {
            guard let card, model.dropTargets(for: card).contains(column) else { return DropProposal(operation: .forbidden) }
            return DropProposal(operation: .move)
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        MainActor.assumeIsolated {
            guard let card, model.dropTargets(for: card).contains(column) else { return false }
            model.dragging = nil
            Task { await model.drop(card, on: column) }
            return true
        }
    }
}

// MARK: - Move… and Assign to…

/// Every other column, one row each: a move the service accepts is a button
/// saying what it does; one it refuses is the same row, dimmed, with the
/// reason in its own words — read aloud with the row.
public struct MoveList: View {
    @Environment(\.colorScheme) private var scheme
    let moves: [BoardMove]
    let onMove: (BoardMove) -> Void

    public init(moves: [BoardMove], onMove: @escaping (BoardMove) -> Void) {
        self.moves = moves
        self.onMove = onMove
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: BoardWords.moveTitle)
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, MetistrySpace.s1)
            ForEach(moves) { move in
                Button {
                    onMove(move)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: move.label)
                            .metistryFont(.body, weight: .medium)
                            .foregroundStyle(p[move.isOffered ? .textPrimary : .textTertiary])
                        Text(verbatim: move.what ?? move.why ?? "")
                            .metistryFont(.footnote)
                            .foregroundStyle(p[.textSecondary])
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, MetistrySpace.s1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!move.isOffered)
                .accessibilityLabel(Text(verbatim: move.spoken))
            }
        }
        .padding(MetistrySpace.s4)
        .frame(width: 320, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// The assign step: the owner, then every agent that is not revoked.
public struct AssignList: View {
    @Environment(\.colorScheme) private var scheme
    let names: [String]
    let current: String?
    let assistantName: String?
    let onPick: (String) -> Void

    public init(names: [String], current: String?, assistantName: String?, onPick: @escaping (String) -> Void) {
        self.names = names
        self.current = current
        self.assistantName = assistantName
        self.onPick = onPick
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(verbatim: BoardWords.assignTitle)
                .metistryFont(.headline)
                .foregroundStyle(p[.textPrimary])
                .accessibilityAddTraits(.isHeader)
            ForEach(names.isEmpty ? [BoardRules.owner] : names, id: \.self) { name in
                let label = name == BoardRules.owner ? BoardWords.me : name
                Button {
                    onPick(name)
                } label: {
                    HStack {
                        Text(verbatim: label)
                            .metistryFont(.body, design: name == BoardRules.owner ? .sans : .mono)
                            .foregroundStyle(p[.textPrimary])
                        Spacer(minLength: 0)
                        if name == current {
                            Text(verbatim: "assigned now").metistryFont(.footnote).foregroundStyle(p[.textSecondary])
                        }
                    }
                    .padding(.vertical, MetistrySpace.s1)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: name == current ? "\(label), assigned now" : label))
            }
        }
        .padding(MetistrySpace.s4)
        .frame(width: 260, alignment: .leading)
    }
}
