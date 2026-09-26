// Settings → Compute: the pane's whole state, and the nine verbs behind it.
//
// EVERY BUTTON ON THIS PANE IS A `metistry compute …` CALL. Nothing here edits
// compute.yaml, opens the Keychain, dials a provider or counts a model. The CLI
// does all of it — it writes the file as the `user` through the reconciler
// (invariant 2), validates the RESULT through core's schema before writing, and
// refuses with the field name when it cannot (`packages/cli/src/compute.ts`).
// This model runs the argument array and renders what came back:
//
//   compute show --json                          what is configured now
//   compute providers add --from <t> --json      + the key, on STDIN
//   compute providers remove <name> --json
//   compute providers test <name> --json         one live GET /v1/models
//   compute models list --provider <n> --json    what fills a model picker
//   compute models install <ref> --json          lms get / ollama pull / a GGUF
//   compute models load|unload <ref> --json      LM Studio only, honestly
//   compute assign <target> <ref> --json
//   compute budget <target> --action … --json
//
// THE APP PERSISTS NOTHING ABOUT COMPUTE. compute.yaml is the record; there is
// no app-side copy of a provider list, a model catalogue or a budget, and no
// UserDefaults key on this pane (app-preferences.swift holds the three pointers
// the app does persist, and none of them is here). The pane re-reads when it
// appears and when the instance changes. The app watches no directory — it has
// no file watcher at all, which is the same reason it has no file reader — so a
// change made in a terminal shows up on the next read, and the pane prints the
// command that read it.
//
// ON STDOUT. Most of these verbs narrate through the same `out()` the `--json`
// result goes to, so stdout is prose and then one object. `JSONValue.parseTrailing`
// is that one fact, in one place (cli-facts.swift).

import Foundation
import Observation

@MainActor
@Observable
public final class ComputeModel {
    /// What the last action did, in the CLI's own words. §3.16: the reason is
    /// shown at the control that produced it, verbatim, never re-worded.
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
        /// There is a provider; what is missing is the line that picks one.
        case assignDefault
    }

    /// `assistant: absent`, said where it can be acted on. Doctor's own row is
    /// the source — the app does not decide that an install has no engine — and
    /// its remediation is quoted rather than paraphrased.
    public struct EngineBanner: Sendable, Equatable {
        public let headline: String
        public let detail: String
        /// `nil` when nothing this pane offers would fix it, which is an answer
        /// (design-system P5) and better than a button that cannot work.
        public let actionLabel: String?
        public let action: BannerAction?

        public init(headline: String, detail: String, actionLabel: String?, action: BannerAction?) {
            self.headline = headline
            self.detail = detail
            self.actionLabel = actionLabel
            self.action = action
        }
    }

    /// The shared doctor report. The local-server rows and the `assistant` row
    /// are read from it; this pane runs no probe of its own (invariant 3).
    public let status: StatusModel
    /// The add-a-provider sheet — and it is the WIZARD's step 7 model, not a
    /// second one. The key's single path to a `metistry` process's stdin lives
    /// in `ComputeStepModel.apply()`, and a second implementation of it is
    /// exactly the thing that would eventually put a key in argv.
    public let draft: ComputeStepModel

    public private(set) var cli: MetistryCLI?
    public private(set) var report: ComputeFacts?
    public private(set) var phase: ReadPhase = .idle
    public private(set) var lastCommand: String?
    /// The `compute show --json` that produced `report`, kept apart from
    /// `lastCommand` so a pane quoting the READ does not end up quoting
    /// whatever was pressed last.
    public private(set) var showCommand: String?
    /// The CLI's own lines from the last action, so a download's progress and a
    /// refusal are both read in its words rather than summarised here.
    public private(set) var output: [OutputLine] = []
    public private(set) var lastOutcome: Outcome?
    /// What is in flight, by key, so one row's spinner is that row's.
    public private(set) var inFlight: Set<String> = []
    /// `compute models list --provider <name>`, per provider, never cached to
    /// disk and dropped on every instance switch.
    public private(set) var catalogues: [String: ModelCatalogue] = [:]
    /// The last `providers test` answer, per provider.
    public private(set) var tests: [String: ProviderTestFacts] = [:]

    public init(status: StatusModel, cli: MetistryCLI?, draft: ComputeStepModel? = nil) {
        self.status = status
        self.cli = cli
        self.draft = draft ?? ComputeStepModel(cli: cli)
    }

    /// Re-point at another install. Everything read-through is dropped rather
    /// than left showing the previous instance's providers beside a new path.
    public func adopt(cli: MetistryCLI?) {
        self.cli = cli
        draft.adopt(cli: cli)
        report = nil
        phase = .idle
        lastCommand = nil
        showCommand = nil
        output = []
        lastOutcome = nil
        catalogues = [:]
        tests = [:]
    }

    // MARK: - Keys for the in-flight set

    public static func providerKey(_ name: String) -> String { "provider:\(name)" }
    public static func assignKey(_ target: String) -> String { "assign:\(target)" }
    public static func budgetKey(_ target: String) -> String { "budget:\(target)" }
    public static func modelsKey(_ provider: String) -> String { "models:\(provider)" }
    /// Keyed on the PROVIDER, not the reference: the model id is being typed
    /// while the row is on screen, and a key that changed under the spinner
    /// would leave it running on a row nobody is looking at.
    public static func serverKey(_ provider: String) -> String { "server:\(provider)" }

    /// The provider half of `<provider>/<model>`, for the in-flight key.
    static func providerOf(ref: String) -> String {
        String(ref.prefix { $0 != "/" })
    }

    public func isBusy(_ key: String) -> Bool { inFlight.contains(key) }
    public var isWorking: Bool { !inFlight.isEmpty }

    // MARK: - Reading

    /// `metistry compute show --json`. Safe on appear: it changes nothing.
    public func refresh() async {
        guard let cli else {
            phase = .unavailable(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        showCommand = cli.plannedArguments(for: ["compute", "show", "--json"]).joined(separator: " ")
        lastCommand = showCommand
        phase = .reading
        switch await cli.computeShow() {
        case .success(let facts):
            report = facts
            phase = .read
        case .failure(let error):
            report = nil
            phase = .unavailable(error.localizedDescription ?? "unavailable")
        }
    }

    /// `metistry compute models list --provider <name> --json` — live, from the
    /// provider itself. This is what a model picker is filled from: the app
    /// keeps no catalogue of its own to go stale, and a provider that did not
    /// answer says so in the picker rather than showing an empty list.
    public func loadCatalogue(for provider: String) async {
        let json = await perform(
            ["compute", "models", "list", "--provider", provider, "--json"],
            naming: "compute models list",
            key: Self.modelsKey(provider)
        ) { json in
            let found = ModelCatalogue.decode(json ?? .null).first { $0.provider == provider }
            return found.map { "\($0.provider): \($0.detail)" } ?? "the reply named no provider \(provider)"
        }
        if let found = ModelCatalogue.decode(json ?? .null).first(where: { $0.provider == provider }) {
            catalogues[provider] = found
        }
    }

    /// The ids offered for a provider, and whether they were asked for yet.
    public func models(for provider: String) -> [String] {
        catalogues[provider]?.models ?? []
    }

    // MARK: - Providers

    /// Run the sheet. `assignsDefault` is the pane's decision, not the sheet's:
    /// the first provider on an install with no engine assigns the default in
    /// the same run, and every later one does not.
    public func openAddProvider(template: ComputeTemplate = .openrouter) {
        draft.reset(template: template, assignsDefault: report?.assignsNothing ?? true)
    }

    /// The sheet's one button. Delegates to the step model — the key goes to
    /// stdin there, and this method never sees it.
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
        output = draft.output
        await refresh()
    }

    /// `metistry compute providers remove <name> --json`.
    ///
    /// The CLI refuses while anything still names the provider, and names the
    /// FIELD (`assignments.default`, `budgets.providers.x`) — which is what the
    /// pane prints, because it is the thing to change next.
    public func removeProvider(_ name: String) async {
        await perform(
            ["compute", "providers", "remove", name, "--json"],
            naming: "compute providers remove",
            key: Self.providerKey(name)
        ) { _ in "provider \(name) removed — its key is left in the login Keychain, which only `metistry secrets` deletes from" }
        catalogues[name] = nil
        tests[name] = nil
        await refresh()
    }

    /// `metistry compute providers test <name> --json` — one live
    /// `GET /v1/models` with the provider's own credential, which the CLI
    /// resolves and this app never holds.
    public func testProvider(_ name: String) async {
        let json = await perform(
            ["compute", "providers", "test", name, "--json"],
            naming: "compute providers test",
            key: Self.providerKey(name)
        ) { json in ProviderTestFacts(json: json ?? .null)?.detail ?? "the test printed nothing this pane could read" }
        if let facts = ProviderTestFacts(json: json ?? .null) {
            tests[name] = facts
            // A test already asked the provider what it serves; asking twice
            // would be a second round trip for an answer in hand.
            catalogues[name] = ModelCatalogue(provider: name, ok: facts.ok, detail: facts.detail, models: facts.models)
        }
    }

    // MARK: - Assignments

    /// `metistry compute assign <target> <provider/model> --effort <e> --json`.
    ///
    /// `target` is the CLI's own spelling — `default`, a tier name, or
    /// `crew:<name>` — taken from the report rather than re-derived, so the app
    /// cannot address a tier the file does not have.
    public func assign(target: String, ref: String, effort: ComputeEffort) async {
        await perform(
            ["compute", "assign", target, ref, "--effort", effort.rawValue, "--json"],
            naming: "compute assign",
            key: Self.assignKey(target)
        ) { json in
            let warn = json?.bool("warn_non_zdr", "warnNonZdr") == true
            return "\(target) → \(ref) at \(effort.rawValue) effort"
                + (warn ? " ⚠ off this machine and claiming no zero data retention — recorded, never blocked" : "")
        }
        await refresh()
    }

    // MARK: - Budgets

    /// `metistry compute budget <instance|provider:<name>> [--daily] [--monthly] --action … --json`.
    ///
    /// The CLI refuses an action with no limit behind it ("an action with no
    /// limit never fires"), so the pane passes whatever was typed and prints
    /// that refusal rather than pre-empting it with a rule of its own.
    public func setBudget(target: String, daily: Double?, monthly: Double?, action: ComputeBudgetAction) async {
        var verb = ["compute", "budget", target]
        if let daily { verb += ["--daily", ComputeBudgetFacts.money(daily)] }
        if let monthly { verb += ["--monthly", ComputeBudgetFacts.money(monthly)] }
        verb += ["--action", action.rawValue, "--json"]
        await perform(verb, naming: "compute budget", key: Self.budgetKey(target)) { _ in
            "\(target): \(ComputeBudgetFacts(dailyUSD: daily, monthlyUSD: monthly, action: action).summary) — recorded; nothing enforces it yet, budgets are checked in the engine before the call"
        }
        await refresh()
    }

    /// `instance` / `provider:<name>` — the two spellings `parseBudgetTarget`
    /// accepts, and the app builds no third.
    public static let instanceBudgetTarget = "instance"
    public static func providerBudgetTarget(_ name: String) -> String { "provider:\(name)" }

    // MARK: - Local models

    /// Every local server doctor probed, whether or not compute.yaml dials it.
    public var localServers: [LocalServerFacts] { status.report?.localServers ?? [] }

    /// `metistry compute models install <provider>/<model> --json`.
    ///
    /// PROGRESS IS THE CLI'S OWN PROSE, not a JSON stream: `lms get`'s output,
    /// Ollama's `/api/pull` status lines and the GGUF download's byte counts
    /// all arrive on stdout as they happen (`packages/cli/src/compute.ts`
    /// passes `onProgress` straight to `out`), and the `--json` result is one
    /// object printed after them. The pane shows those lines verbatim while it
    /// runs, then the result — so there is no progress bar claiming a
    /// percentage nobody reported.
    public func installModel(ref: String) async -> ModelActionFacts? {
        let json = await perform(
            ["compute", "models", "install", ref, "--json"],
            naming: "compute models install",
            key: Self.serverKey(Self.providerOf(ref: ref))
        ) { json in ModelActionFacts(json: json ?? .null)?.detail ?? "the install printed nothing this pane could read" }
        await refresh()
        return ModelActionFacts(json: json ?? .null)
    }

    /// `metistry compute models load|unload <provider>/<model> --json`.
    ///
    /// Only LM Studio has an addressable load. For the other two the CLI
    /// answers `noop` with the sentence about what actually governs their
    /// residency, and the pane prints that instead of a tick it did not earn.
    public func loadModel(ref: String, unload: Bool) async {
        await perform(
            ["compute", "models", unload ? "unload" : "load", ref, "--json"],
            naming: "compute models \(unload ? "unload" : "load")",
            key: Self.serverKey(Self.providerOf(ref: ref))
        ) { json in ModelActionFacts(json: json ?? .null)?.detail ?? "\(ref): \(unload ? "unloaded" : "loaded")" }
    }

    /// The machine's memory, for the local-models section's estimate. Injected
    /// so a test does not depend on the machine it runs on.
    public var physicalMemory: UInt64 = ProcessInfo.processInfo.physicalMemory

    public var memoryNote: String { MemoryHeadroom.summary(physical: physicalMemory) }

    // MARK: - The engine banner

    /// `assistant: absent`, said where it can be acted on — or said plainly
    /// where it cannot. Doctor decides that the engine is absent; this decides
    /// which of the two reasons applies and what the pane offers about it.
    public var engineBanner: EngineBanner? {
        let row = status.report?.assistantRow
        if report?.assignsNothing == true {
            let hasProvider = !(report?.providers.isEmpty ?? true)
            return EngineBanner(
                headline: "assistant: absent — no default assignment",
                detail: row?.remediation ?? ComputeStepModel.skipNote,
                actionLabel: hasProvider ? "Assign a Default Model…" : "Add a Provider…",
                action: hasProvider ? .assignDefault : .addProvider
            )
        }
        // The other reason doctor reports the same row absent: there IS a
        // default, and the key its provider names is not set here. Nothing one
        // button on this pane does would fix that — the key is stored by
        // `providers add`, which refuses to re-declare a provider that already
        // exists — so the row carries doctor's own remediation and no button.
        guard row?.status == .absent, let report else { return nil }
        let onDefault = report.assignments.first { $0.target == "default" }
            .flatMap { report.provider(named: $0.provider) }
        guard let unset = onDefault, unset.isMissingSecret else { return nil }
        return EngineBanner(
            headline: "assistant: absent — \(unset.secret ?? "the provider's key") is not set",
            detail: row?.remediation ?? "the default assignment runs on \(unset.name), which authenticates with a secret this install does not have.",
            actionLabel: nil,
            action: nil
        )
    }

    // MARK: - Running one verb

    /// One `metistry compute …` call: the planned command on screen, the CLI's
    /// lines as they arrive, the trailing JSON decoded, and an outcome in the
    /// CLI's words.
    ///
    /// The exit code is not the whole answer. `providers test` and `models
    /// install` exit 1 when the thing they tested or installed did not work,
    /// having printed a perfectly good `{"ok": false, …}` — so `ok` is read
    /// from the JSON when the JSON says, and from the exit code when it does
    /// not.
    @discardableResult
    private func perform(
        _ verb: [String],
        naming name: String,
        key: String,
        summarize: @escaping @Sendable (JSONValue?) -> String
    ) async -> JSONValue? {
        guard let cli else {
            lastOutcome = Outcome(verb: name, ok: false, message: CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return nil
        }
        guard !inFlight.contains(key) else { return nil }
        inFlight.insert(key)
        defer { inFlight.remove(key) }

        lastCommand = cli.plannedArguments(for: verb).joined(separator: " ")
        output = []
        // Two paths on purpose. The hop to the main actor is what puts a
        // download's progress on screen WHILE it downloads; the sink is what
        // makes the finished list complete and in order, because those hops are
        // scheduled, not awaited. The last assignment replaces the streamed
        // lines with the same lines, so nothing is duplicated and nothing is
        // lost if a hop lands late.
        let sink = OutputSink()
        let collect: @Sendable (OutputLine) -> Void = { [weak self] line in
            sink.append(line)
            Task { @MainActor in self?.output = sink.drain() }
        }
        do {
            let result = try await cli.run(verb, onOutput: collect)
            output = sink.drain()
            if CLIDegradation.isUnknownVerb(result) {
                lastOutcome = Outcome(verb: name, ok: false, message: CLIDegradation.message(verb: name))
                return nil
            }
            let json = JSONValue.parseTrailing(in: result.stdout)
            let ok = json?.bool("ok") ?? result.ok
            lastOutcome = Outcome(verb: name, ok: ok, message: ok ? summarize(json) : Self.refusal(result, verb: name))
            return json
        } catch {
            lastOutcome = Outcome(verb: name, ok: false, message: error.localizedDescription)
            return nil
        }
    }

    /// The CLI's own last line, unedited. `metistry compute` wraps every
    /// `StepFailed` as `metistry compute: <message>` on stderr, and that
    /// message names the field — `assignments.default`,
    /// `budgets.providers.x`, `providers.<name>.auth.secret` — which is the
    /// thing a person needs and the thing a paraphrase would lose.
    nonisolated static func refusal(_ result: CommandResult, verb: String) -> String {
        let line = result.stderr.split(separator: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            ?? result.stdout.split(separator: "\n").last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return line.map(String.init) ?? "`metistry \(verb)` exited \(result.exitCode) with no output"
    }

    // MARK: - The sentences the pane prints

    public static let persistenceNote =
        "The app stores nothing about compute. compute.yaml in the instance repo is the record — a §4.7 protected path, written as you by the reconciler — "
        + "and every control here runs a `metistry compute` verb against it. There is no cached copy to go stale, which is why the pane re-reads when it opens "
        + "and prints the command it read with."

    public static let zdrNote =
        "Zero data retention is what the PROVIDER states about itself, copied into compute.yaml as `zdr: true`. A provider off this machine that does not claim it "
        + "is badged and never blocked (C13): the engine records one warning per run and the turn goes through. Nothing here verifies the claim — no client can."

    public static let budgetNote =
        "Enforced in the engine, before the call, against what this window has already spent (docs/ops/compute.md); what happens at the limit is the action "
        + "below. Set it for the same reason a seatbelt is worth fastening before the engine starts."
}
