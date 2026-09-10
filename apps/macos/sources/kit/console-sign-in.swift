// Who the console thinks this Mac is — and the five answers it can give.
//
// THE DECISION THIS FILE IMPLEMENTS (owner, 2026-09-10). The Mac app is the
// same package as the CLI, on the same machine, running as the same person.
// It therefore authenticates to the LOCAL console *implicitly*, by a token
// only the logged-in user can read, and never by a passkey ceremony. Passkeys
// remain the door for browsers, the phone, and anything that is not this
// machine (docs/ops/auth.md).
//
// WHAT THE APP NEVER DOES. It does not read the login Keychain. It does not
// open, parse, or even name `<instance>/state/.env`. It does not hold, print,
// log or display the token's value, and no type in this file has a field that
// could carry one. The CLI is the one place that knows where the token lives
// (`packages/cli/src/console-client.ts`), so the app asks it:
//
//     metistry console whoami --json
//
// and renders what came back. That is the same rule as everywhere else in this
// app — a front end for the CLI, never a second implementation — applied to the
// one thing it would have been most tempting to shortcut.
//
// ON THE SECRET'S NAME. The variable is `METISTRY_LOCAL_OWNER_TOKEN` (the
// older `METISTRY_OWNER_TOKEN` is the Claude Code plugin's capture token and is
// a different secret). The app names it in PROSE, for the person reading the
// screen — but nothing here MATCHES on it. The five states are told apart by
// the CLI's exit code and by three stable phrases in its own message ("401",
// "unreachable", "is not set"), so a rename of the variable moves one sentence
// of copy and changes no behaviour. `console-sign-in-tests.swift` pins that
// with both spellings.

import Foundation
import Observation

/// `GET /api/whoami`'s body, as `metistry console whoami --json` re-prints it.
///
/// Six fields, and none of them is a credential: this type is structurally
/// incapable of carrying the token, which is the point. An unknown key in the
/// CLI's JSON is ignored rather than surfaced — a future field is the CLI's to
/// introduce and this app's to be told about, not to render blind.
public struct ConsoleWhoami: Sendable, Equatable {
    /// Where the CLI found the console. Its own resolution, not the app's.
    public let url: String
    /// `user` (a passkey session or the local owner token) or `owner_token`
    /// (a host-minted capture token).
    public let principal: String
    /// How it was proved: `local_owner_token` · `passkey_session` · `owner_token`.
    public let via: String
    /// May this credential reach the management surface (devices, agents,
    /// projects)? The local owner token may; a capture token may not.
    public let management: Bool
    /// The console's canonical origin, so a mismatch with a browser's is
    /// visible here rather than only in a failed ceremony.
    public let origin: String?
    public let asOf: String?

    public init(url: String, principal: String, via: String, management: Bool, origin: String? = nil, asOf: String? = nil) {
        self.url = url
        self.principal = principal
        self.via = via
        self.management = management
        self.origin = origin
        self.asOf = asOf
    }

    /// A reply that named neither a principal nor a `via` is not an answer to
    /// "who am I", whatever else it holds.
    public init?(json: JSONValue) {
        guard let principal = json.string("principal"), let via = json.string("via") else { return nil }
        self.init(
            url: json.string("url", "console") ?? "",
            principal: principal,
            via: via,
            management: json.bool("management") ?? false,
            origin: json.string("origin"),
            asOf: json.string("as_of", "asOf")
        )
    }

    /// `local_owner_token` → "local token". Prose, for a screen; the raw `via`
    /// is always shown beside it, because that is the value docs/ops/auth.md
    /// names and the one worth quoting in a bug report.
    public var viaLabel: String {
        switch via {
        case "local_owner_token": return "local token"
        case "passkey_session": return "passkey session"
        case "owner_token": return "capture token"
        default: return via
        }
    }
}

/// The five answers, and nothing between them. Each one is a headline, a reason
/// in the CLI's own words, and — where there is one — the exact command that
/// fixes it (design-system §3.16: what could not be done, why, what to do).
public enum ConsoleSignIn: Sendable, Equatable {
    /// The console answered, and said who this is.
    case signedIn(ConsoleWhoami)
    /// This install's CLI predates `metistry console whoami`.
    case cliTooOld(String)
    /// There is no local owner token for the CLI to present.
    case tokenUnset(String)
    /// The console did not answer at all.
    case unreachable(String)
    /// A token was presented and the console refused it: HTTP 401.
    case refused(reason: String, likely: String)

    /// The variable, for prose only — see the header. Nothing matches on it.
    public static let tokenVariable = "METISTRY_LOCAL_OWNER_TOKEN"

    /// The two commands that mint a token into the environment the console is
    /// started from, in the order they have to run. Shown, never run from here:
    /// re-minting a secret is not something a status row should do behind a
    /// single click.
    public static let mintCommands: [[String]] = [
        ["metistry", "secrets", "sync", "--to", "env"],
        ["metistry", "restart", "console"],
    ]

    public var isSignedIn: Bool {
        if case .signedIn = self { return true }
        return false
    }

    public var whoami: ConsoleWhoami? {
        if case .signedIn(let w) = self { return w }
        return nil
    }

    /// One line, the thing the header and the menu say. Sentence-shaped: it is
    /// prose, not a label (design-system P10).
    public var headline: String {
        switch self {
        case .signedIn(let w):
            return w.principal == "user"
                ? "Signed in as owner (\(w.viaLabel))"
                : "Signed in as \(w.principal) (\(w.viaLabel))"
        case .cliTooOld:
            return "Cannot ask — this install's CLI has no `console whoami`"
        case .tokenUnset:
            return "No local owner token on this install"
        case .unreachable:
            return "The console did not answer"
        case .refused:
            return "The console refused the token (401)"
        }
    }

    /// The reason, verbatim where it came from the CLI. Never paraphrased: this
    /// app does not improve on what another program said about itself.
    public var detail: String {
        switch self {
        case .signedIn(let w):
            var parts = ["via \(w.via)", "management \(w.management ? "yes" : "no")"]
            if !w.url.isEmpty { parts.append(w.url) }
            if let origin = w.origin { parts.append("origin \(origin)") }
            return parts.joined(separator: " · ")
        case .cliTooOld(let detail), .tokenUnset(let detail), .unreachable(let detail):
            return detail
        case .refused(let reason, let likely):
            return "\(reason)\n\n\(likely)"
        }
    }

    /// What to run, when there is something. `nil` is honest: nothing the app
    /// can name would fix an unreachable console, and inventing a command for
    /// it would send someone the wrong way.
    public var remedy: [[String]]? {
        switch self {
        case .signedIn, .unreachable:
            return nil
        case .cliTooOld:
            return [["metistry", "update"]]
        case .tokenUnset, .refused:
            return Self.mintCommands
        }
    }

    /// The dot. `signedIn` is `ok`; a token that was never minted is `absent` —
    /// a fact, not a fault, exactly as doctor treats a bridge nobody configured;
    /// a CLI too old to ask is `degraded` (the install works, this app's view of
    /// it does not); a refusal and a silence are `failed`.
    public var status: CheckStatus {
        switch self {
        case .signedIn: return .ok
        case .tokenUnset: return .absent
        case .cliTooOld: return .degraded
        case .unreachable, .refused: return .failed
        }
    }
}

// MARK: - The mapping

public extension ConsoleSignIn {
    /// `metistry console whoami --json`'s result, turned into one of the five.
    ///
    /// `shape` is doctor's own resolved deployment shape, and it is used for one
    /// thing: deciding which half of a 401 to put first. Under `compose` the
    /// console is behind Docker's NAT and sees the bridge gateway rather than
    /// `127.0.0.1`, so the loopback rule is the likelier cause; under `launchd`
    /// (or an unknown shape) the likelier cause is that the value in this
    /// environment is not the one the console was started with.
    static func from(_ result: CommandResult, shape: String?) -> ConsoleSignIn {
        // A CLI that predates the verb answers `unknown command: console` with
        // exit 2; one that has `console` but not `whoami` answers `usage: …`
        // with the same code. Both mean the same thing to a person — this
        // install's CLI is older than this app — so both say it.
        if result.exitCode == 2 {
            return .cliTooOld(
                CLIDegradation.message(verb: "console whoami")
                    + (lastLine(result.stderr).map { " (\($0))" } ?? "")
            )
        }
        if result.ok {
            guard let data = result.stdout.data(using: .utf8), !data.isEmpty,
                  let json = try? JSONValue.parse(data),
                  let whoami = ConsoleWhoami(json: json)
            else {
                // Exit 0 with something unreadable is a contract disagreement,
                // not a failure of the console — and the fix is the same one.
                return .cliTooOld(
                    "`metistry console whoami --json` exited 0 and printed something this app could not read. "
                        + "That is the app and the CLI disagreeing about the shape of the reply — update the CLI (metistry update, or Check for Updates…)."
                )
            }
            return .signedIn(whoami)
        }

        let line = lastLine(result.stderr) ?? "exit \(result.exitCode)"
        // Three phrases, in the order that cannot be confused. The 401 message
        // and the "not set" message are both about the token, so the 401 is
        // matched FIRST — it is the only one that means a token existed.
        if line.contains("401") {
            return .refused(reason: line, likely: likelyCauseOf401(shape: shape))
        }
        if line.lowercased().contains("unreachable") {
            return .unreachable(line)
        }
        if line.lowercased().contains("is not set") {
            return .tokenUnset(line)
        }
        // Anything else the verb can fail with. The CLI's own words, unedited,
        // under the one headline that claims nothing about the cause.
        return .unreachable(line)
    }

    /// Which of the two halves of docs/ops/auth.md's 401 is likelier here.
    static func likelyCauseOf401(shape: String?) -> String {
        let loopback =
            "the request did not reach the console over loopback. Under the `compose` shape the port is published through "
            + "Docker's NAT, so the peer address the console sees is the bridge gateway (172.17.0.1, 192.168.x.1 — never 127.0.0.1), "
            + "and it has to be told about that with METISTRY_TRUSTED_LOOPBACK_PROXY (docs/ops/auth.md, \"The compose caveat\")."
        let stale =
            "the \(tokenVariable) in this environment is not the one the console was STARTED with. The console keeps the value it "
            + "was launched with, so a freshly minted token does nothing until it is restarted."
        switch shape {
        case "compose":
            return "Most likely: \(loopback)\n\nLess likely, but check it second: \(stale)"
        case "launchd":
            return "Most likely: \(stale)\n\nUnlikely under the `launchd` shape, where the console binds loopback directly: \(loopback)"
        default:
            return "This install's shape is not known here, so both are live.\n\nEither: \(stale)\n\nOr: \(loopback)"
        }
    }

    private static func lastLine(_ text: String) -> String? {
        text.split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .last { !$0.isEmpty }
    }
}

// MARK: - The model

/// The app's sign-in state, refreshed on launch and on every instance switch.
///
/// It holds one `ConsoleSignIn` and the argument array that produced it, so
/// every screen that shows the state also shows what was run to get it. There
/// is no polling: a whoami is one HTTP GET the CLI makes on the app's behalf,
/// and repeating it on a timer would buy nothing that a "Check Again" button
/// does not.
@MainActor
@Observable
public final class ConsoleSignInModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case checking
        case answered
        /// There is no runtime to ask. Distinct from the five answers: this is
        /// the app having nothing to run, not the console having said something.
        case unavailable(String)
    }

    public private(set) var cli: MetistryCLI?
    public private(set) var phase: Phase = .idle
    public private(set) var signIn: ConsoleSignIn?
    public private(set) var lastCommand: String?
    public private(set) var lastCheckedAt: Date?

    /// Doctor's resolved deployment shape, for the 401 diagnosis. Set by
    /// whoever has the report; `nil` is handled and says so.
    public var shape: String?

    public init(cli: MetistryCLI?, shape: String? = nil) {
        self.cli = cli
        self.shape = shape
    }

    /// Re-point at another install. The previous instance's answer is dropped
    /// rather than left on screen beside a new instance path — a stale "signed
    /// in" is the one thing this row must never show.
    public func adopt(cli: MetistryCLI?, shape: String? = nil) {
        self.cli = cli
        self.shape = shape
        signIn = nil
        phase = .idle
        lastCommand = nil
        lastCheckedAt = nil
    }

    public var isChecking: Bool { phase == .checking }

    /// For a view's `.task`: ask once, and do not ask again on every redraw.
    public func refreshIfNeeded() async {
        guard phase == .idle else { return }
        await refresh()
    }

    public func refresh() async {
        guard let cli else {
            signIn = nil
            phase = .unavailable(CLIReadError.noRuntime.localizedDescription)
            return
        }
        lastCommand = cli.plannedArguments(for: ConsoleClient.whoamiVerb).joined(separator: " ")
        phase = .checking
        signIn = await ConsoleClient.signIn(using: cli, shape: shape)
        lastCheckedAt = Date()
        phase = .answered
    }

    /// One line for a menu or a header. Says what it does not know, rather than
    /// showing a tick it has not earned (design-system P5).
    public var headline: String {
        switch phase {
        case .idle: return "not checked yet"
        case .checking: return "asking the console…"
        case .unavailable(let why): return why
        case .answered: return signIn?.headline ?? "no answer"
        }
    }

    /// The dot, or `nil` while there is nothing to colour.
    public var status: CheckStatus? {
        switch phase {
        case .answered: return signIn?.status
        case .unavailable: return .failed
        case .idle, .checking: return nil
        }
    }
}
