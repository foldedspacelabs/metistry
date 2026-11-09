// Set Up Remote Access (design-build-plan §2.23, X-107): the guided flow, the
// wizard step and Settings ▸ Remote Access.
//
// The ticket's bold tests: NONE IS PRESELECTED AND CONTINUE SATISFIES THE STEP;
// ADD A PHONE IS NOT OFFERED BEFORE THE CHECK PASSES; THE CHECK IS NEVER WORDED
// AS REACHING THE PHONE; A PASTED TOKEN NEVER REACHES THE CLI'S ARGV; TURN
// OFF'S CONFIRM NAMES WHAT REVOKE UNDOES. Then: each step's failure shows its
// doctor sentence; the door's misuse tests — any `remote` argv outside the
// grammar is refused by the management runner, and no other row runs one; a
// switch confirms, naming the stranded phones in the CLI's own sentence;
// Devices marks a passkey whose host is no longer configured; and every new
// view speaks every control (U9). `metistry remote` is a scripted runner
// answering what the CLI prints — no console, no CLI, no network.

#if os(macOS)
import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - What `metistry remote` prints

private let funnelOrigin = "https://metistry-a1b2c3d4.tail1234.ts.net"

/// `remote status --json` on a fresh install: None, nothing exposed, the
/// chooser in the plan's order with None and Tailscale available (X-106) —
/// and, for these tests, zrok too, so a pasted-token provider can be driven.
private func statusNoneJSON(zrokAvailable: Bool = true) -> String {
    """
    {
      "provider": "none", "mode": null, "origin": null, "settings": {}, "from": "seed/deployment.yaml",
      "origins": ["http://127.0.0.1:8080"], "dropped_origins": [], "available": ["none", "tailscale"\(zrokAvailable ? #", "zrok""# : "")],
      "choices": \(choicesJSON(zrokAvailable: zrokAvailable)),
      "rows": [{"kind":"remote","name":"remote","status":"ok","latency_ms":0.2,"probe":"deployment.yaml remote: none — nothing exposed, METISTRY_ORIGIN loopback only","meta":{"provider":"none","origin":null,"info":"Remote access: none. Your phone can't reach this Mac. Choose a way in Settings ▸ Remote Access."}}],
      "ok": true
    }
    """
}

/// The same install with Tailscale Funnel in place.
private func statusTailscaleJSON(ok: Bool = true) -> String {
    """
    {
      "provider": "tailscale", "mode": "funnel", "origin": "\(funnelOrigin)",
      "settings": {"upstream": "http://127.0.0.1:8081", "node": "metistry-a1b2c3d4", "node_from": "pack", "handler": "metistry-a1b2c3d4.tail1234.ts.net:443"},
      "from": "/Users/you/instance/.metistry/deployment.yaml",
      "origins": ["\(funnelOrigin)", "http://127.0.0.1:8080"], "dropped_origins": [], "available": ["none", "tailscale", "zrok"],
      "choices": \(choicesJSON(zrokAvailable: true)),
      "rows": \(tailscaleRowsJSON(ok: ok)),
      "ok": \(ok)
    }
    """
}

private func choicesJSON(zrokAvailable: Bool) -> String {
    """
    [
      {"id":"none","label":"None","tag":"default","reachable_from":"this Mac only","tls_ends_at":"—","cost":"$0","needs":"nothing","available":true},
      {"id":"tailscale","label":"Tailscale — Any browser (Funnel)","tag":"recommended","reachable_from":"the internet; the phone needs no app","tls_ends_at":"the Mac","cost":"$0 (all plans)","needs":"a Tailscale account","available":true},
      {"id":"relay","label":"Metistry Relay","reachable_from":"the internet; no account anywhere","tls_ends_at":"the Mac (the relay passes TLS through unopened)","cost":"$0 — 5 GB a month","needs":"nothing","available":false},
      {"id":"cloudflare","label":"Cloudflare Tunnel","reachable_from":"the internet","tls_ends_at":"Cloudflare","cost":"$0 + a domain (~$10/yr)","needs":"a Cloudflare account with a domain on it","available":false},
      {"id":"zrok","label":"zrok","reachable_from":"the internet","tls_ends_at":"zrok's frontend (NetFoundry)","cost":"$0 (5 GB/day; a warning page unless a card is verified)","needs":"a zrok.io account","available":\(zrokAvailable)},
      {"id":"ngrok","label":"ngrok","reachable_from":"the internet","tls_ends_at":"ngrok","cost":"$0 with a weekly warning page; $10/mo removes it","needs":"an ngrok account","available":false},
      {"id":"port-forward","label":"Port forwarding","reachable_from":"the internet","tls_ends_at":"the Mac","cost":"$0; impossible behind CGNAT","needs":"a router that allows NAT-PMP/UPnP, or a forward made by hand","available":false}
    ]
    """
}

/// Doctor's rows for Tailscale: the three shared rows, then its own. `ok: false`
/// fails *answers from this Mac* with `metistry enroll`'s own sentence.
private func tailscaleRowsJSON(ok: Bool) -> String {
    let answers = ok
        ? #"{"kind":"remote","name":"remote:tailscale:answers","status":"ok","latency_ms":41,"probe":"GET \#(funnelOrigin)/health answers from this Mac and names this instance (within 5 s)","meta":{"info":"\#(funnelOrigin) answers from this Mac"}}"#
        : #"{"kind":"remote","name":"remote:tailscale:answers","status":"failed","latency_ms":5002,"probe":"GET \#(funnelOrigin)/health answers from this Mac and names this instance (within 5 s)","remediation":"\#(funnelOrigin) doesn't answer from this Mac, so your phone won't reach it either. Settings ▸ Remote Access shows what tailscale reports. (GET \#(funnelOrigin)/health: no answer within 5 s)","meta":{"case":"unreachable"}}"#
    return """
    [
      {"kind":"remote","name":"remote:tailscale:tool","status":"ok","latency_ms":3,"probe":"the tailscale tool is here (Metistry's pack)","meta":{"info":"tailscale 1.90.2 (Metistry's pack)"}},
      {"kind":"remote","name":"remote:tailscale:proxy-listener","status":"ok","latency_ms":0.1,"probe":"tailscale forwards to the console's proxy listener (port 8081 or /i/.metistry/state/console-proxy.sock), never the main port 8080","meta":{}},
      \(answers),
      {"kind":"remote","name":"remote:tailscale:signed-in","status":"ok","latency_ms":12,"probe":"BackendState is Running","meta":{"info":"Signed in to Tailscale. This node is metistry-a1b2c3d4.tail1234.ts.net."},"action":{"kind":"run_verb","command":["metistry","remote","authorize","tailscale"],"label":"Sign in to Tailscale"}}
    ]
    """
}

/// `remote set <p> … --json` without `--yes`: the preview.
private func previewJSON(from: String = "none", provider: String, origin: String? = nil, signedIn: Bool = false, revoked: Bool = false, stranding: Bool = false) -> String {
    let orig = origin.map { #""\#($0)""# } ?? "null"
    let rev = revoked ? #","revoked":{"undone":["reset the node's serve config (the funnel handler for metistry-a1b2c3d4.tail1234.ts.net:443)","log the node out of Tailscale","stop the node's launchd job com.foldedspacelabs.metistry.tailscale and remove its plist"],"left_for_owner":["the node metistry-a1b2c3d4 in your Tailscale admin console (Machines) — remove it there"]}"# : ""
    let str = stranding ? #","stranding":"\#(strandingSentence)""# : ""
    return """
    {"from":"\(from)","provider":"\(provider)","origin":\(orig),"applied":false,"detail":"preview only — nothing configured, written or revoked"\(rev),"detection":{"tool":{"present":false},"signed_in":\(signedIn),"would_change":["fetch Metistry's Tailscale pack and start the node as a launchd job (metistry-a1b2c3d4, state in /i/.metistry/state/tailscale)","sign this node in at Tailscale's login page (opened in the browser)","point `tailscale funnel` at the proxy listener http://127.0.0.1:8081"]}\(str)}
    """
}

/// The CLI's own sentence for the phones a switch strands (`strandingNote`, packages/cli/src/remote/index.ts).
private let strandingSentence = "phones added under \(funnelOrigin) stop working once this changes to https://a.share.zrok.io: a passkey is bound to the host it was created on. Add each phone again afterwards; Devices marks the ones to remove."

/// `remote set tailscale --mode funnel --yes --json`: the record written.
private let appliedJSON = """
{"from":"none","provider":"tailscale","origin":"\(funnelOrigin)","applied":true,"detail":"written through the reconciler as user","detection":{"tool":{"present":true,"version":"1.90.2","from":"pack"},"signed_in":true,"would_change":[]}}
"""

/// What the CLI narrates on stderr while `set --yes` runs (X-106's own lines, `ctx.note`).
private let setupLines: [OutputLine] = [
    OutputLine(stream: .standardError, text: "   fetched Metistry's Tailscale pack (1.90.2)"),
    OutputLine(stream: .standardError, text: "   the node's launchd job: com.foldedspacelabs.metistry.tailscale → /Users/you/Library/LaunchAgents/com.foldedspacelabs.metistry.tailscale.plist (log /tmp/metistry-tailscale.log)"),
    OutputLine(stream: .standardError, text: "   sign in to Tailscale at: https://login.tailscale.com/a/0123456789ab"),
    OutputLine(stream: .standardError, text: "   the browser is open — finish there; this waits"),
    OutputLine(stream: .standardError, text: "   Tailscale asks you to approve Funnel for this node — one click at: https://login.tailscale.com/f/funnel?node=abc"),
    OutputLine(stream: .standardError, text: "   Waiting for metistry-a1b2c3d4.tail1234.ts.net to appear on the internet — this can take up to 10 minutes."),
    OutputLine(stream: .standardError, text: "   waiting for \(funnelOrigin) to answer from this Mac (up to 120 s)…"),
    OutputLine(stream: .standardError, text: "   \(funnelOrigin) answers from this Mac"),
]

private func testJSON(ok: Bool) -> String {
    #"{"provider":"tailscale","origin":"\#(funnelOrigin)","rows":\#(tailscaleRowsJSON(ok: ok)),"ok":\#(ok)}"#
}

/// `remote off --json` without `--yes`: what revoke would undo, and the strand.
private let offPreviewJSON = """
{"from":"tailscale","provider":"none","origin":null,"applied":false,"detail":"preview only — nothing configured, written or revoked","revoked":{"undone":["reset the node's serve config (the funnel handler for metistry-a1b2c3d4.tail1234.ts.net:443)","log the node out of Tailscale","stop the node's launchd job com.foldedspacelabs.metistry.tailscale and remove its plist","remove the node's state /i/.metistry/state/tailscale"],"left_for_owner":["the node metistry-a1b2c3d4 in your Tailscale admin console (Machines) — remove it there"]},"detection":{"tool":{"present":true,"from":"in-process"},"signed_in":null,"would_change":["stop exposing this Mac through tailscale (\(funnelOrigin)) — METISTRY_ORIGIN becomes the loopback origin alone"]},"stranding":"phones added under \(funnelOrigin) stop working once this changes to no origin at all: a passkey is bound to the host it was created on. Add each phone again afterwards; Devices marks the ones to remove."}
"""

private let offAppliedJSON = """
{"from":"tailscale","provider":"none","origin":null,"applied":true,"detail":"written through the reconciler as user","revoked":{"undone":["the funnel handler for metistry-a1b2c3d4.tail1234.ts.net:443 removed (serve config reset)","the node logged out of Tailscale (its node key is revoked)"],"left_for_owner":["the node metistry-a1b2c3d4 in your Tailscale admin console (Machines) — remove it there"]},"detection":{"tool":{"present":true,"from":"in-process"},"signed_in":null,"would_change":[]}}
"""

// MARK: - The scripted runner

/// `metistry remote` as the flow and the pane drive it: records every
/// command, answers each verb with what the test scripted, and can hold a
/// `set --yes` open so a test can look while it runs.
private final class RemoteRunner: ManagementRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _commands: [ManagementCommand] = []

    var status = statusNoneJSON()
    var preview: (ManagementCommand) -> String = { command in previewJSON(provider: command.arguments[2], origin: command.arguments[2] == "tailscale" ? nil : "https://a.share.zrok.io") }
    var setResult = CommandResult(exitCode: 0, stdout: appliedJSON + "\n", stderr: "")
    var setLines = setupLines
    var setDelay: Duration?
    var testResult = CommandResult(exitCode: 0, stdout: testJSON(ok: true) + "\n", stderr: "")
    var offPreview = offPreviewJSON
    var offResult = CommandResult(exitCode: 0, stdout: offAppliedJSON + "\n", stderr: "")

    var commands: [ManagementCommand] { lock.withLock { _commands } }
    var argv: [[String]] { commands.map(\.arguments) }
    /// The commands that would change something: a `--yes`.
    var writes: [[String]] { argv.filter { $0.contains("--yes") } }

    func plannedArguments(_ command: ManagementCommand) -> [String] { ["metistry"] + command.arguments }

    func run(_ command: ManagementCommand, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        lock.withLock { _commands.append(command) }
        let a = command.arguments
        if a.starts(with: ["remote", "status"]) { return CommandResult(exitCode: 0, stdout: lock.withLock { status } + "\n", stderr: "") }
        if a.starts(with: ["remote", "test"]) { return lock.withLock { testResult } }
        if a.starts(with: ["remote", "off"]) {
            return a.contains("--yes") ? lock.withLock { offResult } : CommandResult(exitCode: 0, stdout: lock.withLock { offPreview } + "\n", stderr: "preview only — pass --yes to do this.\n")
        }
        if a.starts(with: ["remote", "set"]) {
            if a.contains("--yes") {
                for line in lock.withLock({ setLines }) { onOutput(line) }
                if let delay = lock.withLock({ setDelay }) { try await Task.sleep(for: delay) }
                return lock.withLock { setResult }
            }
            return CommandResult(exitCode: 0, stdout: lock.withLock { preview }(command) + "\n", stderr: "preview only — pass --yes to do this.\n")
        }
        return CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: \(a.joined(separator: " "))\n")
    }
}

@MainActor
private func flow(_ runner: RemoteRunner = RemoteRunner()) async -> (RemoteAccessFlowModel, RemoteRunner) {
    let model = RemoteAccessFlowModel(management: runner)
    await model.load()
    return (model, runner)
}

/// Lets the verb a choice kicked off (its `didSet` starts a Task) run and finish.
@MainActor
private func settle(_ model: RemoteAccessFlowModel, until done: @escaping () -> Bool = { true }) async {
    try? await Task.sleep(for: .milliseconds(20))
    for _ in 0..<300 {
        if !model.isBusy, done() { return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor
private func wizard(runner: any CommandRunner = RemoteWizardNoop()) -> WizardModel {
    let runtime = MetistryRuntime(source: .checkout, executable: URL(fileURLWithPath: "/usr/bin/node"), leadingArguments: ["/src/packages/cli/dist/main.js"], productDir: URL(fileURLWithPath: "/src"))
    let steps = FirstRunModel(cli: MetistryCLI(runtime: runtime, runner: runner), resolution: RuntimeResolution(runtime: runtime, attempts: []))
    return WizardModel(steps: steps)
}

private struct RemoteWizardNoop: CommandRunner {
    func run(executable: URL, arguments: [String], environment: [String: String], currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void) async throws -> CommandResult {
        // the wizard's runtime answers `remote status --json` as a fresh install does
        if arguments.contains("remote") { return CommandResult(exitCode: 0, stdout: statusNoneJSON() + "\n", stderr: "") }
        return CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

// MARK: - None is preselected and Continue satisfies the step

@MainActor
@Test func noneIsPreselectedAndContinueSatisfiesTheStep() async {
    // the step sits between Services and Door (§2.23), with its own screen and no verb of its own
    let steps = FirstRunStep.allCases
    #expect(steps.firstIndex(of: .remoteAccess) == steps.firstIndex(of: .services)! + 1)
    #expect(steps.firstIndex(of: .door) == steps.firstIndex(of: .remoteAccess)! + 1)
    #expect(FirstRunStep.remoteAccess.title == "Remote Access")
    #expect(FirstRunStep.remoteAccess.hasOwnScreen)
    #expect(FirstRunStep.remoteAccess.verb == nil)

    let w = wizard()
    w.present(from: .remoteAccess)
    #expect(w.progressLabel == "Step 6 of 8")
    #expect(w.steps.plannedArguments(.remoteAccess) == nil)
    #expect(!w.steps.canRun(.remoteAccess))
    // None, before anything is read or chosen
    #expect(w.steps.remoteAccess.selected == "none")
    #expect(w.isSatisfied(.remoteAccess))
    #expect(w.canContinue)
    #expect(!w.canSkip, "satisfied, so there is nothing to skip past")
    await w.steps.remoteAccess.load()
    #expect(w.steps.remoteAccess.phase == .choosing)
    #expect(w.steps.remoteAccess.selected == "none")
    #expect(w.isSatisfied(.remoteAccess))
    w.advance()
    #expect(w.current == .door)

    // a provider chosen but not set up: optional, so Continue stays open and Skip appears
    w.back()
    w.steps.remoteAccess.selected = "tailscale"
    #expect(!w.isSatisfied(.remoteAccess))
    #expect(w.canContinue)
    #expect(w.canSkip)
    #expect(w.isOptional(.remoteAccess))
}

@MainActor
@Test func theChooserIsTheCLIsRowsInThePlansOrderWithTheUnshippedOnesNotYetAvailable() async throws {
    let (model, _) = await flow()
    #expect(model.choices.map(\.id) == ["none", "tailscale", "relay", "cloudflare", "zrok", "ngrok", "port-forward"])
    #expect(model.choices[1].isRecommended)
    #expect(model.choices.filter { !$0.available }.map(\.id) == ["relay", "cloudflare", "ngrok", "port-forward"])

    let tree = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    let said = tree.nodes.map(\.name).filter { !$0.isEmpty }
    #expect(said.contains(RemoteAccessWords.question))
    #expect(said.contains { $0.contains("Tailscale — Any browser (Funnel) — \(RemoteAccessWords.recommended)") }, "\(said)")
    for choice in model.choices where !choice.available {
        #expect(said.contains { $0.contains(choice.label) }, "\(choice.label) is listed")
    }
    #expect(said.contains { $0.contains(RemoteAccessWords.notYetAvailable) }, "an unshipped provider says so: \(said)")
    #expect(said.contains { $0.contains("None") })
}

// MARK: - Add a Phone is not offered before the check passes

@MainActor
@Test func addAPhoneIsNotOfferedBeforeTheCheckPasses() async throws {
    let runner = RemoteRunner()
    runner.testResult = CommandResult(exitCode: 1, stdout: testJSON(ok: false) + "\n", stderr: "")
    let (model, _) = await flow(runner)
    var added = 0
    model.onAddPhone = { added += 1 }

    // nothing chosen: no Add a Phone
    #expect(!model.canAddPhone)
    model.addPhone()
    #expect(added == 0)

    model.selected = "tailscale"
    await settle(model)
    guard case .previewed(let preview) = model.phase else {
        Issue.record("expected previewed, got \(model.phase)")
        return
    }
    #expect(preview.detection.wouldChange.count == 3)
    #expect(runner.writes.isEmpty, "the preview changes nothing")
    #expect(!model.canAddPhone)

    // Set Up: the CLI's ceremony runs, then the check — which fails here
    model.setUp()
    #expect(model.confirmation == nil, "a first set-up from None is not a switch: the preview was the informed half")
    await settle(model) { if case .checked = model.phase { return true } else { return false } }
    #expect(runner.writes == [["remote", "set", "tailscale", "--mode", "funnel", "--yes", "--json"]])
    #expect(model.applied)
    guard case .checked(let failed) = model.phase else {
        Issue.record("expected checked, got \(model.phase)")
        return
    }
    #expect(!failed.ok)
    #expect(!model.canAddPhone, "the record is written, but Add a Phone waits for the check")
    model.addPhone()
    #expect(added == 0)
    let before = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { before.close() }
    #expect(!before.controlNames.contains(AddPhoneWords.addAPhone), "\(before.controlNames)")
    // the failed row's doctor sentence is on screen, verbatim
    #expect(before.nodes.contains { $0.name.contains("doesn't answer from this Mac, so your phone won't reach it either") }, "\(before.nodes.map(\.name).filter { !$0.isEmpty })")

    // Test again, and it passes: only now is Add a Phone offered
    runner.testResult = CommandResult(exitCode: 0, stdout: testJSON(ok: true) + "\n", stderr: "")
    await model.check()
    #expect(model.canAddPhone)
    let after = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { after.close() }
    #expect(after.controlNames.contains(AddPhoneWords.addAPhone))
    #expect(after.unlabeledBesidesFields.isEmpty, "unlabeled: \(after.unlabeledBesidesFields)")
    model.addPhone()
    #expect(added == 1)
    #expect(model.satisfiesStep)
}

// MARK: - The check is never worded as reaching the phone

@Test func theCheckIsNeverWordedAsReachingThePhone() throws {
    // §2.23 step 6: a Mac on the same tailnet may reach a Funnel name over the
    // tailnet, so the check is *answers from this Mac* and never a claim about
    // the phone. Every sentence the flow, the pane and the model can print is
    // read from the sources and held to it.
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sources/kit")
    let files = ["remote-access-model.swift", "remote-access-flow.swift", "settings-panes/remote-access-pane.swift"]
    let forbidden = ["reachable from your phone", "reached from your phone", "your phone can reach", "reachable by your phone", "your phone can now reach", "your phone reached"]
    for file in files {
        let text = try String(contentsOf: root.appendingPathComponent(file), encoding: .utf8).lowercased()
        for phrase in forbidden {
            #expect(!text.contains(phrase), "\(file) says “\(phrase)” — the check is said as “answers from this Mac”")
        }
    }
    #expect(RemoteAccessWords.answersFromThisMac == "answers from this Mac")
    #expect(RemoteAccessWords.checkTitle.contains(RemoteAccessWords.answersFromThisMac))
    #expect(RemoteAccessWords.checkNote.contains("not that your phone can open it"))
}

@MainActor
@Test func thePassedCheckSaysAnswersFromThisMacAndTheTailnetModeNamesTheAccount() async throws {
    let (model, _) = await flow()
    model.selected = "tailscale"
    model.mode = "tailnet"
    await settle(model)
    model.setUp()
    await settle(model) { if case .checked = model.phase { return true } else { return false } }
    let tree = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { tree.close() }
    #expect(tree.texts.contains("\(funnelOrigin) \(RemoteAccessWords.answersFromThisMac)"), "\(tree.texts)")
    #expect(tree.texts.contains("Your phone must be signed in to the same Tailscale account."))
    #expect(!tree.texts.contains { $0.lowercased().contains("reachable from your phone") })
}

// MARK: - A pasted token never reaches the CLI's argv

@MainActor
@Test func aPastedTokenNeverReachesTheCLIsArgv() async throws {
    let secret = "zrok-account-token-not-real"
    // the plan: `--token` is a switch; the value is the command's stdin
    let plan = RemoteSetPlan(provider: "zrok", token: secret, yes: true)
    let command = try #require(plan.command)
    #expect(command.arguments == ["remote", "set", "zrok", "--token", "--yes", "--json"])
    #expect(command.standardInput == secret)
    #expect(!command.arguments.contains { $0.contains(secret) })
    let runner = RemoteRunner()
    #expect(!runner.plannedArguments(command).contains { $0.contains(secret) })

    // and the type refuses every argv spelling that would carry it
    #expect(ManagementCommand(.remoteAccess, ["remote", "set", "zrok", "--token", secret, "--json"]) == nil)
    #expect(ManagementCommand(.remoteAccess, ["remote", "set", "zrok", "--token=\(secret)", "--json"]) == nil)
    #expect(ManagementCommand(.remoteAccess, ["remote", "set", "zrok", secret, "--json"]) == nil)
    #expect(ManagementCommand(.remoteAccess, ["remote", "set", "zrok", "--name", secret, "--token", "--json"]) != nil, "a bare name is a flag value; the token is not")

    // through the flow: typed into the field, written to the one process's stdin, then dropped
    let (model, r) = await flow(runner)
    model.selected = "zrok"
    model.token = secret
    await settle(model)
    #expect(model.needsToken)
    guard case .previewed = model.phase else {
        Issue.record("expected previewed, got \(model.phase)")
        return
    }
    #expect(r.commands.allSatisfy { $0.standardInput == nil }, "the preview never carries the token")
    model.setUp()
    await settle(model) { if case .checked = model.phase { return true } else { return false } }
    let set = try #require(r.commands.first { $0.arguments.contains("--yes") })
    #expect(set.arguments == ["remote", "set", "zrok", "--token", "--yes", "--json"])
    #expect(set.standardInput == secret)
    for c in r.commands { #expect(!c.arguments.contains { $0.contains(secret) }) }
    #expect(model.token.isEmpty, "held for the one command, then cleared")
    #expect(!model.lastCommand!.contains(secret))
}

// MARK: - Turn Off's confirm names what revoke undoes

@MainActor
@Test func turnOffsConfirmNamesWhatRevokeUndoes() async throws {
    let runner = RemoteRunner()
    runner.status = statusTailscaleJSON()
    let pane = RemoteAccessModel(management: { runner })
    await pane.refresh()
    #expect(pane.status?.provider == "tailscale")
    #expect(pane.status?.origin == funnelOrigin)
    #expect(pane.configuredHosts == ["metistry-a1b2c3d4.tail1234.ts.net", "127.0.0.1"])

    await pane.proposeTurnOff()
    // the preview ran — no --yes — and the confirm lists exactly what it said
    #expect(runner.argv == [["remote", "status", "--json"], ["remote", "off", "--json"]])
    let confirmation = try #require(pane.confirmation)
    #expect(confirmation.title == RemoteAccessWords.turnOffTitle)
    #expect(confirmation.confirm == RemoteAccessWords.turnOff)
    #expect(confirmation.destructive)
    #expect(confirmation.costs.contains("log the node out of Tailscale"))
    #expect(confirmation.costs.contains("reset the node's serve config (the funnel handler for metistry-a1b2c3d4.tail1234.ts.net:443)"))
    #expect(confirmation.costs.contains(RemoteAccessWords.leftForOwner("Tailscale", "the node metistry-a1b2c3d4 in your Tailscale admin console (Machines) — remove it there")))
    #expect(confirmation.costs.contains { $0.hasPrefix("phones added under \(funnelOrigin) stop working") }, "the strand is said before anything changes: \(confirmation.costs)")

    // Cancel runs nothing
    await pane.choose(.cancel)
    #expect(pane.confirmation == nil)
    #expect(runner.writes.isEmpty)

    // Turn Off runs `remote off --yes`, once, then re-reads
    await pane.proposeTurnOff()
    runner.status = statusNoneJSON()
    await pane.choose(.confirm)
    #expect(runner.writes == [["remote", "off", "--yes", "--json"]])
    #expect(pane.note?.kind == .done)
    #expect(pane.note?.text.contains("the node logged out of Tailscale") == true, "\(String(describing: pane.note))")
    #expect(pane.status?.isNone == true)

    // with None there is nothing to turn off, and nothing runs
    await pane.proposeTurnOff()
    #expect(pane.confirmation == nil)
    #expect(runner.writes.count == 1)
}

@MainActor
@Test func turnOffStillNamesACostWhenTheCLIsPreviewSaysNothing() async throws {
    // an older CLI whose preview carries neither `revoked` nor `stranding`
    let runner = RemoteRunner()
    runner.status = statusTailscaleJSON()
    runner.offPreview = #"{"from":"tailscale","provider":"none","origin":null,"applied":false,"detail":"preview only","detection":{"tool":{"present":true},"signed_in":null,"would_change":[]}}"#
    let pane = RemoteAccessModel(management: { runner })
    await pane.refresh()
    await pane.proposeTurnOff()
    let confirmation = try #require(pane.confirmation)
    #expect(confirmation.costs == [RemoteAccessWords.turnOffFallbackCost, RemoteAccessWords.strandedFallback])
}

// MARK: - Each step's failure shows its doctor sentence

@MainActor
@Test func aFailedSetUpShowsTheCLIsWordsAndItsDoctorSentence() async throws {
    let runner = RemoteRunner()
    runner.setLines = Array(setupLines.prefix(3))
    runner.setResult = CommandResult(exitCode: 1, stdout: "", stderr: "metistry remote set: tailscale could not be set up (Tailscale's sign-in didn't finish within 300 s (BackendState NeedsLogin) — open https://login.tailscale.com/a/0123456789ab and run `metistry remote authorize tailscale` to wait again) — nothing was written and remote access is still none\n")
    // after the failure the flow reads the rows: the signed-in row carries X-106's sentence
    runner.status = """
    {"provider":"none","mode":null,"origin":null,"settings":{},"from":"seed","origins":["http://127.0.0.1:8080"],"dropped_origins":[],"available":["none","tailscale"],"choices":\(choicesJSON(zrokAvailable: false)),
     "rows":[{"kind":"remote","name":"remote:tailscale:signed-in","status":"failed","latency_ms":9,"probe":"BackendState is Running","remediation":"This Mac's Metistry node isn't signed in to Tailscale. Sign in again (`metistry remote authorize tailscale`).","meta":{}}],"ok":false}
    """
    let (model, _) = await flow(runner)
    model.selected = "tailscale"
    await settle(model)
    model.setUp()
    await settle(model) { if case .failed = model.phase { return true } else { return false } }
    guard case .failed(let why) = model.phase else {
        Issue.record("expected failed, got \(model.phase)")
        return
    }
    #expect(why.hasPrefix("metistry remote set: tailscale could not be set up"), "the CLI's own last line: \(why)")
    #expect(!model.applied)
    #expect(!model.satisfiesStep)
    #expect(model.problems.map(\.name) == ["remote:tailscale:signed-in"])
    // where the CLI got to, and the link it printed, are still on screen
    #expect(model.progress == .signIn)
    #expect(model.links.map(\.url.absoluteString) == ["https://login.tailscale.com/a/0123456789ab"])
    let tree = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { tree.close() }
    #expect(tree.nodes.contains { $0.name.contains("This Mac's Metistry node isn't signed in to Tailscale. Sign in again") }, "the doctor sentence, verbatim: \(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(tree.controlNames.contains("Look Again"))
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
}

@MainActor
@Test func whileItRunsTheFlowShowsWhereTheCLIIsAndEveryLinkItPrinted() async throws {
    let runner = RemoteRunner()
    runner.setDelay = .seconds(8) // long enough for the snapshot below; Cancel ends it long before
    let (model, _) = await flow(runner)
    model.selected = "tailscale"
    await settle(model)
    model.setUp()
    // the CLI's lines arrive off the main actor; wait for the last to land
    for _ in 0..<300 where model.progress != .check { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.phase == .settingUp)
    // the lines named steps 2, 3, 4, 5 and 6 in turn; the links are the sign-in page and the Funnel approval
    #expect(model.progress == .check)
    #expect(model.links.map(\.step) == [.signIn, .approve])
    #expect(model.links.map(\.label) == ["sign in to Tailscale at", "Tailscale asks you to approve Funnel for this node — one click at"])
    let tree = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: model).frame(width: 640))
    defer { tree.close() }
    #expect(tree.controlNames.contains { $0.hasPrefix("Open sign in to Tailscale at: https://login.tailscale.com/a/") }, "\(tree.controlNames)")
    #expect(tree.controlNames.contains(RemoteAccessWords.cancel))
    #expect(!tree.controlNames.contains(AddPhoneWords.addAPhone))
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    // Cancel ends it, and the late answer is dropped
    model.cancel()
    #expect(model.phase == .choosing)
    try await Task.sleep(for: .milliseconds(200))
    #expect(!model.applied)
    #expect(model.phase == .choosing)
}

@Test func theProgressClassifierReadsX106sOwnLines() {
    #expect(RemoteFlowProgress.step(of: "fetched Metistry's Tailscale pack (1.90.2)") == .getTool)
    #expect(RemoteFlowProgress.step(of: "sign in to Tailscale at: https://login.tailscale.com/a/abc") == .signIn)
    #expect(RemoteFlowProgress.step(of: "signed in — waiting for approval in your Tailscale admin console (Machines)") == .signIn)
    #expect(RemoteFlowProgress.step(of: "Tailscale asks you to approve HTTPS for this node — one click at: https://login.tailscale.com/f/https") == .approve)
    #expect(RemoteFlowProgress.step(of: "Waiting for x.tail1.ts.net to appear on the internet — this can take up to 10 minutes.") == .expose)
    #expect(RemoteFlowProgress.step(of: "waiting for https://x.tail1.ts.net to answer from this Mac (up to 120 s)…") == .expose)
    #expect(RemoteFlowProgress.step(of: "https://x.tail1.ts.net answers from this Mac") == .check)
    #expect(RemoteFlowProgress.step(of: "it takes effect at `metistry up`") == nil)
    let link = RemoteFlowProgress.link(in: "   sign in to Tailscale at: https://login.tailscale.com/a/abc", step: .signIn)
    #expect(link?.url.absoluteString == "https://login.tailscale.com/a/abc")
    #expect(link?.label == "sign in to Tailscale at")
    #expect(RemoteFlowProgress.link(in: "no link here", step: .expose) == nil)
}

// MARK: - The door's misuse tests: the closed set

@Test func anyRemoteArgvOutsideTheGrammarIsRefusedByTheManagementRunner() {
    // the shapes the Mac runs
    let accepted: [[String]] = [
        ["remote", "status", "--json"],
        ["remote", "test", "--json"],
        ["remote", "off", "--json"],
        ["remote", "off", "--yes", "--json"],
        ["remote", "set", "none", "--yes", "--json"],
        ["remote", "set", "tailscale", "--json"],
        ["remote", "set", "tailscale", "--mode", "funnel", "--yes", "--json"],
        ["remote", "set", "tailscale", "--mode", "tailnet", "--use-app", "--yes", "--json"],
        ["remote", "set", "cloudflare", "--hostname", "assistant.example.com", "--access", "--token", "--yes", "--json"],
        ["remote", "set", "zrok", "--name", "assistant", "--token", "--yes", "--json"],
        ["remote", "set", "ngrok", "--domain", "assistant.ngrok-free.dev", "--token", "--yes", "--json"],
        ["remote", "set", "port-forward", "--ddns", "desec", "--hostname", "assistant.dedyn.io", "--manual", "8443", "--yes", "--json"],
    ]
    for argv in accepted {
        #expect(ManagementCommand(.remoteAccess, argv) != nil, "\(argv) is a shape the Mac runs")
    }
    // and nothing else
    let refused: [[String]] = [
        ["remote"],
        ["remote", "frobnicate"],
        // no wider than what the app runs: every shape carries --json, and the app never runs authorize or --timeout
        ["remote", "status"],
        ["remote", "test"],
        ["remote", "off"],
        ["remote", "off", "--yes"],
        ["remote", "set", "tailscale"],
        ["remote", "set", "tailscale", "--mode", "funnel", "--yes"],
        ["remote", "authorize", "tailscale"],
        ["remote", "authorize", "tailscale", "--json"],
        ["remote", "authorize", "cloudflare", "--no-browser", "--timeout", "600", "--json"],
        ["remote", "set", "tailscale", "--timeout", "600", "--yes", "--json"],
        ["remote", "status", "extra"],
        ["remote", "status", "--json", "--json"],
        ["remote", "status", "--yes"],
        ["remote", "test", "tailscale"],
        ["remote", "off", "--force"],
        ["remote", "off", "tailscale", "--yes"],
        ["remote", "authorize"],
        ["remote", "authorize", "zrok"],
        ["remote", "set"],
        ["remote", "set", "fastly"],
        ["remote", "set", "tailscale", "extra"],
        ["remote", "set", "tailscale", "--mode"],
        ["remote", "set", "tailscale", "--mode", "exitnode"],
        ["remote", "set", "tailscale", "--mode", "--yes"],
        ["remote", "set", "tailscale", "--hostname", "x"],
        ["remote", "set", "tailscale", "--token"],
        ["remote", "set", "tailscale", "--json=1"],
        ["remote", "set", "tailscale", "--yes=true"],
        ["remote", "set", "tailscale", "--use-app", "--use-app"],
        ["remote", "set", "tailscale", "--no-browser"],
        ["remote", "set", "tailscale", "--instance", "/elsewhere"],
        ["remote", "set", "tailscale", "--product-dir", "/elsewhere"],
        ["remote", "set", "cloudflare", "--token", "cf-value"],
        ["remote", "set", "cloudflare", "--hostname", "-rf"],
        ["remote", "set", "cloudflare", "--hostname", "two words"],
        ["remote", "set", "port-forward", "--manual", "eight"],
        ["remote", "set", "port-forward", "--ddns", "route53"],
        ["remote", "set", "none", "--mode", "funnel"],
        ["status", "--json"],
        ["doctor", "--json"],
        ["secrets", "set", "x"],
    ]
    for argv in refused {
        #expect(ManagementCommand(.remoteAccess, argv) == nil, "\(argv) is not a shape the Mac runs")
    }
    // no other row runs a `remote` verb, and M20 runs nothing else
    for row in ManagementRow.allCases where row != .remoteAccess {
        #expect(ManagementCommand(row, ["remote", "status", "--json"]) == nil, "\(row) accepted `remote`")
        #expect(ManagementCommand(row, ["remote", "set", "tailscale", "--yes"]) == nil, "\(row) accepted `remote set`")
    }
    #expect(ManagementRow.remoteAccess.rawValue == "M20")
    // the plan the flow builds is always inside the grammar — or nil, never a loosened command
    #expect(RemoteSetPlan(provider: "tailscale", mode: "funnel", useApp: true, yes: true).command?.arguments == ["remote", "set", "tailscale", "--mode", "funnel", "--use-app", "--yes", "--json"])
    #expect(RemoteSetPlan(provider: "tailscale", hostname: "x", yes: true).command == nil, "a flag Tailscale does not take")
    #expect(RemoteSetPlan(provider: "fastly", yes: true).command == nil)
    #expect(RemoteSetPlan(provider: "zrok", name: "two words", yes: true).command == nil)
}

// MARK: - A switch confirms, naming the cost in the CLI's own words

@MainActor
@Test func aSwitchAwayFromAProviderConfirmsNamingTheStrandedPhonesAndWhatRevokeUndoes() async throws {
    let runner = RemoteRunner()
    runner.status = statusTailscaleJSON()
    runner.preview = { _ in previewJSON(from: "tailscale", provider: "zrok", origin: "https://a.share.zrok.io", revoked: true, stranding: true) }
    let pane = RemoteAccessModel(management: { runner })
    await pane.refresh()

    // Change… opens the flow on what is in force
    pane.beginChange()
    let flow = try #require(pane.flow)
    await settle(flow)
    #expect(flow.selected == "tailscale")
    #expect(flow.mode == "funnel")
    #expect(flow.currentProvider == "tailscale")
    #expect(!flow.isSwitch)

    flow.selected = "zrok"
    flow.token = "zrok-token"
    await settle(flow)
    #expect(flow.isSwitch)
    guard case .previewed(let preview) = flow.phase else {
        Issue.record("expected previewed, got \(flow.phase)")
        return
    }
    #expect(preview.stranding == strandingSentence)
    // the preview is on screen, in the CLI's words, before any button
    let tree = try await AccessibilityProbe.snapshot(RemoteAccessFlowView(model: flow, inSettings: true).frame(width: 640))
    defer { tree.close() }
    #expect(tree.texts.contains(strandingSentence), "\(tree.texts)")
    #expect(tree.controlNames.contains(RemoteAccessWords.switchTo("zrok")))
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")

    // Switch to zrok: the confirm, naming the cost; nothing has run with --yes
    flow.setUp()
    let confirmation = try #require(flow.confirmation)
    #expect(confirmation.title == RemoteAccessWords.switchTitle("zrok"))
    #expect(confirmation.confirm == RemoteAccessWords.switchTo("zrok"))
    #expect(confirmation.costs.first == strandingSentence)
    #expect(confirmation.costs.contains("log the node out of Tailscale"))
    #expect(confirmation.costs.contains(RemoteAccessWords.leftForOwner("Tailscale", "the node metistry-a1b2c3d4 in your Tailscale admin console (Machines) — remove it there")))
    #expect(runner.writes.isEmpty)

    // Cancel: nothing runs, the preview stays
    flow.choose(.cancel)
    #expect(flow.confirmation == nil)
    #expect(runner.writes.isEmpty)
    guard case .previewed = flow.phase else {
        Issue.record("expected previewed, got \(flow.phase)")
        return
    }

    // the switch itself is the CLI's one verb — configure, wait, write, revoke are its, not the app's
    flow.setUp()
    flow.choose(.confirm)
    await settle(flow) { if case .checked = flow.phase { return true } else { return false } }
    #expect(runner.writes == [["remote", "set", "zrok", "--token", "--yes", "--json"]])
    #expect(runner.commands.first { $0.arguments.contains("--yes") }?.standardInput == "zrok-token")
    #expect(flow.applied)
}

// MARK: - Devices marks a passkey whose host is no longer configured

@MainActor
@Test func devicesMarksAPasskeyWhoseHostIsNoLongerAConfiguredOrigin() async throws {
    let old = Device(id: 3, passkeyID: "pk-old", label: "Old iPhone", rpID: "old.example.com", added: nil, lastSeen: nil, thisDevice: false, sessions: [])
    let current = Device(id: 4, passkeyID: "pk-new", label: "iPhone", rpID: "metistry-a1b2c3d4.tail1234.ts.net", added: nil, lastSeen: nil, thisDevice: false, sessions: [])
    let unknown = Device(id: 5, passkeyID: "pk-?", label: "Browser", rpID: nil, added: nil, lastSeen: nil, thisDevice: false, sessions: [])
    let hosts = ["metistry-a1b2c3d4.tail1234.ts.net", "127.0.0.1"]
    #expect(old.strandedNote(configuredHosts: hosts) == "Added for old.example.com. Remove it and add this phone again.")
    #expect(current.strandedNote(configuredHosts: hosts) == nil)
    #expect(unknown.strandedNote(configuredHosts: hosts) == nil, "no recorded host: nothing to compare")
    #expect(old.strandedNote(configuredHosts: nil) == nil, "hosts not read yet: nothing is marked")
    #expect(Device(id: 6, passkeyID: "pk", label: "x", rpID: "METISTRY-A1B2C3D4.tail1234.TS.NET", added: nil, lastSeen: nil, thisDevice: false, sessions: []).strandedNote(configuredHosts: hosts) == nil, "hosts compare case-insensitively")

    // the pane reads the hosts through the Remote Access read, with the devices:
    // the recorded devices, each bound to a host the record no longer names
    let console = try FixtureConsole(try ConsoleFixture.loadAll().map { f in
        guard f.stem == "get-api-devices" else { return f }
        var body = try JSONSerialization.jsonObject(with: f.reply) as? [String: Any] ?? [:]
        body["devices"] = (body["devices"] as? [[String: Any]] ?? []).map { var d = $0; d["rp_id"] = "old.example.com"; return d }
        return try f.replacingReply(body)
    })
    let session = ConsoleSession(transport: console, management: nil)
    defer { withExtendedLifetime(session) {} }
    let pane = DevicesModel(session: session)
    pane.readConfiguredHosts = { ["somewhere-else.ts.net"] }
    await pane.refresh()
    #expect(pane.configuredHosts == ["somewhere-else.ts.net"])
    let recorded = pane.devices.filter { $0.rpID != nil }
    #expect(!recorded.isEmpty)
    for device in recorded { #expect(device.strandedNote(configuredHosts: pane.configuredHosts) == "Added for old.example.com. Remove it and add this phone again.") }
    let tree = try await AccessibilityProbe.snapshot(DevicesPaneBody(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.nodes.contains { $0.name.contains("Added for old.example.com. Remove it and add this phone again.") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")

    // a passkey at a configured host is not marked
    pane.readConfiguredHosts = { recorded.compactMap(\.rpID) + ["127.0.0.1"] }
    await pane.refresh()
    let clear = try await AccessibilityProbe.snapshot(DevicesPaneBody(pane: pane).frame(width: SettingsLayout.pane))
    defer { clear.close() }
    #expect(!clear.nodes.contains { $0.name.contains("Added for ") })
}

// MARK: - The pane, and the wizard's step, speak every control

@MainActor
@Test func thePaneShowsTheChoiceTheOriginAndTheRowsWithWhenTheyWereChecked() async throws {
    let runner = RemoteRunner()
    runner.status = statusTailscaleJSON()
    let pane = RemoteAccessModel(management: { runner })
    let t0 = WireTime.date("2026-10-19T14:42:10.000Z")!
    pane.now = { t0 }
    await pane.refresh()
    #expect(pane.checkedAt == t0)
    #expect(pane.rows.map(\.name) == ["remote:tailscale:tool", "remote:tailscale:proxy-listener", "remote:tailscale:answers", "remote:tailscale:signed-in"])
    let tree = try await AccessibilityProbe.snapshot(RemoteAccessPaneBody(pane: pane).frame(width: SettingsLayout.pane))
    defer { tree.close() }
    #expect(tree.unlabeledBesidesFields.isEmpty, "unlabeled: \(tree.unlabeledBesidesFields)")
    #expect(!tree.headings.isEmpty)
    #expect(tree.nodes.contains { $0.name.contains("Tailscale — Any browser (Funnel)") }, "\(tree.nodes.map(\.name).filter { !$0.isEmpty })")
    #expect(RemoteStatus.parse(statusTailscaleJSON())?.label == "Tailscale — Any browser (Funnel)")
    #expect(RemoteStatus.parse(statusTailscaleJSON().replacingOccurrences(of: #""mode": "funnel""#, with: #""mode": "tailnet""#))?.label == "Tailscale — Only my devices (tailnet)")
    #expect(tree.nodes.contains { $0.name.contains(funnelOrigin) })
    #expect(tree.texts.contains { $0.hasPrefix("Checked ") }, "\(tree.texts)")
    #expect(tree.controlNames.contains(RemoteAccessWords.change))
    #expect(tree.controlNames.contains(RemoteAccessWords.test))
    #expect(tree.controlNames.contains(RemoteAccessWords.turnOff))

    // Test is step 6, said as answers from this Mac
    await pane.test()
    #expect(runner.argv.last == ["remote", "test", "--json"])
    #expect(pane.note == ScheduledNote(kind: .done, text: "\(funnelOrigin) answers from this Mac."))
    #expect(pane.testResult?.ok == true)

    // the pane on a fresh install: None, no address, Turn Off has nothing to do
    runner.status = statusNoneJSON()
    pane.reset()
    await pane.refresh()
    let none = try await AccessibilityProbe.snapshot(RemoteAccessPaneBody(pane: pane).frame(width: SettingsLayout.pane))
    defer { none.close() }
    #expect(none.nodes.contains { $0.name.contains(RemoteAccessWords.noneOrigin) })
    #expect(none.unlabeledBesidesFields.isEmpty)
}

@MainActor
@Test func theWizardsStepAndTheSettingsSheetSpeakEveryControl() async throws {
    let w = wizard()
    w.present(from: .remoteAccess)
    await w.steps.remoteAccess.load()
    let step = try await AccessibilityProbe.snapshot(RemoteAccessStepView(steps: w.steps).frame(width: 640))
    defer { step.close() }
    #expect(step.unlabeledBesidesFields.isEmpty, "unlabeled: \(step.unlabeledBesidesFields)")
    #expect(step.texts.contains(RemoteAccessWords.continueWithNone))

    let (flow, _) = await flow()
    let sheet = try await AccessibilityProbe.snapshot(RemoteAccessFlowSheet(model: flow, onDone: {}))
    defer { sheet.close() }
    #expect(sheet.unlabeledBesidesFields.isEmpty, "unlabeled: \(sheet.unlabeledBesidesFields)")
    #expect(sheet.headings.contains("Set Up Remote Access"), "\(sheet.headings)")
    #expect(sheet.controlNames.contains(AddPhoneWords.done))

    // the pane's Change… is the same flow; its Add a Phone… is Devices' sheet, and closing cancels
    let runner = RemoteRunner()
    let pane = RemoteAccessModel(management: { runner })
    var opened = 0
    pane.onAddPhone = { opened += 1 }
    await pane.refresh()
    pane.beginChange()
    let change = try #require(pane.flow)
    change.selected = "tailscale"
    await settle(change)
    change.setUp()
    await settle(change) { if case .checked = change.phase { return true } else { return false } }
    #expect(change.canAddPhone)
    change.addPhone()
    #expect(opened == 1)
    #expect(pane.flow == nil, "the flow closes so Devices' sheet can open")
}

// MARK: - What the verbs print, read

@Test func theVerbsDocumentsAreReadFromTheTrailingObject() throws {
    let status = try #require(RemoteStatus.parse("   a note the CLI printed first\n" + statusTailscaleJSON()))
    #expect(status.provider == "tailscale")
    #expect(status.label == "Tailscale — Any browser (Funnel)")
    #expect(status.rows.count == 4)
    #expect(status.rows[2].status == .ok)
    #expect(status.rows[3].action == .runVerb(command: ["metistry", "remote", "authorize", "tailscale"], label: "Sign in to Tailscale"))
    let set = try #require(RemoteSetResult.parse(previewJSON(from: "tailscale", provider: "zrok", origin: "https://a.share.zrok.io", revoked: true, stranding: true)))
    #expect(set.revoked?.undone.count == 3)
    #expect(set.revoked?.leftForOwner.count == 1)
    #expect(set.stranding == strandingSentence)
    #expect(!set.applied)
    let test = try #require(RemoteTestResult.parse(testJSON(ok: false)))
    #expect(!test.ok)
    #expect(test.problems.map(\.name) == ["remote:tailscale:answers"])
    #expect(RemoteStatus.parse("ok\n") == nil)
    #expect(RemoteSetResult.parse("") == nil)
}
#endif
