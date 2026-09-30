// Settings ▸ Compute (T6-12; screen-15 §5.3, C130–C133; plan §2.4): the pane's
// whole state, where every value comes from, and the one door each change goes
// through.
//
// ONE COLUMN, IN THIS ORDER (§5.3): the assistant uses — one model and its
// effort, no fallback · Providers — one line each · Your Models — memory and
// disk, the search with Refresh, the catalogue · Spending Limits — the
// instance's, each provider's (a subscription's is its window), each project's
// daily budget · Advanced: Tiers (Q1) — the allow-list the router chooses from.
//
// READS ARE THE CLIENT API, AND ONLY WHAT IT SERVES (§2.1, §2.16):
//
//   GET  /api/compute              the providers (switch, tag, key presence),
//                                  the assignments, and `limits` (T4-19)
//   GET  /api/compute/catalogue    every switched-on provider's catalogue,
//                                  grouped by model (T4-18, C131)
//
// WRITES GO THROUGH TWO DOORS, AND §2.3 DECIDES WHICH:
//
//   * Inside the boundary — the assistant's model and effort, a tier, a
//     spending limit, a project's daily budget, a provider test — are client
//     API writes a phone may also make (§2.3's row for the assistant's model
//     and effort, and spending limits): `POST /api/compute/assign|unassign|budget|
//     providers/test`, `PUT /api/projects/:slug`. Each is reversible and acts
//     at once, its answer said at the control (components-03 §3).
//   * The boundary itself — a provider's switch, its base URL, which secret
//     is its key, removing it, a model on this Mac's disk or in its memory —
//     is §2.2's M16 and M17: `metistry compute providers set|remove` and
//     `compute models install|load|unload`, a `ManagementCommand` shown with
//     the exact command and CONFIRMED before it runs (T6-11's pattern). The
//     type cannot hold a verb §2.2 does not list.
//
// No console route is added (invariant 10). What the design draws and nothing
// serves yet — a model's size, a download's cancel, a provider's headers and
// data policy, removing a model, *Add* on a cloud place — is said where it
// would be, dimmed with its reason (C138), never invented here.
//
// THE APP PERSISTS NOTHING ABOUT COMPUTE. `compute.yaml` is the record; the
// console reads it and the CLI writes it. The pane re-reads when it opens and
// when the instance changes.

import Foundation
import Observation

@MainActor
@Observable
public final class ComputeModel {
    /// What the last action did, in its door's own words. §3.16: the reason
    /// is shown at the control that produced it, verbatim, never re-worded.
    public struct Outcome: Sendable, Equatable {
        public let verb: String
        public let ok: Bool
        public let message: String

        public init(verb: String, ok: Bool, message: String) {
            self.verb = verb
            self.ok = ok
            self.message = message
        }
    }

    /// The one thing the pane can do about an install with no engine.
    public enum BannerAction: Sendable, Equatable {
        /// There are no providers at all: the sheet is the fix.
        case addProvider
    }

    /// `assistant: absent`, said where it can be acted on. Doctor's own row is
    /// the source — the app does not decide that an install has no engine —
    /// and its remediation is quoted rather than paraphrased.
    public struct EngineBanner: Sendable, Equatable {
        public let headline: String
        public let detail: String
        /// `nil` when the fix is a control already on the pane (the model
        /// dropdown), or when nothing here would fix it.
        public let actionLabel: String?
        public let action: BannerAction?

        public init(headline: String, detail: String, actionLabel: String?, action: BannerAction?) {
            self.headline = headline
            self.detail = detail
            self.actionLabel = actionLabel
            self.action = action
        }
    }

    /// The shared doctor report: the local servers and the `assistant` row
    /// are read from it; this pane runs no probe of its own (invariant 3).
    public let status: StatusModel
    /// The add-a-provider sheet — the WIZARD's step 7 model, not a second one.
    /// The key's single path to a `metistry` process's stdin lives in
    /// `ComputeStepModel.apply()`, and a second implementation of it is
    /// exactly the thing that would eventually put a key in argv.
    public let draft: ComputeStepModel

    public private(set) var cli: MetistryCLI?
    /// The active instance's console session — held, not copied, so an
    /// instance switch (which re-wires it) reaches here too.
    @ObservationIgnored public private(set) var session: ConsoleSession?
    @ObservationIgnored private let managementOverride: (any ManagementRunner)?

    // MARK: read-through, never persisted

    /// `GET /api/compute`.
    public private(set) var compute: ConsoleCompute?
    public private(set) var phase: ReadPhase = .idle
    /// `GET /api/compute/catalogue`, unfiltered: what fills every model
    /// dropdown and Your Models.
    public private(set) var catalogue: ComputeCatalogueReply?
    public private(set) var cataloguePhase: ReadPhase = .idle
    /// The search field, and what it last found. Empty = no search: Your
    /// Models shows the catalogue by where it runs.
    public var query: String = ""
    public private(set) var results: ComputeCatalogueReply?
    public private(set) var resultsPhase: ReadPhase = .idle
    public var filters: Set<CatalogueFilter> = []
    public var sort: CatalogueSort = .bestMatch

    /// The last provider test, per provider.
    public private(set) var tests: [String: ProviderTestFacts] = [:]
    /// What is in flight, by key, so one row's spinner is that row's.
    public private(set) var inFlight: Set<String> = []
    public private(set) var lastOutcome: Outcome?

    // MARK: §2.2, confirmed

    /// The M16/M17 verb on screen, before it runs. `nil`: none.
    public var confirmation: ComputeConfirmation?
    /// The M16/M17 verb running now, with its waiting words
    /// (*Loading into memory…*, a download's own progress below it).
    public private(set) var running: ComputeConfirmation?
    /// The CLI's own lines from the running (or last) verb, as they arrive.
    public private(set) var output: [OutputLine] = []
    /// A provider's gear, open. `nil`: closed.
    public var gear: ProviderGearDraft?
    /// *Install a Model…*, open. `nil`: closed.
    public var install: ModelInstallDraft?

    // MARK: this Mac

    /// Injected so a test does not depend on the machine it runs on.
    public var physicalMemory: UInt64 = ProcessInfo.processInfo.physicalMemory
    /// The home volume's capacity — where LM Studio, Ollama and the bundled
    /// server keep their models. A volume's own figures, not a file read.
    @ObservationIgnored public var diskCapacity: @MainActor () -> DiskCapacity? = { DiskCapacity.homeVolume() }
    @ObservationIgnored public var now: @MainActor () -> Date = { Date() }

    public init(
        status: StatusModel,
        cli: MetistryCLI?,
        session: ConsoleSession? = nil,
        management: (any ManagementRunner)? = nil,
        draft: ComputeStepModel? = nil
    ) {
        self.status = status
        self.cli = cli
        self.session = session
        self.managementOverride = management
        self.draft = draft ?? ComputeStepModel(cli: cli)
    }

    /// §2.2's runner: the session's, which follows every instance switch.
    public var management: (any ManagementRunner)? {
        managementOverride ?? session?.management ?? cli.map { CLIManagementRunner(cli: $0) }
    }

    /// Re-point at another install. Everything read-through is dropped rather
    /// than left showing the previous instance's providers beside a new path.
    public func adopt(cli: MetistryCLI?) {
        self.cli = cli
        draft.adopt(cli: cli)
        compute = nil
        phase = .idle
        catalogue = nil
        cataloguePhase = .idle
        results = nil
        resultsPhase = .idle
        query = ""
        tests = [:]
        lastOutcome = nil
        confirmation = nil
        output = []
        gear = nil
        install = nil
    }

    public var report: ComputeFacts? { compute?.facts }
    public var limits: ComputeLimits? { compute?.limits }
    /// The route the pane reads, for the unavailable card.
    public static let readRoute = "GET /api/compute"

    public func isBusy(_ key: String) -> Bool { inFlight.contains(key) }

    public static func providerKey(_ name: String) -> String { "provider:\(name)" }
    public static func assignKey(_ target: String) -> String { "assign:\(target)" }
    public static func limitKey(_ scope: String) -> String { "limit:\(scope)" }

    // MARK: - Reading

    /// `GET /api/compute`, then the unfiltered catalogue. Safe on appear.
    public func refresh() async {
        guard let stores = session?.stores else {
            phase = .unavailable("no console session for this instance")
            return
        }
        let generation = session?.generation
        phase = .reading
        let read = await stores.compute()
        guard session?.generation == generation else { return }
        switch read {
        case .success(let value):
            compute = value
            phase = .read
        case .failure(let error):
            compute = nil
            phase = .unavailable(Self.words(error))
        }
        await readCatalogue(refresh: false)
    }

    /// **Refresh** (C132): re-reads every switched-on provider's catalogue
    /// now, whatever its age — and the search, when there is one.
    public func refreshCatalogues() async {
        await readCatalogue(refresh: true)
        if !trimmedQuery.isEmpty { await search() }
    }

    private func readCatalogue(refresh: Bool) async {
        guard let stores = session?.stores else { return }
        let generation = session?.generation
        cataloguePhase = .reading
        let read = await stores.computeCatalogue(query: nil, provider: nil, refresh: refresh)
        guard session?.generation == generation else { return }
        switch read {
        case .success(let value):
            catalogue = value
            cataloguePhase = .read
        case .failure(let error):
            cataloguePhase = .unavailable(Self.words(error))
        }
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The search, grouped by model (C131). An empty field is no search.
    public func search() async {
        let q = trimmedQuery
        guard !q.isEmpty else {
            results = nil
            resultsPhase = .idle
            return
        }
        guard let stores = session?.stores else { return }
        let generation = session?.generation
        resultsPhase = .reading
        let read = await stores.computeCatalogue(query: q, provider: nil, refresh: false)
        guard session?.generation == generation, q == trimmedQuery else { return }
        switch read {
        case .success(let value):
            results = value
            resultsPhase = .read
        case .failure(let error):
            results = nil
            resultsPhase = .unavailable(Self.words(error))
        }
    }

    // MARK: - A model, written one way (§5.3)

    /// **name** maker · provider · tag — for any `<provider>/<model>`, from
    /// the catalogue when it serves the place, and from the reference and its
    /// provider's tag when it does not. Every place a model appears on this
    /// pane asks this, so no two places can write it differently.
    public func line(for ref: String) -> ComputeModelLine {
        for reply in [catalogue, results].compactMap({ $0 }) {
            for row in reply.rows {
                if let place = row.places.first(where: { $0.ref == ref }) {
                    return ComputeModelLine(row: row, place: place)
                }
            }
        }
        let provider = String(ref.prefix { $0 != "/" })
        let model = ref.count > provider.count ? String(ref.dropFirst(provider.count + 1)) : ref
        return ComputeModelLine(
            ref: ref,
            name: model,
            maker: nil,
            provider: provider,
            tag: report?.provider(named: provider)?.tag ?? .cloud,
            price: nil
        )
    }

    /// What a model dropdown offers: every place the catalogue serves on a
    /// switched-on provider, *On this Mac* first, then *Cloud* — and the
    /// value already chosen when the catalogue does not hold it, so a
    /// dropdown never shows a value it cannot say.
    public func modelOptions(including current: String? = nil) -> [ComputeModelLine] {
        var seen: Set<String> = []
        var out: [ComputeModelLine] = []
        let enabled = Set((report?.providers ?? []).filter(\.enabled).map(\.name))
        for row in catalogue?.rows ?? [] {
            for place in row.places where report == nil || enabled.contains(place.provider) {
                if seen.insert(place.ref).inserted { out.append(ComputeModelLine(row: row, place: place)) }
            }
        }
        if let current, !current.isEmpty, seen.insert(current).inserted { out.append(line(for: current)) }
        return ComputeModelLine.ordered(out)
    }

    /// Your Models with no search: one line each, *On this Mac* then *Cloud*.
    public var yourModels: (onThisMac: [ComputeModelLine], cloud: [ComputeModelLine]) {
        let all = modelOptions()
        return (all.filter { $0.tag.runsOnThisMac }, all.filter { !$0.tag.runsOnThisMac })
    }

    /// The search's rows, filtered and sorted as the controls say. Nothing is
    /// computed here that the reply does not carry.
    public var visibleResults: [ComputeSearchResult] {
        let wanted = Set(filters.compactMap(\.tag))
        let kept = (results?.rows ?? []).map { ComputeSearchResult(row: $0) }.filter { result in
            if !wanted.isEmpty, Set(result.lines.map(\.tag)).isDisjoint(with: wanted) { return false }
            if filters.contains(.tools), !result.capabilities.contains("tools") { return false }
            return true
        }
        switch sort {
        case .bestMatch:
            return kept
        case .cheapest:
            return Self.stableSort(kept, by: \.fromInPerM, ascending: true)
        case .largestContext:
            return Self.stableSort(kept, by: { $0.context.map(Double.init) }, ascending: false)
        }
    }

    /// Known values first, in the order asked; unknowns last; ties keep the
    /// server's best-match order.
    private static func stableSort(_ rows: [ComputeSearchResult], by value: (ComputeSearchResult) -> Double?, ascending: Bool) -> [ComputeSearchResult] {
        rows.enumerated().sorted { a, b in
            switch (value(a.element), value(b.element)) {
            case let (x?, y?) where x != y: return ascending ? x < y : x > y
            case (.some, nil): return true
            case (nil, .some): return false
            default: return a.offset < b.offset
            }
        }.map(\.element)
    }

    /// components-03 §2, empty: *No models match "zebra"*.
    public var noMatch: String? {
        guard resultsPhase == .read, visibleResults.isEmpty else { return nil }
        return "No models match \u{201C}\(trimmedQuery)\u{201D}"
    }

    /// components-03 §2: a silent provider named, and a list from yesterday —
    /// each provider's own line, from the catalogue's own `ok` and `read_at`.
    public var catalogueNotes: [CatalogueNote] {
        let reply = results ?? catalogue
        var out: [CatalogueNote] = []
        for provider in reply?.providers ?? [] {
            if !provider.ok {
                out.append(CatalogueNote(provider: provider.name, words: "\(provider.name) is not answering — \(provider.detail)", silent: true))
            } else if let stale = Self.staleWords(provider.readAt, now: now()) {
                out.append(CatalogueNote(provider: provider.name, words: "\(provider.name)\u{2019}s list is \(stale)", silent: false))
            }
        }
        for skipped in reply?.skipped ?? [] {
            out.append(CatalogueNote(provider: skipped.name, words: "\(skipped.name) is not searched — \(skipped.why)", silent: false))
        }
        return out
    }

    /// *from yesterday*, *from 3 days ago* — a listing read before today. A
    /// listing read today is current enough to say nothing about.
    nonisolated static func staleWords(_ readAt: String?, now: Date, calendar: Calendar = .current) -> String? {
        guard let when = WireTime.date(readAt) else { return nil }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: when), to: calendar.startOfDay(for: now)).day ?? 0
        switch days {
        case ..<1: return nil
        case 1: return "from yesterday"
        default: return "from \(days) days ago"
        }
    }

    // MARK: - The assistant uses (assignments.default)

    /// `assignments.default`, as the dropdown shows it.
    public var assistantModel: ComputeAssignmentFacts? {
        report?.assignments.first { $0.target == "default" }
    }

    /// The route's own body — `{tier}` or `{crew}`, exactly one.
    static func assignTarget(_ target: String) -> ComputeAssignTarget {
        target.hasPrefix("crew:") ? .crew(String(target.dropFirst("crew:".count))) : .tier(target)
    }

    /// `POST /api/compute/assign` — a model and its effort for `default`, a
    /// tier, or a crew. Reversible, so it acts at once.
    public func assign(target: String, ref: String, effort: ComputeEffort) async {
        let key = Self.assignKey(target)
        guard let stores = session?.stores, !ref.isEmpty, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        let line = line(for: ref)
        switch await stores.assignCompute(Self.assignTarget(target), model: ref, effort: effort.rawValue) {
        case .success(let result):
            let warn = result.warnNonZDR ? " — off this Mac and claiming no zero data retention: recorded, never blocked" : ""
            lastOutcome = Outcome(verb: "assign \(target)", ok: result.ok, message: "\(Self.targetLabel(target)) uses \(line.text) at \(effort.label.lowercased()) effort\(warn)")
        case .failure(let error):
            lastOutcome = Outcome(verb: "assign \(target)", ok: false, message: Self.words(error))
        }
        await refresh()
    }

    /// `POST /api/compute/unassign` — a tier or a crew goes back to landing
    /// on `default`. `default` itself is reassigned, never unassigned.
    public func unassign(target: String) async {
        let key = Self.assignKey(target)
        guard target != "default", let stores = session?.stores, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        switch await stores.unassignCompute(Self.assignTarget(target)) {
        case .success:
            lastOutcome = Outcome(verb: "unassign \(target)", ok: true, message: "\(target) removed — its turns land on the default model")
        case .failure(let error):
            lastOutcome = Outcome(verb: "unassign \(target)", ok: false, message: Self.words(error))
        }
        await refresh()
    }

    static func targetLabel(_ target: String) -> String {
        target == "default" ? "The default" : target
    }

    /// Advanced: Tiers (Q1) — every assignment but `default`, in the file's
    /// order: the allow-list the dynamic router chooses from.
    public var tiers: [ComputeAssignmentFacts] {
        (report?.assignments ?? []).filter { $0.target != "default" }
    }

    // MARK: - Spending limits (C130, C133)

    /// `POST /api/compute/budget` — the instance's or a provider's. An empty
    /// field is `nil`: leave it as it stands. A subscription has no dollar
    /// limit to set; the route refuses one, and this never sends one.
    public func setLimit(scope: String, daily: Double?, monthly: Double?, action: ComputeBudgetAction) async {
        let key = Self.limitKey(scope)
        guard let stores = session?.stores, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        switch await stores.setComputeBudget(scope: scope, daily: daily, monthly: monthly, action: action.rawValue) {
        case .success:
            let summary = ComputeBudgetFacts(dailyUSD: daily, monthlyUSD: monthly, action: action).summary
            lastOutcome = Outcome(verb: "limit \(scope)", ok: true, message: "\(Self.scopeLabel(scope)): \(summary) — enforced before every call")
        case .failure(let error):
            lastOutcome = Outcome(verb: "limit \(scope)", ok: false, message: Self.words(error))
        }
        await refresh()
    }

    /// `PUT /api/projects/:slug` with `daily_budget_usd` — the same door the
    /// Projects pane uses, so the two can never disagree about a project.
    public func setProjectBudget(_ project: String, daily: Double) async {
        let key = Self.limitKey("project:\(project)")
        guard let stores = session?.stores, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        switch await stores.updateProject(project, ProjectUpdate(dailyBudgetUSD: daily)) {
        case .success:
            lastOutcome = Outcome(verb: "limit project:\(project)", ok: true, message: "\(project): $\(ComputeBudgetFacts.money(daily))/day — at the limit it switches to review")
        case .failure(let error):
            lastOutcome = Outcome(verb: "limit project:\(project)", ok: false, message: Self.words(error))
        }
        await refresh()
    }

    static func scopeLabel(_ scope: String) -> String {
        scope == "instance" ? "This instance" : scope.hasPrefix("provider:") ? String(scope.dropFirst("provider:".count)) : scope
    }

    // MARK: - Providers

    /// `POST /api/compute/providers/test` — one live `GET <base_url>/models`
    /// with the provider's own credential, which the console resolves and this
    /// app never holds.
    public func testProvider(_ name: String) async {
        let key = Self.providerKey(name)
        guard let stores = session?.stores, !inFlight.contains(key) else { return }
        inFlight.insert(key)
        defer { inFlight.remove(key) }
        switch await stores.testComputeProvider(name, complete: false) {
        case .success(let reply):
            tests[name] = reply.facts
            lastOutcome = Outcome(verb: "test \(name)", ok: reply.facts.ok, message: reply.facts.detail)
        case .failure(let error):
            lastOutcome = Outcome(verb: "test \(name)", ok: false, message: Self.words(error))
        }
    }

    /// The one issue a provider line shows, only when there is one (§5.3):
    /// its last test, a key it names and this instance lacks, a local server
    /// doctor found not running, or a catalogue it did not answer.
    public func issue(for provider: ComputeProviderFacts) -> ProviderIssue? {
        if let test = tests[provider.name], !test.ok {
            return ProviderIssue.fromFailure(test.detail)
        }
        if provider.isMissingSecret { return .keyNotSet }
        if provider.tag == .local, let server = server(for: provider.name), server.status != .ok {
            return .notRunning
        }
        if provider.enabled, let listed = catalogue?.providers.first(where: { $0.name == provider.name }), !listed.ok {
            return ProviderIssue.fromFailure(listed.detail)
        }
        return nil
    }

    /// The add-a-provider sheet. The first provider on an install with no
    /// engine assigns the default in the same run; every later one does not.
    public func openAddProvider(template: ComputeTemplate = .openrouter) {
        draft.reset(template: template, assignsDefault: report?.assignsNothing ?? true)
    }

    /// The sheet's one button — the key goes to stdin in the step model, and
    /// this method never sees it. The sheet shows both commands before it runs.
    public func addProvider() async {
        await draft.apply()
        switch draft.phase {
        case .added(let name):
            lastOutcome = Outcome(verb: "compute providers add", ok: true, message: "provider \(name) added and tested")
        case .assigned(let ref):
            lastOutcome = Outcome(verb: "compute providers add", ok: true, message: "provider added, \(ref) assigned as the default")
        case .failed(let why):
            lastOutcome = Outcome(verb: "compute providers add", ok: false, message: why)
        default:
            break
        }
        await refresh()
    }

    /// The switch: `metistry compute providers set <name> --enabled on|off`
    /// (M16), confirmed. Off = not searched, not offered; the CLI refuses it
    /// while an assignment still names the provider, and says which.
    public func proposeSwitch(_ provider: ComputeProviderFacts, on: Bool) {
        guard provider.enabled != on,
              let command = ManagementCommand(.computeProviders, ["compute", "providers", "set", provider.name, "--enabled", on ? "on" : "off", "--json"])
        else { return }
        confirmation = ComputeConfirmation(
            title: on ? "Switch \(provider.name) on?" : "Switch \(provider.name) off?",
            cost: on
                ? "Its catalogue is searched again and its models are offered in every model menu."
                : "It is neither searched nor offered, and nothing may be assigned to it. Refused while an assignment still names it.",
            actionTitle: on ? "Switch On" : "Switch Off",
            command: command,
            waiting: on ? "Switching \(provider.name) on…" : "Switching \(provider.name) off…",
            done: on ? "\(provider.name) is on" : "\(provider.name) is off"
        )
    }

    /// Remove: `metistry compute providers remove <name>` (M16), confirmed,
    /// naming what stays behind.
    public func proposeRemove(_ provider: ComputeProviderFacts) {
        guard let command = ManagementCommand(.computeProviders, ["compute", "providers", "remove", provider.name, "--json"]) else { return }
        let keeps = provider.secretName.map { " The secret \($0) stays; Settings \u{203A} Secrets removes one." } ?? ""
        confirmation = ComputeConfirmation(
            title: "Remove \(provider.name)?",
            cost: "Its block leaves compute.yaml, as you. Refused while an assignment or a spending limit still names it — the refusal says which field.\(keeps)",
            actionTitle: "Remove",
            command: command,
            destructive: true,
            waiting: "Removing \(provider.name)…",
            done: "\(provider.name) removed"
        )
    }

    /// The gear: base URL, which secret is the key, billing.
    public func openGear(_ provider: ComputeProviderFacts) {
        gear = ProviderGearDraft(provider)
    }

    /// Save in the gear: `providers set <name>` with only what changed
    /// (M16), confirmed. Nothing changed = nothing to confirm.
    public func proposeGearSave() {
        guard let draft = gear else { return }
        gear = nil
        guard let command = draft.command else { return }
        confirmation = ComputeConfirmation(
            title: "Change \(draft.name)?",
            cost: "Where prompts go and which key they carry: written to compute.yaml as you, and read by the next call.",
            actionTitle: "Change",
            command: command,
            waiting: "Changing \(draft.name)…",
            done: "\(draft.name) changed"
        )
    }

    // MARK: - Models on this Mac (M17)

    /// Every local server doctor probed, whether or not compute.yaml dials it.
    public var localServers: [LocalServerFacts] { status.report?.localServers ?? [] }

    /// The local server a provider dials, from doctor's own rows.
    public func server(for provider: String) -> LocalServerFacts? {
        localServers.first { $0.provider == provider }
    }

    /// Load or Unload — LM Studio alone has an addressable load; the pane
    /// offers it nowhere else rather than a button that answers `noop`.
    public func proposeLoad(_ line: ComputeModelLine, unload: Bool) {
        guard server(for: line.provider)?.canLoad == true,
              let command = ManagementCommand(.localModels, ["compute", "models", unload ? "unload" : "load", line.ref, "--json"])
        else { return }
        confirmation = ComputeConfirmation(
            title: unload ? "Unload \(line.name)?" : "Load \(line.name)?",
            cost: unload
                ? "It leaves this Mac\u{2019}s memory; the next turn that needs it loads it again, slowly."
                : "It is loaded into this Mac\u{2019}s memory now, not on the first turn that needs it. \(memoryNote)",
            actionTitle: unload ? "Unload" : "Load",
            command: command,
            waiting: unload ? "Unloading \(line.name)…" : "Loading into memory…",
            done: unload ? "\(line.name) unloaded" : "\(line.name) loaded",
            refreshesDoctor: true
        )
    }

    /// *Install a Model…*: a local provider Metistry can pull for, and a model.
    public func beginInstall() {
        install = ModelInstallDraft(provider: installableProviders.first ?? "", model: "")
    }

    /// The configured local providers with an install mechanism.
    public var installableProviders: [String] {
        localServers.filter(\.canInstall).compactMap(\.provider)
    }

    /// Install: `metistry compute models install <provider>/<model>` (M17),
    /// confirmed — with this Mac's disk and memory said BEFORE it runs
    /// (components-03 §2), since the model's own size is not known until it
    /// downloads.
    public func proposeInstall() {
        guard let draft = install else { return }
        install = nil
        let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !draft.provider.isEmpty, !model.isEmpty,
              let command = ManagementCommand(.localModels, ["compute", "models", "install", "\(draft.provider)/\(model)", "--json"])
        else { return }
        confirmation = ComputeConfirmation(
            title: "Install \(model)?",
            cost: "Downloaded onto this Mac. \(diskNote) \(memoryNote) Its size is not known until the download starts; its progress shows here.",
            actionTitle: "Install",
            command: command,
            waiting: "Downloading \(model)…",
            done: "\(model) installed",
            refreshesDoctor: true
        )
    }

    public var memoryNote: String {
        "About \(MemoryHeadroom.gigabytes(MemoryHeadroom.headroomBytes(physical: physicalMemory))) GB of memory is free for a model (an estimate)."
    }

    public var diskNote: String {
        guard let disk = diskCapacity() else { return "This Mac\u{2019}s free disk space could not be read." }
        return "\(DiskCapacity.gigabytes(disk.availableBytes)) GB free on this Mac\u{2019}s disk."
    }

    // MARK: - Running a confirmed verb

    public func cancelConfirmation() {
        confirmation = nil
    }

    /// The confirmation's action: run the command it named — the one the
    /// owner read, handed back by the dialog rather than built again. The
    /// CLI's lines stream into `output` as they arrive (a download's own
    /// progress); its answer is read from its `--json`, and the read it
    /// changed is re-done.
    public func confirm(_ pending: ComputeConfirmation) async {
        if confirmation?.id == pending.id { confirmation = nil }
        guard let runner = management else {
            lastOutcome = Outcome(verb: pending.said, ok: false, message: CLIReadError.noRuntime.localizedDescription)
            return
        }
        guard running == nil else { return }
        running = pending
        output = []
        let sink = OutputSink()
        let collect: @Sendable (OutputLine) -> Void = { [weak self] line in
            sink.append(line)
            Task { @MainActor in self?.output = sink.drain() }
        }
        let verb = pending.command.arguments.prefix(3).joined(separator: " ")
        do {
            let result = try await runner.run(pending.command, onOutput: collect)
            output = sink.drain()
            if CLIDegradation.isUnknownVerb(result) {
                lastOutcome = Outcome(verb: pending.said, ok: false, message: CLIDegradation.message(verb: verb))
            } else {
                let json = JSONValue.parseTrailing(in: result.stdout)
                let ok = json?.bool("ok") ?? result.ok
                let detail = json?.string("detail").flatMap { $0.isEmpty ? nil : $0 }
                lastOutcome = Outcome(verb: pending.said, ok: ok, message: ok ? (detail ?? pending.done) : CLIDegradation.refusalMessage(result, verb: verb))
            }
        } catch {
            lastOutcome = Outcome(verb: pending.said, ok: false, message: error.localizedDescription)
        }
        running = nil
        await refresh()
        if pending.refreshesDoctor { await status.refresh() }
    }

    // MARK: - The engine banner

    /// `assistant: absent`, said where it can be acted on. Doctor decides that
    /// the engine is absent; this decides which of its two reasons applies.
    public var engineBanner: EngineBanner? {
        guard let report else { return nil }
        let row = status.report?.assistantRow
        if report.assignsNothing {
            let hasProvider = !report.providers.isEmpty
            return EngineBanner(
                headline: "assistant: absent — no default assignment",
                detail: row?.remediation ?? ComputeStepModel.skipNote,
                actionLabel: hasProvider ? nil : "Add a Provider…",
                action: hasProvider ? nil : .addProvider
            )
        }
        // There IS a default, and the key its provider names is not set here.
        // The fix is the provider's Replace Key, not a button on this row.
        guard row?.status == .absent,
              let unset = assistantModel.flatMap({ report.provider(named: $0.provider) }),
              unset.isMissingSecret
        else { return nil }
        return EngineBanner(
            headline: "assistant: absent — \(unset.secretName ?? unset.secret ?? "the provider's key") is not set",
            detail: row?.remediation ?? "the default model runs on \(unset.name), which authenticates with a secret this instance does not have.",
            actionLabel: nil,
            action: nil
        )
    }

    // MARK: - Words

    /// A refusal in the console's own words: the envelope's message, which
    /// names the field (`assignments.default`, `budgets.providers.x`).
    nonisolated static func words(_ error: ConsoleError) -> String {
        if case .http(_, let envelope?) = error { return envelope.message }
        return error.localizedDescription
    }

    public static let limitsNote =
        "Enforced before every call, against what the window has already spent. At a limit, Allow records the overrun and keeps going, "
        + "Stop refuses every call until the window rolls over, and Critical Only lets only turns marked critical through."
}

// MARK: - A model, written one way

/// **name** maker · provider · tag (screen-15 §5.3), and its price on the
/// right. Built in exactly two ways — from a catalogue place, or from a bare
/// reference the catalogue does not hold — and rendered by one view
/// (`ModelLineText`), so a model reads identically in the dropdown's field,
/// its menu, Your Models, a search result and a tier.
public struct ComputeModelLine: Sendable, Equatable, Identifiable {
    /// `<provider>/<model>` — exactly what an assignment takes.
    public let ref: String
    public let name: String
    public let maker: String?
    public let provider: String
    public let tag: ComputeTag
    /// *$0.02 / $0.04 per M*, *In your plan*, or nil on this Mac (free).
    public let price: String?

    public var id: String { ref }

    public init(ref: String, name: String, maker: String?, provider: String, tag: ComputeTag, price: String?) {
        self.ref = ref
        self.name = name
        self.maker = maker
        self.provider = provider
        self.tag = tag
        self.price = price
    }

    public init(row: ComputeCatalogueReply.Row, place: ComputeCatalogueReply.Place) {
        self.init(
            ref: place.ref,
            name: row.name,
            maker: row.maker,
            provider: place.provider,
            tag: ComputeTag(wire: place.tag),
            price: Self.price(inPerM: place.inPerM, outPerM: place.outPerM, included: place.included)
        )
    }

    /// Everything after the name: maker · provider · tag.
    public var detail: String {
        ([maker].compactMap { $0 } + [provider, tag.label]).joined(separator: " \u{00B7} ")
    }

    /// The line as plain text — what a menu item and a test read.
    public var text: String { "\(name) \(detail)" }

    /// What VoiceOver says: the same words, with pauses where the dots are.
    public var spoken: String {
        ([name] + [maker].compactMap { $0 } + [provider, tag.label] + [price].compactMap { $0 }).joined(separator: ", ")
    }

    /// Per million tokens in / out; a subscription's place is in the plan.
    public static func price(inPerM: Double?, outPerM: Double?, included: Bool) -> String? {
        if included { return "In your plan" }
        guard let inPerM else { return nil }
        return "\(dollars(inPerM))\(outPerM.map { " / \(dollars($0))" } ?? "") per M"
    }

    /// Cents, and a tenth of a cent below one.
    static func dollars(_ value: Double) -> String {
        value > 0 && value < 0.01 ? String(format: "$%.3f", value) : String(format: "$%.2f", value)
    }

    /// *On this Mac* first, then *Cloud*; by name within each.
    static func ordered(_ lines: [ComputeModelLine]) -> [ComputeModelLine] {
        lines.enumerated().sorted { a, b in
            if a.element.tag.runsOnThisMac != b.element.tag.runsOnThisMac { return a.element.tag.runsOnThisMac }
            let byName = a.element.name.localizedCaseInsensitiveCompare(b.element.name)
            return byName == .orderedSame ? a.offset < b.offset : byName == .orderedAscending
        }.map(\.element)
    }
}

/// One search result, grouped by MODEL (C131): the model, then one line per
/// place it runs.
public struct ComputeSearchResult: Sendable, Equatable, Identifiable {
    public let key: String
    public let name: String
    public let maker: String?
    public let context: Int?
    public let capabilities: [String]
    public let lines: [ComputeModelLine]
    public let places: [ComputeCatalogueReply.Place]
    public let local: Bool
    public let cloud: Bool
    public let fromInPerM: Double?

    public var id: String { key }

    public init(row: ComputeCatalogueReply.Row) {
        key = row.key
        name = row.name
        maker = row.maker
        context = row.context
        capabilities = row.capabilities
        lines = row.places.map { ComputeModelLine(row: row, place: $0) }
        places = row.places
        local = row.local
        cloud = row.cloud
        fromInPerM = row.fromInPerM
    }

    /// *N places*.
    public var placesWord: String { lines.count == 1 ? "1 place" : "\(lines.count) places" }

    /// The collapsed result: *Local or cloud · from $0.10 per M*.
    public var summary: String {
        let where_: String
        switch (local, cloud) {
        case (true, true): where_ = "Local or cloud"
        case (true, false): where_ = "Local"
        default: where_ = "Cloud"
        }
        guard let from = fromInPerM else { return where_ }
        return "\(where_) \u{00B7} from \(ComputeModelLine.dollars(from)) per M"
    }

    /// Maker, context, capabilities and *N places*, for the result's header.
    public var facts: String {
        var parts: [String] = []
        if let maker { parts.append(maker) }
        if let context { parts.append(context >= 1000 ? "\(context / 1000)K context" : "\(context) context") }
        if !capabilities.isEmpty { parts.append(capabilities.joined(separator: ", ")) }
        parts.append(placesWord)
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// Filters: Local · Cloud · Subscription · Tools. *Fits this Mac* is drawn
/// and not built: nothing serves a model's size yet.
public enum CatalogueFilter: String, CaseIterable, Sendable, Identifiable {
    case local, cloud, subscription, tools

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .local: return "Local"
        case .cloud: return "Cloud"
        case .subscription: return "Subscription"
        case .tools: return "Tools"
        }
    }

    var tag: ComputeTag? {
        switch self {
        case .local: return .local
        case .cloud: return .cloud
        case .subscription: return .subscription
        case .tools: return nil
        }
    }
}

/// Sort: Best match · Cheapest · Largest context.
public enum CatalogueSort: String, CaseIterable, Sendable, Identifiable {
    case bestMatch, cheapest, largestContext

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .bestMatch: return "Best Match"
        case .cheapest: return "Cheapest"
        case .largestContext: return "Largest Context"
        }
    }
}

/// A provider's catalogue said something about itself.
public struct CatalogueNote: Sendable, Equatable, Identifiable {
    public let provider: String
    public let words: String
    /// It did not answer — components-03's *a silent provider named*.
    public let silent: Bool

    public var id: String { "\(provider):\(words)" }
}

/// The one issue a provider line carries (§5.3; components-03 §2's failed
/// state), with the action that answers it.
public enum ProviderIssue: Sendable, Equatable {
    case notRunning
    case keyNotSet
    case keyRejected
    case notAnswering

    public var label: String {
        switch self {
        case .notRunning: return "Not running"
        case .keyNotSet: return "Key not set"
        case .keyRejected: return "Key rejected"
        case .notAnswering: return "Not answering"
        }
    }

    /// *Retry* for a provider that did not answer; *Replace Key* where the
    /// key is the problem — the key is one of this instance's secrets, so
    /// that opens Secrets (§2.2 M7), never a field here.
    public var actionLabel: String { replacesKey ? "Replace Key" : "Retry" }

    public var replacesKey: Bool { self == .keyNotSet || self == .keyRejected }

    /// A 401 or 403 is the key; anything else is the provider not answering.
    static func fromFailure(_ detail: String) -> ProviderIssue {
        detail.range(of: #"\b(401|403)\b"#, options: .regularExpression) != nil ? .keyRejected : .notAnswering
    }
}

/// What a confirmed M16/M17 verb is, before it runs: what it is called, what
/// it costs, the exact command, and what the pane says while it runs.
public struct ComputeConfirmation: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let title: String
    public let cost: String
    public let actionTitle: String
    public let command: ManagementCommand
    public let destructive: Bool
    /// While it runs: *Loading into memory…*, *Downloading qwen3:8b…*.
    public let waiting: String
    /// Its success in the pane's words when the CLI's JSON carries no `detail`.
    public let done: String
    /// A model changed on this Mac: doctor's local-server rows re-read.
    public let refreshesDoctor: Bool

    public init(
        title: String, cost: String, actionTitle: String, command: ManagementCommand, destructive: Bool = false,
        waiting: String, done: String, refreshesDoctor: Bool = false
    ) {
        self.title = title
        self.cost = cost
        self.actionTitle = actionTitle
        self.command = command
        self.destructive = destructive
        self.waiting = waiting
        self.done = done
        self.refreshesDoctor = refreshesDoctor
    }

    /// The command as a person would type it.
    public var said: String { (["metistry"] + command.arguments).joined(separator: " ") }
}

/// `--billing token|subscription` — `BILLINGS` in `packages/core`.
public enum ComputeBilling: String, CaseIterable, Sendable, Identifiable {
    case token, subscription

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .token: return "By the Token"
        case .subscription: return "Subscription"
        }
    }
}

/// A provider's gear, being edited: what `providers set` takes.
public struct ProviderGearDraft: Sendable, Equatable {
    public let name: String
    public let tag: ComputeTag
    public var baseURL: String
    /// The NAME of the instance secret that is the key — never a value.
    public var secret: String
    /// Off this Mac only: billed by the token, or a subscription.
    public var billing: ComputeBilling?
    public let zdr: Bool?
    private let originalBaseURL: String
    private let originalSecret: String
    private let originalBilling: ComputeBilling?

    public init(_ provider: ComputeProviderFacts) {
        name = provider.name
        tag = provider.tag
        baseURL = provider.baseURL
        secret = provider.secretName ?? ""
        billing = provider.tag == .local ? nil : (provider.tag == .subscription ? .subscription : .token)
        zdr = provider.zdr
        originalBaseURL = baseURL
        originalSecret = secret
        originalBilling = billing
    }

    /// `providers set <name>` with only what changed, or nil when nothing did.
    public var command: ManagementCommand? {
        var arguments = ["compute", "providers", "set", name]
        let url = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if url != originalBaseURL, !url.isEmpty { arguments += ["--base-url", url] }
        let key = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        if key != originalSecret, !key.isEmpty { arguments += ["--secret", key] }
        if let billing, billing != originalBilling { arguments += ["--billing", billing.rawValue] }
        guard arguments.count > 4 else { return nil }
        return ManagementCommand(.computeProviders, arguments + ["--json"])
    }
}

/// *Install a Model…*, being typed.
public struct ModelInstallDraft: Sendable, Equatable {
    public var provider: String
    public var model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }
}

/// A volume's size and what is free on it, from the volume's own figures.
public struct DiskCapacity: Sendable, Equatable {
    public let totalBytes: UInt64
    public let availableBytes: UInt64

    public init(totalBytes: UInt64, availableBytes: UInt64) {
        self.totalBytes = totalBytes
        self.availableBytes = availableBytes
    }

    /// The home volume — where the local servers keep their models.
    public static func homeVolume() -> DiskCapacity? {
        let values = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey])
        guard let total = values?.volumeTotalCapacity, let free = values?.volumeAvailableCapacityForImportantUsage else { return nil }
        return DiskCapacity(totalBytes: UInt64(max(total, 0)), availableBytes: UInt64(max(free, 0)))
    }

    /// How full the volume is, 0…1.
    public var usedFraction: Double {
        totalBytes == 0 ? 0 : Double(totalBytes - min(availableBytes, totalBytes)) / Double(totalBytes)
    }

    public static func gigabytes(_ bytes: UInt64) -> String {
        String(format: "%.0f", Double(bytes) / 1_000_000_000)
    }
}
