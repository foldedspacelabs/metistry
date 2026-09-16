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

/// Choosing where the assistant's turns run. Three cards and a way out: the
/// provider, the model, and — where the provider needs one — a secure field
/// whose value goes to the CLI's STDIN and nowhere else (compute-step.swift).
public struct ComputeStepView: View {
    @Environment(\.colorScheme) private var scheme
    @Bindable private var model: ComputeStepModel

    public init(model: ComputeStepModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Provider").metistryText(.headline, p)
                Picker("", selection: $model.template) {
                    ForEach(ComputeTemplate.allCases) { t in
                        Text(t.label).tag(t)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                Text(model.template.detail)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Model").metistryText(.headline, p)
                TextField("model id", text: $model.model)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                Text("The id as \(model.template.label) knows it. It becomes `assignments.default` in compute.yaml — one pinned `<provider>/<model>`, never an auto-router: no model decides which model runs.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if !model.modelRef.isEmpty {
                    FactRow("Will assign", model.modelRef, mono: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            if model.template.needsKey {
                VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                    Text("API Key").metistryText(.headline, p)
                    SecureField("paste your \(model.template.label) key", text: $model.apiKey)
                        .textFieldStyle(.roundedBorder)
                    Text(ComputeStepModel.keyNote)
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .metistryCard(p)
            }

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                ForEach(Array(model.plannedCommands.enumerated()), id: \.offset) { _, command in
                    CommandCard(title: "Runs", argument: command)
                }
                HStack(spacing: MetistrySpace.s3) {
                    Button("Add and Assign") { Task { await model.apply() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.canApply)
                    Button("Skip: No Engine Yet") { model.skip() }
                }
                statusCard(p)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            Text(ComputeStepModel.skipNote)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            if !model.output.isEmpty {
                OutputLogView(lines: model.output)
            }
        }
    }

    @ViewBuilder
    private func statusCard(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            switch model.phase {
            case .assigned(let ref):
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(.ok)
                    Text("assigned — turns run on \(ref)").metistryText(.footnote, p, .ok)
                }
            case .added(let name):
                // Not reachable from the wizard, which always assigns the
                // default; the case exists for the Compute pane's sheet, which
                // shares this model (compute-model.swift).
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(.ok)
                    Text("provider \(name) added").metistryText(.footnote, p, .ok)
                }
            case .working(let what):
                HStack(spacing: MetistrySpace.s2) {
                    ProgressView().controlSize(.small)
                    Text(what).metistryText(.footnote, p, .textSecondary)
                }
            case .skipped:
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(.absent)
                    Text("no engine — the assistant will not be started, and everything else will").metistryText(.footnote, p, .textSecondary)
                }
            case .failed(let why):
                UnavailableCard(what: "Could not set compute", reason: why, command: model.lastCommand)
            case .idle:
                HStack(alignment: .top, spacing: MetistrySpace.s2) {
                    StatusDot(model.isSet ? .ok : .absent)
                    Text(model.report?.engineSummary ?? "not read yet")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let command = model.lastCommand {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
