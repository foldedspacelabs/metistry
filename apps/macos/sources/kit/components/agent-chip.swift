// The agent chip — one component per idea (amendments §8.3): one tinted pill
// in the `agent` hue, the id in mono, on its `agent-quiet` plate. Never
// accent, never grey. It carries P1 before a title is read: what follows came
// from an agent and is data.
//
// THE ASSISTANT IS CALLED BY ITS NAME (C88). The instance's own assistant is
// the principal `assistant` (`INTERNAL_ASSISTANT_ID`, apps/console/src/agents.ts)
// and a request it raised says `source_agent: "assistant"`; that id is a key,
// never a label. The chip prints the configured name — `GET /api/identity`'s
// `name` — for it, so no attribution in the app can read *assistant*. The
// chip holds no glyph: a mark on a plate of its own hue fails its own
// contrast (C73).

import SwiftUI

public struct AgentChipModel: Sendable, Equatable {
    public enum Actor: Sendable, Equatable {
        /// The instance's assistant, by the name the owner gave it.
        case assistant(name: String)
        /// An agent, by its id — a slug, printed as-is.
        case agent(id: String)
    }

    /// The principal id the console gives the instance's own assistant.
    public static let assistantPrincipal = "assistant"

    public let actor: Actor

    private init(actor: Actor) {
        self.actor = actor
    }

    /// The instance's assistant, by its configured name.
    public static func assistant(named name: String) -> AgentChipModel {
        AgentChipModel(actor: .assistant(name: name))
    }

    /// An agent id as the wire gives it — a request's `source_agent`, a
    /// registry row's `id`. The one id that is the assistant's principal
    /// prints the configured name instead. Nothing else is mapped: a default
    /// routine's request says `source_agent: plan-tomorrow` with `trust:
    /// internal`, and the chip says what the row says rather than guessing
    /// who stands behind it (P5).
    public init(agentID: String, assistantName: String) {
        self.actor = agentID == Self.assistantPrincipal ? .assistant(name: assistantName) : .agent(id: agentID)
    }

    public var isAssistant: Bool {
        if case .assistant = actor { return true }
        return false
    }

    /// What the chip prints.
    public var label: String {
        switch actor {
        case .assistant(let name): return name
        case .agent(let id): return id
        }
    }

    /// What VoiceOver says: agent text carries its prefix (components-01 §2.8).
    public var spoken: String {
        switch actor {
        case .assistant(let name): return "from \(name)"
        case .agent(let id): return "from agent \(id)"
        }
    }

    public func mark(on ground: MetistryColorRole) -> Mark {
        Mark(label, style: .caption1, design: .mono, ink: .agent, plate: .agentQuiet, on: ground, shape: .chip, spoken: spoken)
    }
}

public struct AgentChip: View {
    let model: AgentChipModel
    let ground: MetistryColorRole

    public init(_ model: AgentChipModel, on ground: MetistryColorRole = .surface) {
        self.model = model
        self.ground = ground
    }

    public var body: some View {
        MarkView(model.mark(on: ground))
    }
}
