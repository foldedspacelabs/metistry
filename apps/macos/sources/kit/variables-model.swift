// Settings ▸ Variables (T6-14; screen-19 §2, plan §2.14): plain shared values
// agents read, `{{ variable.name }}` anywhere a value is typed.
//
// Read from `GET /api/variables` (name, value, read by, used in); every write
// is `metistry variables set|unset` (M14), shown with its exact command before
// it runs. A variable is plain text agents read, so its value is an argument
// like any other — which is exactly why a key must never be typed into one.
//
// A KEY-SHAPED VALUE IS REFUSED, WITH NO OVERRIDE. Screen 19 §2 drew *Store as
// Secret* · *Save as Variable*; the plan (§2.14) and the CLI (T4-4) refuse the
// value outright, and the plan wins: the sheet offers **Store as Secret** and
// nothing that saves it anyway. The CLI is the control — `variables set` and
// the file's own parse refuse a key whatever sent it — and this app checks
// FIRST, with `KeyShape` below, for one reason the CLI cannot cover: a value
// that reaches `variables set` is in that process's argv, where every process
// on the Mac can read it. A key caught here never becomes an argument. A key
// this copy of the patterns misses is still refused by the CLI, and the
// refusal reads the same.

import Foundation
import Observation

// MARK: - The rows

/// One row of `GET /api/variables`.
public struct SharedVariable: Identifiable, Equatable, Sendable {
    public let name: String
    public let value: String
    /// Who the files that reference it stand for: `agent:<id>`, `connection:<name>`.
    public let readBy: [String]
    /// Instance-relative files that reference it.
    public let usedIn: [String]

    public var id: String { name }

    public init(name: String, value: String, readBy: [String] = [], usedIn: [String] = []) {
        self.name = name
        self.value = value
        self.readBy = readBy
        self.usedIn = usedIn
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name"), let value = json.string("value") else { return nil }
        self.init(
            name: name,
            value: value,
            readBy: json["read_by"]?.arrayValue?.compactMap(\.stringValue) ?? json["readBy"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            usedIn: json["used_in"]?.arrayValue?.compactMap(\.stringValue) ?? json["usedIn"]?.arrayValue?.compactMap(\.stringValue) ?? []
        )
    }

    public static func list(_ json: JSONValue) -> [SharedVariable] {
        (json["variables"]?.arrayValue ?? json.arrayValue ?? []).compactMap(SharedVariable.init(json:))
    }

    /// The list's **Used in** column.
    public var usedInLine: String {
        guard !usedIn.isEmpty else { return "Not used yet" }
        let who = readBy.isEmpty ? "" : " — read by \(readBy.joined(separator: ", "))"
        return usedIn.joined(separator: ", ") + who
    }

    /// How it is written where it is used.
    public var reference: String { "{{ variable.\(name) }}" }
}

/// New Variable or Edit, as its sheet holds it.
public struct VariableDraft: Equatable, Sendable {
    /// `nil`: a new variable, named in the sheet. Otherwise the one being edited.
    public var editing: String?
    public var name: String
    public var value: String
    /// Why the last try was refused — by `KeyShape` or by the CLI.
    public var refusal: VariableRefusal?

    public init(editing: String? = nil, name: String = "", value: String = "", refusal: VariableRefusal? = nil) {
        self.editing = editing
        self.name = editing ?? name
        self.value = value
        self.refusal = refusal
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var trimmedValue: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var canSave: Bool { !trimmedName.isEmpty && !trimmedValue.isEmpty }

    public func arguments(instanceDir: URL?) -> [String] {
        ["variables", "set", trimmedName, trimmedValue] + (instanceDir.map { ["--instance", $0.path] } ?? [])
    }
}

/// A refused variable, and what the sheet offers instead.
public struct VariableRefusal: Equatable, Sendable {
    public let words: String
    /// The value looks like a key: **Store as Secret** is the only way on.
    public let storeAsSecret: Bool

    public init(words: String, storeAsSecret: Bool) {
        self.words = words
        self.storeAsSecret = storeAsSecret
    }

    /// Screen 19 §2's sentence. Names nothing typed.
    public static let keyShaped = VariableRefusal(words: "This looks like a key. Variables can be read by agents.", storeAsSecret: true)
}

// MARK: - The key-shape check

/// `packages/core/src/variables.ts`'s `looksLikeKey`, pattern for pattern —
/// the same credential prefixes, JWTs, key blocks, Authorization values, URLs
/// with a password or a token parameter, and long random-looking runs.
/// Biased to refuse, like core's: the cost of a false refusal is Store as
/// Secret. Core stays the control; this copy keeps a key out of argv.
public enum KeyShape {
    private static let patterns: [NSRegularExpression] = [
        #"(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}"#,
        #"(?:^|[^A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}"#,
        #"(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}"#,
        #"(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}"#,
        #"(?:^|[^A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}"#,
        #"(?:^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}"#,
        #"(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"#,
        #"(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}"#,
        #"(?:^|[^A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}"#,
        #"(?:^|[^A-Za-z0-9])lin_(?:api|oauth)_[A-Za-z0-9]{20,}"#,
        #"(?:^|[^A-Za-z0-9])apk_[A-Za-z0-9_]{16,}"#,
        #"(?:^|[^A-Za-z0-9])hf_[A-Za-z0-9]{20,}"#,
        #"(?:^|[^A-Za-z0-9])npm_[A-Za-z0-9]{30,}"#,
        #"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#,
        #"-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----"#,
        #"(?i)^\s*(?:bearer|basic|token)\s+\S{8,}"#,
        #"(?i)[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@"#,
        #"(?i)[?&#][A-Za-z_]*(?:token|key|secret|sig|signature|password|passwd|auth|credential)[A-Za-z_]*=[^&#\s]{6,}"#,
    ].map { try! NSRegularExpression(pattern: $0) }

    private static let run = try! NSRegularExpression(pattern: #"[A-Za-z0-9+=_-]{20,}"#)
    private static let uuid = try! NSRegularExpression(pattern: #"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#)

    public static func looksLikeKey(_ value: String) -> Bool {
        let whole = NSRange(value.startIndex..., in: value)
        if patterns.contains(where: { $0.firstMatch(in: value, range: whole) != nil }) { return true }
        for match in run.matches(in: value, range: whole) {
            if let range = Range(match.range, in: value), looksRandom(String(value[range])) { return true }
        }
        return false
    }

    /// One run of token characters, judged on its letters and digits alone:
    /// random text changes character class on most characters, words and slugs
    /// a handful of times; hex is judged by length.
    static func looksRandom(_ run: String) -> Bool {
        if uuid.firstMatch(in: run, range: NSRange(run.startIndex..., in: run)) != nil { return false }
        let alnum = run.unicodeScalars.filter { ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) }
        guard alnum.count >= 20 else { return false }
        let digits = alnum.contains { ("0"..."9").contains($0) }
        let letters = alnum.contains { ("a"..."z").contains($0) || ("A"..."Z").contains($0) }
        guard digits && letters else { return false }
        let hex = alnum.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0) }
        if alnum.count >= 32 && hex { return true }
        func kind(_ c: Unicode.Scalar) -> Int { ("a"..."z").contains(c) ? 0 : ("A"..."Z").contains(c) ? 1 : 2 }
        let scalars = Array(alnum)
        var changes = 0
        for i in 1..<scalars.count where kind(scalars[i]) != kind(scalars[i - 1]) { changes += 1 }
        return Double(changes) / Double(scalars.count - 1) >= 0.3
    }
}

// MARK: - The pane's state

@MainActor
@Observable
public final class VariablesModel {
    public private(set) var rows: [SharedVariable] = []
    public var phase: ReadPhase = .idle
    /// The New Variable / Edit sheet. `nil`: closed.
    public var draft: VariableDraft?

    public init() {}

    public func reset() {
        rows = []
        phase = .idle
        draft = nil
    }

    func adopt(rows: [SharedVariable]) {
        self.rows = rows
        phase = .read
    }

    public static let note =
        "Plain shared values, referenced as {{ variable.name }} anywhere a value is typed — including an agent's instructions. "
        + "Agents read them, so a value that looks like a key is refused: store it as a secret. "
        + "A schedule or a time is refused too — a routine's timing is its own schedule, in Scheduled."
}

extension SettingsModel {
    /// `GET /api/variables`.
    public func refreshVariablesPane() async {
        guard let session else {
            variablesPane.phase = .unavailable("no console session for this instance")
            return
        }
        variablesPane.phase = .reading
        switch await session.stores.variables() {
        case .success(let list):
            variablesPane.adopt(rows: SharedVariable.list(list.json))
        case .failure(let error):
            variablesPane.phase = .unavailable(error.localizedDescription)
        }
    }

    public func beginNewVariable() {
        secretsPane.draft = nil
        variablesPane.draft = VariableDraft()
    }

    public func beginEditVariable(_ variable: SharedVariable) {
        secretsPane.draft = nil
        variablesPane.draft = VariableDraft(editing: variable.name, value: variable.value)
    }

    public func cancelVariableDraft() {
        variablesPane.draft = nil
    }

    /// The exact command the sheet shows before its button runs it — or nil
    /// while the value would be refused, so a key is never drawn as an argument.
    public func plannedVariableCommand(_ draft: VariableDraft) -> [String]? {
        guard !KeyShape.looksLikeKey(draft.value),
              let command = ManagementCommand(.variables, draft.arguments(instanceDir: instanceDir))
        else { return nil }
        return management?.plannedArguments(command) ?? (["metistry"] + command.arguments)
    }

    /// Save Variable. A key-shaped value is refused HERE, before any process
    /// sees it, with Store as Secret as the only way on; otherwise `variables
    /// set` runs, and a refusal reopens the sheet in the CLI's words.
    public func saveVariable() async {
        guard var draft = variablesPane.draft, draft.canSave else { return }
        if KeyShape.looksLikeKey(draft.value) {
            draft.refusal = .keyShaped
            variablesPane.draft = draft
            return
        }
        guard let command = ManagementCommand(.variables, draft.arguments(instanceDir: instanceDir)) else { return }
        variablesPane.draft = nil
        await run(command, after: .variables)
        if let outcome, !outcome.ok {
            let words = Self.withoutVerbPrefix(outcome.words, "metistry variables set: ")
            draft.refusal = VariableRefusal(words: words, storeAsSecret: words.localizedCaseInsensitiveContains("looks like a key"))
            variablesPane.draft = draft
        }
    }

    /// Store as Secret: the name and the value move to New Secret, and the
    /// variable is not saved. Nothing runs until that sheet's own button.
    public func storeVariableAsSecret() {
        guard let draft = variablesPane.draft else { return }
        variablesPane.draft = nil
        beginNewSecret(name: draft.trimmedName, value: draft.value)
    }

    /// Remove…: confirmed, naming every file whose reference stops filling in.
    public func proposeVariableRemoval(_ variable: SharedVariable) {
        guard let command = ManagementCommand(.variables, ["variables", "unset", variable.name] + (instanceDir.map { ["--instance", $0.path] } ?? [])) else { return }
        let stops = variable.usedIn.isEmpty
            ? "Nothing references it."
            : "\(variable.reference) stops filling in: \(variable.usedIn.joined(separator: ", "))\(variable.readBy.isEmpty ? "" : " (read by \(variable.readBy.joined(separator: ", ")))")."
        confirmation = SettingsConfirmation(
            title: "Remove \(variable.name)?",
            cost: "\(stops) variables.yaml is a protected file: this is written as you, through the reconciler, and shows in Activity.",
            actionTitle: "Remove",
            command: command,
            destructive: true,
            after: .variables
        )
    }
}
