// Work ▸ Board, the card detail and a task's room (T6-7). Built against the
// recorded fixtures first — `GET /api/q/board`, `GET /api/q/board_projects`,
// the task routes and a task's room as the console served them — and a
// scripted console where a fixture cannot say it (a claim that raced in, a
// save that fails, a room past its cap).
//
// The ticket's two bold tests come first: **no drop target the service would
// refuse** — every card shape the board can serve, every column, held to a
// model of `packages/tasks`' own WHERE clauses — and **a refused move reverts
// and says why**, in the server's sentence. Then one route per drop, the
// counts, the card, the room, and §2.18. macOS only, as the accessibility
// probe is (shell-accessibility-tests.swift).

#if os(macOS)
import AppKit
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The ticket's two

/// The statements of `packages/tasks` (src/index.ts), as a model: what each
/// op's WHERE clause accepts, and the column the row lands in after it — by
/// `board.yaml`'s CASE. Written from the SQL, not from `BoardRules`, so the
/// two are checked against each other rather than against themselves.
private enum TasksService {
    struct Row {
        var status: String
        var owner: String?
        var claimedBy: String?
        var leaseLapsed: Bool
    }

    static func accepts(_ op: BoardOp, _ r: Row) -> Bool {
        switch op {
        // claim: CLAIMABLE AND (claimed_by IS NULL OR lease_expires_at < now()) AND status IN ('open','in_progress') AND deps closed
        case .claim: return (r.claimedBy == nil || r.leaseLapsed) && ["open", "in_progress"].contains(r.status)
        // release / the holder arm: claimed_by = $agent AND status <> 'closed'
        case .release, .close: return r.claimedBy == BoardRules.owner && r.status != "closed"
        // the board arm: status <> 'closed' AND (status IS DISTINCT FROM 'open' OR w.status = 'blocked')
        case .unblock: return r.status == "blocked"
        case .assign, .unassign: return r.status != "closed"
        }
    }

    static func after(_ op: BoardOp, _ r: Row) -> Row {
        var r = r
        switch op {
        case .claim: r.status = "in_progress"; r.claimedBy = BoardRules.owner; r.leaseLapsed = false
        case .release, .unblock: r.status = "open"; r.claimedBy = nil
        case .close: r.status = "closed"; r.claimedBy = nil
        case .assign: r.owner = "crew-a"
        case .unassign: r.owner = nil
        }
        return r
    }

    /// board.yaml's CASE, first match wins.
    static func column(_ r: Row) -> String {
        switch r.status {
        case "closed": return "done"
        case "blocked": return "blocked"
        case "in_progress": return "in_progress"
        default: return r.owner == nil ? "backlog" : "assigned"
        }
    }

    /// Every row shape the board can hold: a status, an owner or none, a
    /// holder (the owner, an agent, nobody) with a live or a lapsed lease.
    static var shapes: [Row] {
        var out: [Row] = []
        for status in ["open", "in_progress", "blocked", "closed"] {
            for owner in [nil, BoardRules.owner, "crew-a"] as [String?] {
                for holder in [nil, BoardRules.owner, "crew-b"] as [String?] {
                    for lapsed in holder == nil ? [false] : [false, true] {
                        // claim() always sets in_progress, so an open row is never held
                        if status == "open", holder != nil { continue }
                        out.append(Row(status: status, owner: owner, claimedBy: holder, leaseLapsed: lapsed))
                    }
                }
            }
        }
        return out
    }
}

@MainActor
@Test func noDropTargetTheServiceWouldRefuse() throws {
    let now = recordedNow
    var checked = 0
    for (i, shape) in TasksService.shapes.enumerated() {
        let card = try boardCard(id: 100 + i, shape: shape, now: now)
        #expect(card.column == TasksService.column(shape))
        let drops = BoardRules.drops(for: card)
        for column in Board.columnOrder where column != card.column {
            // What ONE route accepted by the service would land here.
            let landing = BoardOp.allCases.filter { TasksService.accepts($0, shape) && TasksService.column(TasksService.after($0, shape)) == column }
            if let op = drops[column] {
                #expect(TasksService.accepts(op, shape), "\(describe(shape)) → \(column): offered \(op), and the service refuses it")
                #expect(TasksService.column(TasksService.after(op, shape)) == column, "\(describe(shape)) → \(column): \(op) lands in \(TasksService.column(TasksService.after(op, shape)))")
                #expect(BoardRules.landsIn(op, card, target: column) == column, "the drawn landing is where the row lands")
            } else {
                // Not offered: no single accepted route lands the card there — and Move… says why.
                #expect(landing.isEmpty, "\(describe(shape)) → \(column): the service would take \(landing) and the board offers nothing")
                let row = try #require(BoardRules.moves(for: card).first { $0.column == column })
                #expect(row.why?.isEmpty == false, "a dimmed row carries its reason")
            }
            checked += 1
        }
        // A closed card is never picked up at all.
        if shape.status == "closed" { #expect(!BoardRules.isMovable(card)) }
    }
    #expect(checked > 150, "the matrix is the point: \(checked)")
}

@MainActor
@Test func theModelDrawsNoTargetTheRulesDoNotOffer() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    for card in model.cards {
        #expect(model.dropTargets(for: card) == Set(BoardRules.drops(for: card).keys), "\(card.title)")
        for column in Board.columnOrder where !model.dropTargets(for: card).contains(column) {
            #expect(await model.drop(card, on: column) == false, "\(card.title) → \(column) landed")
        }
    }
    // The recorded Done card, the blocked card and a card another holds offer only what the service takes.
    let done = try #require(model.cards.first { $0.column == "done" })
    #expect(model.dropTargets(for: done).isEmpty)
    let held = try #require(model.cards.first { $0.claimedBy == "target:github-issues" })
    #expect(model.dropTargets(for: held).isEmpty, "only the holder hands a card back or closes it")
    let blocked = try #require(model.cards.first { $0.column == "blocked" })
    #expect(model.dropTargets(for: blocked) == ["backlog"], "the unblock, to its home — nothing claims a blocked card")
}

@MainActor
@Test func aRefusedMoveRevertsAndSaysWhy() async throws {
    let console = BoardConsole()
    let refusal = "task 1 waits on depends_on [7] — close those rows first; a dangling id blocks on purpose"
    console.failures["POST /api/tasks/1/claim"] = .http(status: 409, envelope: ConsoleErrorEnvelope(code: "conflict", message: refusal))
    let (model, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let card = try #require(model.card(1))
    #expect(card.column == "backlog")
    #expect(model.dropTargets(for: card).contains("in_progress"), "the board cannot see depends_on: the drop is offered")

    #expect(await model.drop(card, on: "in_progress"))
    // One route, then the board asked again — the server owns the columns.
    #expect(console.writes == ["POST /api/tasks/1/claim"])
    #expect(console.boardReads == 2)
    // Back where it was, and the server's own sentence — never one the board wrote.
    let after = try #require(model.card(1))
    #expect(model.drawnColumn(after) == "backlog")
    #expect(model.inFlight.isEmpty)
    let said = try #require(model.refusal)
    #expect(said.message == refusal)
    #expect(said.sentence == "Couldn't move \u{201C}Freeze the store interface (F-7)\u{201D} — \(refusal)")
    #expect(!said.canRetry, "a 409 is the row saying no")

    // Drawn under the board, spoken as failed.
    let tree = try await AccessibilityProbe.snapshot(BoardView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 1100, height: 700))
    defer { tree.close() }
    #expect((tree.labels + tree.texts).contains { $0.hasPrefix("failed. Couldn't move") && $0.hasSuffix(refusal) }, "said: \(tree.labels)")

    // A move that never reached the service offers Try Again, and Try Again is the same route.
    console.failures["POST /api/tasks/1/claim"] = .transport("connect ECONNREFUSED 127.0.0.1:1")
    #expect(await model.drop(try #require(model.card(1)), on: "in_progress"))
    #expect(model.refusal?.canRetry == true)
    console.failures["POST /api/tasks/1/claim"] = nil
    await model.retry()
    #expect(console.writes.suffix(2) == ["POST /api/tasks/1/claim", "POST /api/tasks/1/claim"])
    #expect(model.refusal == nil)
}

// MARK: - One route per drop

@MainActor
@Test func aDropOnDoneSendsClosedNeverDone() async throws {
    #expect(TaskPatch.moving(to: "done").wireBody?["status"] as? String == "closed", "`done` is a column, not a task status")
    #expect(TaskPatch.moving(to: "blocked").status == "blocked")
    #expect(TaskPatch.moving(to: "backlog").status == "open")
    #expect(TaskPatch.closing.wireBody?["status"] as? String == "closed")
    #expect(TaskPatch.unblocking.wireBody?["status"] as? String == "open")
    // Assigned → Backlog is owner: null — which `owner` alone could never say.
    #expect(TaskPatch.unassigning.wireBody?["owner"] is NSNull)
    var mixed = TaskPatch.unassigning
    mixed.status = "open"
    #expect(mixed.wireBody == nil, "two arms never travel together")

    let console = BoardConsole()
    console.rows = [row(id: 9, title: "Mine to close", status: "in_progress", claimedBy: "user", lease: "2026-09-27T01:36:35.000Z")]
    let (model, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let card = try #require(model.card(9))
    #expect(model.dropTargets(for: card) == ["done", "backlog"])
    #expect(await model.drop(card, on: "done"))
    #expect(console.writes == ["PATCH /api/tasks/9"])
    #expect(console.bodies.last == .object(["status": .string("closed")]))
}

@MainActor
@Test func eachDropIsExactlyOneRoute() async throws {
    let console = BoardConsole()
    console.rows = [
        row(id: 1, title: "Nobody's", status: "open"),
        row(id: 2, title: "For crew", status: "open", owner: "crew-a"),
        row(id: 3, title: "Held by me", status: "in_progress", owner: "crew-a", claimedBy: "user", lease: "2026-09-27T01:36:35.000Z"),
        row(id: 4, title: "Stuck", status: "blocked", claimedBy: "crew-b", lease: "2026-09-27T01:36:35.000Z"),
    ]
    let (model, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()

    // Backlog → In Progress: the claim, as the owner.
    #expect(await model.drop(try #require(model.card(1)), on: "in_progress"))
    // Assigned → Backlog: owner null.
    #expect(await model.drop(try #require(model.card(2)), on: "backlog"))
    // In Progress, held by the owner → its home (Assigned): the release.
    #expect(await model.drop(try #require(model.card(3)), on: "assigned"))
    // Blocked → Backlog: the unblock — it frees crew-b's claim, said so.
    let stuck = try #require(model.card(4))
    #expect(model.moves(for: stuck).first { $0.column == "backlog" }?.what == "unblocks it — releases crew-b's claim")
    #expect(await model.drop(stuck, on: "backlog"))
    #expect(console.writes == ["POST /api/tasks/1/claim", "PATCH /api/tasks/2", "POST /api/tasks/3/release", "PATCH /api/tasks/4"])
    #expect(console.bodies == [.object([:]), .object(["owner": .null]), .object([:]), .object(["status": .string("open")])])

    // Backlog → Assigned needs a name: the drop waits for it, then sends one PATCH.
    console.writes = []
    let open = try #require(model.card(1))
    #expect(await model.drop(open, on: "assigned"))
    #expect(model.assigningCard == 1)
    #expect(console.writes.isEmpty, "nothing is sent until the name is picked")
    await model.loadAssignees()
    #expect(model.assignees.first == "user")
    #expect(!model.assignees.contains("assistant"), "the principal id is never a pickable name")
    await model.assign(open, to: "crew-a")
    #expect(console.writes == ["PATCH /api/tasks/1"])
    #expect(console.bodies.last == .object(["owner": .string("crew-a")]))
}

@MainActor
@Test func noMoveIsOfferedWhileTheConsoleIsNotAnswering() async throws {
    let console = BoardConsole()
    let (model, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await model.load()
    let card = try #require(model.card(1))
    console.down = "connect ECONNREFUSED 127.0.0.1:1"
    await model.load()
    #expect(model.panel == .board(staleSince: ConsoleFixture.asOf("get-api-q-board")), "stale annotates; the last board stays")
    #expect(model.dropTargets(for: card).isEmpty)
    #expect(model.moves(for: card).allSatisfy { $0.op == nil && $0.why == StateWords.unreachable })
}

// MARK: - Reading the board

@MainActor
@Test func theHeadersCountEveryCardFromBoardProjects() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let columns = Dictionary(uniqueKeysWithValues: model.columns.map { ($0.key, $0) })
    #expect(model.columns.map(\.label) == ["Backlog", "Assigned", "In Progress", "Blocked", "Done"], "Assigned, not Addressed To (C38); Reported is not a column (C39)")
    #expect(columns["in_progress"]?.total == 2)
    #expect(columns["blocked"]?.escalations == 1)
    #expect(columns["blocked"]?.spoken == "Blocked, 1 card, 1 wants you")
    #expect(model.projects == ["metistry"], "the filter offers only projects that have cards")

    // A capped column says so: the count is the query's, not the rendered cards'.
    let console = BoardConsole()
    console.counts = [BoardProjectCount(project: "metistry", column: "backlog", cards: 212, escalations: 0)]
    let (capped, cappedSession) = boardModel(console)
    defer { withExtendedLifetime(cappedSession) {} }
    await capped.load()
    #expect(capped.columns.first?.countText == "showing 1 of 212")

    // Has Thread (C89) keeps only cards with a room, and the header says how many of how many.
    model.setHasThreadOnly(true)
    #expect(model.cards.map(\.title) == ["Decide the fixture format"])
    #expect(model.columns.first { $0.key == "in_progress" }?.countText == "showing 1 of 2")
}

@MainActor
@Test func eachColumnShowsTheFacetThatColumnIsAbout() throws {
    let now = recordedNow
    func facets(_ r: JSONValue) throws -> BoardCardFacets { BoardCardFacets(try decode(r), now: now, assistantName: "Aide") }
    #expect(try facets(row(id: 1, title: "t", status: "open", ageHours: 50)).facet?.text == "2d in backlog")
    let assigned = try facets(row(id: 1, title: "t", status: "open", owner: "assistant"))
    #expect(assigned.facet?.text == "Aide", "the assistant's principal prints its name")
    #expect(assigned.facet?.tone == .agent)
    #expect(try facets(row(id: 1, title: "t", status: "in_progress", claimedBy: "crew-b", lease: "2026-09-27T03:25:35.215Z")).facet?.text == "held by crew-b · 4m left")
    let lapsed = try facets(row(id: 1, title: "t", status: "in_progress", claimedBy: "crew-b", lease: "2026-09-27T03:09:35.215Z", escalated: true))
    #expect(lapsed.facet?.text == "held by crew-b · lease lapsed 12 minutes ago")
    #expect(lapsed.facet?.tone == .degraded, "degraded, never failed (C36)")
    #expect(lapsed.exception == nil, "the lapse is already the facet")
    let waiting = try facets(row(id: 1, title: "t", status: "blocked", escalated: true, blockedBy: "vault:Journal/x.md#^a", blockedByTask: "Call the dentist", blockedByTaskOpen: true))
    #expect(waiting.facet?.text == "Waiting on you: Call the dentist", "the reason, never the word Blocked again")
    #expect(waiting.exception == nil)
    let overdue = try facets(row(id: 1, title: "t", status: "open", owner: "crew-a", escalated: true, due: "2026-09-01"))
    #expect(overdue.exception?.text == "Overdue")
    let done = try facets(row(id: 1, title: "t", status: "closed", reported: true, lastReportAt: "2026-09-27T01:21:35.215Z", updatedAt: "2026-09-27T01:21:35.215Z"))
    #expect(done.facet?.text == "closed 2 hours ago")
    #expect(done.exception?.spoken == "reported 2 hours ago")
    let marked = try facets(row(id: 1, title: "t", status: "open", externalRef: "vault:Meetings/x.md#^b", hasThread: true, threadCount: 3))
    #expect(marked.fromNote && marked.threadCount == 3)
    #expect(BoardCardFacets.spoken(try decode(row(id: 1, title: "Ship it", status: "open", externalRef: "vault:x.md", hasThread: true, threadCount: 1, ageHours: 5)), now: now, assistantName: "Aide")
        == "Ship it, Backlog, 5h in backlog, room with 1 message, from a note")
}

// MARK: - The card (screen 14)

@MainActor
@Test func theDescriptionSaveKeepsTheEditWhenItFails() async throws {
    let console = BoardConsole()
    console.failures["PATCH /api/tasks/1"] = .http(status: 409, envelope: ConsoleErrorEnvelope(code: "conflict", message: "task 1 is closed — a closed row takes no further change here; create a follow-up task instead"))
    let (board, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await board.load()
    board.open(try #require(board.card(1)))
    let detail = try #require(board.detail)
    #expect(board.openCard == 1, "every click opens the card (C84)")
    detail.beginEditing()
    #expect(detail.editing == "One protocol per store, and every method answers from a fixture before its route is served.")
    detail.editing = "Rewritten by the owner."
    #expect(await detail.save() == false)
    #expect(detail.editing == "Rewritten by the owner.", "the edit is kept")
    #expect(detail.problem?.hasPrefix("task 1 is closed") == true)
    console.failures["PATCH /api/tasks/1"] = nil
    #expect(await detail.save())
    #expect(detail.editing == nil)
    #expect(console.bodies.last == .object(["description": .string("Rewritten by the owner.")]), "a board-arm field, alone")
}

@MainActor
@Test func aCardMovedElsewhereSaysWhereAndByWhom() async throws {
    let console = BoardConsole()
    let (board, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await board.load()
    let detail = CardDetailModel(.work(try #require(board.card(1))), session: session)
    #expect(detail.whereabouts(in: board.section.value?.rows ?? []) == .here)
    let moved = try decode(row(id: 1, title: "Freeze the store interface (F-7)", status: "closed"))
    let closedBy = try decode(row(id: 1, title: "Freeze the store interface (F-7)", status: "in_progress", claimedBy: "collator", lease: "2026-09-27T04:00:00.000Z"))
    #expect(detail.whereabouts(in: [closedBy]) == .moved(column: "in_progress", by: "collator"))
    #expect(detail.whereabouts(in: [moved]) == .moved(column: "done", by: nil))
    let other = try decode(row(id: 2, title: "Another", status: "open"))
    #expect(detail.whereabouts(in: [other]) == .gone, "filtered off the board")
    #expect(detail.whereabouts(in: []) == .here, "off the board, nothing is claimed")
    detail.follow(moved)
    #expect(detail.whereabouts(in: [moved]) == .here, "Open in Done re-anchors the card")
}

@Test func aMarkdownTaskShowsItsHeadingAndNeighbours() {
    let note = """
    # Vendor review

    Notes from the call.

    ## To-dos
    - [ ] Send Jim the revised Q4 scope 📅 2026-09-29
    - [ ] Sign the SOW
    - [x] Book the room

    ## After
    - [ ] Something later
    """
    let context = NoteContext.around("Sign the SOW", in: note)
    #expect(context.heading == "To-dos")
    #expect(context.lines == ["- [ ] Send Jim the revised Q4 scope 📅 2026-09-29", "- [ ] Sign the SOW", "- [x] Book the room"])
    #expect(context.taskIndex == 1)
    #expect(NoteContext.around("Not in the note", in: note).taskIndex == nil)
    // prose that merely mentions the words is not the line
    #expect(NoteContext.around("Notes from", in: note).taskIndex == nil)
}

@MainActor
@Test func aMarkdownTaskCompletesThroughTheTickDoor() async throws {
    let console = BoardConsole()
    console.pages["Meetings/Vendor.md"] = "## To-dos\n- [ ] Sign the SOW\n- [ ] Book the room\n"
    let session = ConsoleSession(transport: console, management: nil)
    defer { withExtendedLifetime(session) {} }
    let task = try #require(TodayTask(json: .object(["task_key": .string("mt-1"), "text": .string("Sign the SOW"), "path": .string("Meetings/Vendor.md")])))
    let detail = CardDetailModel(.task(task), session: session)
    await detail.load()
    #expect(detail.context?.lines == ["- [ ] Sign the SOW", "- [ ] Book the room"])
    await detail.complete()
    #expect(detail.completed)
    let tick = try #require(console.calls.first { $0.path == "/api/vault-tasks/mt-1/check" })
    #expect(tick.body == .object(["checked": .bool(true), "seen_text": .string("Sign the SOW")]))
    #expect(tick.idempotencyKey?.hasPrefix("tick-") == true)
}

// MARK: - The room (screen 16 §2)

@MainActor
@Test func theRoomSaysWhenItCameToYouAndKeepsAnUnsentMessage() async throws {
    let console = BoardConsole()
    let (_, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    let room = RoomModel(workID: 3, session: session)
    await room.load()
    let recorded = try #require(room.room)
    #expect(recorded.title == "Decide the fixture format")
    #expect(recorded.messages.map(\.author) == ["user"])
    #expect(!recorded.cameToYou)
    #expect(RoomWords.pips(recorded.agentTail, recorded.cap) == "0 of 10 agent turns in a row")
    #expect(RoomWords.pips(3, 10) == "3 of 10 agent turns in a row · yours resets it")

    console.room = .object(["work_id": .number(3), "title": .string("Decide"), "state": .string("open"), "agent_tail": .number(10), "cap": .number(10), "comments": .array([])])
    await room.load()
    #expect(room.room?.cameToYou == true)

    console.failures["POST /api/work/3/comments"] = .transport("connect ECONNREFUSED 127.0.0.1:1")
    room.draft = "Pick one and move on."
    await room.post()
    #expect(room.draft == "Pick one and move on.", "a message that did not land stays in the composer")
    #expect(room.problem?.hasSuffix("Your message is still here.") == true)
    console.failures["POST /api/work/3/comments"] = nil
    await room.load() // a read is how reachability comes back (O3)
    await room.post()
    #expect(room.draft.isEmpty)
    #expect(console.bodies.last == .object(["body": .string("Pick one and move on.")]), "no recipient — a room addresses nobody")
}

// MARK: - §2.18

@MainActor
@Test func theBoardSpeaksEveryCardColumnAndControl() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let tree = try await AccessibilityProbe.snapshot(BoardView(model: model, assistantName: "Aide", tick: .seconds(3600)).frame(width: 1100, height: 700))
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty, "unlabeled: \(tree.unlabeledControls)")
    let said = tree.labels + tree.texts
    #expect(said.contains("Pick the fixture redaction, Blocked, waiting on you: Send Dana the fixture format"), "said: \(said)")
    #expect(said.contains("Decide the fixture format, In Progress, room with 1 message"), "said: \(said)")
    #expect(said.contains("Measure the recorder run time, Done, closed 2 hours ago, reported 2 hours ago"), "said: \(said)")
    #expect(said.contains("Blocked, 1 card, 1 wants you"), "said: \(said)")
    #expect(tree.controlNames.contains(BoardWords.hasThread), "controls: \(tree.controlNames)")
    #expect(tree.saysAssistant.isEmpty, "\(tree.saysAssistant)")
}

@MainActor
@Test func moveListReadsEachRefusalWithItsRow() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let blocked = try #require(model.cards.first { $0.column == "blocked" })
    let tree = try await AccessibilityProbe.snapshot(MoveList(moves: model.moves(for: blocked)) { _ in })
    defer { tree.close() }
    #expect(tree.unlabeledControls.isEmpty)
    let names = tree.controlNames
    #expect(names.contains("Backlog, unblocks it"), "names: \(names)")
    #expect(names.contains("In Progress, dimmed. nothing claims a blocked card — unblock it first"), "names: \(names)")
    #expect(names.contains("Done, dimmed. only the one holding a card closes it — claim it first"), "names: \(names)")
    #expect(names.contains("Assigned, dimmed. unblocked, nobody's name is on it, so it goes back to Backlog"), "names: \(names)")
}

@MainActor
@Test func theCardAndTheRoomSpeakEveryControl() async throws {
    let console = BoardConsole()
    let (board, session) = boardModel(console)
    defer { withExtendedLifetime(session) {} }
    await board.load()
    let detail = CardDetailModel(.work(try #require(board.card(1))), session: session)
    let card = try await AccessibilityProbe.snapshot(CardDetailView(model: detail, assistantName: "Aide", now: recordedNow, onOpenRoom: { _ in }))
    defer { card.close() }
    #expect(card.unlabeledControls.isEmpty, "unlabeled: \(card.unlabeledControls)")
    for name in ["Edit the description", "Open Room →", "Comment"] { #expect(card.controlNames.contains(name), "controls: \(card.controlNames)") }
    for heading in ["Description", "Held By", "Thread"] { #expect(card.labels.contains(heading) || card.texts.contains(heading), "headings: \(card.headings)") }

    let task = try #require(TodayTask(json: .object(["task_key": .string("mt-1"), "text": .string("Sign the SOW"), "path": .string("Meetings/Vendor.md")])))
    let line = try await AccessibilityProbe.snapshot(CardDetailView(model: CardDetailModel(.task(task), session: session), assistantName: "Aide", now: recordedNow, onOpenPath: { _ in }))
    defer { line.close() }
    #expect(line.unlabeledControls.isEmpty, "unlabeled: \(line.unlabeledControls)")
    #expect(line.controlNames.contains("Complete, Space"), "controls: \(line.controlNames)")
    #expect(line.controlNames.contains("Open in Obsidian, Command-O"), "controls: \(line.controlNames)")
    #expect(line.controlNames.contains { $0.hasPrefix("Delegate") }, "controls: \(line.controlNames)")

    let room = RoomModel(workID: 3, session: session)
    await room.load()
    let pane = try await AccessibilityProbe.snapshot(RoomPane(model: room, assistantName: "Aide", onClose: {}).frame(width: 700, height: 500))
    defer { pane.close() }
    // AppKit's text field answers its label on the cell, not through the probe (as Capture's and Chat's tests read it)
    #expect(pane.unlabeledControls.filter { !["AXTextField", "AXTextArea"].contains($0.role) }.isEmpty, "unlabeled: \(pane.unlabeledControls)")
    for name in [RoomWords.resolve, RoomWords.close, RoomWords.add] { #expect(pane.controlNames.contains(name), "controls: \(pane.controlNames)") }
    #expect(textFieldLabels(in: pane.window) == [RoomWords.composer], "the composer says what it is: no @, no recipient")
}

@MainActor
@Test func everyInkOnTheBoardClearsItsGroundInBothSchemes() throws {
    let now = recordedNow
    let shapes: [JSONValue] = [
        row(id: 1, title: "t", status: "open", ageHours: 5),
        row(id: 2, title: "t", status: "open", owner: "crew-a"),
        row(id: 3, title: "t", status: "in_progress", claimedBy: "crew-b", lease: "2026-09-27T03:09:35.215Z", escalated: true),
        row(id: 4, title: "t", status: "blocked", escalated: true, blockedBy: "vault:x.md#^a", blockedByTask: "Call", blockedByTaskOpen: true),
        row(id: 5, title: "t", status: "open", escalated: true, due: "2026-09-01"),
        row(id: 6, title: "t", status: "closed", reported: true),
    ]
    for scheme in [ColorScheme.light, .dark] {
        for shape in shapes {
            for mark in BoardCardView.marks(BoardCardFacets(try decode(shape), now: now, assistantName: "Aide"), on: BoardView.cardGround) {
                #expect(Contrast.ratio(mark.ink, mark.ground, scheme) >= 4.5, "\(mark.ink.rawValue) on \(mark.ground.rawValue) in \(scheme): \(mark.text)")
            }
        }
        #expect(Contrast.ratio(.textPrimary, .failedQuiet, scheme) >= 4.5, "the refusal band")
        #expect(Contrast.ratio(.textPrimary, .degradedQuiet, scheme) >= 4.5, "the room's came-to-you band")
        #expect(Contrast.ratio(.degraded, BoardView.columnGround, scheme) >= 3, "the escalation count's glyph")
        #expect(Contrast.ratio(.textSecondary, BoardView.columnGround, scheme) >= 4.5, "a column's count")
    }
}

@MainActor
@Test func aCardGrowsLongerNeverWiderAtTheLargestText() throws {
    let card = try decode(row(id: 1, title: "A title long enough to wrap its card at the largest text size the Mac offers", status: "blocked", escalated: true, hasThread: true, threadCount: 4, blockedBy: "vault:x.md#^a", blockedByTask: "Send Dana the fixture format before Thursday", blockedByTaskOpen: true))
    var heights: [DynamicTypeSize: CGFloat] = [:]
    for size in [DynamicTypeSize.large, .accessibility5] {
        let renderer = ImageRenderer(content: BoardCardView(card: card, compact: false, selected: false, now: recordedNow, assistantName: "Aide").environment(\.dynamicTypeSize, size))
        renderer.proposedSize = ProposedViewSize(width: 220, height: nil)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        #expect(CGFloat(image.width) <= 220, "\(image.width) wide at \(size)")
        heights[size] = CGFloat(image.height)
    }
    #expect((heights[.accessibility5] ?? 0) > (heights[.large] ?? 0))
}

@MainActor
@Test func openingTheBoardNeverRaisesTheWindowsMinimum() async throws {
    let (model, _, session) = try await fixtureModel()
    defer { withExtendedLifetime(session) {} }
    let window = try await ShellProbe.acrossTheSwitch { BoardView(model: model, assistantName: "Aide", tick: .seconds(3600)) }
    #expect(window.after.minimum.height <= max(window.before.minimum.height, 460), "opening the Board raised the window's minimum to \(window.after.minimum)")
    #expect(window.after.frame == window.before.frame, "the window moved: \(window.before.frame) → \(window.after.frame)")
    let probe = MinimumProbe()
    let size = probe.minimum(of: BoardView(model: model, assistantName: "Aide", tick: .seconds(3600)))
    #expect(size.height <= 460 && size.width <= 460, "the board asks for \(size) at the least")
}

@Test func noStringInTheBoardsSourcesSaysAssistantOrBindsAKey() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    var literals: [String] = []
    for name in ["board-view.swift", "board-model.swift", "card-detail-view.swift", "room-view.swift"] {
        let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
        // §2.18.4: nothing on these screens slides; C119: no key outside the menu table
        #expect(!text.contains("withAnimation") && !text.contains(".animation(") && !text.contains(".transition("), "\(name)")
        #expect(!text.contains(".keyboardShortcut("), "\(name)")
        for line in text.split(separator: "\n") where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !line.trimmingCharacters(in: .whitespaces).hasPrefix("///") {
            let parts = line.split(separator: "\"", omittingEmptySubsequences: false)
            literals += stride(from: 1, to: parts.count, by: 2).map { String(parts[$0]) }
        }
    }
    #expect(literals.count > 80, "the scan found almost nothing")
    for literal in literals {
        // an interpolation's `assistantName` is code, not words
        let words = literal.replacingOccurrences(of: "assistantName", with: "")
        #expect(!words.localizedCaseInsensitiveContains("assistant"), "\"\(literal)\"")
        #expect(literal.range(of: #"\bMetis\b"#, options: .regularExpression) == nil, "\"\(literal)\"")
        #expect(!literal.contains("Addressed To"), "C38: the column is Assigned")
    }
}

// MARK: - Helpers

private let utc = TimeZone(identifier: "UTC")!
/// The clock the scripted boards are read at.
private let recordedNow = WireTime.date("2026-09-27T03:21:35.215Z")!
/// Two hours and three quarters after the recorded board's `as_of` — read from
/// the fixture, since every recording stamps its board at its own wall clock (X-29).
private let fixtureNow = ConsoleFixture.asOf("get-api-q-board").addingTimeInterval(2 * 3600 + 45 * 60)

@MainActor
private func boardModel(_ console: any ConsoleCallTransport, now: Date = recordedNow) -> (BoardModel, ConsoleSession) {
    let session = ConsoleSession(transport: console, management: nil)
    return (BoardModel(session: session, timeZone: utc, now: { now }), session)
}

@MainActor
private func fixtureModel() async throws -> (BoardModel, FixtureConsole, ConsoleSession) {
    let console = try FixtureConsole.recorded()
    let (model, session) = boardModel(console, now: fixtureNow)
    await model.load()
    #expect(model.cards.count == 6, "the recorded board")
    return (model, console, session)
}

@MainActor
private func textFieldLabels(in window: NSWindow) -> [String] {
    func fields(_ view: NSView) -> [NSTextField] {
        ((view as? NSTextField).map { $0.isEditable ? [$0] : [] } ?? []) + view.subviews.flatMap(fields)
    }
    return (window.contentView.map(fields) ?? []).map { $0.cell?.accessibilityLabel() ?? $0.accessibilityLabel() ?? "" }
}

private func describe(_ r: TasksService.Row) -> String {
    "\(r.status) owner=\(r.owner ?? "-") holder=\(r.claimedBy ?? "-")\(r.leaseLapsed ? " (lapsed)" : "")"
}

private func boardCard(id: Int, shape: TasksService.Row, now: Date) throws -> BoardCard {
    let lease = shape.claimedBy == nil ? nil : (shape.leaseLapsed ? "2026-09-27T03:00:00.000Z" : "2026-09-27T04:00:00.000Z")
    return try decode(row(id: id, title: "card \(id)", status: shape.status, owner: shape.owner, claimedBy: shape.claimedBy, lease: lease))
}

private func decode(_ json: JSONValue) throws -> BoardCard {
    try JSONDecoder().decode(BoardCard.self, from: JSONEncoder().encode(json))
}

/// One `board` row, in the wire's own spelling.
private func row(
    id: Int, title: String, status: String, owner: String? = nil, claimedBy: String? = nil, lease: String? = nil,
    escalated: Bool = false, due: String? = nil, reported: Bool = false, lastReportAt: String? = nil, updatedAt: String? = nil,
    externalRef: String? = nil, hasThread: Bool = false, threadCount: Int = 0, ageHours: Double = 0,
    blockedBy: String? = nil, blockedByTask: String? = nil, blockedByTaskOpen: Bool? = nil, description: String? = nil
) -> JSONValue {
    let column = TasksService.column(TasksService.Row(status: status, owner: owner, claimedBy: claimedBy, leaseLapsed: false))
    func s(_ v: String?) -> JSONValue { v.map(JSONValue.string) ?? .null }
    return .object([
        "column": .string(column), "id": .string(String(id)), "title": .string(title), "description": s(description), "kind": .string("task"),
        "project": .string("metistry"), "owner": s(owner), "claimed_by": s(claimedBy), "lease_expires_at": s(lease),
        "age_hours": .number(ageHours), "last_report_at": s(lastReportAt), "reported": .bool(reported), "escalated": .bool(escalated),
        "external_ref": s(externalRef), "artifact": .null, "has_thread": .bool(hasThread), "thread_count": .number(Double(threadCount)),
        "blocked_by": s(blockedBy), "blocked_by_task": s(blockedByTask), "blocked_by_task_open": blockedByTaskOpen.map(JSONValue.bool) ?? .null,
        "status": .string(status), "due": s(due), "updated_at": s(updatedAt),
    ])
}

/// A console that serves the board it holds — the recorded board until a
/// test replaces `rows` — and answers the task routes, failing where a test
/// says; everything else from the recorded fixtures.
private final class BoardConsole: ConsoleCallTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _rows: [JSONValue]?
    private var _counts: [BoardProjectCount]?
    private var _failures: [String: ConsoleError] = [:]
    private var _calls: [FixtureCall] = []
    private var _writes: [String] = []
    private var _bodies: [JSONValue] = []
    private var _boardReads = 0
    private var _down: String?
    private var _room: JSONValue?
    private var _pages: [String: String] = [:]
    private let fallback = try? FixtureConsole.recorded()

    var rows: [JSONValue]? { get { lock.withLock { _rows } } set { lock.withLock { _rows = newValue } } }
    var counts: [BoardProjectCount]? { get { lock.withLock { _counts } } set { lock.withLock { _counts = newValue } } }
    var failures: [String: ConsoleError] { get { lock.withLock { _failures } } set { lock.withLock { _failures = newValue } } }
    var calls: [FixtureCall] { lock.withLock { _calls } }
    var writes: [String] { get { lock.withLock { _writes } } set { lock.withLock { _writes = newValue } } }
    var bodies: [JSONValue] { lock.withLock { _bodies } }
    var boardReads: Int { lock.withLock { _boardReads } }
    var down: String? { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    var room: JSONValue? { get { lock.withLock { _room } } set { lock.withLock { _room = newValue } } }
    var pages: [String: String] { get { lock.withLock { _pages } } set { lock.withLock { _pages = newValue } } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
        let bare = String(path.split(separator: "?").first ?? "")
        let scripted: Result<Data, ConsoleError>? = lock.withLock {
            _calls.append(FixtureCall(method: method, path: path, body: sent, idempotencyKey: idempotencyKey, lastEventID: nil, servedBy: nil))
            if let down = _down { return .failure(.transport(down)) }
            if method != "GET", bare.hasPrefix("/api/tasks/") || bare.hasPrefix("/api/work/") {
                if bare.hasPrefix("/api/tasks/") { _writes.append("\(method) \(bare)") }
                _bodies.append(sent ?? .object([:]))
                if let failure = _failures["\(method) \(bare)"] { return .failure(failure) }
            }
            if bare == "/api/q/board" {
                _boardReads += 1
                if let rows = _rows { return .success(try! JSONEncoder().encode(JSONValue.object(["rows": .array(rows), "as_of": .string("2026-09-27T00:36:35.462Z")]))) }
            }
            if bare == "/api/q/board_projects", let counts = _counts {
                return .success(try! JSONEncoder().encode(BoardProjects(rows: counts, asOf: "2026-09-27T00:36:35.462Z")))
            }
            if bare.hasPrefix("/api/work/"), bare.hasSuffix("/thread"), method == "GET", let room = _room {
                return .success(try! JSONEncoder().encode(room))
            }
            if bare == "/api/knowledge/page", let p = URLComponents(string: "http://x\(path)")?.queryItems?.first(where: { $0.name == "path" })?.value, let content = _pages[p] {
                return .success(try! JSONEncoder().encode(JSONValue.object(["path": .string(p), "content": .string(content)])))
            }
            return nil
        }
        if let scripted { return scripted }
        guard let fallback else { return .failure(.transport("no fixtures")) }
        // a task route answers from its fixture whatever the id
        return await fallback.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }
}
#endif
