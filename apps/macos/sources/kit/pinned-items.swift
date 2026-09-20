// The sidebar's Pinned area (app-ux-plan.md §3.4).
//
// THE TWO RULES THE SHAPE ENCODES. The six sections are **not** customizable —
// the same order and the same names are what stop the owner learning the
// product twice, and they are not in this file at all. Everything below them
// **is**: a pin is a shortcut to a destination that already exists, so it can
// be anything without touching the map.
//
// WHERE IT LIVES, AND WHY THAT IS NOT A FOURTH CATEGORY. Pins are app
// preferences **keyed by instance id** — a pin points at a project, page,
// saved search or agent *in one instance*, and the same app against a second
// instance must not show the first one's. Nothing about pinning goes into the
// instance repo, Postgres or the vault: it is per-machine client state, it is
// derived from nothing, and invariant 1 ("git is the record; Postgres is
// derived") does not want a third thing to reason about. Losing it costs the
// owner one drag.
//
// WHAT A PIN HOLDS. A **reference**, not the object. The project is in
// Postgres, the page is in the vault, the agent is in `agents` — the sidebar
// reads them like any other screen. A pin whose target has gone is therefore a
// pin that still exists: it renders as a dimmed row that says so and offers
// Unpin, never a crash and never a silent disappearance (P5). This type is
// what makes that possible; which rows are dimmed is the view's question,
// answered against the data the store already holds.
//
// The defaults key is `pinnedItems.<instance_id>` and an instance with no id
// gets no store at all rather than a shared one — see `AppPreference`.

import Foundation
import Observation

/// One pinned destination.
public struct PinnedItem: Codable, Sendable, Equatable, Identifiable, Hashable {
    /// The five things §3.4 says may be pinned. A sixth would be a product
    /// change, not a config line.
    public enum Kind: String, Codable, Sendable, Equatable, CaseIterable {
        /// A project, by slug.
        case project
        /// The board, optionally filtered to one project.
        case board
        /// A vault page, by its vault-relative path.
        case page
        /// A saved search: the query text, and the mode if one was chosen.
        case search
        /// An agent, by id.
        case agent

        /// The sidebar row's SF Symbol. Shape carries meaning as well as
        /// colour, so a pin is readable with Increase Contrast.
        public var symbolName: String {
            switch self {
            case .project: return "folder"
            case .board: return "square.grid.3x2"
            case .page: return "doc.text"
            case .search: return "magnifyingglass"
            case .agent: return "person.crop.circle"
            }
        }
    }

    public let kind: Kind
    /// What the pin points at: a project slug, a vault path, the query text, an
    /// agent id. Empty for the unfiltered board, which is the one destination
    /// that needs no reference.
    public let reference: String
    /// What the row says. The user's words where they typed any (a saved
    /// search), otherwise the object's own name at the time it was pinned — so
    /// a renamed project shows its old label until the sidebar reads it back,
    /// which is honest about being a shortcut rather than a copy.
    public var displayName: String

    /// Stable across a reorder, so `.onMove` and `.contextMenu` address the
    /// same row they were drawn for.
    public var id: String { "\(kind.rawValue):\(reference)" }

    public init(kind: Kind, reference: String, displayName: String) {
        self.kind = kind
        self.reference = reference
        self.displayName = displayName
    }

    public static func project(_ slug: String, displayName: String? = nil) -> PinnedItem {
        PinnedItem(kind: .project, reference: slug, displayName: displayName ?? slug)
    }

    public static func board(project: String? = nil) -> PinnedItem {
        PinnedItem(
            kind: .board,
            reference: project ?? "",
            displayName: project.map { "Board — \($0)" } ?? "Board"
        )
    }

    public static func page(_ path: String, displayName: String? = nil) -> PinnedItem {
        // The leaf, without its extension, is what a person calls a page.
        let leaf = path.split(separator: "/").last.map(String.init) ?? path
        let title = leaf.hasSuffix(".md") ? String(leaf.dropLast(3)) : leaf
        return PinnedItem(kind: .page, reference: path, displayName: displayName ?? title)
    }

    public static func search(_ query: String, displayName: String? = nil) -> PinnedItem {
        PinnedItem(kind: .search, reference: query, displayName: displayName ?? query)
    }

    public static func agent(_ id: String, displayName: String? = nil) -> PinnedItem {
        PinnedItem(kind: .agent, reference: id, displayName: displayName ?? id)
    }
}

/// The pins for one instance, in the order the user put them in.
@MainActor
@Observable
public final class PinnedItems {
    /// Long enough for a real working set, short enough that the sidebar is
    /// read rather than searched — the same reasoning as `recentsLimit`.
    public static let limit = 24

    /// `pinnedItems.<instance_id>`. The prefix is registered in
    /// `AppPreference`; the whole key is per instance, which is the point.
    public static func defaultsKey(instanceID: String) -> String {
        "\(AppPreference.pinnedItemsPrefix.rawValue).\(instanceID)"
    }

    public private(set) var items: [PinnedItem] = []

    /// Nil where the instance has no id yet (a folder that has not been
    /// stamped, or no instance chosen). Such a store holds pins in memory and
    /// writes nothing: filing them under a shared key would leak one install's
    /// sidebar into another's.
    public let instanceID: String?

    private let defaults: UserDefaults

    public init(instanceID: String?, defaults: UserDefaults = .standard) {
        self.instanceID = instanceID
        self.defaults = defaults
        items = Self.read(instanceID: instanceID, defaults: defaults)
    }

    public var isPersisted: Bool { instanceID != nil }

    public func isPinned(_ item: PinnedItem) -> Bool {
        items.contains { $0.id == item.id }
    }

    /// Pin, at the end. Pinning something already pinned is a no-op rather than
    /// a duplicate — a sidebar with the same row twice is a bug the user cannot
    /// fix except by unpinning both.
    public func pin(_ item: PinnedItem) {
        guard !isPinned(item) else { return }
        guard items.count < Self.limit else { return }
        items.append(item)
        persist()
    }

    public func unpin(_ item: PinnedItem) {
        unpin(id: item.id)
    }

    public func unpin(id: String) {
        let before = items.count
        items.removeAll { $0.id == id }
        if items.count != before { persist() }
    }

    /// Toggle, for a context menu that shows one item either way.
    public func toggle(_ item: PinnedItem) {
        if isPinned(item) { unpin(item) } else { pin(item) }
    }

    /// `List`'s `.onMove` hands these exact arguments, so this takes them
    /// unchanged rather than asking a view to translate.
    public func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        guard !source.isEmpty else { return }
        items.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    /// Rename a pin's label. The reference does not change: renaming a shortcut
    /// must not repoint it.
    public func rename(id: String, to displayName: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        items[index].displayName = trimmed
        persist()
    }

    public func removeAll() {
        guard !items.isEmpty else { return }
        items = []
        persist()
    }

    // MARK: - Storage

    private func persist() {
        guard let instanceID else { return }
        let key = Self.defaultsKey(instanceID: instanceID)
        guard !items.isEmpty else {
            // Nothing pinned writes no key, so the defaults domain carries only
            // what the user actually chose (settings-model-tests.swift holds
            // the app to exactly the keys it names).
            defaults.removeObject(forKey: key)
            return
        }
        guard let data = try? JSONEncoder().encode(items) else { return }
        defaults.set(data, forKey: key)
    }

    /// A stored list that does not decode is dropped rather than crashing the
    /// sidebar — it is one drag to rebuild, and a launch that fails on a
    /// preference is not a trade worth making.
    private static func read(instanceID: String?, defaults: UserDefaults) -> [PinnedItem] {
        guard let instanceID else { return [] }
        guard let data = defaults.data(forKey: defaultsKey(instanceID: instanceID)) else { return [] }
        return (try? JSONDecoder().decode([PinnedItem].self, from: data)) ?? []
    }
}
