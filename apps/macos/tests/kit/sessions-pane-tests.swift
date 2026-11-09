// Settings ▸ Sessions (T6-15; screen-12 §4, C136).
//
// The ticket's bold test: PURGE NOW LISTS THE UNFOLDED SESSIONS AND OFFERS
// FOLD FIRST. Then the door's misuse tests: pressing Purge Now sends nothing,
// Cancel sends nothing, Fold First runs the fold and never the purge, and the
// one confirmed body carries the preview's own `as_of`; a client that is not
// the Mac is not offered the button. Every read is the recorded fixtures
// (U9) — no console, no CLI, no network.

#if os(macOS)
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The bold test

@MainActor
@Test func purgeNowListsTheUnfoldedSessionsAndOffersFoldFirst() async throws {
    let (pane, console) = try sessionsReading()
    await pane.refresh()
    #expect(pane.reach == .local)
    let preview = try #require(pane.preview)
    #expect((preview.sessions, preview.turns, preview.sessionsUnfolded) == (2, 3, 1))
    #expect(pane.countLine == "2 sessions · 3 turns")
    #expect(preview.unfoldedLine == "1 not folded yet")
    #expect(pane.purgeUnavailableReason == nil)

    console.reset()
    pane.purgeNow()
    let confirm = try #require(pane.confirmation)
    // the act's own verb, and the way round the cost
    #expect(confirm.confirm == SessionsWords.purgeNow)
    #expect(confirm.alternative == SessionsWords.foldFirst)
    #expect(confirm.destructive)
    #expect(confirm.title == "Purge 2 Sessions Now?")
    #expect(confirm.costHeading.contains("has not been folded yet"))
    #expect(confirm.costHeading.contains("Aide"), "the assistant's name is templated: \(confirm.costHeading)")
    // each unfolded session is a line: the thread, when, how many turns — twelve-hour time
    #expect(confirm.costs == ["Chat — 28 Sep, 12:04 PM · 2 turns"])
    // in reading order: Fold First, Cancel, Purge Now
    #expect(confirm.presentation().controls.map(\.label) == [SessionsWords.foldFirst, CostConfirmation.cancel, SessionsWords.purgeNow])
    // presenting the confirm sent nothing
    #expect(console.calls.isEmpty, "\(console.calls)")
}

@Test func aFullyFoldedArchiveConfirmsWithoutFoldFirst() {
    let preview = SessionPurgePreview(sessions: 4, turns: 9, sessionsUnfolded: 0, unfolded: [], asOf: "2026-09-30T00:00:00.000Z")
    let confirm = preview.confirmation(assistantName: nil, clock: ClockTime(timeZone: TimeZone(identifier: "UTC")!), now: Date())
    #expect(confirm?.alternative == nil, "nothing to fold, so Fold First is not offered")
    #expect(confirm?.costs == ["4 archived sessions — 9 turns of conversation"])
    #expect(confirm?.costHeading.contains("the assistant") == true)
    // an empty archive: no dialog at all
    let empty = SessionPurgePreview(sessions: 0, turns: 0, sessionsUnfolded: 0, unfolded: [], asOf: nil)
    #expect(empty.confirmation(assistantName: "Aide", clock: ClockTime(), now: Date()) == nil)
    #expect(empty.countLine == "Nothing archived")
    // more unfolded than the newest fifty named: the rest is counted
    let many = SessionPurgePreview(sessions: 60, turns: 100, sessionsUnfolded: 52, unfolded: [
        UnfoldedSession(sessionID: "a", thread: "default", turns: 1, unfoldedTurns: 1, firstTS: nil, lastTS: nil),
    ], asOf: nil)
    let manyConfirm = many.confirmation(assistantName: "Aide", clock: ClockTime(), now: Date())
    #expect(manyConfirm?.costs == ["Chat · 1 turn", "and 51 more sessions not listed here"])
}

// MARK: - Misuse: the one door, and what reaches it

@MainActor
@Test func cancelSendsNothingAndTheConfirmedBodyCarriesThePreviewsAsOf() async throws {
    let (pane, console) = try sessionsReading()
    await pane.refresh()
    let asOf = try #require(pane.preview?.asOf)
    console.reset()

    pane.purgeNow()
    #expect(pane.confirmation != nil)
    await pane.choose(.cancel)
    #expect(pane.confirmation == nil)
    #expect(console.calls.isEmpty, "Cancel sent: \(console.calls)")

    pane.purgeNow()
    await pane.choose(.confirm)
    #expect(pane.confirmation == nil)
    let purges = console.calls.filter { $0.path == "/api/sessions/purge" }
    #expect(purges.count == 2, "the confirmed purge, then the re-read preview: \(purges)")
    #expect(purges.first?.body == .object(["confirm": .bool(true), "as_of": .string(asOf)]), "\(String(describing: purges.first?.body))")
    #expect(purges.last?.body == .object(["confirm": .bool(false)]), "the preview is re-read with nothing else in its body")
    #expect(pane.note?.kind == .done)
    #expect(pane.note?.text.hasPrefix("Purged") == true, "\(String(describing: pane.note))")
}

@MainActor
@Test func foldFirstRunsTheFoldAndNeverThePurge() async throws {
    let (pane, console) = try sessionsReading()
    await pane.refresh()
    console.reset()

    pane.purgeNow()
    await pane.choose(.alternative)
    #expect(pane.confirmation == nil)
    let paths = console.calls.map { "\($0.method) \($0.path)" }
    #expect(paths.first == "POST /api/scheduled/routines/session-fold/run", "\(paths)")
    // then the count is re-read — a preview, never a confirmed purge
    let purges = console.calls.filter { $0.path == "/api/sessions/purge" }
    #expect(purges.map(\.body) == [.object(["confirm": .bool(false)])], "\(purges)")
    #expect(pane.note == ScheduledNote(kind: .done, text: SessionsWords.folding))
}

@MainActor
@Test func purgeNowIsNotOfferedToAClientThatIsNotTheMac() async throws {
    // whoami says a passkey session: the button is off with its reason, and pressing it sends nothing
    let (pane, console) = try sessionsReading(whoamiVia: "passkey_session")
    await pane.refresh()
    #expect(pane.reach == .remote(via: "passkey_session"))
    #expect(pane.purgeUnavailableReason == SessionsWords.onlyTheMac)
    console.reset()
    pane.purgeNow()
    #expect(pane.confirmation == nil)
    #expect(console.calls.isEmpty)
    // the count is still read — a phone may read the archive, not delete it
    #expect(pane.countLine == "2 sessions · 3 turns")
}

@MainActor
@Test func purgeNowWithNothingArchivedIsOffAndSendsNothing() async throws {
    let (pane, console) = try sessionsReading(purgeBody: ["purged": false, "sessions": 0, "turns": 0, "sessions_unfolded": 0, "unfolded": [], "as_of": "2026-09-30T00:00:00.000Z"])
    await pane.refresh()
    #expect(pane.countLine == "Nothing archived")
    #expect(pane.purgeUnavailableReason == "Nothing to purge — the archive is empty.")
    console.reset()
    pane.purgeNow()
    #expect(pane.confirmation == nil)
    #expect(console.calls.isEmpty)
}

// MARK: - Learning and retention

@MainActor
@Test func letTheAssistantLearnIsTheFoldRoutinesPauseAndKeepSessionsItsRetention() async throws {
    let (pane, console) = try sessionsReading()
    await pane.refresh()
    // the recorded routine fixture answers every routine name; it is not paused
    #expect(pane.learns == true)
    #expect(pane.foldPhase == .read)
    // Session Purge's retention_days is not in the recorded fixture's config: the ruling's default is said
    #expect(pane.retentionLine == "30 days")
    let read = console.calls.map { "\($0.method) \($0.path)" }
    #expect(read.contains("GET /api/scheduled/routines/session-fold"))
    #expect(read.contains("GET /api/scheduled/routines/session-purge"))

    console.reset()
    await pane.setLearns(false)
    #expect(console.calls.map { "\($0.method) \($0.path)" } == ["POST /api/scheduled/routines/session-fold/pause"])
    #expect(pane.note?.kind == .done)
    // the pause fixture answers the routine paused: the switch follows the console's answer, not the click
    #expect(pane.learns == false)
    console.reset()
    await pane.setLearns(false)
    #expect(console.calls.isEmpty, "already off: nothing is sent")
    await pane.setLearns(true)
    #expect(console.calls.map { "\($0.method) \($0.path)" } == ["POST /api/scheduled/routines/session-fold/resume"])
    #expect(pane.learns == true)
}

@Test func retentionIsReadFromTheRoutinesConfigWithItsOrigin() throws {
    let json = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"name":"session-purge","title":"Session Purge","config":{"retention_days":{"value":7,"origin":"yours"}}}"#.utf8))
    let routine = try #require(ScheduledRoutine(json: json))
    #expect(routine.config == [ScheduledConfigField(key: "retention_days", value: "7", origin: .yours)])
    let one = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"name":"session-purge","config":{"retention_days":{"value":1,"origin":"default"}}}"#.utf8))
    #expect(ScheduledRoutine(json: one)?.config.first?.value == "1")
}

// MARK: - The view

@MainActor
@Test func theSessionsPaneSpeaksEveryControlAndNamesTheCount() async throws {
    let (pane, _) = try sessionsReading()
    await pane.refresh()
    let tree = try await AccessibilityProbe.snapshot(SessionsPaneProbe(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    #expect(tree.headings.contains("Learning") && tree.headings.contains("Keep Sessions") && tree.headings.contains(SessionsWords.purgeNow), "\(tree.headings)")
    // the destructive verb says what it will destroy
    #expect(tree.controlNames.contains("\(SessionsWords.purgeNow): 2 sessions · 3 turns"), "\(tree.controlNames)")
    #expect(tree.controlNames.contains("Let Aide learn from them"), "\(tree.controlNames)")
}

/// The pane, with the model under test standing in for the app's.
private struct SessionsPaneProbe: View {
    let pane: SessionsModel

    var body: some View {
        SessionsPaneBody(pane: pane, assistantName: "Aide")
    }
}

// MARK: - Fixtures

/// A `SessionsModel` over the recorded console, with `GET /api/whoami`'s
/// `via` and the purge preview's body replaceable.
@MainActor
private func sessionsReading(whoamiVia: String? = nil, purgeBody: [String: Any]? = nil) throws -> (SessionsModel, FixtureConsole) {
    var fixtures = try ConsoleFixture.loadAll()
    if let whoamiVia {
        fixtures = try fixtures.map { f in
            guard f.stem == "get-api-whoami" else { return f }
            var body = try JSONSerialization.jsonObject(with: f.reply) as? [String: Any] ?? [:]
            body["via"] = whoamiVia
            return try f.replacingReply(body)
        }
    }
    if let purgeBody {
        fixtures = try fixtures.map { f in f.stem == "post-api-sessions-purge" ? try f.replacingReply(purgeBody) : f }
    }
    let console = FixtureConsole(fixtures)
    let session = ConsoleSession(transport: console, management: nil)
    let pane = SessionsModel(session: session)
    pane.assistantName = "Aide"
    pane.clock = ClockTime(timeZone: TimeZone(identifier: "UTC")!)
    pane.now = { ConsoleFixture.asOf("post-api-sessions-purge") }
    return (pane, console)
}

extension ConsoleFixture {
    /// The same fixture answering a different body — a state the recorder did not record.
    func replacingReply(_ body: [String: Any]) throws -> ConsoleFixture {
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return ConsoleFixture(
            stem: stem, route: route, source: source, ticket: ticket, method: method, path: path, body: self.body,
            idempotencyKey: idempotencyKey, lastEventID: lastEventID, status: status,
            reply: data, replyJSON: try JSONDecoder().decode(JSONValue.self, from: data), stream: stream
        )
    }
}
#endif
