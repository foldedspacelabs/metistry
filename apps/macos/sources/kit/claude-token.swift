// Step 7, Claude: `claude setup-token`, guided.
//
// THE RULE THIS FILE IS BUILT AROUND: the app never handles the token's value.
// Not in a text field, not in a variable, not in a log line. `claude setup-token`
// writes it where Claude Code keeps it, `metistry secrets sync --to keychain`
// imports it into the login Keychain under the user account, and the app's whole
// contribution is to open a terminal, name the command, and watch
// `secrets list --json` for the name to appear. Everything the app knows about
// this secret is a boolean.
//
// WHY A TERMINAL AND NOT A PROGRESS VIEW. `claude setup-token` is interactive: it
// opens a browser, waits for the OAuth round trip, and prompts. The app hands
// every child an EMPTY stdin on purpose (process-command-runner.swift) so no verb
// can hang a progress view waiting for input, which means the app structurally
// cannot drive this. A pty would lift that (and `connect-repo --auth token` with
// it); until there is one, opening Terminal is the honest shape — the user sees
// the real command in a real shell, which is also what the documentation tells a
// terminal user to do. No second path.

import Foundation
import Observation

/// Where a `claude` binary lands. A Finder-launched app has a near-empty PATH,
/// so the directories are named rather than inherited — the same reason
/// `RuntimeLocator` names its own.
public enum ClaudeCodeLocator {
    /// In order. `~/.local/bin` first because that is where the current
    /// installer puts it; `node_modules/.bin` last because the copy that arrives
    /// with `@anthropic-ai/claude-agent-sdk` is the product's, not the person's,
    /// and a login belongs to the person (`CLAUDE_CODE_OAUTH_TOKEN` is
    /// user-scoped — one Claude login per Mac).
    public static func candidateDirectories(home: URL, productDir: URL?) -> [URL] {
        var dirs = [
            home.appendingPathComponent(".local/bin", isDirectory: true),
            home.appendingPathComponent(".claude/local", isDirectory: true),
            URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/local/bin", isDirectory: true),
        ]
        if let productDir { dirs.append(productDir.appendingPathComponent("node_modules/.bin", isDirectory: true)) }
        return dirs
    }

    public static func locate(
        home: URL = URL(fileURLWithPath: NSHomeDirectory()),
        productDir: URL? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> URL? {
        let fromPath = (environment["PATH"] ?? "")
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0), isDirectory: true) }
        for dir in fromPath + candidateDirectories(home: home, productDir: productDir) {
            let candidate = dir.appendingPathComponent("claude")
            if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// What the screen says when there is none. It names the two things the
    /// person can do, and neither is "the app will install it": a Claude
    /// subscription login is theirs (docs/product/desktop-app-plan.md, "The
    /// user's own, unavoidable").
    public static let notFoundReason =
        "No `claude` on this Mac, in ~/.local/bin, ~/.claude/local, /opt/homebrew/bin, /usr/local/bin, or the product's "
        + "node_modules/.bin. Claude Code arrives with the Agent SDK in a bundled install; otherwise install it from "
        + "claude.com/claude-code, then come back to this step."
}

/// Opening a terminal on a command. The kit does not know how — it is AppKit's
/// job — so this is the seam, exactly like `CommandRunner` is for a subprocess.
public protocol TerminalOpener: Sendable {
    /// Open a terminal window running `command`, and hand control to the person.
    /// Throws only when the terminal could not be opened at all.
    func open(command: String, title: String) throws
}

@MainActor
@Observable
public final class ClaudeTokenModel {
    public enum Phase: Equatable, Sendable {
        case idle
        /// No `claude` to run.
        case unavailable(String)
        /// A terminal is open and the person is signing in. The app is watching.
        case awaitingLogin
        /// Reading `metistry secrets list --json`.
        case checking
        /// The token is in the Keychain, the .env, or both.
        case set(String)
        /// The list was read and the name is not in it.
        case notSet(String)
        case failed(String)
    }

    /// The variable, by name. It is user-scoped — one Claude login per Mac,
    /// shared by every instance — which is `packages/cli/src/secrets.ts`'s
    /// `SECRET_SCOPES` decision, not this app's (docs/ops/cli.md).
    public nonisolated static let variable = "CLAUDE_CODE_OAUTH_TOKEN"

    /// The command the person runs after signing in, verbatim, so it can be read
    /// off the screen and typed. `claude setup-token` puts the token where Claude
    /// Code keeps it; this is what carries it into the login Keychain, which is
    /// the canonical store every service is started from.
    public nonisolated static let importCommand = "metistry secrets sync --to keychain"

    public nonisolated static let note =
        "The app never sees the token. `claude setup-token` is interactive — it opens a browser and waits — so it runs in a "
        + "terminal you can see, and the only thing the app does afterwards is ask `metistry secrets list --json` whether the "
        + "name is set. That verb has no code path that can print a value."

    /// How often the watch asks, and for how long. `secrets list` reads the
    /// Keychain and an `.env`; every four seconds for four minutes is cheap
    /// enough to be invisible and long enough to outlast an OAuth round trip
    /// through a browser.
    public nonisolated static let pollInterval: Duration = .seconds(4)
    public nonisolated static let pollLimit = 60

    private let terminal: (any TerminalOpener)?
    public private(set) var cli: MetistryCLI?
    public private(set) var claudeBinary: URL?

    public private(set) var phase: Phase = .idle
    public private(set) var listing: SecretListing?
    /// How many times the watch has asked. On screen, so a watch that is running
    /// looks like it is running.
    public private(set) var polls = 0
    public private(set) var lastCommand: String?

    public init(cli: MetistryCLI?, terminal: (any TerminalOpener)? = nil, claudeBinary: URL? = nil) {
        self.cli = cli
        self.terminal = terminal
        self.claudeBinary = claudeBinary
        if claudeBinary == nil { phase = .unavailable(ClaudeCodeLocator.notFoundReason) }
    }

    public func adopt(cli: MetistryCLI?, claudeBinary: URL?) {
        self.cli = cli
        self.claudeBinary = claudeBinary
        if claudeBinary == nil, case .idle = phase {
            phase = .unavailable(ClaudeCodeLocator.notFoundReason)
        }
    }

    /// The exact command the terminal will run, shown before it is opened like
    /// every other command in this app.
    public var setupCommand: String? {
        claudeBinary.map { "\($0.path) setup-token" }
    }

    public var isSet: Bool {
        if case .set = phase { return true }
        return false
    }

    /// Open the terminal, then start watching. The two are one action because a
    /// login the app was not watching for is a login the person has to come back
    /// and tell it about.
    public func signIn(sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async {
        guard let command = setupCommand else {
            phase = .unavailable(ClaudeCodeLocator.notFoundReason)
            return
        }
        guard let terminal else {
            phase = .failed("this build cannot open a terminal — run `\(command)` yourself, then press Check")
            return
        }
        do {
            try terminal.open(command: command, title: "claude setup-token")
        } catch {
            phase = .failed("could not open a terminal: \(error.localizedDescription)")
            return
        }
        phase = .awaitingLogin
        polls = 0
        await watch(sleep: sleep)
    }

    /// Ask once. This is also the button for somebody who ran the command
    /// themselves.
    @discardableResult
    public func check() async -> Bool {
        guard let cli else {
            phase = .failed(CLIReadError.noRuntime.localizedDescription ?? "no runtime")
            return false
        }
        lastCommand = cli.plannedArguments(for: ["secrets", "list", "--json"]).joined(separator: " ")
        let wasWatching = phase == .awaitingLogin
        if !wasWatching { phase = .checking }
        switch await cli.secretsList() {
        case .success(let rows):
            let found = rows.first { $0.name == Self.variable }
            listing = found
            if let found, found.isSet {
                phase = .set(found.scopeLabel)
                return true
            }
            if !wasWatching {
                phase = .notSet(found == nil
                    ? "`\(Self.variable)` is not in `metistry secrets list --json` yet. After `claude setup-token`, run `\(Self.importCommand)` to carry it into the login Keychain."
                    : "`\(Self.variable)` is known but not set. Run `\(Self.importCommand)` after signing in.")
            }
            return false
        case .failure(let error):
            phase = .failed(error.localizedDescription ?? "unavailable")
            return false
        }
    }

    /// Poll until the name is set or the watch gives up. It gives up out loud:
    /// a step that quietly stopped watching is a step that lies about its state.
    public func watch(sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async {
        while polls < Self.pollLimit {
            polls += 1
            if await check() { return }
            if case .failed = phase { return }
            do { try await sleep(Self.pollInterval) } catch { return }
        }
        phase = .notSet(
            "Stopped watching after \(Self.pollLimit) checks. If you have signed in, run `\(Self.importCommand)` and press Check."
        )
    }
}
