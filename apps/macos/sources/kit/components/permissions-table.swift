// The permissions table — one table, everywhere permissions appear (C58;
// screen 7 §4.1; amendments §3): on a local agent, a connected agent and a
// routine alike.
//
//     Resource   | Read                                   | Write
//     Knowledge  | Areas/Ops · Areas/Finance (Approved …) | —
//     Work       | All tasks                              | Update · Comment · Dispatch ⏱
//     ⧉ Jira     | 3 projects                             | Comment ⏱
//
// ROWS COME FROM THE ACTOR MODEL, NOT FROM HERE. A row is F-2's
// `PermissionRow` (packages/core/src/actor.ts) as the wire carries it —
// `describePermissions()` composes it once, for the CLI, the console and
// this kit alike, and each entry's `label` is the words every surface prints.
// So this file composes no sentence of its own about what an agent may do
// (amendments §4: a surface that composes its own version creates a second
// record); it draws the rows it is handed.
//
// ABSENCE IS THE DENIAL. There is no Allow/Never control in a cell: an empty
// cell is `—`, one glyph marks a verb that waits for the owner, and **Edit**
// sits on the section. Provenance lives in the cell — base configuration is
// unmarked, because a marker on everything is a marker on nothing.
//
// THE WORDS, IN ONE PLACE. `PermissionWords` is every string this table and
// any permission surface in the app prints about a mode. They are the CLI's
// (*Allow · Ask First · Never*, `packages/cli/src/agents.ts` MODE_LABEL) while
// the owner's ruling (b) in docs/product/decisions-log.md — those, or C93's
// *On · Ask · Off* — is pending. Changing them is this enum and nothing else.

import SwiftUI

// MARK: - The words

public enum PermissionWords {
    /// `allow` — the CLI's word. C93 would say *On*.
    public static let allow = "Allow"
    /// `propose` — the CLI's word. C93 would say *Ask*.
    public static let ask = "Ask First"
    /// `deny` — the CLI's word. C93 would say *Off*.
    public static let never = "Never"

    /// The wire's mode (`allow | propose | deny`) as said. Nil for anything else — never a guess.
    public static func mode(_ wire: String) -> String? {
        switch wire {
        case "allow": return allow
        case "propose": return ask
        case "deny": return never
        default: return nil
        }
    }

    /// What the ask glyph means, in the legend and to VoiceOver.
    public static let asksYouFirst = "asks you first"
    /// What the relay glyph means.
    public static let relayed = "reached through Metistry"
    /// The table's rule, always in its legend.
    public static let notGranted = "anything not listed is not granted"
    /// An empty cell.
    public static let emptyCell = "—"

    /// Approved in a queue (amendments §3.2).
    public static func approved(_ proposalID: Int?) -> String {
        proposalID.map { "Approved in Needs You · #\($0)" } ?? "Approved in Needs You"
    }

    /// Granted by a routine, held only while it runs (amendments §3.2).
    public static func duringRoutine(_ routine: String) -> String {
        "during \(routine) only"
    }

    /// One kind's effective line with its reason (C46, C47) — the CLI's
    /// `renderActionLine` word for word, so the app and `metistry agents
    /// autonomy` never disagree: `set` is plain; `defaulted` says so;
    /// `clamped` names what the owner asked for, the one case where their own
    /// setting is being overridden.
    public static func line(_ entry: AgentActionEntry, level: String) -> String {
        let word = mode(entry.mode) ?? entry.mode
        switch entry.source {
        case "clamped":
            let asked = entry.asked.flatMap(mode) ?? entry.asked ?? "?"
            return "\(word) (asked \(asked) — \(level)'s ceiling is \(word))"
        case "defaulted":
            return "\(word) (default for \(level))"
        default:
            return word
        }
    }
}

// MARK: - The actor model's rows, as the wire carries them (F-2)

public struct PermissionResource: Decodable, Sendable, Equatable {
    /// `knowledge · work · artifacts · inbox · queries · agents`, or `connection`.
    public let kind: String
    /// A connection's name.
    public let name: String?

    public init(kind: String, name: String? = nil) {
        self.kind = kind
        self.name = name
    }

    public var isConnection: Bool { kind == "connection" }
}

public enum PermissionProvenance: Decodable, Sendable, Equatable {
    /// How the actor holds it by default — unmarked.
    case base(source: String)
    /// Approved in Needs You; the request, when there is one.
    case approved(proposalID: Int?)
    /// Held only while this routine runs.
    case routine(String)

    enum CodingKeys: String, CodingKey { case kind, source, proposalId, routine }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "approved": self = .approved(proposalID: try c.decodeIfPresent(Int.self, forKey: .proposalId))
        case "routine": self = .routine(try c.decode(String.self, forKey: .routine))
        default: self = .base(source: try c.decodeIfPresent(String.self, forKey: .source) ?? "")
        }
    }

    /// The marker in the cell; nil for base.
    public var marker: String? {
        switch self {
        case .base: return nil
        case .approved(let id): return PermissionWords.approved(id)
        case .routine(let name): return PermissionWords.duringRoutine(name)
        }
    }
}

public struct PermissionEntry: Decodable, Sendable, Equatable {
    /// What a client matches on; never shown.
    public let key: String
    /// The words every surface prints.
    public let label: String
    /// The owner answers first: an action at `propose`, a connection tool at `ask`.
    public let asks: Bool
    public let provenance: PermissionProvenance

    public init(key: String, label: String, asks: Bool = false, provenance: PermissionProvenance = .base(source: "registry")) {
        self.key = key
        self.label = label
        self.asks = asks
        self.provenance = provenance
    }
}

public struct PermissionRow: Decodable, Sendable, Equatable {
    public let resource: PermissionResource
    /// The resource in words: *Knowledge*, or the connection's name.
    public let label: String
    public let read: [PermissionEntry]
    public let write: [PermissionEntry]

    public init(resource: PermissionResource, label: String, read: [PermissionEntry] = [], write: [PermissionEntry] = []) {
        self.resource = resource
        self.label = label
        self.read = read
        self.write = write
    }
}

// MARK: - The table

public struct PermissionsTableModel: Sendable, Equatable {
    public var rows: [PermissionRow]
    public var editable: Bool

    public init(rows: [PermissionRow], editable: Bool = false) {
        self.rows = rows
        self.editable = editable
    }

    /// Resource · Read · Write, as fractions of the width.
    public static let columns: [CGFloat] = [0.26, 0.37, 0.37]

    public struct Presentation: Sendable, Equatable {
        public struct Row: Sendable, Equatable {
            public var resource: Mark
            public var read: [Mark]
            public var write: [Mark]
            public var spoken: String
        }

        public var header: [Mark]
        public var rows: [Row]
        public var legend: [Mark]
        public var controls: [ControlSpec]
    }

    public func presentation(on ground: MetistryColorRole = .surface) -> Presentation {
        let header = ["Resource", "Read", "Write"].map { Mark($0, style: .caption1, weight: .semibold, ink: .textTertiary, on: ground) }
        let rows = rows.map { row -> Presentation.Row in
            let resource = Mark(row.label, glyph: row.resource.isConnection ? .relay : nil, style: .subhead, weight: .semibold, ink: .textPrimary, on: ground, spoken: row.resource.isConnection ? "\(row.label), \(PermissionWords.relayed)" : row.label)
            return Presentation.Row(resource: resource, read: Self.cell(row.read, ground), write: Self.cell(row.write, ground), spoken: "\(resource.voice). Read: \(Self.spoken(row.read)). Write: \(Self.spoken(row.write)).")
        }
        let legend = [
            Mark("\(PermissionWords.ask) — \(PermissionWords.asksYouFirst)", glyph: .asksFirst, style: .caption1, ink: .textSecondary, on: ground),
            Mark(PermissionWords.relayed, glyph: .relay, style: .caption1, ink: .textSecondary, on: ground),
            Mark(PermissionWords.notGranted, style: .caption1, ink: .textSecondary, on: ground),
        ]
        return Presentation(header: header, rows: rows, legend: legend, controls: editable ? [ControlSpec("Edit", role: .secondary, name: "Edit permissions")] : [])
    }

    static func cell(_ entries: [PermissionEntry], _ ground: MetistryColorRole) -> [Mark] {
        guard !entries.isEmpty else { return [Mark(PermissionWords.emptyCell, style: .subhead, ink: .textSecondary, on: ground, spoken: "not granted")] }
        var marks: [Mark] = []
        for entry in entries {
            if !marks.isEmpty { marks.append(Mark("·", style: .subhead, ink: .textSecondary, on: ground, spoken: "")) }
            marks.append(Mark(entry.label, glyph: entry.asks ? .asksFirst : nil, glyphAfter: true, style: .subhead, ink: .textPrimary, on: ground, spoken: entry.asks ? "\(entry.label), \(PermissionWords.asksYouFirst)" : entry.label))
            if let marker = entry.provenance.marker {
                marks.append(Mark(marker, style: .caption1, ink: .textSecondary, on: ground))
            }
        }
        return marks
    }

    static func spoken(_ entries: [PermissionEntry]) -> String {
        guard !entries.isEmpty else { return "not granted" }
        return entries.map { e in
            ([e.label] + (e.asks ? [PermissionWords.asksYouFirst] : []) + (e.provenance.marker.map { [$0] } ?? [])).joined(separator: ", ")
        }.joined(separator: "; ")
    }
}

public struct PermissionsTable: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var size
    let model: PermissionsTableModel
    let ground: MetistryColorRole
    let onEdit: (() -> Void)?

    public init(_ rows: [PermissionRow], on ground: MetistryColorRole = .surface, onEdit: (() -> Void)? = nil) {
        self.model = PermissionsTableModel(rows: rows, editable: onEdit != nil)
        self.ground = ground
        self.onEdit = onEdit
    }

    public var body: some View {
        let p = Palette(scheme)
        let view = model.presentation(on: ground)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "Permissions").metistryFont(.headline).foregroundStyle(p[.textPrimary])
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: MetistrySpace.s2)
                if let edit = view.controls.first, let onEdit {
                    ControlButton(edit, action: onEdit)
                }
            }
            if size.isAccessibilitySize {
                // At the accessibility sizes three columns would break words
                // mid-letter; each row stacks instead — longer, never wider (§2.18.5).
                ForEach(Array(view.rows.enumerated()), id: \.offset) { item in
                    Divider().overlay(p[.border])
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        MarkView(item.element.resource)
                        stacked(view.header[1], item.element.read)
                        stacked(view.header[2], item.element.write)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: item.element.spoken))
                }
            } else {
                ColumnsLayout(PermissionsTableModel.columns) {
                    ForEach(Array(view.header.enumerated()), id: \.offset) { MarkView($0.element) }
                }
                .accessibilityHidden(true)
                ForEach(Array(view.rows.enumerated()), id: \.offset) { item in
                    Divider().overlay(p[.border])
                    ColumnsLayout(PermissionsTableModel.columns) {
                        MarkView(item.element.resource)
                        cell(item.element.read)
                        cell(item.element.write)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: item.element.spoken))
                }
            }
            Divider().overlay(p[.border])
            FlowLayout(spacing: MetistrySpace.s3) {
                ForEach(Array(view.legend.enumerated()), id: \.offset) { MarkView($0.element) }
            }
        }
    }

    /// A column head, then the cell's entries one to a line — the separators are for a row, not a list.
    private func stacked(_ head: Mark, _ marks: [Mark]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MarkView(head)
            ForEach(Array(marks.filter { $0.text != "·" }.enumerated()), id: \.offset) { MarkView($0.element).padding(.leading, MetistrySpace.s3) }
        }
    }

    private func cell(_ marks: [Mark]) -> some View {
        FlowLayout(spacing: MetistrySpace.s1, lineSpacing: 2) {
            ForEach(Array(marks.enumerated()), id: \.offset) { MarkView($0.element) }
        }
    }
}
