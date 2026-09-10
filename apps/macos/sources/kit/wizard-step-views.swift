// The two wizard steps that are not a `metistry` verb.
//
// Every other step is "here is the argument array, here is the CLI's output".
// These two are not, so they get their own screens rather than being forced
// through a run row that would describe them wrongly:
//
//   6. Door    — this Mac's sign-in state first (it needs no ceremony at all),
//                then, for the devices that DO need one, the console's own
//                enrolment code.
//   7. Claude  — an interactive terminal login the app cannot drive, and a watch
//                on whether the token's NAME became set.
//
// Both keep the app's promise in their own currency: the exact thing that will
// happen, before it happens, and the system's own words when it refuses.
//
// STEP 6'S REFRAMING (owner, 2026-09-10). The step used to open with an origin
// card and a long refusal: `ASAuthorization` cannot run a ceremony against a
// loopback origin, for four independent reasons, and a fifth that outranks them
// all (passkey-enrolment.swift's header has the measurements). All of that is
// still TRUE and still worth being able to check — but it was never the first
// thing this screen had to say, because this Mac does not need a passkey. It is
// the same package as the CLI on the same machine and the console takes its
// local owner token as the `user` principal over loopback. So the step leads
// with that, offers the enrolment code for the browser and the phone, and the
// "ask macOS" probe moved to Settings → Advanced where a diagnostic belongs
// (`PasskeyDiagnosticView`, below — the same view, one place).

import SwiftUI

// MARK: - Step 6

public struct PasskeyStepView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private let steps: FirstRunModel

    public init(steps: FirstRunModel) {
        self.steps = steps
    }

    private var model: PasskeyEnrolmentModel { steps.passkey }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            ConsoleSignInCard(model: steps.consoleSignIn, title: "This Mac")
                .task { await steps.consoleSignIn.refreshIfNeeded() }
            Text(WizardOptions.doorNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            WizardOptionList(WizardOptions.door, selection: steps.doorPlan) { steps.doorPlan = $0 }
            if steps.doorPlan == .otherDevices {
                originCard(p)
                switch model.route {
                case .native(let rpID):
                    nativeCard(rpID: rpID, p)
                case .consoleCode(let reason):
                    NotYetCard(title: "Not natively, on this install", reason: reason)
                    fallbackCard(p)
                case nil:
                    Text("Waiting for doctor to report the console.")
                        .metistryText(.footnote, p, .textSecondary)
                }
                phaseRow(p)
            }
        }
    }

    private func originCard(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            FactRow(
                "Console",
                model.endpoint?.origin ?? "not reported",
                help: "Where doctor probed the console. The relying party a passkey binds to comes from the console's own METISTRY_ORIGIN, which is not always this — a tailnet install serves a public origin over a loopback bind.",
                mono: true,
                role: model.endpoint == nil ? .absent : .textPrimary
            )
            if let rpID = model.reportedRPID {
                FactRow("Relying party", rpID, help: "The console's own answer, from POST /auth/login/start.", mono: true)
            }
            if let reachable = model.consoleReachable {
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(reachable ? .ok : .failed)
                    Text(reachable ? "the console answered GET /health" : "the console did not answer")
                        .metistryText(.footnote, p, reachable ? .ok : .failed)
                }
            }
            Button("Ask the Console") { Task { await model.askTheConsole() } }
                .disabled(model.endpoint == nil || model.phase == .asking)
            Text("GET /health, then POST /auth/login/start for its relying-party ID — the only public route that reports one. It costs the console a single in-memory challenge with a five-minute life, so it is a button and not a poll.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func nativeCard(rpID: String, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text("Enrol This Mac").metistryText(.headline, p)
            Text("ASAuthorization can register a passkey for `\(rpID)`. Paste the enrolment code and macOS will ask for Touch ID; the credential goes to the console's `passkeys` table and nothing else leaves this Mac.")
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            codeField(p)
            labelField(p)
            Button("Enrol") { Task { await model.enrol() } }
                .buttonStyle(.borderedProminent)
                .disabled(model.enrolmentCode.trimmingCharacters(in: .whitespaces).isEmpty || model.phase == .enrolling)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func fallbackCard(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            Text("Enrol From the Console").metistryText(.headline, p)
            Text(PasskeyEnrolmentModel.fallbackNote)
                .metistryText(.footnote, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            CommandCard(title: "Mint a code on the host", argument: [PasskeyEnrolmentModel.mintCommand(shape: nil)])
            Text(PasskeyEnrolmentModel.mintNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            codeField(p)
            if let url = model.enrolmentURL {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text(url.absoluteString)
                        .metistryText(.mono, p, .accent)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: MetistrySpace.s3) {
                        Button("Open in a Browser") { openURL(url) }
                            .buttonStyle(.borderedProminent)
                        Text("or type it on the phone")
                            .metistryText(.caption1, p, .textTertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func codeField(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("Enrolment code").metistryText(.caption2, p, .textSecondary)
            TextField("the 22 characters the host printed", text: Binding(get: { model.enrolmentCode }, set: { model.enrolmentCode = $0 }))
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
        }
    }

    private func labelField(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text("Name this device").metistryText(.caption2, p, .textSecondary)
            TextField("this Mac", text: Binding(get: { model.deviceLabel }, set: { model.deviceLabel = $0 }))
                .textFieldStyle(.roundedBorder)
            Text("Shown in the console's Devices list, so a lost device can be told from the others and revoked.")
                .metistryText(.caption1, p, .textTertiary)
        }
    }

    @ViewBuilder
    private func phaseRow(_ p: Palette) -> some View {
        let p = Palette(scheme)
        switch model.phase {
        case .asking:
            HStack(spacing: MetistrySpace.s2) {
                ProgressView().controlSize(.small)
                Text("talking to the console…").metistryText(.footnote, p, .textSecondary)
            }
        case .enrolling:
            HStack(spacing: MetistrySpace.s2) {
                ProgressView().controlSize(.small)
                Text("macOS has the ceremony — answer its prompt").metistryText(.footnote, p, .textSecondary)
            }
        case .enrolled(let what):
            HStack(spacing: MetistrySpace.s2) {
                StatusDot(.ok)
                Text(what).metistryText(.footnote, p, .ok)
            }
        case .failed(let why):
            UnavailableCard(what: "Enrolment did not happen", reason: why)
        case .idle:
            EmptyView()
        }
    }
}

// MARK: - The ASAuthorization diagnostic (Settings → Advanced)

/// What macOS actually says about a relying party — the evidence behind
/// `PasskeyRouting.decide`'s reason, rather than an assertion of it.
///
/// It was in the wizard's step 6 until 2026-09-10. It is out of the main flow
/// now, because this Mac does not need a passkey and a person setting up an
/// install should not be asked to run a probe about one. It is not DELETED,
/// because it is real measured behaviour and the finding it produces
/// (`AuthorizationError 1004` for every relying party, from any build
/// distributed as a Developer ID DMG) is the thing that would otherwise cost
/// someone a day of editing `METISTRY_ORIGIN`. So it lives here: one button,
/// under Advanced, where a diagnostic belongs.
///
/// It sends nothing. The challenge is 32 bytes generated locally, no enrolment
/// code is used, and nothing is posted back — so it cannot register a credential
/// anywhere, and the console pays nothing for it.
public struct PasskeyDiagnosticView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: PasskeyEnrolmentModel

    public init(model: PasskeyEnrolmentModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            if let endpoint = model.endpoint {
                FactRow("Relying party", model.reportedRPID ?? endpoint.host ?? endpoint.origin, mono: true)
            }
            if let reason = model.route?.reason {
                Text(reason)
                    .metistryText(.caption1, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Asks ASAuthorization to register against that relying party with a challenge generated here. Nothing is sent to the console and nothing can be enrolled by it — it exists so the reason above is something you can check rather than something this app asserts.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Ask macOS") { Task { await model.runDiagnostic() } }
                .disabled(model.phase == .enrolling)
            if let diagnostic = model.diagnostic {
                Text(diagnostic)
                    .metistryText(.mono, p, .textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(MetistrySpace.s3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Step 7

public struct ClaudeStepView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: ClaudeTokenModel

    public init(model: ClaudeTokenModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                FactRow(
                    "claude",
                    model.claudeBinary?.path ?? "not found",
                    mono: true,
                    role: model.claudeBinary == nil ? .absent : .textPrimary
                )
                if model.claudeBinary == nil {
                    Text(ClaudeCodeLocator.notFoundReason)
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Sign In to Claude").metistryText(.headline, p)
                CommandCard(
                    title: "Opens a terminal on",
                    argument: model.setupCommand.map { [$0] },
                    placeholder: "nothing — there is no claude to run"
                )
                Text("It opens a browser and waits for you, which is why it runs in a terminal rather than behind a progress bar: this app hands every command it runs an empty input, so nothing it spawns can sit waiting for an answer.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: MetistrySpace.s3) {
                    Button("Open a Terminal and Sign In") { Task { await model.signIn() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.setupCommand == nil || model.phase == .awaitingLogin)
                    Button("Check") { Task { await model.check() } }
                        .disabled(model.phase == .checking)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Then, in the Same Terminal").metistryText(.headline, p)
                CommandCard(title: "Run", argument: [ClaudeTokenModel.importCommand])
                Text("`claude setup-token` leaves the token where Claude Code keeps it. That carries it into the login Keychain, which is where every service is started from. It is user-scoped — one Claude login per Mac, shared by every instance.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            statusCard(p)

            Text(ClaudeTokenModel.note)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func statusCard(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(ClaudeTokenModel.variable).metistryText(.mono, p)
            switch model.phase {
            case .set(let scope):
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(.ok)
                    Text("set — \(scope)").metistryText(.footnote, p, .ok)
                }
            case .awaitingLogin:
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text("watching for it — check \(model.polls) of \(ClaudeTokenModel.pollLimit)")
                        .metistryText(.footnote, p, .textSecondary)
                        .monospacedDigit()
                }
            case .checking:
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text("reading `metistry secrets list --json`…").metistryText(.footnote, p, .textSecondary)
                }
            case .notSet(let why):
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(.absent)
                    Text(why).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
                }
            case .unavailable(let why):
                Text(why).metistryText(.footnote, p, .textSecondary).fixedSize(horizontal: false, vertical: true)
            case .failed(let why):
                UnavailableCard(what: "Could not tell", reason: why, command: model.lastCommand)
            case .idle:
                Text("not checked yet").metistryText(.footnote, p, .textTertiary)
            }
            if let command = model.lastCommand {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }
}
