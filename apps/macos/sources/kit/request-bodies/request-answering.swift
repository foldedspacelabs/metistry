// Answering one request: the answers under its body, and what happens to the
// card when the console says something other than yes.
//
// WHAT AN ANSWER SENDS IS THE SHAPE'S (F-5). The slot's `sends` is either a
// decision on the row — `POST /api/proposals/:id` through `NeedsYouStore`,
// carrying `if_unchanged.seen_at` so the answer is to the row that was shown
// — or a door onto another system (§2.11), which `RequestDoorHandling` owns.
// Nothing here maps a kind to a verb.
//
// THE REFUSALS, EACH A CODE PATH (U3):
//
//   * `409 stale` — the row moved while the card was open. NOTHING WAS SENT,
//     and nothing is re-sent: the card repaints from the row the refusal
//     carries back, keeps the owner's words (and their choices, when the
//     questions are the same questions), and says so above the current
//     version (components-01 §2.5). The next answer claims to have seen the
//     row as it now stands (`changed_at`).
//   * `409 already_decided` — someone answered first. The card collapses to
//     what actually happened, from the winner the refusal carries.
//   * any other refusal — a `400` for Revise wider than the ask (C40), a
//     consequence that failed (C45: the row stays pending with
//     `payload.error`) — is shown in the console's own words and the card
//     stays answerable. There is deliberately no retry: the owner decides again.
//   * O3 — while the instance is unreachable, the gate refuses a decision
//     before it is sent (stores/reachability-gate.swift). The draft stays.
//
// Later is not an answer: it leaves the list with no receipt (components-01 §2.5).

import Foundation
import Observation

/// Another system's door: a pull request review, an RSVP, a draft in Mail, a
/// conflict settled, a report's act, a mirrored task sent to Today or
/// delegated (§2.11, `REQUEST_DOORS`).
public protocol RequestDoorHandling: Sendable {
    /// Nil when this build can answer `row` through `door`; otherwise the fact
    /// that stops it, printed under the control it turns off (components-01 §1.3).
    func unavailable(_ door: RequestDoor, row: RequestRow) -> String?
    /// Answer through the door. `words` is what the owner typed, where the answer carries words.
    func perform(_ door: RequestDoor, answer: RequestShape.Answer, words: String?, row: RequestRow) async -> Result<RequestReceipt, ConsoleError>
}

/// The doors this build reaches: none yet. Each door's own ticket — T2-13 for
/// pull requests, T2-9 and T2-10 for a report's act and a conflict, the
/// mirrors' for RSVP, Draft Reply, Today and Delegate — names the payload
/// fields its route needs and replaces this; until then a door's answer is a
/// control that says why it is off, never one that pretends.
public struct UnwiredRequestDoors: RequestDoorHandling {
    public init() {}

    public func unavailable(_ door: RequestDoor, row: RequestRow) -> String? {
        "This build can't \(door.reach) from here yet"
    }

    public func perform(_ door: RequestDoor, answer: RequestShape.Answer, words: String?, row: RequestRow) async -> Result<RequestReceipt, ConsoleError> {
        .failure(.http(status: 503, envelope: ConsoleErrorEnvelope(code: "not_available", message: unavailable(door, row: row) ?? "")))
    }
}

/// What the card collapses to once it is settled: a glyph and one line.
public struct RequestReceipt: Sendable, Equatable {
    public let glyph: MetistryGlyph?
    public let text: String

    public init(_ text: String, glyph: MetistryGlyph? = nil) {
        self.text = text
        self.glyph = glyph
    }
}

@MainActor
@Observable
public final class RequestAnswering {
    public enum Phase: Sendable, Equatable {
        /// Answerable.
        case open
        /// An answer is in flight: the answers are disabled and nothing spins
        /// (components-01 §2.5). Nil is Later.
        case deciding(RequestAnswerSlot?)
        /// The console refused, in its own words; the row still waits.
        case refused(String)
        /// O3 held it before it was sent.
        case held(String)
        case settled(RequestReceipt)
        /// Someone answered first; the winner.
        case alreadyDecided(RequestReceipt)
        /// Later: out of the list, no receipt.
        case snoozed
    }

    public private(set) var reading: RequestReading
    /// What the next answer claims to have seen: the rendered row's `ts` (or
    /// its cursor), and after a stale repaint the row as it now stands.
    public private(set) var seenAt: String
    public private(set) var phase: Phase = .open
    /// A `409 stale` repainted this card; the notice stays until the next answer.
    public private(set) var repainted = false
    public var steps: QuestionSteps?
    /// The slot whose words are being typed (Revise, Request Changes, Reply), if any.
    public private(set) var composing: RequestAnswerSlot?
    public var words = ""
    /// The diff's lines, or the whole set behind a before-and-after: open or not.
    public var expanded = false
    /// Access Revise (C40): the folder UNDER the asked area. The control
    /// composes `<asked>/<tail>`, so it cannot express a wider or a sibling
    /// area at all; the console refuses one anyway.
    public var areaTail = ""

    @ObservationIgnored private let store: any NeedsYouStore
    @ObservationIgnored public let doors: any RequestDoorHandling
    @ObservationIgnored private let assistantName: String

    public init(_ row: RequestRow, store: any NeedsYouStore, doors: any RequestDoorHandling = UnwiredRequestDoors(), assistantName: String) {
        let reading = RequestReading(row, assistantName: assistantName)
        self.reading = reading
        self.seenAt = row.cursor ?? row.ts
        self.steps = reading.questions
        self.store = store
        self.doors = doors
        self.assistantName = assistantName
    }

    public var row: RequestRow { reading.row }

    /// The body as it is drawn: the reading's block, opened or not.
    public var expandable: RequestBodyBlock? {
        switch reading.body {
        case .diff(var d)?:
            d.expanded = expanded
            return .diff(d)
        case .beforeAfter(var b)?:
            b.expanded = expanded
            return .beforeAfter(b)
        default:
            return reading.body
        }
    }

    public var isDeciding: Bool {
        if case .deciding = phase { return true }
        return false
    }

    public var isSettled: Bool {
        switch phase {
        case .settled, .alreadyDecided, .snoozed: return true
        default: return false
        }
    }

    // MARK: - The words an answer carries

    /// Open the field for an answer that carries words; pressing it again with
    /// nothing typed closes it — an empty reason cancels rather than sends.
    public func compose(_ slot: RequestAnswerSlot) {
        guard let answer = reading.shape.answer(slot) else { return }
        guard answer.carrying != nil || answer.isRequired else { return }
        composing = slot
        if answer.carrying == .area { areaTail = "" }
    }

    public func cancelComposing() {
        composing = nil
        words = ""
        areaTail = ""
    }

    /// The asked area, and what Revise would grant instead: `<asked>` or a folder under it.
    public var askedArea: String? { reading.row.payload?.string("area") }

    public var revisedArea: String? {
        guard let asked = askedArea else { return nil }
        let tail = areaTail.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return tail.isEmpty ? asked : ([asked] + tail).joined(separator: "/")
    }

    /// Why the typed folder cannot be sent — nil when it can.
    public var areaProblem: String? {
        let parts = areaTail.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.contains("..") || parts.contains(".") { return "a folder name can't be “.” or “..”" }
        return nil
    }

    // MARK: - Resolving a slot

    public enum Resolved: Sendable, Equatable {
        case decision(RequestAnswer)
        case door(RequestDoor, RequestShape.Answer, words: String?)
    }

    /// What pressing `slot` would send now — nil when it cannot be sent as it
    /// stands (a question with one unanswered; words required and none typed).
    public func resolve(_ slot: RequestAnswerSlot) -> Resolved? {
        guard let answer = reading.shape.answer(slot) else { return nil }
        let typed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        switch answer.send {
        case .door(let name):
            guard let door = RequestDoor(rawValue: name) else { return nil }
            if answer.isRequired && typed.isEmpty { return nil }
            return .door(door, answer, words: typed.isEmpty ? nil : typed)
        case .decision(let decision):
            let resolved: RequestAnswer?
            switch decision {
            case "allow": resolved = .approve
            case "accept_as_work": resolved = .approveAsWork
            case "deny": resolved = .decline(nil)
            case "skip": resolved = .skip
            case "answers": resolved = steps?.answer
            case "accept_with_changes":
                if answer.carrying == .area {
                    resolved = areaProblem == nil ? revisedArea.map(RequestAnswer.reviseArea) : nil
                } else {
                    resolved = .revise(typed)
                }
            default: resolved = nil // a decision this build does not know is not offered
            }
            guard let resolved, resolved.isSendable else { return nil }
            return .decision(resolved)
        }
    }

    // MARK: - Answering

    /// Press an answer. One that carries words opens its field first.
    public func press(_ slot: RequestAnswerSlot) async {
        guard !isDeciding, !isSettled, let answer = reading.shape.answer(slot) else { return }
        if (answer.carrying != nil && slot == .revise) || answer.isRequired, composing != slot {
            compose(slot)
            return
        }
        guard let resolved = resolve(slot) else {
            // An empty reason cancels rather than sends.
            if composing == slot { cancelComposing() }
            return
        }
        phase = .deciding(slot)
        switch resolved {
        case .decision(let decision):
            let result = await store.answer(row.id, decision, seenAt: seenAt)
            settle(result, answered: decision, label: answer.label ?? "")
        case .door(let door, let shaped, let words):
            switch await doors.perform(door, answer: shaped, words: words, row: row) {
            case .success(let receipt):
                phase = .settled(receipt)
            case .failure(let error):
                fail(error)
            }
        }
    }

    /// Choose an option on the showing question; one question, pick one, a
    /// real option — choosing sends (§13.2).
    public func choose(_ index: Int) async {
        guard !isDeciding, !isSettled, var s = steps else { return }
        let sends = s.choose(index)
        steps = s
        if sends { await press(.primary) }
    }

    /// Later: a snooze, not a decision. It never claims to have seen anything.
    public func later() async {
        guard !isDeciding, !isSettled else { return }
        phase = .deciding(nil)
        switch await store.answer(row.id, .later, seenAt: nil) {
        case .success: phase = .snoozed
        case .failure(let error): fail(error)
        }
    }

    private func settle(_ result: Result<RequestAnswerResult, ConsoleError>, answered: RequestAnswer, label: String) {
        switch result {
        case .success(let reply):
            composing = nil
            phase = .settled(Self.receipt(answered, label: label, reply: reply, reading: reading))
        case .failure(let error):
            fail(error)
        }
    }

    private func fail(_ error: ConsoleError) {
        if error.wasHeldForReachability {
            phase = .held(StateWords.unreachable)
            return
        }
        switch error.conflictReason {
        case "stale":
            if repaint(from: error.details) { return }
            phase = .refused(error.refusal ?? "this request changed after you saw it")
        case "already_decided":
            phase = .alreadyDecided(Self.winner(error.details))
        default:
            phase = .refused(error.refusal ?? error.localizedDescription)
        }
    }

    /// The `409 stale` repaint: the row as it stands, under the notice. The
    /// row the refusal carries is the stored row — no `request` — so the
    /// reading on screen is kept (a row's kind does not change while open).
    private func repaint(from details: [String: JSONValue]) -> Bool {
        guard let proposal = details["proposal"],
              let data = try? JSONEncoder().encode(proposal),
              let fresh = try? JSONDecoder().decode(RequestRow.self, from: data),
              fresh.id == row.id
        else { return false }
        let old = steps
        reading = RequestReading(fresh.reading(row.shape), assistantName: assistantName)
        seenAt = proposal.string("changed_at") ?? fresh.ts
        steps = reading.questions
        if let old, var s = steps {
            s.carry(from: old)
            steps = s
        }
        repainted = true
        phase = .open
        return true
    }

    // MARK: - Receipts

    static func receipt(_ answer: RequestAnswer, label: String, reply: RequestAnswerResult?, reading: RequestReading) -> RequestReceipt {
        switch answer {
        case .approve, .approveAsWork:
            if let work = reply?.work { return RequestReceipt("Approved — task #\(work.id) is on the board", glyph: .approve) }
            if let granted = reply?.granted { return RequestReceipt("Approved — " + grantSentence(granted), glyph: .approve) }
            if let action = reply?.action { return RequestReceipt("Approved — \(action.kind) done", glyph: .approve) }
            return RequestReceipt("Approved", glyph: .approve)
        case .reviseArea(let area):
            if let granted = reply?.granted { return RequestReceipt("Revised — " + grantSentence(granted), glyph: .edit) }
            return RequestReceipt("Revised — granted \(area) instead", glyph: .edit)
        case .revise:
            return RequestReceipt("Revised — your words went back to \(reading.asker?.label ?? "the asker")", glyph: .edit)
        case .decline:
            return RequestReceipt("Declined", glyph: .decline)
        case .skip:
            switch label {
            case "Dismiss": return RequestReceipt("Dismissed", glyph: .decline)
            case "Not Mine": return RequestReceipt("Marked as not yours", glyph: .decline)
            default: return RequestReceipt(label.isEmpty ? "Put down" : label, glyph: .decline)
            }
        case .option(let option):
            return RequestReceipt("Answered “\(option)”", glyph: .approve)
        case .answers(let answers):
            return RequestReceipt(answers.count == 1 ? "Answer sent" : "\(answers.count) answers sent", glyph: .approve)
        case .later:
            return RequestReceipt("Later")
        }
    }

    /// C41, from the answer rather than the ask: *can now read Areas/Health, and
    /// no longer browses every title*.
    static func grantSentence(_ g: RequestAnswerResult.AnsweredGrant) -> String {
        let base = "\(g.agent) can now read \(g.area)"
        return g.priorTier == "index" ? base + ", and no longer browses every title" : base
    }

    /// The winner a `409 already_decided` carries.
    static func winner(_ details: [String: JSONValue]) -> RequestReceipt {
        let decision = details["decision"]?.stringValue
        let word: String
        switch decision {
        case "allow": word = "approved"
        case "deny": word = "declined"
        case "accept_with_changes": word = "revised"
        case "resolved_at_source": word = "cleared at its source"
        case "expired": word = "expired"
        case "auto": word = "done on its own"
        case let other?: word = "answered “\(other)”"
        case nil: word = "answered"
        }
        return RequestReceipt("Already \(word) elsewhere — nothing was sent from here", glyph: nil)
    }
}
