// The samples every shared component is snapshotted with (T5-3), built from
// F-7's recorded fixtures wherever a route serves the data — store → fixture →
// component, with no console running — and from the design record's own
// drawn rows where no route serves it yet (the permissions table: T4-6 has
// not put `permissions.lines` on the wire, so its rows are screen 7 §4.1's,
// decoded through the same `Decodable` the wire will use).
//
// One clock for all of them: the fixtures' own `as_of`, in New York, so a
// 12-hour time renders the same on every machine that runs the tests.

import Foundation
import SwiftUI

@testable import MetistryKit

struct ComponentSample: @unchecked Sendable {
    /// The component's file stem — one snapshot file per component.
    let component: String
    /// This sample, within the component.
    let name: String
    /// The ground the component sits on.
    let ground: MetistryColorRole
    /// The presentation value — what is dumped and checked.
    let presentation: Any
    /// The view, drawn — nil where the component draws nothing on purpose (an Undo whose window closed).
    let view: (@MainActor () -> AnyView)?
}

enum SampleClock {
    static let zone = TimeZone(identifier: "America/New_York")!
    static let clock = ClockTime(timeZone: zone)
    /// The fixtures' `as_of`: Monday 28 September 2026, 9:05 AM in New York.
    static let now = WireTime.date("2026-09-28T13:05:00.000Z")!
    static let today = TaskDay("2026-09-28")!
    static func at(_ iso: String) -> Date { WireTime.date(iso)! }
}

/// The screen 7 §4.1 rows, as `describePermissions()` will put them on the wire (packages/core/src/actor.ts).
let drawnPermissionRows = """
[
  {"resource": {"kind": "knowledge"}, "label": "Knowledge",
   "read": [
     {"key": "Areas/Ops", "label": "Areas/Ops", "asks": false, "provenance": {"kind": "base", "source": "registry"}},
     {"key": "Areas/Finance", "label": "Areas/Finance", "asks": false, "provenance": {"kind": "approved", "proposalId": 311}}
   ],
   "write": []},
  {"resource": {"kind": "work"}, "label": "Work",
   "read": [{"key": "*", "label": "All tasks", "asks": false, "provenance": {"kind": "base", "source": "registry"}}],
   "write": [
     {"key": "task_update", "label": "Update", "asks": false, "provenance": {"kind": "base", "source": "registry"}},
     {"key": "comment", "label": "Comment", "asks": false, "provenance": {"kind": "base", "source": "registry"}},
     {"key": "dispatch", "label": "Dispatch", "asks": true, "provenance": {"kind": "base", "source": "registry"}}
   ]},
  {"resource": {"kind": "artifacts"}, "label": "Artifacts",
   "read": [{"key": "*", "label": "All", "asks": false, "provenance": {"kind": "base", "source": "registry"}}],
   "write": [{"key": "comment", "label": "Comment", "asks": false, "provenance": {"kind": "base", "source": "registry"}}]},
  {"resource": {"kind": "inbox"}, "label": "Inbox",
   "read": [],
   "write": [{"key": "capture", "label": "Capture", "asks": false, "provenance": {"kind": "routine", "routine": "Morning Brief"}}]},
  {"resource": {"kind": "connection", "name": "jira"}, "label": "Jira",
   "read": [{"key": "search_issues", "label": "3 projects", "asks": false, "provenance": {"kind": "base", "source": "registry"}}],
   "write": [{"key": "add_comment", "label": "Comment", "asks": true, "provenance": {"kind": "base", "source": "registry"}}]}
]
"""

func componentSamples() async throws -> [ComponentSample] {
    let stores = ConsoleStores(transport: try FixtureConsole.recorded())
    let identity = try await stores.identity().get()
    let requests = try await stores.requests().get().proposals
    let today = try await stores.today(date: nil).get()
    let agents = try await stores.agents().get().agents
    let clock = SampleClock.clock
    let now = SampleClock.now
    let day = SampleClock.today
    var samples: [ComponentSample] = []

    func add(_ component: String, _ name: String, on ground: MetistryColorRole = .surface, _ presentation: Any, _ view: (@MainActor () -> AnyView)?) {
        samples.append(ComponentSample(component: component, name: name, ground: ground, presentation: presentation, view: view))
    }

    // MARK: agent chip — the assistant by its configured name, and an agent by its id
    let asker = requests.first { $0.kind == "decision" }!
    let assistantChip = AgentChipModel(agentID: asker.sourceAgent!, assistantName: identity.name)
    add("agent-chip", "the assistant, from a request's source_agent", assistantChip.mark(on: .surface)) { AnyView(AgentChip(assistantChip)) }
    let agentChip = AgentChipModel(agentID: agents[0].id, assistantName: identity.name)
    add("agent-chip", "an agent, from the registry", agentChip.mark(on: .surface)) { AnyView(AgentChip(agentChip)) }

    // MARK: agent prose — the wash (generated, rateable) and the rule (a transcript reply)
    let brief = AgentProseModel(treatment: .wash, author: .assistant(named: identity.name), text: "Two things need you before standup: Dana's fixture question, and the store list for the roadmap.", at: SampleClock.at("2026-09-28T12:58:01.000Z"), generated: true, proseID: "brief-2026-09-28", rating: .down)
    add("agent-prose", "wash — a generated brief line, rated down", brief.presentation(on: .surface, clock: clock)) { AnyView(AgentProse(brief, on: .surface, clock: clock, onRate: { _ in })) }
    let reply = AgentProseModel(treatment: .rule, author: AgentChipModel(agentID: "assistant", assistantName: identity.name), text: "One file per route: the recorder already writes them that way, and a store's test reads only its own.", at: now)
    add("agent-prose", "rule — a transcript reply, not rateable here", on: .bg, reply.presentation(on: .bg, clock: clock)) {
        AnyView(AgentProse(reply, on: .bg, clock: clock).padding(.leading, AgentProse.gutter))
    }

    // MARK: facet row — the fixture's task, and one that hits every rule
    let task = today["tasks"]!.arrayValue![0]
    let fixtureFacets = TaskFacets(vaultTask: task)
    add("facet-row", "the Today fixture's task", FacetRowModel(fixtureFacets, today: day).presentation()) { AnyView(FacetRow(fixtureFacets, today: day)) }
    let full = TaskFacets(
        priority: 1, due: TaskDay("2026-09-25"), planned: TaskDay("2026-10-02"), estimateMinutes: 90,
        people: ["Jim Fallon", "Dana"], links: [.note("Lease Renewal"), .project("metistry"), .work(418), .external("linear:ABC-123")],
        states: [.overdue, .waiting, .carried(days: 5)]
    )
    add("facet-row", "everything: overdue wins the one tint, the rest fold into +N", FacetRowModel(full, today: day).presentation()) { AnyView(FacetRow(full, today: day)) }
    let quiet = TaskFacets(priority: 4, due: TaskDay("2026-09-30"), estimateMinutes: 15, people: ["Dana"], states: [.carried(days: 2)])
    add("facet-row", "P4, due this week, carried two days", FacetRowModel(quiet, today: day).presentation()) { AnyView(FacetRow(quiet, today: day)) }

    // MARK: permissions table — screen 7's rows through the wire's Decodable
    let rows = try JSONDecoder().decode([PermissionRow].self, from: Data(drawnPermissionRows.utf8))
    add("permissions-table", "screen 7 §4.1's rows, editable", PermissionsTableModel(rows: rows, editable: true).presentation()) { AnyView(PermissionsTable(rows, onEdit: {})) }
    let lines = agents.flatMap { a in a.actionsDetailed.sorted { $0.key < $1.key }.map { "\(a.id) \($0.key): \(PermissionWords.line($0.value, level: a.scope?["autonomy"]?.string("level") ?? "observe"))" } }
    let lineMarks = lines.map { Mark($0, style: .footnote, design: .mono, on: .surface) }
    add("permissions-table", "the agents fixture's effective actions, in the CLI's words", lineMarks) {
        AnyView(VStack(alignment: .leading) { ForEach(Array(lineMarks.enumerated()), id: \.offset) { MarkView($0.element) } })
    }

    // MARK: the four states, plus partial, plus the fact note
    let empty = StatePanelModel(.empty, title: "Nothing on the Board", sentence: "Work fills as agents pick things up.")
    add("content-states", "empty", empty.presentation(now: now, clock: clock)) { AnyView(StatePanel(empty, now: now, clock: clock)) }
    let absent = StatePanelModel(.absent, title: "Not Configured", sentence: "Connect a calendar to fill this in.", action: "Open Connections")
    add("content-states", "absent", absent.presentation(now: now, clock: clock)) { AnyView(StatePanel(absent, now: now, clock: clock, onAction: {})) }
    let failed = StatePanelModel(.failed, title: "Couldn't Read Spend", sentence: "The sync answered, and the answer was an error.", reason: "over_cap · aws-costs · run 4f21", lastSucceeded: SampleClock.at("2026-09-26T08:10:00.000Z"), action: StateWords.tryAgain)
    add("content-states", "failed, with both timestamps", failed.presentation(now: now, clock: clock)) { AnyView(StatePanel(failed, now: now, clock: clock, onAction: {})) }
    let partial = PartialNoteModel.parseWarning(token: "every weekdy")
    add("content-states", "partial — one token unreadable", partial.mark(on: .surface)) { AnyView(PartialNote(partial)) }
    add("content-states", "a control off because of a fact (O3)", FactNoteModel.unreachable.mark(on: .surface)) { AnyView(FactNote(.unreachable)) }

    // MARK: stale — the pill and the band
    let pill = StalePillModel(isStale: true, age: "3 days ago")
    add("stale-band", "the pill, welded to a row's name", pill.mark(on: .surface) as Any) { AnyView(StalePill(isStale: true, age: "3 days ago")) }
    let band = StaleBandModel("Showing the board", asOf: SampleClock.at("2026-09-28T13:14:00.000Z").addingTimeInterval(-3600), action: "Sync Now")
    add("stale-band", "the band, as a clock time", band.presentation(now: now, clock: clock)) { AnyView(StaleBand(band, now: now, clock: clock, onAction: {})) }
    let spend = StaleBandModel("Spend", asOf: now.addingTimeInterval(-40 * 60), when: .age)
    add("stale-band", "the band, as an age", spend.presentation(now: now, clock: clock)) { AnyView(StaleBand(spend, now: now, clock: clock)) }

    // MARK: undo and confirm
    let undo = UndoWindow("Declined 5 requests", actedAt: now.addingTimeInterval(-3))
    add("undo-and-confirm", "undo, window open", on: .elevated, undo.presentation(at: now)) {
        // Drawn at the real clock so the TimelineView finds the window open.
        AnyView(UndoBar(UndoWindow("Declined 5 requests", actedAt: Date()), onUndo: {}))
    }
    add("undo-and-confirm", "undo, window closed after ten seconds", on: .elevated, undo.presentation(at: now.addingTimeInterval(8)), nil)
    let purge = CostConfirmation(title: "Purge 3 Sessions Now?", costHeading: "These sessions have not been folded yet, so what they hold is lost:", costs: ["Standup — 28 Sep, 9:30 AM", "Vendor call — 27 Sep, 2:00 PM", "Chat — 26 Sep, 11:12 PM"], confirm: "Purge Now", alternative: "Fold First")!
    add("undo-and-confirm", "confirm, naming the cost", on: .elevated, purge.presentation()) { AnyView(CostConfirmView(purge, onChoice: { _ in })) }

    // MARK: the seven request body blocks, from the requests fixture where it has them
    let options = asker.payload?["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
    let choices = RequestBodyBlock.choices(ChoicesBody(prompt: asker.title ?? "", options: options, step: 1, of: 2, chosen: [options.count], other: "one file per route, grouped by store"))
    let knowledge = requests.first { $0.kind == "knowledge" }!
    let report = requests.first { $0.kind == "report" }!
    let blocks: [(String, RequestBodyBlock)] = [
        ("choices — the fixture's decision, Something else… chosen", choices),
        ("diff — expanded", .diff(DiffBody(title: "Journal/2026-09-28.md", lines: [
            DiffLine(.context, "## Today"),
            DiffLine(.removed, "- [ ] Send Dana the fixture format due today"),
            DiffLine(.added, "- [ ] Send Dana the fixture format do fri"),
        ], expanded: true))),
        ("thread", .thread(ThreadBody(location: "apps/console/src/server.ts:630", code: ["if (!decision) return refuse(409, \"stale\");"], messages: [
            ThreadMessage(author: "dana", at: SampleClock.at("2026-09-28T12:40:00.000Z"), text: "Should this be a 409 or a 422?"),
            ThreadMessage(author: "cursor", byAgent: true, at: SampleClock.at("2026-09-28T12:52:00.000Z"), text: "409 — the row moved; the request itself was well formed."),
        ]))),
        ("before and after — access, expanded", .beforeAfter(BeforeAfterBody(heading: "What Approve Does", content: .sets(before: ["Areas/Ops", "Areas/Home", "Projects/Metistry"], after: ["Areas/Ops", "Areas/Home", "Projects/Metistry", "Areas/Finance"], total: "It would then read 4 folders"), expanded: true))),
        ("before and after — two versions", .beforeAfter(BeforeAfterBody(heading: "Knowledge Conflict", content: .versions(before: .init(label: "Yours · 9:12 PM", text: "Renewal due 1 Nov."), after: .init(label: "The fold's · 9:14 PM", text: "Renewal due 1 Nov; landlord wants 60 days' notice."))))),
        ("preview — the fixture's knowledge request", .preview(PreviewBody(heading: "Where It Would Be Written", path: knowledge.payload?.string("path"), text: knowledge.payload?.string("summary") ?? ""))),
        ("preview — an agent's own words", .preview(PreviewBody(heading: "What Approve Posts", text: "Moved to Friday — the fixture format is waiting on the store list.", agentWords: true))),
        ("to-dos — a meeting's, with proposed facets", .todos([
            TodoItem("Send Kessler the revised scope", facets: TaskFacets(due: TaskDay("2026-09-30"), people: ["Kessler"])),
            TodoItem("Book the vendor call", facets: TaskFacets(estimateMinutes: 15)),
        ])),
        ("excerpt — the fixture's report, failed", .excerpt(ExcerptBody(text: report.payload?.string("summary") ?? "", source: report.title, failedAt: SampleClock.at("2026-09-28T11:00:00.000Z"), lastSucceeded: SampleClock.at("2026-09-26T11:00:00.000Z"), reason: "token expired"))),
    ]
    for (name, block) in blocks {
        add("request-body", name, block.presentation(today: day, now: now, clock: clock)) { AnyView(RequestBodyView(block, today: day, now: now, clock: clock)) }
    }
    return samples
}
