// Knowledge (design-build-plan T6-4; screen-10-knowledge.md).
//
// THE ORDER IS THE OWNER'S INTENTS (§1): the fold, in prose, at the top; Needs
// your eye; Areas, each with its written line; one sources line, folded until
// something is wrong. Each section ends on the one architectural rule it
// depends on, in situ. Behind them: an area's pages, search (Go ▸ Filter, ⌘F),
// and a page with its outgoing and incoming links (§7). The model is
// knowledge-model.swift.
//
// P1 ON THE FOLD. Every control in the card is the reader's — Open the Fold,
// Earlier Folds. The prose offers nothing to press but a page name: a path is
// a reference, not an action, and following one changes nothing (§2).
//
// NEEDS YOUR EYE IS NOT A SECOND QUEUE (§3). Its count sits in the section's
// header, never in a badge — the one badge is Needs You's, and these are the
// same requests. A draft or a suggestion opens the Needs You card itself
// (Approve · Revise · Decline, amendments §8.1); a conflict opens the conflict
// view, whose Keep Mine and Take the Other are held ten seconds with Undo and
// only then sent (C136).
//
// ACCESSIBILITY (§2.18). Every row is one spoken element — *Draft,
// Areas/Health/Sleep.md, the taper. Review* — and every control says its name.
// Each section is a heading. Nothing moves, so Reduce Motion has nothing to
// stop. No key is bound here: Filter and the Item menu's verbs are the menu
// table's (C119). Text is semantic styles only, so the largest text grows a
// row longer, never wider.

import Foundation
import Observation
import SwiftUI

// MARK: - The view

public struct KnowledgeView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let assistantName: String?
    let tickInterval: Duration
    /// Opens a vault path where the owner reads the vault. Nil: dimmed, with why.
    let onOpenInObsidian: ((String) -> Void)?
    /// The vault is not there: choose the instance's folder.
    let onChooseFolder: (() -> Void)?
    @FocusState private var searchFocused: Bool

    public init(model: KnowledgeModel, assistantName: String?, tick: Duration = .seconds(15), onOpenInObsidian: ((String) -> Void)? = nil, onChooseFolder: (() -> Void)? = nil) {
        self.model = model
        self.assistantName = assistantName
        self.tickInterval = tick
        self.onOpenInObsidian = onOpenInObsidian
        self.onChooseFolder = onChooseFolder
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            KnowledgeHeader(model: model, searchFocused: $searchFocused)
                .padding(.horizontal, MetistrySpace.s5)
                .padding(.vertical, MetistrySpace.s3)
                .background(p[.surface])
            Divider()
            content(p)
        }
        // Flexible down to nothing, as Activity and Today are: the page
        // scrolls, and the window's minimum is the shell's to set (#392).
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        // Go ▸ Filter (⌘F) is the search box. A menu item, never a bare key (C119).
        .shellScreenActions([.filter: { model.askForTheBox() }])
        .shellItemActions(itemActions)
        .onChange(of: model.wantsSearchFocus) { _, wants in
            if wants {
                searchFocused = true
                model.wantsSearchFocus = false
            }
        }
        // A page name in the fold or a page opens here, in place (§2).
        .environment(\.openURL, OpenURLAction { url in
            guard let path = FoldText.path(from: url) else { return .systemAction }
            Task { await model.open(path: path) }
            return .handled
        })
        .task {
            await model.refreshIfDue()
            while !Task.isCancelled {
                try? await Task.sleep(for: tickInterval)
                if Task.isCancelled { break }
                await model.refreshIfDue()
            }
        }
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        switch model.place {
        case .home:
            switch model.panel {
            case .placeholders:
                VStack(alignment: .leading) {
                    PlaceholderRows(count: 5, waitingFor: "Reading your vault")
                    Spacer(minLength: 0)
                }
                .padding(MetistrySpace.s4)
            case .failed(let state):
                VStack {
                    StatePanel(state, now: model.now(), clock: model.clock) {
                        if state.action == KnowledgeWords.chooseFolder, let onChooseFolder {
                            onChooseFolder()
                        } else {
                            Task { await model.load() }
                        }
                    }
                    Spacer(minLength: 0)
                }
            case .page:
                KnowledgeScroll {
                    KnowledgeHome(model: model, assistantName: assistantName, onOpenInObsidian: onOpenInObsidian)
                }
            }
        case .area(let area):
            KnowledgeScroll { KnowledgeAreaPages(model: model, area: area) }
        case .search(let q):
            KnowledgeScroll { KnowledgeSearchResults(model: model, query: q) }
        case .page(let path):
            KnowledgeScroll { KnowledgePageDetail(model: model, path: path, onOpenInObsidian: onOpenInObsidian) }
        case .item(let id):
            KnowledgeScroll { KnowledgeItemDetail(model: model, id: id, assistantName: assistantName, onOpenInObsidian: onOpenInObsidian) }
        }
    }

    /// The Item menu for what is on screen: Open in Obsidian (⌘O) for a page,
    /// and for a request its own verbs — the same card, so the menu and the
    /// button never disagree.
    private var itemActions: ShellActionTable {
        var table: ShellActionTable = [:]
        let open: (String) -> Void = { path in onOpenInObsidian?(path) }
        switch model.place {
        case .page(let path):
            if onOpenInObsidian != nil { table[.openInObsidian] = { open(path) } }
        case .item(let id):
            guard let item = model.eye.first(where: { $0.id == id }) else { break }
            if onOpenInObsidian != nil, !item.path.isEmpty { table[.openInObsidian] = { open(item.path) } }
            guard let row = item.request else { break }
            if item.kind == .conflict {
                guard let r = model.conflicts[row.id], model.allowsDecisions, KnowledgeConflictView.canChoose(r.phase) else { break }
                table[.approve] = { r.choose(.mine) }
                table[.revise] = { r.choose(.theirs) }
            } else if let name = assistantName, let cards = model.cards(assistantName: name) {
                table.merge(cards.card(for: row).itemActions(allowsDecisions: model.allowsDecisions)) { a, _ in a }
            }
        default:
            break
        }
        return table
    }
}

/// The header: where the owner is, the way back, and the box.
struct KnowledgeHeader: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    var searchFocused: FocusState<Bool>.Binding

    var body: some View {
        let p = Palette(scheme)
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                title(p)
                Spacer(minLength: MetistrySpace.s2)
                field.frame(minWidth: 160, idealWidth: 240, maxWidth: 280)
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                title(p)
                field
            }
        }
    }

    @ViewBuilder
    private func title(_ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            if model.canGoBack {
                ControlButton(ControlSpec(KnowledgeWords.back, glyph: .disclosure, role: .plain, name: KnowledgeWords.back)) {
                    Task { await model.back() }
                }
            }
            Text(verbatim: KnowledgeWords.title).knowledgeText(.title2, p).accessibilityAddTraits(.isHeader)
        }
    }

    private var field: some View {
        TextField(KnowledgeWords.search, text: $model.query, prompt: Text(verbatim: KnowledgeWords.search))
        .textFieldStyle(.roundedBorder)
        .metistryFont(.body)
        .focused(searchFocused)
        .onSubmit { Task { await model.submitSearch() } }
        .accessibilityLabel(Text(verbatim: KnowledgeWords.search))
    }
}

/// A column at reading width that scrolls.
struct KnowledgeScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s6) {
                content()
            }
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            .padding(MetistrySpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Home

struct KnowledgeHome: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let assistantName: String?
    let onOpenInObsidian: ((String) -> Void)?

    var body: some View {
        if let stale = staleSince {
            StaleBand(StaleBandModel("Showing Knowledge", asOf: stale, action: StateWords.tryAgain), now: model.now(), clock: model.clock) {
                Task { await model.load() }
            }
        }
        KnowledgeFoldCard(model: model, assistantName: assistantName, onOpenInObsidian: onOpenInObsidian)
        KnowledgeEyeSection(model: model)
        KnowledgeAreasSection(model: model)
        if let line = model.sourcesLine {
            KnowledgeSourcesView(line: line, expanded: model.sourcesExpanded) { model.sourcesOpen.toggle() }
        } else if let problem = model.sources.section.problem {
            FactNote(FactNoteModel("Sources: \(problem)"))
        }
    }

    /// Something on screen is from before the console stopped answering.
    private var staleSince: Date? {
        for s in [model.fold.section.state, model.areas.section.state] {
            if case .stale = s { return model.areas.section.asOf ?? model.fold.section.asOf ?? model.areas.section.lastAttemptAt }
        }
        return nil
    }
}

/// A section's heading, and the rule it depends on (§1: one per section, in situ).
struct KnowledgeSectionHeading: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    var trailing: String? = nil
    var spoken: String? = nil

    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
            Text(verbatim: title).knowledgeText(.headline, p)
            if let trailing {
                Text(verbatim: trailing).knowledgeText(.subhead, p, .textSecondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken ?? [title, trailing].compactMap { $0 }.joined(separator: ", ")))
        .accessibilityAddTraits(.isHeader)
    }
}

struct KnowledgeRule: View {
    @Environment(\.colorScheme) private var scheme
    let text: String

    var body: some View {
        Text(verbatim: text)
            .knowledgeText(.footnote, Palette(scheme), .textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: The fold

struct KnowledgeFoldCard: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let assistantName: String?
    let onOpenInObsidian: ((String) -> Void)?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            switch model.fold.section.value {
            case .some(.some(let fold)):
                KnowledgeSectionHeading(title: KnowledgeWords.fold, trailing: fold.path)
                KnowledgeFoldWords(fold: fold, assistantName: assistantName)
                if !fold.links.isEmpty {
                    KnowledgeLinkChips(title: "Pages It Names", links: fold.links) { path in Task { await model.open(path: path) } }
                }
                controls(fold)
            case .some(.none):
                KnowledgeSectionHeading(title: KnowledgeWords.fold)
                Text(verbatim: model.foldDate == nil ? KnowledgeWords.noFold : "No fold on or before \(model.foldDate ?? "").")
                    .knowledgeText(.body, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if model.foldDate != nil {
                    ControlButton(ControlSpec(KnowledgeWords.newestFold, role: .secondary)) { Task { await model.newestFold() } }
                }
            case .none:
                KnowledgeSectionHeading(title: KnowledgeWords.fold)
                if let problem = model.fold.section.problem {
                    FactNote(FactNoteModel(problem))
                }
            }
            KnowledgeRule(text: KnowledgeWords.foldRule(assistantName))
        }
    }

    @ViewBuilder
    private func controls(_ fold: KnowledgeFoldRead) -> some View {
        FlowLayout(spacing: MetistrySpace.s2) {
            ControlButton(ControlSpec(KnowledgeWords.openFold, role: .secondary, disabledBecause: onOpenInObsidian == nil ? "Obsidian isn't reachable from here" : nil)) {
                onOpenInObsidian?(fold.path)
            }
            ControlButton(ControlSpec(KnowledgeWords.earlierFolds, role: .secondary)) { Task { await model.earlierFold() } }
            if model.foldDate != nil {
                ControlButton(ControlSpec(KnowledgeWords.newestFold, role: .secondary)) { Task { await model.newestFold() } }
            }
        }
    }
}

/// The fold's words: the agent wash, the serif, the name with the spark (C88),
/// and page names as links.
struct KnowledgeFoldWords: View {
    @Environment(\.colorScheme) private var scheme
    let fold: KnowledgeFoldRead
    let assistantName: String?

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            if let name = assistantName {
                MarkView(Mark(name, glyph: .spark, style: .caption1, weight: .semibold, ink: .agent, on: .agentQuiet, spoken: "\(name) wrote"))
            }
            if let doc = fold.document {
                ForEach(Array(doc.parts.enumerated()), id: \.offset) { item in
                    let part = item.element
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        if let heading = part.heading {
                            Text(verbatim: heading).knowledgeText(.subhead, p, .textSecondary).accessibilityAddTraits(.isHeader)
                        }
                        if let text = part.text {
                            Text(FoldText.attributed(text))
                                .metistryFont(.body, design: .serif)
                                .foregroundStyle(p[.textPrimary])
                                .tint(p[.accent])
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        } else {
                            Text(verbatim: KnowledgeWords.pending).knowledgeText(.body, p, .textSecondary)
                        }
                    }
                }
            } else {
                Text(verbatim: "The fold's page could not be read. Open it in Obsidian to read it.")
                    .knowledgeText(.body, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.agentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// A short list of pages, each a link that opens in place; an unwritten one is shown, not followed.
struct KnowledgeLinkChips: View {
    let title: String
    let links: [KnowledgeLinkRef]
    let onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            KnowledgeSectionHeading(title: title)
            FlowLayout(spacing: MetistrySpace.s2) {
                ForEach(links) { link in
                    let name = link.title ?? FoldText.displayName(link.path)
                    ControlButton(ControlSpec(name, role: .plain, disabledBecause: link.resolved ? nil : "not written yet", name: "\(name), \(KnowledgePageRead.kindWord(link.kind)), \(link.path)")) {
                        onOpen(link.path)
                    }
                }
            }
        }
    }
}

// MARK: Needs your eye

struct KnowledgeEyeSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel

    var body: some View {
        let p = Palette(scheme)
        let items = model.eye
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            // The count sits here, in the header — never a badge (§3, P2).
            KnowledgeSectionHeading(title: KnowledgeWords.needsYourEye, trailing: items.isEmpty ? nil : "\(items.count)", spoken: items.isEmpty ? KnowledgeWords.needsYourEye : "\(KnowledgeWords.needsYourEye), \(items.count) waiting")
            if items.isEmpty {
                if let problem = model.requests.section.problem ?? model.drafts.section.problem {
                    FactNote(FactNoteModel(problem))
                } else if model.requests.section.hasValue || model.drafts.section.hasValue {
                    Text(verbatim: KnowledgeWords.nothingNeedsYourEye).knowledgeText(.body, p, .textSecondary)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(items) { item in
                        KnowledgeEyeRow(item: item) { Task { await model.go(to: .item(item.id)) } }
                        if item.id != items.last?.id { Divider() }
                    }
                }
                .background(p[.elevated], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous).strokeBorder(p[.border], lineWidth: 1))
                .shellListFocus()
            }
            KnowledgeRule(text: KnowledgeWords.draftRule)
        }
    }
}

struct KnowledgeEyeRow: View {
    @Environment(\.colorScheme) private var scheme
    let item: KnowledgeEyeItem
    let onOpen: () -> Void

    var body: some View {
        let p = Palette(scheme)
        Button(action: onOpen) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                Image(systemName: item.kind.glyph.rawValue)
                    .foregroundStyle(p[item.kind == .conflict ? .degraded : .textSecondary])
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Text(verbatim: item.kind.rawValue).knowledgeText(.subhead, p, weight: .semibold)
                        Text(verbatim: item.path).knowledgeText(.footnote, p, design: .mono)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text(verbatim: item.why).knowledgeText(.footnote, p, .textSecondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: MetistrySpace.s2)
                Text(verbatim: "\(item.kind.verb) →").knowledgeText(.subhead, p, .accent)
            }
            .padding(.horizontal, MetistrySpace.s3)
            .padding(.vertical, MetistrySpace.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: item.spoken))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: Areas

struct KnowledgeAreasSection: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel

    var body: some View {
        let p = Palette(scheme)
        let now = model.now()
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            KnowledgeSectionHeading(title: KnowledgeWords.areas)
            Text(verbatim: KnowledgeWords.areasNote).knowledgeText(.footnote, p, .textSecondary)
            if let rows = model.areas.section.value {
                if rows.isEmpty {
                    Text(verbatim: "No areas yet — a folder in the vault becomes one.").knowledgeText(.body, p, .textSecondary)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { row in
                            KnowledgeAreaRowView(row: row, now: now) { Task { await model.go(to: .area(row.area)) } }
                            if row.id != rows.last?.id { Divider() }
                        }
                    }
                    .shellListFocus()
                }
            } else if let problem = model.areas.section.problem {
                FactNote(FactNoteModel(problem))
            }
            KnowledgeRule(text: KnowledgeWords.areaRule)
        }
    }
}

struct KnowledgeAreaRowView: View {
    @Environment(\.colorScheme) private var scheme
    let row: KnowledgeAreaRow
    let now: Date
    let onOpen: () -> Void

    var body: some View {
        let p = Palette(scheme)
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: row.area).knowledgeText(.subhead, p, design: .mono, weight: .semibold)
                Text(verbatim: row.line).knowledgeText(.body, p, row.description == nil ? .textSecondary : .textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(verbatim: row.provenance(now: now)).knowledgeText(.footnote, p, .textSecondary)
            }
            .padding(.vertical, MetistrySpace.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: row.spoken(now: now)))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: Sources

struct KnowledgeSourcesView: View {
    @Environment(\.colorScheme) private var scheme
    let line: SourcesLine
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Button(action: onToggle) {
                HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                    Image(systemName: line.faulted ? "circle.fill" : "circle")
                        .foregroundStyle(p[line.faulted ? .failed : .textSecondary])
                        .accessibilityHidden(true)
                    Text(verbatim: line.text).knowledgeText(.subhead, p)
                    Spacer(minLength: MetistrySpace.s2)
                    Image(systemName: expanded ? MetistryGlyph.disclosureOpen.rawValue : MetistryGlyph.disclosure.rawValue)
                        .foregroundStyle(p[.textSecondary])
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(KnowledgeWords.sources), \(line.spoken), \(expanded ? "expanded" : "collapsed")"))
            .accessibilityAddTraits(.isButton)
            if expanded {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    ForEach(line.rows) { row in
                        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                            Image(systemName: row.state.glyph?.rawValue ?? "checkmark.circle")
                                .foregroundStyle(p[row.state.ink])
                                .accessibilityHidden(true)
                            Text(verbatim: row.title).knowledgeText(.subhead, p)
                            Text(verbatim: row.detail).knowledgeText(.footnote, p, row.state == .failed ? .textPrimary : .textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        // The state is said in words, in its row — never colour alone (C121).
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(verbatim: row.spoken))
                    }
                }
                .padding(.leading, MetistrySpace.s5)
            }
        }
    }
}

// MARK: - An area's pages

struct KnowledgeAreaPages: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let area: String

    var body: some View {
        let p = Palette(scheme)
        KnowledgeSectionHeading(title: area)
        if let row = model.areas.section.value?.first(where: { $0.area == area }) {
            Text(verbatim: row.line).knowledgeText(.body, p, row.description == nil ? .textSecondary : .textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        switch model.areaPages {
        case .loading?, nil:
            PlaceholderRows(count: 3, waitingFor: "Reading \(area)")
        case .failed(let why)?:
            StatePanel(StatePanelModel(.failed, title: "Pages Not Read", sentence: "This area's pages could not be read.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.readArea(area) }
            }
        case .loaded(let pages)?:
            if pages.isEmpty {
                Text(verbatim: KnowledgeWords.noPages).knowledgeText(.body, p, .textSecondary)
            } else {
                KnowledgePageRows(pages: pages.map { ($0.path, $0.title, $0.description, WireTime.date($0.modified)) }, now: model.now()) { path in
                    Task { await model.open(path: path) }
                }
            }
        }
    }
}

/// The page table — path, title, when it changed — behind an area and behind search (§5).
struct KnowledgePageRows: View {
    @Environment(\.colorScheme) private var scheme
    let pages: [(path: String, title: String?, detail: String?, modified: Date?)]
    let now: Date
    let onOpen: (String) -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(pages.enumerated()), id: \.offset) { item in
                let page = item.element
                let title = page.title ?? FoldText.displayName(page.path)
                let changed = page.modified.map { "changed \(ClockTime.age(now.timeIntervalSince($0)))" }
                Button { onOpen(page.path) } label: {
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        Text(verbatim: title).knowledgeText(.body, p, weight: .semibold)
                        Text(verbatim: page.path).knowledgeText(.footnote, p, .textSecondary, design: .mono)
                        if let detail = page.detail, !detail.isEmpty {
                            Text(verbatim: detail).knowledgeText(.footnote, p, .textSecondary).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        }
                        if let changed { Text(verbatim: changed).knowledgeText(.caption1, p, .textSecondary) }
                    }
                    .padding(.vertical, MetistrySpace.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: [title, page.path, page.detail, changed].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")))
                .accessibilityAddTraits(.isButton)
                if item.offset < pages.count - 1 { Divider() }
            }
        }
        .shellListFocus()
    }
}

// MARK: - Search

struct KnowledgeSearchResults: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let query: String

    var body: some View {
        let p = Palette(scheme)
        KnowledgeSectionHeading(title: "Search", trailing: "“\(query)”")
        switch model.search {
        case .loading?, nil:
            PlaceholderRows(count: 3, waitingFor: "Searching the vault")
        case .failed(let why)?:
            StatePanel(StatePanelModel(.failed, title: "Search Didn't Answer", sentence: "The vault could not be searched.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.runSearch(query) }
            }
        case .loaded(let reply)?:
            if let degraded = reply.degraded {
                FactNote(FactNoteModel(degraded))
            }
            if reply.hits.isEmpty {
                // components-03 §2: no match.
                StatePanel(StatePanelModel(.empty, title: KnowledgeWords.noMatch(query), sentence: "Try other words, or look in an area."))
            } else {
                KnowledgePageRows(pages: reply.hits.map { ($0.path, $0.title, $0.snippet ?? $0.description, nil) }, now: model.now()) { path in
                    Task { await model.open(path: path) }
                }
                if reply.isAtCeiling {
                    Text(verbatim: "The first \(KnowledgeSearchReply.maximumHits) matches — narrow the words to see others.").knowledgeText(.footnote, p, .textSecondary)
                }
            }
        }
    }
}

// MARK: - A page

struct KnowledgePageDetail: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let path: String
    let onOpenInObsidian: ((String) -> Void)?

    var body: some View {
        let p = Palette(scheme)
        switch model.page {
        case .loading?, nil:
            KnowledgeSectionHeading(title: FoldText.displayName(path), trailing: path)
            PlaceholderRows(count: 4, waitingFor: "Reading \(path)")
        case .failed(let why)?:
            KnowledgeSectionHeading(title: FoldText.displayName(path), trailing: path)
            StatePanel(StatePanelModel(.failed, title: "Page Not Read", sentence: "This page could not be read.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.readPage(path) }
            }
        case .loaded(let page)?:
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: page.title).knowledgeText(.title3, p).accessibilityAddTraits(.isHeader)
                Text(verbatim: page.path).knowledgeText(.footnote, p, .textSecondary, design: .mono)
            }
            ControlButton(ControlSpec(KnowledgeWords.openInObsidian, role: .secondary, shortcut: "⌘O", disabledBecause: onOpenInObsidian == nil ? "Obsidian isn't reachable from here" : nil)) {
                onOpenInObsidian?(page.path)
            }
            Text(FoldText.attributed(page.content))
                .knowledgeText(.body, p)
                .tint(p[.accent])
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(MetistrySpace.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p[.elevated], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
            if let problem = page.linksProblem {
                FactNote(FactNoteModel("Links: \(problem)"))
            } else {
                KnowledgeLinkList(title: KnowledgeWords.outgoing, empty: KnowledgeWords.noOutgoing, links: page.outgoing) { path in Task { await model.open(path: path) } }
                KnowledgeLinkList(title: KnowledgeWords.incoming, empty: KnowledgeWords.noIncoming, links: page.incoming) { path in Task { await model.open(path: path) } }
            }
        }
    }
}

/// One direction of a page's links, `kind` shown: a frontmatter link, a
/// wikilink and an embed mean different things about intent (§7).
struct KnowledgeLinkList: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let empty: String
    let links: [KnowledgePageLink]
    let onOpen: (String) -> Void

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            KnowledgeSectionHeading(title: title, trailing: links.isEmpty ? nil : "\(links.count)")
            if links.isEmpty {
                Text(verbatim: empty).knowledgeText(.footnote, p, .textSecondary)
            }
            ForEach(links) { link in
                let name = link.title ?? FoldText.displayName(link.path)
                Button { onOpen(link.path) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Text(verbatim: name).knowledgeText(.body, p, link.resolved == false ? .textSecondary : .textPrimary)
                        Text(verbatim: KnowledgePageRead.kindWord(link.kind)).knowledgeText(.caption1, p, .textSecondary)
                        Text(verbatim: link.path).knowledgeText(.caption1, p, .textSecondary, design: .mono)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(link.resolved == false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: KnowledgePageRead.spoken(link)))
                .accessibilityAddTraits(.isButton)
            }
        }
    }
}

// MARK: - One item of Needs your eye

struct KnowledgeItemDetail: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: KnowledgeModel
    let id: String
    let assistantName: String?
    let onOpenInObsidian: ((String) -> Void)?

    var body: some View {
        let p = Palette(scheme)
        if let item = model.eye.first(where: { $0.id == id }) {
            KnowledgeSectionHeading(title: item.kind.rawValue, trailing: item.path)
            switch (item.kind, item.request) {
            case (.conflict, let row?):
                if let resolution = model.conflicts[row.id] {
                    KnowledgeConflictView(resolution: resolution, row: row, allowsDecisions: model.allowsDecisions, today: model.today, clock: model.clock, now: model.now(), onOpenInObsidian: onOpenInObsidian)
                    KnowledgeRule(text: KnowledgeWords.conflictRule)
                }
            case (_, let row?):
                Text(verbatim: KnowledgeWords.answeredThere).knowledgeText(.footnote, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let name = assistantName, let cards = model.cards(assistantName: name) {
                    let card = cards.card(for: row)
                    RequestCardView(card, allowsDecisions: model.allowsDecisions, today: model.today, now: model.now(), clock: model.clock)
                        // An answer changed the queue here and in Needs You.
                        .task(id: card.isSettled) { if card.isSettled { await model.answered() } }
                } else {
                    // The name is not known yet; the card would print none.
                    Text(verbatim: item.why).knowledgeText(.body, p).fixedSize(horizontal: false, vertical: true)
                }
                pageControls(item)
            case (_, nil):
                Text(verbatim: item.why).knowledgeText(.body, p).fixedSize(horizontal: false, vertical: true)
                // Off because of a fact, so the fact is said (components-01 §1.3).
                FlowLayout(spacing: MetistrySpace.s2) {
                    ForEach(["Approve", "Revise", "Decline"], id: \.self) { verb in
                        ControlButton(ControlSpec(verb, role: verb == "Approve" ? .primary : .secondary, disabledBecause: "no request to answer yet")) {}
                    }
                }
                FactNote(FactNoteModel(KnowledgeWords.notAskedYet))
                pageControls(item)
            }
        } else {
            KnowledgeSectionHeading(title: KnowledgeWords.needsYourEye)
            Text(verbatim: "This has been answered, here or in Needs You.").knowledgeText(.body, p, .textSecondary)
            ControlButton(ControlSpec(KnowledgeWords.back, role: .secondary)) { Task { await model.back() } }
        }
    }

    @ViewBuilder
    private func pageControls(_ item: KnowledgeEyeItem) -> some View {
        if !item.path.isEmpty {
            FlowLayout(spacing: MetistrySpace.s2) {
                ControlButton(ControlSpec("Read the Page", role: .secondary)) { Task { await model.open(path: item.path) } }
                ControlButton(ControlSpec(KnowledgeWords.openInObsidian, role: .secondary, shortcut: "⌘O", disabledBecause: onOpenInObsidian == nil ? "Obsidian isn't reachable from here" : nil)) {
                    onOpenInObsidian?(item.path)
                }
            }
        }
    }
}

/// §4: who wrote what, that neither was lost, the diff, and the verbs —
/// Keep Mine · Take the Other · Merge in Obsidian. No auto-merge and no
/// fourth button: a merge in the console would be the console mutating the
/// vault by inference (invariant 10).
struct KnowledgeConflictView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var resolution: ConflictResolution
    let row: RequestRow
    let allowsDecisions: Bool
    let today: TaskDay
    let clock: ClockTime
    let now: Date
    let onOpenInObsidian: ((String) -> Void)?
    @State private var linesOpen = true

    nonisolated static func canChoose(_ phase: ConflictResolution.Phase) -> Bool {
        switch phase {
        case .open, .refused: return true
        default: return false
        }
    }

    var body: some View {
        let p = Palette(scheme)
        let c = resolution.conflict
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text(verbatim: Self.whoWrote(c, clock: clock, now: now)).knowledgeText(.body, p).fixedSize(horizontal: false, vertical: true)
            Text(verbatim: KnowledgeWords.neitherLost).knowledgeText(.body, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            RequestBodyView(.diff(DiffBody(title: "Mine − · the other +", lines: c.diff, expanded: linesOpen)), today: today, now: now, clock: clock) { event in
                if case .toggleExpanded = event { linesOpen.toggle() }
            }
            if c.truncated {
                PartialNote(PartialNoteModel("each side is shown up to its first 32,000 characters — compare the rest in Obsidian"))
            }
            state(p)
        }
    }

    /// Named, not inferred: which file is whose, and the one time the request knows.
    nonisolated static func whoWrote(_ c: KnowledgeConflict, clock: ClockTime, now: Date) -> String {
        let yours = c.original.map { "Yours is \($0)." } ?? "The note itself is gone; only the copy is left."
        let found = c.foundAt.map { " Found \(clock.moment($0, now: now))." } ?? ""
        return "\(yours) A sync kept the other version beside it as \(c.copy).\(found)"
    }

    @ViewBuilder
    private func state(_ p: Palette) -> some View {
        switch resolution.phase {
        case .holding:
            if let window = resolution.undoWindow {
                UndoBar(window) { resolution.undo() }
            }
        case .sending:
            Text(verbatim: "Settling…").knowledgeText(.subhead, p, .textSecondary)
        case .settled(let receipt):
            MarkView(Mark(receipt, glyph: .approve, glyphInk: .ok, style: .subhead, ink: .textPrimary, on: .surface))
        case .gone(let fact):
            MarkView(Mark(fact, style: .subhead, ink: .textSecondary, on: .surface))
        case .open, .refused:
            if case .refused(let why) = resolution.phase {
                Text(verbatim: why).knowledgeText(.subhead, p, .failed).fixedSize(horizontal: false, vertical: true)
            }
            let fact = allowsDecisions ? nil : StateWords.unreachable
            FlowLayout(spacing: MetistrySpace.s2) {
                ControlButton(ControlSpec(ConflictResolution.label(.mine, row: row), role: .primary, disabledBecause: fact)) { resolution.choose(.mine) }
                ControlButton(ControlSpec(ConflictResolution.label(.theirs, row: row), role: .secondary, disabledBecause: fact)) { resolution.choose(.theirs) }
                ControlButton(ControlSpec(KnowledgeWords.mergeInObsidian, role: .secondary, disabledBecause: onOpenInObsidian == nil ? "Obsidian isn't reachable from here" : nil)) {
                    onOpenInObsidian?(resolution.conflict.original ?? resolution.conflict.copy)
                }
            }
            if let fact {
                FactNote(FactNoteModel(fact))
            }
        }
    }
}

extension View {
    /// A type step that grows with the text size on the Mac too, in one of the palette's inks.
    func knowledgeText(_ style: MetistryTextStyle, _ p: Palette, _ role: MetistryColorRole = .textPrimary, design: TypeDesign = .sans, weight: TypeWeight? = nil) -> some View {
        metistryFont(style, design: design, weight: weight).foregroundStyle(p[role])
    }
}
