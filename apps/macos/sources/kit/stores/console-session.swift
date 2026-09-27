// One instance's console, as the app holds it (design-build-plan §2.16, T5-1).
//
// THE COMPOSITION, IN ONE PLACE. Every screen of one instance reaches the
// console through the same four things, built here and nowhere else:
//
//     metistry console session --stdio        one child per instance (F-12)
//       └─ ReachabilityGate                   O3: the answer recorded, a decision refused while unreachable
//            └─ ConsoleStores                 the fourteen §2.16 protocols, one method per route (F-7)
//                 └─ InstanceStore            the Phase-A sections (feed, queue, board, …)
//
// plus `management` — `CLIManagementRunner`, §2.2's verbs, which do NOT go
// through the gate: restarting a console that is down is exactly when the
// owner needs M5, and a management verb talks to this Mac, not to the console.
//
// The child starts lazily, on the first request, so holding a session costs
// nothing until a screen asks. `adopt` is the instance switch: the old child
// is ended, every section built on this session is dropped (a value belongs
// to the install it was asked about), and `generation` moves so an answer
// still in flight for the previous instance is discarded when it lands.
//
// What the app used to have instead: `InstanceStore(api:)`, built by nobody —
// the app held no client at all. Now `AppModel.console` is this.

import Foundation
import Observation

@MainActor
@Observable
public final class ConsoleSession {
    /// Every §2.16 protocol, over the gate. A view calls a method on this (as
    /// `any NeedsYouStore`, `any WorkStore`, …) and never holds a transport.
    public private(set) var stores: ConsoleStores
    /// O3's one source: what the console last said, and whether a decision may go.
    public private(set) var gate: ReachabilityGate
    /// §2.2's verbs over this install's CLI. Nil with no runtime located —
    /// there is nothing to run them with.
    public private(set) var management: (any ManagementRunner)?
    /// The Phase-A sections, over the same gate and the same child.
    public let instance: InstanceStore
    /// The one live-changes subscription (§2.20, T5-7): `GET /api/events` over
    /// the same child, feeding every `SectionModel` with topics and the shell.
    /// Started by the app (`AppModel.startShell`); it survives `adopt` and
    /// reopens against the new instance.
    public let events: LiveEvents
    /// Moves on every `adopt`. A read that started before the switch compares
    /// it when it returns, and drops an answer that belongs to the other instance.
    public private(set) var generation = 0

    @ObservationIgnored private var spawner: (any SessionSpawner)?
    @ObservationIgnored private var child: SessionConsoleCallTransport?
    @ObservationIgnored private var dependents: [@MainActor () -> Bool] = []

    /// The production session: the install's own CLI, one long-lived
    /// `console session` child spawned through `spawner` (the app's `Process`
    /// runner). With no spawner — a platform with no `Process` — every request
    /// is a `metistry console call`; with no CLI, nothing can be asked and the
    /// session says so from the start.
    public convenience init(
        cli: MetistryCLI?,
        spawner: (any SessionSpawner)?,
        instanceID: String? = nil,
        defaults: UserDefaults = .standard
    ) {
        let wiring = Self.wiring(cli: cli, spawner: spawner)
        self.init(
            transport: wiring.transport,
            stream: wiring.stream,
            management: cli.map { CLIManagementRunner(cli: $0) },
            initially: wiring.initially,
            instanceID: instanceID,
            defaults: defaults
        )
        self.spawner = spawner
        self.child = wiring.child
    }

    /// Any transport — the recorded fixtures, a scripted console. `stream`
    /// defaults to the transport itself when it can hold `GET /api/events` open.
    public init(
        transport: any ConsoleCallTransport,
        stream: (any ConsoleEventTransport)? = nil,
        management: (any ManagementRunner)?,
        initially: ConsoleReachability = .reachable,
        instanceID: String? = nil,
        defaults: UserDefaults = .standard,
        eventTiming: LiveEvents.Timing = .standard
    ) {
        let gate = ReachabilityGate(transport, initially: initially)
        let stores = ConsoleStores(transport: gate, stream: stream ?? (transport as? any ConsoleEventTransport))
        self.gate = gate
        self.stores = stores
        self.management = management
        self.instance = InstanceStore(api: stores.api, instanceID: instanceID, defaults: defaults)
        self.events = LiveEvents(stores: stores, timing: eventTiming)
    }

    // MARK: - What a view reads

    public var reachability: ConsoleReachability { gate.reachability }
    /// O3. A decision control binds `.disabled(!session.allowsDecisions)` and
    /// prints `decisionsUnavailableReason` under itself — a control disabled by
    /// a fact about the system always shows that fact (components-01 §1.3).
    public var allowsDecisions: Bool { gate.allowsDecisions }
    public var decisionsUnavailableReason: String? {
        guard case .unreachable(let why) = gate.reachability else { return nil }
        return "\(ReachabilityGate.decisionsNeedTheConnection) — \(why)"
    }

    // MARK: - Switching instance

    /// Point the session at another install, or the same one through a
    /// re-resolved runtime. The old child is ended; every section is dropped.
    public func adopt(cli: MetistryCLI?, instanceID: String? = nil, defaults: UserDefaults = .standard) {
        let wiring = Self.wiring(cli: cli, spawner: spawner)
        adopt(
            transport: wiring.transport,
            stream: wiring.stream,
            management: cli.map { CLIManagementRunner(cli: $0) },
            initially: wiring.initially,
            instanceID: instanceID,
            defaults: defaults
        )
        child = wiring.child
    }

    public func adopt(
        transport: any ConsoleCallTransport,
        stream: (any ConsoleEventTransport)? = nil,
        management: (any ManagementRunner)?,
        initially: ConsoleReachability = .reachable,
        instanceID: String? = nil,
        defaults: UserDefaults = .standard
    ) {
        shutdown()
        generation += 1
        let gate = ReachabilityGate(transport, initially: initially)
        let stores = ConsoleStores(transport: gate, stream: stream ?? (transport as? any ConsoleEventTransport))
        self.gate = gate
        self.stores = stores
        self.management = management
        instance.adopt(api: stores.api, instanceID: instanceID, defaults: defaults)
        events.adopt(stores)
        dependents = dependents.filter { $0() }
    }

    /// Ends the session child, if one was started. The next request starts a
    /// new one — this is not a way to stop asking, it is a way to let go.
    public func shutdown() {
        guard let child else { return }
        self.child = nil
        Task { await child.shutdown() }
    }

    /// A section built on this session registers here to be dropped on
    /// `adopt`. The closure answers false once its owner is gone.
    func register(_ reset: @escaping @MainActor () -> Bool) {
        dependents.append(reset)
    }

    // MARK: - Wiring

    private struct Wiring {
        let transport: any ConsoleCallTransport
        let stream: (any ConsoleEventTransport)?
        let child: SessionConsoleCallTransport?
        let initially: ConsoleReachability
    }

    private static func wiring(cli: MetistryCLI?, spawner: (any SessionSpawner)?) -> Wiring {
        guard let cli else {
            // Reported, not inferred: the locator found no runtime, so there
            // is nothing to ask and nothing to decide with.
            let why = CLIReadError.noRuntime.localizedDescription
            return Wiring(transport: UnavailableConsoleTransport(reason: why), stream: nil, child: nil, initially: .unreachable(why))
        }
        guard let spawner else {
            return Wiring(transport: CLIConsoleCallTransport(cli: cli), stream: nil, child: nil, initially: .reachable)
        }
        let child = SessionConsoleCallTransport(cli: cli, spawner: spawner)
        return Wiring(transport: child, stream: child, child: child, initially: .reachable)
    }
}

/// The transport of a session with no runtime: every request is answered with
/// the reason, and nothing is spawned.
public struct UnavailableConsoleTransport: ConsoleCallTransport {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }

    public func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.notConfigured(reason))
    }
}
