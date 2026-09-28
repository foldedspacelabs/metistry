// A task's room — a pane over Board, with Board still selected in the sidebar
// (design-build-plan T6-7; screen-16-artifacts-and-rooms.md §2, C89;
// docs/ops/threads.md). There is no Rooms list: a thread lives where its
// subject lives, and a task's opens from its card (screen 14, C84).
//
// What the pane draws, top to bottom: the escalation band when the room came
// to the owner (ten agent turns in a row — the next agent message was not
// stored, it became a Needs You request); the conversation, agent turns on the
// 2px `agent` rule in the reply serif and the owner's in the accent wash; the
// pips — the agent tail against the cap — and *yours resets it* above the
// composer.
//
// THE COMPOSER IS *ADD TO THE ROOM*. No @, no recipient: a room cannot address
// anyone, posting wakes nobody, and agents read it when they pick the task up.
// **Resolve** is the owner's alone — no tool resolves a room — and a resolved
// room still takes messages. A message that could not be posted stays in the
// composer (C136's *edit kept*).
//
// Reads `GET /api/work/:id/thread`; writes `POST /api/work/:id/comments`,
// `…/thread/resolve` and `…/thread/reopen`. Nothing else.

import Foundation
import Observation
import SwiftUI

// MARK: - The room, as the route serves it

public struct RoomMessage: Sendable, Equatable, Identifiable {
    public let id: String
    public let body: String
    public let author: String
    /// `agent` or `human`.
    public let authorKind: String
    public let at: Date?

    public var isAgent: Bool { authorKind == "agent" }
}

/// `GET /api/work/:id/thread`, read.
public struct RoomReading: Sendable, Equatable {
    public let workID: Int
    public let title: String
    public let project: String?
    public let status: String?
    /// `open` or `resolved`. A room with no message yet has no state.
    public let state: String?
    public let resolvedBy: String?
    public let messages: [RoomMessage]
    /// Consecutive agent messages at the end — the ping-pong rule, counted by the service.
    public let agentTail: Int
    public let cap: Int

    public init(_ room: TaskRoom) {
        let j = room.json
        workID = j["work_id"]?.intValue ?? j.string("work_id").flatMap { Int($0) } ?? 0
        title = j.string("title") ?? ""
        project = j.string("project")
        status = j.string("status")
        state = j.string("state")
        resolvedBy = j.string("resolved_by")
        messages = (j["comments"]?.arrayValue ?? []).compactMap { c in
            guard let body = c.string("body") else { return nil }
            return RoomMessage(
                id: c.string("id") ?? UUID().uuidString, body: body,
                author: c.string("author_principal") ?? "", authorKind: c.string("author_kind") ?? "human",
                at: WireTime.date(c.string("created_at"))
            )
        }
        agentTail = j["agent_tail"]?.intValue ?? 0
        cap = j["cap"]?.intValue ?? 10
    }

    public var isResolved: Bool { state == "resolved" }
    /// The tail reached the cap: the next agent message became a request in
    /// Needs You. The same test the PWA draws its band from.
    public var cameToYou: Bool { agentTail >= cap && cap > 0 }
}

public enum RoomWords {
    /// `payload.reason = 'ping_pong_cap'`, said as a sentence (docs/ops/threads.md).
    public static let cameToYou = "Ten agent turns went by without a human. The next agent message was not stored — this is where it came to you. Answer, or resolve the room."
    public static let composer = "Add to the Room"
    public static let add = "Add"
    public static let resolve = "Resolve"
    public static let reopen = "Reopen"
    public static let close = "Close Room"
    public static let empty = "Nothing said yet — a message here reaches whoever works on it."
    public static let yoursResetsIt = "yours resets it"

    /// *3 of 10 agent turns in a row · yours resets it*.
    public static func pips(_ tail: Int, _ cap: Int) -> String {
        "\(tail) of \(cap) agent turns in a row" + (tail > 0 ? " · \(yoursResetsIt)" : "")
    }
}

// MARK: - The model

@MainActor
@Observable
public final class RoomModel {
    public let workID: Int
    public private(set) var section = Section<RoomReading>()
    /// The composer — kept when a post fails.
    public var draft = ""
    public private(set) var isPosting = false
    /// Why the last write did not land, in the console's words.
    public private(set) var problem: String?

    @ObservationIgnored weak var session: ConsoleSession?

    public init(workID: Int, session: ConsoleSession) {
        self.workID = workID
        self.session = session
    }

    public var room: RoomReading? { section.value }

    public func load() async {
        guard let session else { return }
        let generation = session.generation
        section.beginLoading(background: section.hasValue)
        let answer = await session.stores.taskRoom(workID)
        guard session.generation == generation else { return }
        switch answer {
        case .success(let room): section.loaded(RoomReading(room), asOf: nil)
        case .failure(let error): section.failed(error)
        }
    }

    /// Add to the Room. Posting as the owner resets the agent-only run.
    public func post() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let session, !body.isEmpty, !isPosting else { return }
        isPosting = true
        problem = nil
        let answer = await session.stores.comment(onTask: workID, body)
        isPosting = false
        switch answer {
        case .success:
            draft = ""
            await load()
        case .failure(let error):
            problem = "Not added — \(BoardModel.sentence(error)). Your message is still here."
        }
    }

    /// Resolve, or Reopen a resolved room. The owner's alone.
    public func toggleResolved() async {
        guard let session, let room else { return }
        problem = nil
        let answer = room.isResolved ? await session.stores.reopenRoom(workID) : await session.stores.resolveRoom(workID)
        switch answer {
        case .success(let now): section.loaded(RoomReading(now), asOf: nil)
        case .failure(let error): problem = room.isResolved ? "Couldn't reopen it — \(BoardModel.sentence(error))" : "Couldn't resolve it — \(BoardModel.sentence(error))"
        }
    }
}

// MARK: - The pane

public struct RoomPane: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable var model: RoomModel
    let assistantName: String?
    let clock: ClockTime
    let onClose: () -> Void

    public init(model: RoomModel, assistantName: String?, clock: ClockTime = ClockTime(), onClose: @escaping () -> Void) {
        self.model = model
        self.assistantName = assistantName
        self.clock = clock
        self.onClose = onClose
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            header(p)
            Divider()
            content(p)
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .background(p[.surface])
        .onExitCommand(perform: onClose)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "Room, \(model.room?.title ?? "task \(model.workID)")"))
        .task { if !model.section.hasValue { await model.load() } }
    }

    private func header(_ p: Palette) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(verbatim: model.room?.title ?? "Task \(model.workID)")
                    .metistryFont(.title3, weight: .semibold)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let room = model.room {
                    MarkView(Mark(meta(room), style: .subhead, ink: .textSecondary, on: .surface))
                }
            }
            Spacer(minLength: 0)
            if let room = model.room {
                ControlButton(ControlSpec(room.isResolved ? RoomWords.reopen : RoomWords.resolve, role: .secondary)) {
                    Task { await model.toggleResolved() }
                }
            }
            ControlButton(ControlSpec("", glyph: .decline, role: .plain, name: RoomWords.close)) { onClose() }
        }
        .padding(MetistrySpace.s4)
    }

    private func meta(_ room: RoomReading) -> String {
        var parts = [room.project ?? "no project"]
        if let status = room.status { parts.append(status.replacingOccurrences(of: "_", with: " ")) }
        if let state = room.state { parts.append(room.isResolved ? "room resolved\(room.resolvedBy.map { " by \(BoardCardFacets.name($0, assistantName: assistantName))" } ?? "")" : "room \(state)") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        if case .failed(let why) = FirstPaint.paint(model.section, loadingSince: nil, ageLimit: .infinity, waitingFor: "Opening the room", now: Date()) {
            StatePanel(StatePanelModel(.failed, title: "Couldn't Open the Room", sentence: "The console answered, and the answer was an error.", reason: why, action: StateWords.tryAgain)) {
                Task { await model.load() }
            }
            Spacer(minLength: 0)
        } else if let room = model.room {
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                    if room.cameToYou {
                        MarkView(Mark(RoomWords.cameToYou, glyph: .degraded, glyphInk: .degraded, style: .subhead, ink: .textPrimary, plate: .degradedQuiet, on: .surface, shape: .band, spoken: "Came to you. \(RoomWords.cameToYou)"))
                    }
                    if room.messages.isEmpty {
                        MarkView(Mark(RoomWords.empty, style: .subhead, ink: .textSecondary, on: .surface))
                    }
                    ForEach(room.messages) { message in
                        messageView(message, p)
                    }
                }
                .padding(.vertical, MetistrySpace.s4)
                .padding(.leading, MetistrySpace.s4 + AgentProse.gutter)
                .padding(.trailing, MetistrySpace.s4)
                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            }
            Divider()
            composer(room, p)
        } else {
            PlaceholderRows(count: 4, waitingFor: nil)
                .padding(MetistrySpace.s4)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func messageView(_ message: RoomMessage, _ p: Palette) -> some View {
        if message.isAgent {
            AgentProse(AgentProseModel(treatment: .rule, author: AgentChipModel(agentID: message.author, assistantName: assistantName ?? message.author), text: message.body, at: message.at), on: .surface, clock: clock)
        } else {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                MarkView(Mark([message.author == BoardRules.owner ? "You" : message.author, message.at.map { clock.time($0) }].compactMap { $0 }.joined(separator: " · "), style: .caption1, ink: .textSecondary, on: .accentQuiet))
                Text(verbatim: message.body)
                    .metistryFont(.body)
                    .foregroundStyle(p[.textPrimary])
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(MetistrySpace.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p[.accentQuiet], in: RoundedRectangle(cornerRadius: MetistryRadius.md, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }

    private func composer(_ room: RoomReading, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s1) {
                ForEach(0..<max(room.cap, 0), id: \.self) { i in
                    Circle()
                        .fill(i < room.agentTail ? p[.agent] : p[.border])
                        .frame(width: 6, height: 6)
                }
                MarkView(Mark(RoomWords.pips(room.agentTail, room.cap), style: .caption1, ink: .textSecondary, on: .surface))
                    .padding(.leading, MetistrySpace.s1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: RoomWords.pips(room.agentTail, room.cap)))
            if let problem = model.problem {
                MarkView(Mark(problem, glyph: .failed, glyphInk: .failed, style: .subhead, ink: .textPrimary, on: .surface))
            }
            HStack(alignment: .bottom, spacing: MetistrySpace.s2) {
                TextField(RoomWords.composer, text: $model.draft, prompt: Text(verbatim: RoomWords.composer), axis: .vertical)
                    .labelsHidden()
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .metistryFont(.body)
                    .padding(MetistrySpace.s2)
                    .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous).strokeBorder(p[.borderControl], lineWidth: 1))
                    .accessibilityLabel(Text(verbatim: RoomWords.composer))
                ControlButton(ControlSpec(RoomWords.add, role: .primary, disabledBecause: model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isPosting ? "" : nil)) {
                    Task { await model.post() }
                }
            }
        }
        .padding(MetistrySpace.s4)
    }
}
