// The first-launch wizard: navigation, and the reason for every choice.
//
// It replaces the scaffold's "First run" tab group, which was a list of seven
// screens you could click in any order — fine for a developer checking that a
// verb ran, wrong for the one moment the app has to explain itself. This is a
// sheet: one step at a time, Back · Continue · Skip, and every choice presented
// with what it gets you and what it costs, because a person installing this has
// no way to know that "device flow" and "SSH" differ in anything that matters.
//
// The division of labour: `FirstRunModel` (first-run-model.swift) knows the
// verbs and runs them — the exact argument array on screen before it runs, the
// CLI's own output streaming after. This file knows the order, the gating and
// the prose. Neither knows how to do a step itself.

import Foundation
import Observation

/// One choice, with both sides of it. `pro` and `con` are not optional: a choice
/// offered without a cost is a choice the app has already made for the user and
/// should not be asking about.
public struct WizardOption<Value: Hashable & Sendable>: Identifiable, Sendable {
    public let value: Value
    /// Title Case — it is a control label (design-system P10).
    public let title: String
    public let pro: String
    public let con: String
    /// Non-nil when the option cannot be taken from the app, with the reason.
    /// Shown and disabled rather than hidden: knowing a route exists and why it
    /// is closed here is worth more than a shorter list.
    public let unavailable: String?

    public var id: Value { value }
    public var isAvailable: Bool { unavailable == nil }

    public init(value: Value, title: String, pro: String, con: String, unavailable: String? = nil) {
        self.value = value
        self.title = title
        self.pro = pro
        self.con = con
        self.unavailable = unavailable
    }
}

public enum WizardOptions {
    public static let instanceMode: [WizardOption<InstanceMode>] = [
        .init(
            value: .create,
            title: "Create a New Instance",
            pro: "`metistry init` lays out the whole thing: a git repo, Knowledge/, identity.yaml, config, one commit. Nothing else on the machine is touched.",
            con: "Refuses a folder that already has contents unless you force it, so it is not the way to reuse an install."
        ),
        .init(
            value: .adopt,
            title: "Use an Existing Folder",
            pro: "Runs nothing at all — the app just points at an instance you already have, which is what a second Mac, a restored backup or a cloned instance repo looks like.",
            con: "Nothing is validated beyond the folder holding an identity.yaml; a half-built instance will fail later, at doctor, rather than here."
        ),
    ]

    public static let repoPlan: [WizardOption<RepoPlan>] = [
        .init(
            value: .now,
            title: "Connect a Repository",
            pro: "Every knowledge change is versioned off this machine, and a lost Mac costs nothing but the trend lines (invariant 1).",
            con: "Needs a private repository and a credential the reconciler can push with unattended."
        ),
        .init(
            value: .later,
            title: "Later",
            pro: "Local git still records every change; the reconciler simply never pushes. `metistry connect-repo` adds a remote any time.",
            con: "Until then the instance exists on exactly one disk."
        ),
    ]

    public static let repoAuth: [WizardOption<RepoAuth>] = [
        .init(
            value: .device,
            title: "GitHub Device Flow",
            pro: "A code you type into github.com in a browser — no token to copy, and the result lands in the login Keychain where git's osxkeychain helper finds it.",
            con: "Needs a browser and a GitHub account, and the code expires in 15 minutes."
        ),
        .init(
            value: .ssh,
            title: "SSH Key",
            pro: "Uses the key you already have; no token is stored anywhere and nothing expires.",
            con: "The remote URL must be the SSH one, and an agent-less key with a passphrase cannot push unattended."
        ),
        .init(
            value: .token,
            title: "Paste a Personal Access Token",
            pro: "Works with any git host, and with a fine-grained token scoped to one repository.",
            con: "A long-lived credential you have to create and later remember to rotate.",
            unavailable: "`--auth token` reads the token from stdin, and the app gives every command it runs an empty stdin so nothing can hang waiting for a paste. Run `metistry connect-repo <url> --auth token` in a terminal instead."
        ),
    ]

    /// The two deployment shapes. Both descriptions are what
    /// `docs/ops/deployment-shapes.md` and the plan's open decision #15 say;
    /// neither is written by this app (see `FirstRunModel.previewShape`).
    public static let shape: [WizardOption<String>] = [
        .init(
            value: "compose",
            title: "Docker Compose",
            pro: "Postgres, the console and the assistant in containers — the shape Linux and cloud use, and the assistant's container is defense in depth behind invariant 9's allowlist.",
            con: "Docker Desktop is the largest thing a new install has to download, and it is where the lock-ups came from."
        ),
        .init(
            value: "launchd",
            title: "Everything Under Launchd",
            pro: "No Docker: a bundled Postgres and Node services, all started by launchd — the one-click shape the Mac app is for.",
            con: "The assistant runs on the host, so its confinement has to come from a sandbox profile instead of a container. Open decision #15."
        ),
    ]

    /// Step 6, since the owner decision of 2026-09-10. The framing is the
    /// change: this is no longer "get a door", it is "this Mac already has one —
    /// do the other devices need theirs yet?".
    public static let door: [WizardOption<DoorPlan>] = [
        .init(
            value: .thisMacOnly,
            title: "This Mac Only, for Now",
            pro: "Nothing to do: this app and the `metistry` command are the same package on the same machine, so the console already takes them as the owner over loopback — by a token only the logged-in user can read (docs/ops/auth.md). No ceremony, no credential to lose.",
            con: "It is the only thing signed in. A browser — Safari on this same Mac included — and the phone each present a different credential, and get a 401 until one of them enrols a passkey."
        ),
        .init(
            value: .otherDevices,
            title: "Enrol a Browser or a Phone",
            pro: "A passkey is the door for everything that is not this Mac, and it is the only door the console offers them. The phone flow and the browser flow are the same one.",
            con: "It needs an enrolment code minted on the host — single-use, ten minutes — because nothing mints one over HTTP on purpose (plan §4.2)."
        ),
    ]

    /// Where the `ASAuthorization` probe went, said in the step that used to
    /// carry it so nobody has to guess whether it was removed or moved.
    public static let doorDiagnosticLocation = "Settings → Advanced"

    public static let doorNote =
        "Passkeys did not change: enrolling one is exactly the flow it was, and it is still what a browser and a phone need. "
        + "What changed is that this Mac is no longer asked to perform one against a loopback origin — it authenticates as the "
        + "same `user` principal by the local owner token instead, which is not weaker: possession of that token means being "
        + "able to read this login Keychain, the same claim a platform passkey makes. The `ASAuthorization` probe that measures "
        + "what macOS says about a relying party is under \(doorDiagnosticLocation)."

    /// What "enable this bridge" actually does, said once rather than per bridge.
    public static let bridgeNote =
        "Enabling a bridge mints its token (`metistry secrets mint METISTRY_BRIDGE_TOKEN_<NAME>`) into the login Keychain and .env. "
        + "Its URL line and its launchd job come from `metistry up`, and a bridge that reaches Calendars or Apple Intelligence "
        + "will ask macOS for permission the first time it runs."
}

@MainActor
@Observable
public final class WizardModel {
    /// Said on every step, because it is the thing that makes a wizard bearable.
    public nonisolated static let reassurance = "You can change all of this later in Settings."

    public let steps: FirstRunModel
    public private(set) var current: FirstRunStep = .runtime
    /// Steps the user chose to pass over. Kept so the last screen can list them
    /// rather than implying the install is finished.
    public private(set) var skipped: Set<Int> = []
    public private(set) var isFinished = false
    public var isPresented = false

    /// Called the moment the wizard knows which folder is the instance, so the
    /// rest of the steps run with `METISTRY_INSTANCE_DIR` pointed at it.
    public var onInstanceChosen: (URL) -> Void = { _ in }

    public init(steps: FirstRunModel) {
        self.steps = steps
    }

    /// Present it. Also the entry point behind Settings → Instance → "Set up
    /// again…", which is why it resets rather than resuming: a setup run that
    /// resumes halfway through somebody else's session is a confusing gift.
    public func present(from step: FirstRunStep = .runtime) {
        steps.reset()
        skipped = []
        isFinished = false
        current = step
        steps.selected = step
        isPresented = true
    }

    public func dismiss() {
        isPresented = false
    }

    // MARK: - Gating

    /// Required steps: there is no install without a CLI and an instance folder.
    /// Everything else can be done later from Settings or a terminal, and
    /// pretending otherwise would make the wizard a wall.
    public nonisolated static let requiredSteps: Set<FirstRunStep> = [.runtime, .instance]

    public func isOptional(_ step: FirstRunStep) -> Bool { !Self.requiredSteps.contains(step) }

    /// Has this step got what it came for? Steps 6 and 7 answer from their own
    /// models rather than from a `metistry` verb's exit code, because neither is
    /// one: the door is open or it is not, and compute.yaml assigns a default or
    /// it does not. Both are optional either way, so neither can wall the
    /// wizard — an install with no engine is a supported shape, and step 7 says
    /// so where it offers to skip.
    ///
    /// Step 6's answer changed with the owner decision of 2026-09-10. The
    /// console has a door the moment it takes this Mac as the owner — which it
    /// does by default, with no ceremony — so a successful `console whoami` is
    /// what satisfies the step. An enrolled passkey satisfies it too: that is
    /// the same door, opened for a browser or a phone.
    public func isSatisfied(_ step: FirstRunStep) -> Bool {
        switch step {
        case .door:
            if steps.consoleSignIn.signIn?.isSignedIn == true { return true }
            if case .enrolled = steps.passkey.phase { return true }
            return false
        case .compute:
            if case .skipped = steps.compute.phase { return true } // a knowing choice, not an unfinished step
            return steps.compute.isSet
        default:
            break
        }
        switch steps.state(step) {
        case .succeeded: return true
        case .notYet: return true
        case .running: return false
        case .pending, .failed: return false
        }
    }

    public var canGoBack: Bool { current != FirstRunStep.allCases.first }

    public var canContinue: Bool {
        guard steps.state(current) != .running else { return false }
        return isSatisfied(current) || isOptional(current)
    }

    public var canSkip: Bool {
        isOptional(current) && steps.state(current) != .running && !isSatisfied(current)
    }

    public var isOnLastStep: Bool { current == FirstRunStep.allCases.last }

    /// "Step 3 of 7" — sentence case, it is prose.
    public var progressLabel: String {
        "Step \(current.rawValue) of \(FirstRunStep.allCases.count)"
    }

    // MARK: - Navigation

    public func back() {
        guard let index = FirstRunStep.allCases.firstIndex(of: current), index > 0 else { return }
        current = FirstRunStep.allCases[index - 1]
        steps.selected = current
    }

    /// Continue. Leaving the instance step is the moment the app adopts the
    /// folder, whether `init` created it or the user pointed at one.
    public func advance() {
        guard canContinue else { return }
        skipped.remove(current.rawValue)
        if current == .instance, let dir = steps.instanceDirectory {
            onInstanceChosen(dir)
        }
        moveOn()
    }

    public func skip() {
        guard canSkip else { return }
        skipped.insert(current.rawValue)
        moveOn()
    }

    private func moveOn() {
        guard let index = FirstRunStep.allCases.firstIndex(of: current) else { return }
        if index + 1 < FirstRunStep.allCases.count {
            current = FirstRunStep.allCases[index + 1]
            steps.selected = current
        } else {
            isFinished = true
            isPresented = false
        }
    }

    /// What the last step says about the steps that were passed over — named, so
    /// "done" never means "everything happened".
    public var skippedTitles: [String] {
        FirstRunStep.allCases.filter { skipped.contains($0.rawValue) }.map { "\($0.rawValue). \($0.title)" }
    }
}
