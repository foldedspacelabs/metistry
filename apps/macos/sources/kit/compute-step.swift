// Step 7, Compute: choose where the assistant's turns run.
//
// THE RULE THIS FILE IS BUILT AROUND: the app never STORES the key and never
// shows it. It holds the pasted string in memory for exactly as long as one
// `metistry compute providers add` takes, writes it to that process's STDIN —
// never argv, never a file, never a log line — and clears it. The Keychain is
// the CLI's to write (user scope, C6); the app's whole knowledge of the secret
// afterwards is the boolean `metistry compute show --json` reports.
//
// WHY TWO VERBS AND NOT ONE SCREEN'S WORTH OF LOGIC. `providers add --from
// <template>` writes a validated block into the instance's compute.yaml
// through the protected-write path and stores the key; `compute assign default
// <provider>/<model>` writes the one line that decides which model answers.
// Both already exist and both take `--json`, so this file names them and
// decodes their answers. There is no second implementation of either (plan
// §4.20).
//
// AND IT IS SKIPPABLE, HONESTLY. An install with no `assignments.default` has
// NO engine: `metistry up` leaves the assistant out of the supervisor's
// children, doctor reports `assistant: absent`, and captures, tasks, search
// and the console all run (docs/ops/assistant-tools.md). That is a supported
// shape, so the step offers it as a choice with its consequence written down
// rather than as a dead end.

import Foundation
import Observation

/// The provider templates `metistry compute providers add --from` accepts —
/// `COMPUTE_TEMPLATES` in `packages/cli/src/compute.ts`. The app keeps the
/// names and nothing else: what each one writes is the CLI's file to own.
public enum ComputeTemplate: String, CaseIterable, Sendable, Identifiable {
    case openrouter
    case lmstudio
    case ollama
    case llamaserver
    case applefm

    public var id: String { rawValue }

    /// Title Case, because this names a thing (design-system P10).
    public var label: String {
        switch self {
        case .openrouter: return "OpenRouter"
        case .lmstudio: return "LM Studio"
        case .ollama: return "Ollama"
        case .llamaserver: return "Bundled Local Model"
        case .applefm: return "Apple Foundation Models"
        }
    }

    /// One sentence, sentence case, saying what picking this means.
    public var detail: String {
        switch self {
        case .openrouter: return "One key, most models, prices passed through. Claude, GPT and the open-weights models all arrive this way."
        case .lmstudio: return "An LM Studio server you already run on this Mac. Nothing leaves the machine, and nothing is billed."
        case .ollama: return "An Ollama server you already run on this Mac. Nothing leaves the machine, and nothing is billed."
        case .llamaserver: return "The llama-server Metistry bundles and starts itself. No second app to install, and nothing leaves the machine."
        case .applefm: return "The model already in macOS, through Metistry's apple-fm bridge. Nothing to install, nothing to pay, nothing leaves the machine."
        }
    }

    /// Whether this template's provider authenticates with a key at all. The
    /// local ones do not, so the field is not shown rather than shown and
    /// ignored.
    public var needsKey: Bool {
        switch self {
        case .openrouter: return true
        // apple-fm authenticates with METISTRY_BRIDGE_TOKEN_APPLE_FM, which
        // this install already minted for itself — `providers add` finds it in
        // the environment and asks for nothing (compute.ts's `secretStatus`
        // = `present`). Showing a field would be asking someone to paste back
        // a value we generated.
        case .lmstudio, .ollama, .llamaserver, .applefm: return false
        }
    }

    /// A model id to start from — a SUGGESTION in a field the person can edit,
    /// not a default the app writes on their behalf. The local ones are left
    /// empty on purpose: which model is loaded is a property of their machine,
    /// and guessing it would be worse than asking.
    public var suggestedModel: String {
        switch self {
        case .openrouter: return "anthropic/claude-sonnet-5"
        case .lmstudio, .ollama, .llamaserver, .applefm: return ""
        }
    }
}

@MainActor
@Observable
public final class ComputeStepModel {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Running `compute providers add` (and then `compute assign default`).
        case working(String)
        /// Both verbs succeeded; the string is the `<provider>/<model>` now assigned.
        case assigned(String)
        /// `compute providers add` succeeded and nothing was assigned, because
        /// nothing was asked to be: the Compute pane adds a SECOND provider
        /// without touching which one answers a turn. The string is its name.
        case added(String)
        /// The person chose to finish without an engine, knowingly.
        case skipped
        case failed(String)
    }

    /// What `metistry compute show --json` says right now — the same report the
    /// Settings pane renders, so the two cannot disagree.
    public private(set) var report: ComputeFacts?
    public private(set) var phase: Phase = .idle
    public private(set) var lastCommand: String?
    /// The CLI's own lines from the last run, so a refusal is read in its words.
    public private(set) var output: [OutputLine] = []

    public private(set) var cli: MetistryCLI?

    /// The chosen template. `openrouter` leads because it is the one that works
    /// on a Mac with nothing else installed.
    public var template: ComputeTemplate = .openrouter {
        didSet {
            if oldValue != template { model = template.suggestedModel }
        }
    }

    /// The model id, as the provider knows it. Pre-filled from the template.
    public var model: String = ComputeTemplate.openrouter.suggestedModel

    /// The pasted key. Bound to a `SecureField`, held only until `apply()` has
    /// written it to the CLI's stdin, and cleared there — see `apply`.
    public var apiKey: String = ""

    // The three fields the WIZARD leaves alone and the Compute pane's
    // add-a-provider sheet uses. They are here rather than in a second model
    // because the thing worth having exactly one of is the key's path to
    // stdin, and that is `apply()`.

    /// `--name`, when this provider should not be called after its template —
    /// a second OpenRouter account, an LM Studio on another port. Empty = the
    /// template's own name, which is the CLI's default and not a guess here.
    public var providerName: String = ""

    /// `--base-url`, when the template's default is not where the server is.
    /// Empty = the template's, unchanged.
    public var baseURL: String = ""

    /// Whether `apply()` follows the provider with `compute assign default`.
    /// True in the wizard, where the whole point of the step is to end with an
    /// engine. False in the pane once a default exists: adding a provider is
    /// not a decision to run every turn on it.
    public var assignsDefault: Bool = true

    public init(cli: MetistryCLI?) {
        self.cli = cli
    }

    public func adopt(cli: MetistryCLI?) {
        self.cli = cli
        report = nil
        phase = .idle
        apiKey = ""
        providerName = ""
        baseURL = ""
        output = []
    }

    /// Put the sheet back the way it opens. The key is cleared first and
    /// unconditionally: a sheet dismissed mid-paste must not leave one in an
    /// observable property.
    public func reset(template: ComputeTemplate = .openrouter, assignsDefault: Bool) {
        apiKey = ""
        self.template = template
        model = template.suggestedModel
        providerName = ""
        baseURL = ""
        self.assignsDefault = assignsDefault
        output = []
        phase = .idle
    }

    public var isSet: Bool {
        if case .assigned = phase { return true }
        return report?.assignsNothing == false
    }

    /// The two commands, in order, exactly as they will run — shown before they
    /// run, like every other command in this app. The key is not in either of
    /// them, and cannot be: it goes to stdin.
    public var plannedCommands: [[String]] {
        guard let cli else { return [] }
        var out = [cli.plannedArguments(for: providerAddVerb)]
        if let assign = assignVerb { out.append(cli.plannedArguments(for: assign)) }
        return out
    }

    private var providerAddVerb: [String] {
        var verb = ["compute", "providers", "add", "--from", template.rawValue]
        let name = Self.trim(providerName)
        if !name.isEmpty { verb += ["--name", name] }
        let url = Self.trim(baseURL)
        if !url.isEmpty { verb += ["--base-url", url] }
        return verb + ["--json"]
    }

    private var assignVerb: [String]? {
        guard assignsDefault else { return nil }
        let ref = modelRef
        return ref.isEmpty ? nil : ["compute", "assign", "default", ref, "--json"]
    }

    /// The name this provider will have in compute.yaml: `--name` when one was
    /// given, and otherwise the template's own — which is the CLI's rule, not
    /// this app's guess.
    public var resolvedProviderName: String {
        let name = Self.trim(providerName)
        return name.isEmpty ? template.rawValue : name
    }

    /// `<provider>/<model-id>`, the reference every assign verb takes.
    public var modelRef: String {
        let trimmed = Self.trim(model)
        return trimmed.isEmpty ? "" : "\(resolvedProviderName)/\(trimmed)"
    }

    /// Whether the button can do anything yet: a key when the template needs
    /// one, and — when this run will assign the default — a model to assign.
    public var canApply: Bool {
        guard cli != nil else { return false }
        if case .working = phase { return false }
        if template.needsKey && Self.trim(apiKey).isEmpty { return false }
        if assignsDefault && modelRef.isEmpty { return false }
        return true
    }

    private nonisolated static func trim(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Read the current state. Safe to call on appear: it changes nothing.
    public func refresh() async {
        guard let cli else { return }
        lastCommand = cli.plannedArguments(for: ["compute", "show", "--json"]).joined(separator: " ")
        switch await cli.computeShow() {
        case .success(let facts):
            report = facts
            if facts.assignsNothing == false, case .idle = phase, let ref = facts.defaultRef {
                phase = .assigned(ref)
            }
        case .failure(let error):
            // A missing verb or an unreadable file is not "no engine": say which.
            phase = .failed(error.localizedDescription ?? "unavailable")
        }
    }

    /// Add the provider (key on stdin) and assign it as the default.
    ///
    /// The key is read out of `apiKey` into a local, and `apiKey` is cleared
    /// BEFORE the process runs — so the observable property holds a value for
    /// no longer than one statement, and a screenshot of a crashed app cannot
    /// contain it.
    public func apply() async {
        guard let cli else {
            phase = .failed(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return
        }
        if assignsDefault && assignVerb == nil {
            phase = .failed("choose a model first — it is the second half of `\(resolvedProviderName)/<model>`, and nothing can be assigned without it")
            return
        }
        let key = Self.trim(apiKey)
        apiKey = ""
        if template.needsKey && key.isEmpty {
            phase = .failed("\(template.label) authenticates with an API key — paste one, or choose a local provider that needs none")
            return
        }

        output = []
        phase = .working("adding the \(template.label) provider…")
        lastCommand = cli.plannedArguments(for: providerAddVerb).joined(separator: " ")
        let collect: @Sendable (OutputLine) -> Void = { [weak self] line in
            Task { @MainActor in self?.output.append(line) }
        }
        do {
            let added = try await cli.run(providerAddVerb, standardInput: key.isEmpty ? nil : key + "\n", onOutput: collect)
            guard added.ok else {
                phase = .failed(Self.reason(added, verb: "compute providers add"))
                return
            }
            guard let assign = assignVerb else {
                // `providers add` ends with a live `/v1/models` against the new
                // provider unless `--skip-test` says otherwise, so this phase
                // already carries a tested provider rather than a written file.
                phase = .added(resolvedProviderName)
                await refresh()
                return
            }
            phase = .working("assigning \(modelRef) as the default…")
            lastCommand = cli.plannedArguments(for: assign).joined(separator: " ")
            let assigned = try await cli.run(assign, onOutput: collect)
            guard assigned.ok else {
                phase = .failed(Self.reason(assigned, verb: "compute assign default"))
                return
            }
            phase = .assigned(modelRef)
        } catch {
            phase = .failed(error.localizedDescription)
        }
        await refresh()
    }

    /// Finish the wizard without an engine, knowingly. Not a failure state: it
    /// is a supported install, and `skipNote` is what makes the choice informed.
    public func skip() {
        phase = .skipped
    }

    public nonisolated static let skipNote =
        "You can finish without one. With no `assignments.default` in compute.yaml there is no engine: `metistry up` does not start the assistant at all, "
        + "`metistry doctor` reports `assistant: absent`, and captures, tasks, search and the console keep working — queued turns simply wait. "
        + "Settings → Compute, or `metistry compute assign default <provider/model>`, adds one whenever you like."

    public nonisolated static let keyNote =
        "The key goes to the command's standard input — never onto a command line, never into a file this app writes, never into a log. "
        + "`metistry compute providers add` puts it in the login Keychain under your user account, where every instance on this Mac shares it, "
        + "and everything the app knows about it afterwards is whether it is there."

    private nonisolated static func reason(_ result: CommandResult, verb: String) -> String {
        let last = result.stderr.split(separator: "\n").last.map(String.init)
            ?? result.stdout.split(separator: "\n").last.map(String.init)
        return "`metistry \(verb)` exited \(result.exitCode): \(last ?? "no output")"
    }
}
