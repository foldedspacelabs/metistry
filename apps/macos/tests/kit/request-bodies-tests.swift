// Needs You: the bodies (T5-4b). The twelve types by body block, stepped
// questions with their summary, the `409` repaint, Accept All in order behind
// a ten-second Undo — each rule its own test, built against the recorded
// fixtures (F-7) wherever a route serves the row, and against the rows the
// product's own producers write where one does not yet (each names its file).
//
// THE SHAPES BELOW ARE CORE'S OWN OUTPUT. `requestShapes` is
// `describeRequest(kind, payload)` from packages/core/src/requests.ts, printed
// by running that file under Node (`node --experimental-strip-types`) — so a
// test here reads exactly what `GET /api/proposals` serves for each kind, and
// `theUnknownReadingIsCoresOwn` holds the kit's one constant to it.

import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

let requestShapes: [String: String] = [
    "decision": #"{"type":"question","word":"question","body":"choices","primary":{"label":"Send Answers","sends":{"decision":"answers"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["answers","accept_with_changes","deny"]}"#,
    "pull_request": #"{"type":"pull_request","word":"pull request","body":"diff","primary":{"label":"Approve","sends":{"door":"pr_review"},"carries":"feedback"},"revise":{"label":"Request Changes","sends":{"door":"pr_review"},"carries":"feedback","required":true},"decline":null,"grouped":false,"decisions":[]}"#,
    "pull_request+thread": #"{"type":"pull_request","word":"pull request","body":"thread","primary":{"label":"Reply","sends":{"door":"pr_review"},"carries":"feedback","required":true},"revise":{"label":"Request Changes","sends":{"door":"pr_review"},"carries":"feedback","required":true},"decline":null,"grouped":false,"decisions":[]}"#,
    "access_request": #"{"type":"access","word":"access","body":"before_after","primary":{"label":"Approve","sends":{"decision":"allow"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"area"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_with_changes","deny"]}"#,
    "action": #"{"type":"action","word":"action","body":"preview","primary":{"label":"Approve","sends":{"decision":"allow"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_with_changes","deny"]}"#,
    "knowledge": #"{"type":"note","word":"note","body":"preview","primary":{"label":"Approve","sends":{"decision":"allow"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_with_changes","deny"]}"#,
    "knowledge+work": #"{"type":"note","word":"note","body":"preview","primary":{"label":"Approve","sends":{"decision":"accept_as_work"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_as_work","accept_with_changes","deny"]}"#,
    "review": #"{"type":"review","word":"review","body":"preview","primary":{"label":"Approve","sends":{"decision":"allow"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_with_changes","deny"]}"#,
    "review+before_after": #"{"type":"review","word":"review","body":"before_after","primary":{"label":"Keep Mine","sends":{"door":"resolve_conflict"}},"revise":{"label":"Take the Other","sends":{"door":"resolve_conflict"}},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["deny"]}"#,
    "improvement": #"{"type":"improvement","word":"improvement","body":"before_after","primary":{"label":"Approve","sends":{"decision":"allow"}},"revise":{"label":"Revise","sends":{"decision":"accept_with_changes"},"carries":"feedback"},"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["allow","accept_with_changes","deny"]}"#,
    "report": #"{"type":"report","word":"report","body":"excerpt","primary":{"label":null,"sends":{"door":"act"}},"revise":null,"decline":{"label":"Dismiss","sends":{"decision":"skip"}},"grouped":false,"decisions":["skip"]}"#,
    "invitation": #"{"type":"invitation","word":"invitation","body":"preview","primary":{"label":"Accept","sends":{"door":"rsvp"}},"revise":{"label":"Maybe","sends":{"door":"rsvp"}},"decline":{"label":"Decline","sends":{"door":"rsvp"}},"grouped":false,"decisions":[]}"#,
    "task": #"{"type":"task","word":"task","body":"excerpt","primary":{"label":"Add to Today","sends":{"door":"today"}},"revise":null,"decline":{"label":"Delegate","sends":{"door":"delegate"}},"grouped":false,"decisions":[]}"#,
    "message": #"{"type":"message","word":"message","body":"excerpt","primary":{"label":"Draft Reply","sends":{"door":"draft"}},"revise":null,"decline":{"label":"Not Mine","sends":{"decision":"skip"}},"grouped":false,"decisions":["skip"]}"#,
    "zebra": #"{"type":"report","word":"report","body":"excerpt","primary":null,"revise":null,"decline":{"label":"Dismiss","sends":{"decision":"skip"}},"grouped":false,"decisions":["skip"]}"#,
]

// MARK: - Rows, as GET /api/proposals serves them

/// One row through the wire's own `Decodable`, `request` and all.
func requestRow(_ id: Int, _ kind: String, shape: String? = nil, payload: String, ts: String = "2026-09-28T12:00:00.000Z", trust: String = "internal", agent: String = "assistant") throws -> RequestRow {
    let request = shape.map { requestShapes[$0]! } ?? requestShapes[kind] ?? "null"
    let json = """
    {"id": "\(id)", "ts": "\(ts)", "kind": "\(kind)", "source_agent": "\(agent)", "trust": "\(trust)", "payload": \(payload),
     "decision": "pending", "decided_at": null, "work_id": null, "snoozed_until": null, "request": \(request)}
    """
    return try JSONDecoder().decode(RequestRow.self, from: Data(json.utf8))
}

let assistantName = "Aide"
private let clock = SampleClock.clock
private let now = SampleClock.now
private let today = SampleClock.today

/// A console that answers each call from a script, and remembers what it was sent.
final class AnswerConsole: ConsoleCallTransport, @unchecked Sendable {
    typealias Reply = Result<Data, ConsoleError>
    struct Call: Sendable, Equatable {
        let method: String
        let path: String
        let body: JSONValue?
    }

    private let lock = NSLock()
    private var log: [Call] = []
    private var inFlight = 0
    private(set) var mostInFlight = 0
    private let script: @Sendable (Call, Int) -> Reply

    init(_ script: @escaping @Sendable (Call, Int) -> Reply) {
        self.script = script
    }

    var calls: [Call] { lock.withLock { log } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Reply {
        let call = Call(method: method, path: path, body: body.flatMap { try? JSONValue.parse($0) })
        let n: Int = lock.withLock {
            log.append(call)
            inFlight += 1
            mostInFlight = max(mostInFlight, inFlight)
            return log.count
        }
        // Long enough that a second answer sent without waiting would overlap this one.
        try? await Task.sleep(for: .milliseconds(5))
        lock.withLock { inFlight -= 1 }
        return script(call, n)
    }

    static func ok(_ json: String = #"{"ok":true}"#) -> Reply { .success(Data(json.utf8)) }

    static func refusal(_ status: Int, _ json: String) -> Reply {
        .failure(.http(status: status, envelope: ConsoleErrorEnvelope(json: try! JSONValue.parse(Data(json.utf8)))))
    }
}

@MainActor
private func stores(_ transport: any ConsoleCallTransport, reachable: Bool = true) -> (ConsoleStores, ReachabilityGate) {
    let gate = ReachabilityGate(transport, initially: reachable ? .reachable : .unreachable("connect ECONNREFUSED 127.0.0.1:8080"))
    return (ConsoleStores(transport: gate), gate)
}

@MainActor
private func card(_ row: RequestRow, _ transport: any ConsoleCallTransport = AnswerConsole { _, _ in .success(Data(#"{"ok":true}"#.utf8)) }) -> RequestAnswering {
    RequestAnswering(row, store: stores(transport).0, assistantName: assistantName)
}

@MainActor
private func present(_ model: RequestAnswering, allowsDecisions: Bool = true) -> RequestCardPresentation {
    RequestCard.presentation(model, allowsDecisions: allowsDecisions, today: today, now: now, clock: clock)
}

// MARK: - The reading is the server's (X-5)

@Test func everyFixtureRowCarriesItsReadingAndTheCardDrawsTheWordItIsGiven() async throws {
    let rows = try await ConsoleStores(transport: try FixtureConsole.recorded()).requests().get().proposals
    #expect(rows.map { $0.request?.word } == ["report", "note", "question"])
    #expect(rows.map { $0.shape.bodyKind } == [.excerpt, .preview, .choices])
    for row in rows {
        let reading = RequestReading(row, assistantName: assistantName)
        // the word the owner reads is served — never the stored kind
        #expect(reading.shape.word == row.request?.word)
        #expect(reading.asker?.label == "Aide", "the assistant by its configured name (C88)")
    }
    let question = try #require(rows.first { $0.kind == "decision" })
    #expect(question.shape.primary == RequestShape.Answer(label: "Send Answers", sends: .init(decision: "answers")))
    #expect(question.shape.revise?.carrying == .feedback)
}

@MainActor
@Test func theUnknownReadingIsCoresOwn() throws {
    let served = try JSONDecoder().decode(RequestShape.self, from: Data(requestShapes["zebra"]!.utf8))
    #expect(served == RequestShape.unknownKind)
    // A row from a console that predates X-5 reads the same: a report, an excerpt, Dismiss alone.
    let old = RequestRow(id: 9, ts: "2026-09-28T12:00:00.000Z", kind: "zebra", payload: .object(["title": .string("Something new")]))
    #expect(old.request == nil)
    let model = RequestAnswering(old, store: ConsoleStores(transport: AnswerConsole { _, _ in AnswerConsole.ok() }), assistantName: assistantName)
    let p = RequestCard.presentation(model, allowsDecisions: true, today: today, now: now, clock: clock)
    #expect(p.header.first?.text == "report", "never the stored kind")
    #expect(p.answers.map(\.control.label) == ["Dismiss"])
}

@MainActor
@Test func aReadingANewerConsoleServesStillDecodes() throws {
    // an unknown `carries`, and a door this build does not know
    let json = #"{"type":"thing","word":"thing","body":"hologram","primary":{"label":"Beam","sends":{"door":"teleport"},"carries":"vibes"},"revise":null,"decline":{"label":"Decline","sends":{"decision":"deny"}},"grouped":false,"decisions":["deny"]}"#
    let shape = try JSONDecoder().decode(RequestShape.self, from: Data(json.utf8))
    #expect(shape.primary?.carrying == nil, "an unknown `carries` carries nothing")
    #expect(shape.bodyKind == .excerpt, "a block outside the closed set draws as the one that claims least")
    let row = try requestRow(4, "thing", shape: nil, payload: #"{"title":"x","summary":"y"}"#)
    #expect(row.request == nil, "no table entry for `thing` in this test's shapes, so nothing was served")
    let model = card(RequestRow(id: 4, ts: row.ts, kind: "thing", payload: row.payload, request: shape))
    #expect(present(model).answers.map(\.control.label) == ["Decline"], "a door this build does not know is not offered")
}

// MARK: - The twelve types, by body block

/// Real payloads, as their producers write them (the file is named on each).
private let payloads: [String: String] = [
    // apps/assistant/src/drain.ts
    "question": #"{"title":"Which fixture format?","options":["one file per route","one file per store"],"thread":"t"}"#,
    // T2-13's pull request, with its patch
    "pull_request": #"{"title":"Review foldedspacelabs/metistry#418","repo":"foldedspacelabs/metistry","number":418,"patch":"@@ -1,2 +1,2 @@\n context\n-old line\n+new line"}"#,
    "pull_request+thread": #"{"title":"Dana replied on #418","body":{"kind":"thread","location":"apps/console/src/server.ts:630","code":["return refuse(409)"],"messages":[{"author":"dana","at":"2026-09-28T12:40:00.000Z","text":"409 or 422?"},{"author":"cursor","by_agent":true,"text":"409."}]}}"#,
    // packages/mcp-brain/src/access.ts
    "access_request": #"{"title":"devin asks to read Areas/Health","area":"Areas/Health","reason":"The sleep log is there.","current_tier":"index","current_areas":[],"current_scope":{"line":"external · titles · autonomy: observe"},"escalated":true,"prior_proposal":311,"prior_declined_at":"2026-09-27T13:14:00.000Z"}"#,
    // packages/mcp-brain/src/action-tools.ts
    "action": #"{"title":"Comment on work #41","action":{"kind":"comment","args":{"work_id":41,"body":"Moved to Friday — waiting on the store list."}},"reason":"The owner asked for a status note."}"#,
    // collectors/inbox-drain/run.ts
    "knowledge": #"{"inbox_id":7,"path":"Inbox/2026-09-28-lease.md","classification":{"kind":"note","title":"Lease renewal terms"},"note":"Landlord wants 60 days' notice."}"#,
    "knowledge+work": #"{"inbox_id":8,"path":"Inbox/cert.md","classification":{"kind":"task","title":"Cert"},"note":"renew the wildcard cert","suggested_work":{"title":"renew the wildcard cert"}}"#,
    // packages/artifacts/src/service.ts — a thread past its ping-pong cap
    "review": #"{"reason":"ping_pong_cap","title":"review thread needs you: 6 agent exchanges on art_1","path":"Projects/Metistry/spec.md","transcript":[{"author":"collator","author_kind":"agent","at":"2026-09-28T11:00:00.000Z","body":"I still think the table belongs in §2."}]}"#,
    // T2-9's knowledge conflict, both versions in the body
    "review+before_after": #"{"title":"Conflict: Lease.md","body":{"kind":"before_after","heading":"Knowledge Conflict","before":{"label":"Yours · 9:12 PM","text":"Renewal due 1 Nov."},"after":{"label":"The fold's · 9:14 PM","text":"Renewal due 1 Nov; 60 days' notice."}}}"#,
    // apps/console/src/profile-tidy.ts
    "improvement": #"{"title":"Tidy Me/profile.md","body":{"kind":"before_after","heading":"What Approve Writes","before":{"label":"Now","text":"likes: tea, tea"},"after":{"label":"Tidied","text":"likes: tea"}},"edit":{"path":"Me/profile.md","base_sha256":"abc"}}"#,
    // routines/plan-tomorrow/run.ts
    "report": #"{"title":"Templates/Plan.md could not be read — no plan for 2026-09-29","summary":"The template is not readable text.","refs":["Templates/Plan.md"]}"#,
    "invitation": #"{"title":"Vendor review — Tue 2:00 PM","summary":"Kessler invited you · Room 4 · overlaps Standup"}"#,
    "task": #"{"title":"ABC-123 Fix the export","summary":"Exports drop the last row.","source_label":"Linear · ABC-123"}"#,
    "message": #"{"title":"Re: Q4 scope","excerpt":"Can you send the revised scope by Friday?","from":"Jim Fallon","reason":"Aide thinks this needs you — Mail didn't say so."}"#,
]

@Test func theTwelveTypesEachDrawTheirBodyBlock() throws {
    let expected: [(String, RequestBodyKind?)] = [
        ("question", nil), // choices: the steps draw it
        ("pull_request", .diff), ("pull_request+thread", .thread),
        ("access_request", .beforeAfter), ("action", .preview),
        ("review", .preview), ("review+before_after", .beforeAfter),
        ("knowledge", .preview), ("improvement", .beforeAfter),
        ("report", .excerpt), ("invitation", .preview), ("task", .excerpt), ("message", .excerpt),
    ]
    var types: Set<String> = []
    for (key, kind) in expected {
        let storedKind = key.split(separator: "+").first.map(String.init)! == "question" ? "decision" : key.split(separator: "+").first.map(String.init)!
        let row = try requestRow(1, storedKind, shape: key == "question" ? "decision" : key, payload: payloads[key]!)
        let reading = RequestReading(row, assistantName: assistantName)
        types.insert(reading.shape.type)
        #expect(reading.body?.kind == kind, "\(key): \(String(describing: reading.body?.kind))")
        #expect(reading.partial == nil, "\(key) is whole: \(String(describing: reading.partial))")
        if kind == nil { #expect(reading.questions?.questions.count == 1) }
    }
    // the meeting, from a group of parts
    let parts = try (1...2).map { try requestRow($0, "knowledge", payload: #"{"title":"Send Kessler the scope \#($0)","due":"2026-09-30","people":["Kessler"]}"#) }
    let meeting = MeetingGroup(id: "mtg-1", parts: parts)
    #expect(meeting.todos(assistantName: assistantName).map(\.text) == ["Send Kessler the scope 1", "Send Kessler the scope 2"])
    #expect(meeting.todos(assistantName: assistantName)[0].facets.people == ["Kessler"])
    types.insert(RequestShape.meeting.type)
    #expect(types.count == 12, "every one of the twelve: \(types.sorted())")
}

@Test func eachBodyReadsWhatItsProducerWrote() throws {
    func reading(_ key: String, _ kind: String) throws -> RequestReading {
        RequestReading(try requestRow(1, kind, shape: key, payload: payloads[key]!), assistantName: assistantName)
    }
    // a pull request's patch: headers dropped, + and − kept
    guard case .diff(let d)? = try reading("pull_request", "pull_request").body else { Issue.record("no diff"); return }
    #expect(d.title == "foldedspacelabs/metistry#418")
    #expect(d.lines == [DiffLine(.context, "context"), DiffLine(.removed, "old line"), DiffLine(.added, "new line")])
    // access: the set the grant becomes, the scope as given, the trade and the re-ask
    let access = try reading("access_request", "access_request")
    guard case .beforeAfter(let b)? = access.body, case .sets(let before, let after, let total) = b.content else { Issue.record("no sets"); return }
    #expect(before == [] && after == ["Areas/Health"] && total == "It would then read 1 folder")
    #expect(access.holds == "external · titles · autonomy: observe", "rendered as given (§9.1)")
    #expect(access.context == "The sleep log is there.", "the agent's own words")
    #expect(access.notes.contains(.trade("Approving trades its whole-vault title browse for reads inside Areas/Health.")))
    #expect(access.notes.contains { if case .askedAgain(_, .some(311)) = $0 { return true } else { return false } })
    // an action's comment is the agent's words, shown before Approve posts them (review 01)
    guard case .preview(let v)? = try reading("action", "action").body else { Issue.record("no preview"); return }
    #expect(v.agentWords && v.text == "Moved to Friday — waiting on the store list." && v.path == "work #41")
    // a review's reason is a code, never shown as prose
    #expect(try reading("review", "review").context == nil)
    // Approve makes the task, and says so before it does (components-01 §2.4)
    let work = try reading("knowledge+work", "knowledge")
    #expect(work.notes == [.makesTask("Approve also adds the task “renew the wildcard cert” to the board")])
    // a message: the excerpt, and the assistant's reason as context
    let message = try reading("message", "message")
    guard case .excerpt(let e)? = message.body else { Issue.record("no excerpt"); return }
    #expect(e.text == "Can you send the revised scope by Friday?" && e.source == "Jim Fallon")
    #expect(message.context == "Aide thinks this needs you — Mail didn't say so.")
}

@MainActor
@Test func aBodyThePayloadCannotFillIsPartialAndTheRestOfTheCardStands() throws {
    let row = try requestRow(5, "pull_request", payload: #"{"title":"Review #419","repo":"a/b","number":419}"#)
    let model = card(row)
    let p = present(model)
    #expect(model.reading.body == nil)
    #expect(p.partial?.text == "the changes didn't come with this request — the rest of it is here")
    #expect(p.partial?.glyph == .degraded)
    #expect(p.ask.text == "Review #419")
    #expect(p.answers.map(\.control.label) == ["Approve", "Request Changes"], "the answers never depend on the body")
    // a question whose questions did not come: no Send Answers to press, Revise and Decline still there
    let empty = present(card(try requestRow(9, "decision", payload: #"{"thread":"t"}"#)))
    #expect(empty.partial?.text == "the questions did not arrive with this request — Revise to say so, or Decline it")
    #expect(empty.answers.map(\.control.label) == ["Revise", "Decline"])
    // the improvement whose file is not in the request: the section, and why the rest is missing
    let append = RequestReading(try requestRow(6, "improvement", payload: ###"{"title":"Reply quality","suggested_edit":{"path":"Me/prompt-overlay.md","mode":"append_section","content":"## Replies\nShorter."}}"###), assistantName: assistantName)
    #expect(append.partial?.text == "only the new section is in this request — the rest of Me/prompt-overlay.md stays as it is")
}

// MARK: - The answers (C92; components-01 §2.4)

@MainActor
@Test func theAnswersArePrimaryReviseDeclineThenLaterAndEachSaysWhatItIs() throws {
    let model = card(try requestRow(2, "action", payload: payloads["action"]!))
    let p = present(model)
    #expect(p.answers.map(\.control.label) == ["Approve", "Revise", "Decline"])
    #expect(p.answers.map(\.control.role) == [.primary, .secondary, .secondary], "Approve is the one filled button")
    #expect(p.answers.map(\.control.glyph) == [.approve, .edit, .decline], "a check and a cross, so the pair survives greyscale")
    #expect(p.later?.label == "" && p.later?.glyph == .later && p.later?.spoken == "Later, L")
    #expect(p.facts.isEmpty)
}

@MainActor
@Test func whileUnreachableEveryAnswerIsOffAndSaysWhyOnce() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let (s, _) = stores(transport, reachable: false)
    let model = RequestAnswering(try requestRow(2, "action", payload: payloads["action"]!), store: s, assistantName: assistantName)
    let p = RequestCard.presentation(model, allowsDecisions: false, today: today, now: now, clock: clock)
    #expect(p.answers.allSatisfy { $0.control.disabledBecause == StateWords.unreachable })
    #expect(p.later?.disabledBecause == StateWords.unreachable)
    #expect(p.facts.map(\.text) == [StateWords.unreachable], "the fact, once, under the controls it turned off")
    // …and the tool refuses it anyway: nothing reaches the transport, the draft is kept (O3).
    model.compose(.revise)
    model.words = "Say Thursday, not Friday."
    await model.press(.revise)
    #expect(transport.calls.isEmpty)
    #expect(model.phase == .held(StateWords.unreachable))
    #expect(model.words == "Say Thursday, not Friday.")
}

@MainActor
@Test func aDoorThisBuildCannotReachIsOffAndSaysSoAndDismissStillWorks() throws {
    let task = present(card(try requestRow(3, "task", payload: payloads["task"]!)))
    #expect(task.answers.map(\.control.label) == ["Add to Today", "Delegate"])
    #expect(task.answers.allSatisfy { !$0.control.isEnabled })
    #expect(task.answers[1].control.glyph == .spark, "Delegate, with the spark (amendments §8.1)")
    #expect(task.facts.map(\.text) == ["This build can't add a tracker's tasks to Today from here yet", "This build can't delegate a tracker's tasks from here yet"])
    let message = present(card(try requestRow(4, "message", payload: payloads["message"]!)))
    #expect(message.answers.map(\.control.label) == ["Draft Reply", "Not Mine"])
    #expect(!message.answers[0].control.isEnabled && message.answers[1].control.isEnabled, "Not Mine is a decision on the row")
    // a report names its act, or has none — its Dismiss is always there
    let report = present(card(try requestRow(5, "report", payload: payloads["report"]!)))
    #expect(report.answers.map(\.control.label) == ["Dismiss"])
    let acting = present(card(try requestRow(6, "report", payload: #"{"title":"Standup failed","summary":"token expired","act":{"label":"Try Again"}}"#)))
    #expect(acting.answers.map(\.control.label) == ["Try Again", "Dismiss"])
}

@MainActor
@Test func theItemMenuOffersOnlyWhatCanBePressedAndTheDetailAndMenuShareOneCard() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let cards = RequestCards(store: stores(transport).0, assistantName: assistantName)
    let row = try requestRow(2, "action", payload: payloads["action"]!)
    let model = cards.card(for: row)
    #expect(cards.card(for: row) === model, "one card per request, so the menu and the detail act on the same one")
    #expect(Set(model.itemActions(allowsDecisions: true).keys) == [.approve, .revise, .decline, .later])
    #expect(model.itemActions(allowsDecisions: false).isEmpty, "O3: nothing while unreachable")
    // a question on its first step: no Send yet, so no Approve
    let question = cards.card(for: try requestRow(1, "decision", payload: #"{"questions":[{"prompt":"a?","options":["x","y"]},{"prompt":"b?","options":["x","y"]}]}"#))
    #expect(Set(question.itemActions(allowsDecisions: true).keys) == [.revise, .decline, .later])
    // Approve from the menu is the primary verb, sent like the button
    model.itemActions(allowsDecisions: true)[.approve]?()
    for _ in 0..<50 where transport.calls.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
    #expect(transport.calls.first?.body?["decision"] == .string("allow"))
    cards.keep(only: [1])
    #expect(cards.card(for: row) !== model, "a request that left the queue lets its card go")
}

@MainActor
@Test func dismissSendsSkipAndTheCardCollapsesToItsReceipt() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = card(try requestRow(5, "report", payload: payloads["report"]!), transport)
    await model.press(.decline)
    #expect(transport.calls.map(\.body) == [.object(["decision": .string("skip"), "if_unchanged": .object(["seen_at": .string("2026-09-28T12:00:00.000Z")])])])
    #expect(model.phase == .settled(RequestReceipt("Dismissed", glyph: .decline)))
    let p = present(model)
    #expect(p.receipt?.text == "Dismissed" && p.answers.isEmpty, "collapsed to one line (components-01 §2.5)")
}

@MainActor
@Test func laterSettlesNothingSendsNoSeenAtAndLeavesWithoutAReceipt() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok(#"{"ok":true,"snoozed_until":"2026-09-28T16:00:00.000Z"}"#) }
    let model = card(try requestRow(2, "action", payload: payloads["action"]!), transport)
    await model.later()
    #expect(transport.calls.map(\.body) == [.object(["decision": .string("later")])])
    #expect(model.phase == .snoozed)
}

@MainActor
@Test func reviseOpensItsWordsAndAnEmptyReasonCancelsRatherThanSends() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = card(try requestRow(2, "action", payload: payloads["action"]!), transport)
    await model.press(.revise)
    #expect(model.composing == .revise)
    #expect(present(model).composer?.field == .words(placeholder: "What should change? Your words go back to whoever asked"))
    await model.press(.revise) // nothing typed
    #expect(model.composing == nil && transport.calls.isEmpty)
    await model.press(.revise)
    model.words = "  Say Thursday.  "
    await model.press(.revise)
    #expect(transport.calls.first?.body?["decision"] == .string("accept_with_changes"))
    #expect(transport.calls.first?.body?["feedback"] == .string("Say Thursday."))
    #expect(model.phase == .settled(RequestReceipt("Revised — your words went back to Aide", glyph: .edit)))
}

// MARK: - Access: Revise only grants less (C40), and the trade is said (C41)

@MainActor
@Test func accessReviseCanOnlyNameTheAskedAreaOrAFolderUnderIt() async throws {
    let transport = AnswerConsole { _, _ in
        AnswerConsole.ok(#"{"ok":true,"granted":{"agent":"devin","area":"Areas/Health/Sleep","grants":{"tier":"areas","areas":["Areas/Health/Sleep"],"queries":true},"prior_tier":"index"}}"#)
    }
    let model = card(try requestRow(7, "access_request", payload: payloads["access_request"]!, trust: "external", agent: "devin"), transport)
    await model.press(.revise)
    guard case .area(let prefix)? = present(model).composer?.field else { Issue.record("no area field"); return }
    #expect(prefix.text == "Areas/Health/", "the asked area is fixed text, not an edit")
    #expect(present(model).composer?.send.label == "Approve Health")
    // whatever is typed lands UNDER the ask: there is no way to write a sibling or a parent
    model.areaTail = "/Finance"
    #expect(model.revisedArea == "Areas/Health/Finance")
    model.areaTail = "../Finance"
    #expect(model.areaProblem != nil)
    #expect(model.resolve(.revise) == nil, "a traversal cannot be sent")
    #expect(present(model).composer?.send.disabledBecause == "a folder name can't be “.” or “..”")
    model.areaTail = "Sleep"
    #expect(present(model).composer?.send.label == "Approve Sleep")
    await model.press(.revise)
    #expect(transport.calls.first?.body?["area"] == .string("Areas/Health/Sleep"))
    #expect(transport.calls.first?.body?["decision"] == .string("accept_with_changes"))
    #expect(model.phase == .settled(RequestReceipt("Revised — devin can now read Areas/Health/Sleep, and no longer browses every title", glyph: .edit)), "C41, from prior_tier")
}

@MainActor
@Test func theConsolesWiderThanAskedRefusalIsShownInItsOwnWordsAndTheCardStaysAnswerable() async throws {
    let refusal = #"{"error":{"code":"invalid_request","message":"Revise can only grant less than was asked: Areas/Finance is not Areas/Health or a folder under it."},"asked":"Areas/Health"}"#
    let model = card(try requestRow(7, "access_request", payload: payloads["access_request"]!), AnswerConsole { _, _ in AnswerConsole.refusal(400, refusal) })
    await model.press(.revise)
    model.areaTail = "Sleep"
    await model.press(.revise)
    #expect(model.phase == .refused("Revise can only grant less than was asked: Areas/Finance is not Areas/Health or a folder under it."))
    let p = present(model)
    #expect(p.reason?.text == "Revise can only grant less than was asked: Areas/Finance is not Areas/Health or a folder under it.")
    #expect(p.answers.allSatisfy { $0.control.isEnabled }, "still answerable — a refusal is not a decision")
}

// MARK: - C45: a failed answer stays pending, and says so

@MainActor
@Test func aFailedConsequenceOnTheRowIsDrawnAsFailedWithItsReasonVerbatim() throws {
    let payload = #"{"title":"Dispatch #41","action":{"kind":"dispatch","args":{"work_id":41}},"error":{"code":"conflict","message":"task 6 is held by nobody, not by user","decision":"allow","at":"2026-09-28T12:14:00.000Z"}}"#
    let p = present(card(try requestRow(8, "action", payload: payload)))
    #expect(p.notices.map(\.text) == ["Couldn't approve this — it is still waiting · 8:14 AM"])
    #expect(p.notices.first?.glyph == .failed)
    #expect(p.reason?.text == "task 6 is held by nobody, not by user" && p.reason?.design == .mono)
    #expect(p.answers.map(\.control.label) == ["Approve", "Revise", "Decline"], "there is no retry — the owner decides again")
}

// MARK: - The 409 repaint

@MainActor
@Test func aStaleAnswerSendsNothingRepaintsTheCurrentRowAndTheNextAnswerClaimsIt() async throws {
    let moved = #"{"error":{"code":"conflict","message":"the proposal changed after you saw it"},"reason":"stale","decision":"pending","decided_at":null,"proposal":{"id":"2","ts":"2026-09-28T12:00:00.000Z","kind":"action","source_agent":"assistant","trust":"internal","payload":{"title":"Comment on work #41 (edited)","action":{"kind":"comment","args":{"work_id":41,"body":"Moved to Monday."}},"reason":"It moved again."},"decision":"pending","decided_at":null,"work_id":41,"snoozed_until":null,"changed_at":"2026-09-28T12:30:00.000Z"}}"#
    let transport = AnswerConsole { _, n in n == 1 ? AnswerConsole.refusal(409, moved) : AnswerConsole.ok() }
    let model = card(try requestRow(2, "action", payload: payloads["action"]!), transport)
    await model.press(.primary)
    #expect(transport.calls.count == 1, "it never re-sends")
    #expect(transport.calls[0].body?["if_unchanged"] == .object(["seen_at": .string("2026-09-28T12:00:00.000Z")]))
    #expect(model.phase == .open && model.repainted)
    let p = present(model)
    #expect(p.notices.first?.text == RequestCard.staleNotice)
    #expect(p.notices.first?.plate == .staleQuiet && p.notices.first?.glyph == .stale)
    #expect(p.ask.text == "Comment on work #41 (edited)", "the current version, beneath the notice")
    guard case .preview(let v)? = model.reading.body else { Issue.record("no preview"); return }
    #expect(v.text == "Moved to Monday.")
    #expect(model.reading.shape.word == "action", "the reading on screen is kept — the 409's row carries none")
    #expect(model.seenAt == "2026-09-28T12:30:00.000Z")
    await model.press(.primary)
    #expect(transport.calls[1].body?["if_unchanged"] == .object(["seen_at": .string("2026-09-28T12:30:00.000Z")]))
    #expect(model.phase == .settled(RequestReceipt("Approved", glyph: .approve)))
}

@MainActor
@Test func alreadyDecidedShowsWhatActuallyHappened() async throws {
    let winner = #"{"error":{"code":"conflict","message":"already decided"},"reason":"already_decided","decision":"deny","decided_at":"2026-09-28T12:10:00.000Z","proposal":{"id":"2","ts":"2026-09-28T12:00:00.000Z","kind":"action","decision":"deny"}}"#
    let model = card(try requestRow(2, "action", payload: payloads["action"]!), AnswerConsole { _, _ in AnswerConsole.refusal(409, winner) })
    await model.press(.primary)
    #expect(model.phase == .alreadyDecided(RequestReceipt("Already declined elsewhere — nothing was sent from here")))
    #expect(present(model).receipt?.text == "Already declined elsewhere — nothing was sent from here")
}

// MARK: - Stepped questions (§13.2; components-02 §3)

private let threeQuestions = #"{"title":"Three things about the Connections pane","questions":[{"prompt":"Where should the Connections table live?","options":["Its own file, SettingsConnections.swift","Inside settings-view.swift"]},{"prompt":"Which columns?","options":["Name","Status","Last used"],"multi":true},{"prompt":"Ship it behind a flag?","options":["Yes","No"],"allow_other":false}],"context":{"prose":"Three calls before I start.","refs":["docs/product/design/screen-15-settings.md"]}}"#

@MainActor
@Test func questionsStepOneAtATimeAndSendTogetherFromTheSummary() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = card(try requestRow(1, "decision", payload: threeQuestions), transport)
    var p = present(model)
    // one question fills the card: Question 1 of 3, its heading spoken as the Spoken table says
    #expect(p.body?.heading.last?.voice == "Question 1 of 3. Where should the Connections table live?")
    #expect(p.body?.controls.first?.spoken == "Its own file, SettingsConnections.swift. 1 of 3", "components-02 §3, verbatim")
    #expect(p.steps?.segments.map(\.showing) == [true, false, false])
    #expect(p.answers.map(\.control.label) == ["Next", "Revise", "Decline"], "Revise and Decline under every step; no Send until the summary")
    #expect(p.context?.text == "Three calls before I start.")
    #expect(p.refs.map(\.text) == ["docs/product/design/screen-15-settings.md"])

    await model.choose(0)
    model.steps?.next()
    await model.choose(0)
    await model.choose(2) // pick any: toggles
    model.steps?.next()
    p = present(model)
    #expect(p.body?.controls.map(\.label) == ["Yes", "No"], "allow_other: false — no Something else…")
    #expect(p.answers.map(\.control.label) == ["Back", "Next", "Revise", "Decline"])
    model.steps?.next()

    // Your Answers: each with Edit; Send dimmed, saying what is left
    p = present(model)
    #expect(p.steps?.summary?.map(\.answer.text) == ["Its own file, SettingsConnections.swift", "Name, Last used", "Not answered"])
    #expect(p.steps?.summary?.map(\.edit.spoken) == ["Edit question 1", "Edit question 2", "Edit question 3"])
    let send = try #require(p.answers.first { $0.action == .send }?.control)
    #expect(send.label == "Send Answers" && send.spoken == "Send answers" && send.disabledBecause == "1 question unanswered", "Send answers, dimmed. 1 question unanswered")
    #expect(p.facts.isEmpty, "the count is Send Answers' own line, not a fact about the system")
    #expect(p.remaining?.text == "1 question unanswered", "the count above it says how many are left (§12.3)")
    await model.press(.primary)
    #expect(transport.calls.isEmpty, "Send Answers fills only when every question has an answer")

    model.steps?.edit(2)
    await model.choose(1)
    model.steps?.next()
    #expect(present(model).answers.first { $0.action == .send }?.control.isEnabled == true)
    await model.press(.primary)
    #expect(transport.calls.count == 1, "one reply to the asker, not three")
    let body = try #require(transport.calls.first?.body)
    #expect(body["decision"] == .string("answers"))
    #expect(body["answers"] == .array([
        .object(["choices": .array([.string("Its own file, SettingsConnections.swift")])]),
        .object(["choices": .array([.string("Name"), .string("Last used")])]),
        .object(["choices": .array([.string("No")])]),
    ]))
    #expect(model.phase == .settled(RequestReceipt("3 answers sent", glyph: .approve)))
}

@MainActor
@Test func somethingElseIsAnAnswerInTheOwnersWords() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = card(try requestRow(1, "decision", payload: payloads["question"]!), transport)
    await model.choose(2) // Something else…
    #expect(transport.calls.isEmpty, "choosing Something else… opens the field; it does not send")
    #expect(present(model).body?.otherField == "")
    let send = try #require(present(model).answers.first { $0.action == .send }?.control)
    #expect(send.disabledBecause == "1 question unanswered", "no words yet")
    model.steps?.type("one file per route, grouped by store")
    await model.press(.primary)
    #expect(transport.calls.first?.body?["answers"] == .array([.object(["choices": .array([]), "other": .string("one file per route, grouped by store")])]))
}

@MainActor
@Test func aSingleQuestionSkipsTheSummaryChoosingSendsTheOptionItself() async throws {
    // the recorded fixture: the question row, and T2-3's recorded answer to it
    let console = try FixtureConsole.recorded()
    let (s, _) = stores(console)
    let row = try #require(try await s.requests().get().proposals.first { $0.kind == "decision" })
    let model = RequestAnswering(row, store: s, assistantName: assistantName)
    #expect(present(model).steps == nil, "no bar and no summary for one question")
    #expect(present(model).answers.map(\.control.label) == ["Revise", "Decline"], "choosing is the send")
    console.reset()
    await model.choose(0)
    #expect(console.calls.map(\.servedBy) == ["post-api-proposals-id"])
    #expect(console.calls.first?.body == .object(["decision": .string("one file per route"), "if_unchanged": .object(["seen_at": .string(row.ts)])]))
    #expect(model.phase == .settled(RequestReceipt("Answered “one file per route”", glyph: .approve)))
}

@Test func aRepaintKeepsAnswersOnlyToTheSameQuestions() throws {
    var old = try #require(QuestionSteps(payload: try JSONValue.parse(Data(threeQuestions.utf8))))
    old.choose(1)
    var same = try #require(QuestionSteps(payload: try JSONValue.parse(Data(threeQuestions.utf8))))
    same.carry(from: old)
    #expect(same.isAnswered(0))
    var changed = try #require(QuestionSteps(payload: try JSONValue.parse(Data(#"{"questions":[{"prompt":"Something different?","options":["a","b"]}]}"#.utf8))))
    changed.carry(from: old)
    #expect(!changed.isAnswered(0), "an answer to a different question is not an answer to this one")
}

@Test func underReduceMotionTheNextQuestionCrossFades() {
    #expect(QuestionMotion.kind(reduceMotion: true) == .crossFade)
    #expect(QuestionMotion.kind(reduceMotion: false) == .slide)
}

// MARK: - The meeting: Accept All in order, behind a ten-second Undo

@MainActor
private func meeting(_ transport: AnswerConsole, hold: @escaping @Sendable (TimeInterval) async throws -> Void = { _ in }) throws -> GroupAnswering {
    // five parts, raised a second apart and handed over out of order
    let parts = try [3, 1, 5, 2, 4].map { i in
        try requestRow(i, "knowledge", payload: #"{"title":"To-do \#(i)","meeting":"Vendor review"}"#, ts: "2026-09-28T12:00:0\(i).000Z")
    }
    let group = MeetingGroup(id: "mtg-7", parts: parts)
    return GroupAnswering(group, store: stores(transport).0, assistantName: assistantName, hold: hold)
}

@MainActor
@Test func aPartialAcceptAllShowsFourOfFive() async throws {
    let answeredElsewhere = #"{"error":{"code":"conflict","message":"already decided"},"reason":"already_decided","decision":"allow","decided_at":"2026-09-28T12:20:00.000Z","proposal":{"id":"3"}}"#
    let transport = AnswerConsole { call, _ in call.path == "/api/proposals/3" ? AnswerConsole.refusal(409, answeredElsewhere) : AnswerConsole.ok() }
    let model = try meeting(transport)
    model.start(.acceptAll, now: now)
    guard case .holding(.acceptAll, let window) = model.phase else { Issue.record("not held: \(model.phase)"); return }
    #expect(window.receipt == "Accepting all 5 parts")
    await model.settled()

    // one allow per part, oldest first, each waiting for the one before
    #expect(transport.calls.map(\.path) == (1...5).map { "/api/proposals/\($0)" })
    #expect(transport.calls.allSatisfy { $0.body?["decision"] == .string("allow") })
    #expect(transport.mostInFlight == 1, "not a batch: in order, one at a time")
    guard case .done(let outcome) = model.phase else { Issue.record("not done"); return }
    #expect(outcome.headline == "4 of 5 accepted.")
    #expect(outcome.explanation == "One was already answered elsewhere. Nothing was lost and nothing was re-sent.")
    #expect(outcome.retryable.isEmpty, "a part someone else answered is settled")

    let p = MeetingCard.presentation(model, assistantName: assistantName, allowsDecisions: true, today: today, now: now, clock: clock)
    #expect(p.outcome.map(\.text) == ["4 of 5 accepted.", "One was already answered elsewhere. Nothing was lost and nothing was re-sent."])
    #expect(p.outcome.first?.glyph == .degraded && p.outcome.first?.ink == .textPrimary, "colour on the glyph, the words in text-primary (§3.1)")
    #expect(p.receipts.count == 5, "every part keeps its receipt")
    #expect(p.receipts[2].text == "To-do 3: Already approved elsewhere — nothing was sent from here")
}

@MainActor
@Test func undoInsideTheWindowSendsNothingAtAll() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = try meeting(transport, hold: { try await Task.sleep(for: .seconds($0 * 360)) })
    model.start(.declineAll, now: now)
    guard case .holding(.declineAll, let window) = model.phase else { Issue.record("not held"); return }
    #expect(window.receipt == "Declining all 5 parts")
    #expect(window.presentation(at: now.addingTimeInterval(9)).controls.map(\.label) == ["Undo"])
    #expect(UndoWindow.seconds == 10)
    model.undo()
    await model.settled()
    #expect(transport.calls.isEmpty)
    #expect(model.phase == .open)
}

@MainActor
@Test func declineAllSendsOneDenyPerPartInOrderOnceTheWindowCloses() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let model = try meeting(transport)
    model.start(.declineAll, now: now)
    await model.settled()
    #expect(transport.calls.map(\.path) == (1...5).map { "/api/proposals/\($0)" })
    #expect(transport.calls.allSatisfy { $0.body?["decision"] == .string("deny") })
    guard case .done(let outcome) = model.phase else { Issue.record("not done"); return }
    #expect(outcome.headline == "5 declined." && outcome.explanation == nil)
}

@MainActor
@Test func tryAgainSendsOnlyWhatWasNeverApplied() async throws {
    let transport = AnswerConsole { call, n in
        // the console refuses part 2 the first time, and part 4 goes stale
        if call.path == "/api/proposals/2" && n <= 5 { return AnswerConsole.refusal(503, #"{"error":{"code":"not_available","message":"no vault bridge in this deployment"}}"#) }
        if call.path == "/api/proposals/4" && n <= 5 {
            return AnswerConsole.refusal(409, #"{"error":{"code":"conflict","message":"changed"},"reason":"stale","proposal":{"id":"4","ts":"2026-09-28T12:00:04.000Z","kind":"knowledge","payload":{"title":"To-do 4, reworded","meeting":"Vendor review"},"decision":"pending","changed_at":"2026-09-28T12:40:00.000Z"}}"#)
        }
        return AnswerConsole.ok()
    }
    let model = try meeting(transport)
    model.start(.acceptAll, now: now)
    await model.settled()
    guard case .done(let first) = model.phase else { Issue.record("not done"); return }
    #expect(first.headline == "3 of 5 accepted.")
    #expect(first.explanation == "One changed while this was open, so nothing was sent for it — it is shown as it stands. One was refused: no vault bridge in this deployment. Nothing was lost and nothing was re-sent.")
    #expect(first.retryable == [2])
    await model.retry()
    #expect(transport.calls.map(\.path).suffix(1) == ["/api/proposals/2"], "only the refused part goes again")
    guard case .done(let second) = model.phase else { Issue.record("not done"); return }
    #expect(second.headline == "1 accepted.")
    #expect(model.reach(.acceptAll).map(\.id) == [4], "applied parts are out of reach; the one that moved waits to be answered as it now stands")
    #expect(model.group.parts.first { $0.id == 4 }?.title == "To-do 4, reworded", "shown as it stands")
    #expect(model.group.parts.first { $0.id == 4 }?.shape.word == "note", "its reading kept — the 409's row carries none")
    model.start(.acceptAll, now: now)
    await model.settled()
    #expect(transport.calls.last?.path == "/api/proposals/4")
    #expect(transport.calls.last?.body?["if_unchanged"] == .object(["seen_at": .string("2026-09-28T12:40:00.000Z")]), "the next answer claims the row it now shows")
}

@MainActor
@Test func whileUnreachableTheGroupSendsNothingAndCountsWhatWasHeld() async throws {
    let transport = AnswerConsole { _, _ in AnswerConsole.ok() }
    let parts = try (1...2).map { try requestRow($0, "knowledge", payload: #"{"title":"To-do \#($0)"}"#) }
    let (s, _) = stores(transport, reachable: false)
    let model = GroupAnswering(MeetingGroup(id: "g", parts: parts), store: s, assistantName: assistantName, hold: { _ in })
    let p = MeetingCard.presentation(model, assistantName: assistantName, allowsDecisions: false, today: today, now: now, clock: clock)
    #expect(p.controls.map(\.control.label) == ["Accept All", "Decline All"])
    #expect(p.controls.allSatisfy { $0.control.disabledBecause == StateWords.unreachable })
    model.start(.acceptAll, now: now)
    await model.settled()
    #expect(transport.calls.isEmpty)
    guard case .done(let outcome) = model.phase else { Issue.record("not done"); return }
    #expect(outcome.headline == "0 of 2 accepted.")
    #expect(outcome.explanation == "2 weren't sent — \(StateWords.unreachable). Nothing was lost and nothing was re-sent.")
}

// MARK: - What the sources may not do

private let bodiesDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("sources/kit/request-bodies")

@Test func theBodiesNeverClipNeverHardcodeANameNeverMapAKindAndTakeEveryColourFromARole() throws {
    let files = try FileManager.default.contentsOfDirectory(atPath: bodiesDirectory.path).filter { $0.hasSuffix(".swift") }
    #expect(files.count >= 6)
    for name in files {
        let text = try String(contentsOf: bodiesDirectory.appendingPathComponent(name), encoding: .utf8)
        let code = text.components(separatedBy: "\n").map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? line }.joined(separator: "\n")
        #expect(!code.contains(".lineLimit(") && !code.contains(".truncationMode("), "\(name) clips")
        #expect(!code.contains("\"Metis"), "\(name) hardcodes the assistant's name")
        #expect(!code.contains(".opacity("), "\(name) dims with opacity (C63)")
        for literal in ["Color(red", "Color(hue", "Color(white", "Color.red", "Color.green", "Color.gray", "Color.black", "Color.white", ".foregroundColor("] {
            #expect(!code.contains(literal), "\(name) paints \(literal)")
        }
        // The client keeps no kind → word map (X-5): no stored kind is spelled as a case.
        for kind in ["\"access_request\"", "\"knowledge\"", "\"draft_settle\"", "\"grant_elevation\"", "\"connection_call\""] {
            #expect(!code.contains("case \(kind)"), "\(name) maps the stored kind \(kind)")
        }
    }
}
