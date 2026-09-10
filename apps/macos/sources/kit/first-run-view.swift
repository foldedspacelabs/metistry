// The First run flow: seven steps down the left, the selected one on the right.
//
// Every implemented step shows the exact argument array it will run BEFORE it
// runs it, then the CLI's own output as it arrives. That is the whole design:
// the app is a progress view over a `metistry` verb, and the user can always
// see which command touched their machine.

import SwiftUI
import UniformTypeIdentifiers

public struct FirstRunView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private let model: FirstRunModel
    private let onRelocate: () -> Void
    private let onChooseProductDirectory: (URL) -> Void
    private let productDirectory: URL?

    @State private var pickingInstanceDirectory = false
    @State private var pickingProductDirectory = false

    public init(
        model: FirstRunModel,
        productDirectory: URL?,
        onRelocate: @escaping () -> Void,
        onChooseProductDirectory: @escaping (URL) -> Void
    ) {
        self.model = model
        self.productDirectory = productDirectory
        self.onRelocate = onRelocate
        self.onChooseProductDirectory = onChooseProductDirectory
    }

    public var body: some View {
        let p = Palette(scheme)
        HStack(spacing: 0) {
            steps(p)
                .frame(width: MetistrySize.sidebar)
            Divider().overlay(p[.border])
            detail(p)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(p[.bg])
    }

    // MARK: - Step list

    private func steps(_ p: Palette) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text("First run").metistryText(.caption2, p, .textSecondary)
                    .padding(.horizontal, MetistrySpace.s3)
                    .padding(.top, MetistrySpace.s3)
                ForEach(FirstRunStep.allCases) { step in
                    Button {
                        model.selected = step
                    } label: {
                        stepRow(step, p)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, MetistrySpace.s4)
        }
        .background(p[.surface])
    }

    private func stepRow(_ step: FirstRunStep, _ p: Palette) -> some View {
        let selected = model.selected == step
        let state = model.state(step)
        return HStack(spacing: MetistrySpace.s2) {
            stateGlyph(state, p)
                .frame(width: MetistrySize.iconMd)
            VStack(alignment: .leading, spacing: 0) {
                Text("\(step.rawValue). \(step.title)")
                    .metistryText(.callout, p, selected ? .accent : .textPrimary)
                Text(stateLabel(state))
                    .metistryText(.caption1, p, .textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, MetistrySpace.s3)
        .padding(.vertical, MetistrySpace.s2)
        .frame(minHeight: MetistrySize.pointerTarget, alignment: .leading)
        .background(selected ? p[.accentQuiet] : .clear, in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        .padding(.horizontal, MetistrySpace.s2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    @ViewBuilder
    private func stateGlyph(_ state: StepState, _ p: Palette) -> some View {
        switch state {
        case .pending:
            Image(systemName: "circle").foregroundStyle(p[.textTertiary])
        case .running:
            ProgressView().controlSize(.small)
        case .succeeded:
            Image(systemName: CheckStatus.ok.symbolName).foregroundStyle(p[.ok])
        case .failed:
            Image(systemName: CheckStatus.failed.symbolName).foregroundStyle(p[.failed])
        case .notYet:
            Image(systemName: CheckStatus.absent.symbolName).foregroundStyle(p[.absent])
        }
    }

    private func stateLabel(_ state: StepState) -> String {
        switch state {
        case .pending: return "not started"
        case .running: return "running…"
        case .succeeded: return "done"
        case .failed: return "failed"
        case .notYet: return "not yet"
        }
    }

    // MARK: - Detail

    private func detail(_ p: Palette) -> some View {
        let step = model.selected
        return ScrollView {
            VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text("\(step.rawValue). \(step.title)").metistryText(.title2, p)
                    Text(step.summary)
                        .metistryText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let reason = step.notYetReason {
                    notYet(reason, p)
                } else {
                    inputs(step, p)
                    command(step, p)
                    if step == .versioning, let code = model.deviceCode {
                        deviceCodeCard(code, p)
                    }
                    log(step, p)
                }
            }
            .padding(MetistrySpace.s5)
            .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
        }
    }

    private func notYet(_ reason: String, _ p: Palette) -> some View {
        // Not an error and not an empty state: this is `absent` — a fact.
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: CheckStatus.absent.symbolName).foregroundStyle(p[.absent])
                Text("Not yet").metistryText(.headline, p, .absent)
            }
            Text(reason)
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    @ViewBuilder
    private func inputs(_ step: FirstRunStep, _ p: Palette) -> some View {
        switch step {
        case .runtime:
            runtimeInputs(p)
        case .instance:
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                folderField(
                    label: "Instance folder",
                    help: "Where the private instance repo is created — vault, identity.yaml, config.",
                    url: model.instanceDirectory,
                    p: p
                ) { pickingInstanceDirectory = true }
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text("Assistant name").metistryText(.caption2, p, .textSecondary)
                    TextField("what you'll call it", text: Binding(get: { model.assistantName }, set: { model.assistantName = $0 }))
                        .textFieldStyle(.roundedBorder)
                    Text("Written to identity.yaml, and read from there by everything else. Leave it blank to take the seed's default.")
                        .metistryText(.caption1, p, .textTertiary)
                }
            }
            .metistryCard(p)
            .fileImporter(isPresented: $pickingInstanceDirectory, allowedContentTypes: [.folder]) { result in
                if case .success(let url) = result { model.instanceDirectory = url }
            }
        case .versioning:
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("Private repository URL").metistryText(.caption2, p, .textSecondary)
                TextField("https://github.com/you/your-instance.git", text: Binding(get: { model.remoteURL }, set: { model.remoteURL = $0 }))
                    .textFieldStyle(.roundedBorder)
                Text("`--auth device` runs GitHub's device-authorization flow; the token goes to the login Keychain and reaches git through the osxkeychain credential helper. It is never printed and never written to .env.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .metistryCard(p)
        case .secrets:
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Picker("Direction", selection: Binding(get: { model.secretsDirection }, set: { model.secretsDirection = $0 })) {
                    ForEach(SecretsDirection.allCases) { d in
                        Text(d.label).tag(d)
                    }
                }
                .pickerStyle(.radioGroup)
                Text(model.secretsDirection.detail)
                    .metistryText(.caption1, p, .textTertiary)
            }
            .metistryCard(p)
        case .services:
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("`metistry up` renders every ops/launchd plist into ~/Library/LaunchAgents and bootstraps it, brings the containers up if this install's shape uses them, and finishes with doctor — whose verdict is the exit code.")
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Follow-up: SMAppService (macOS 13+) is the sanctioned way an app registers its own launchd agents — one approval in System Settings, no plist to edit. Until then this is the same by-hand shape the terminal path uses.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .metistryCard(p)
        case .door, .claude:
            EmptyView()
        }
    }

    private func runtimeInputs(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: model.cli == nil ? CheckStatus.failed.symbolName : CheckStatus.ok.symbolName)
                    .foregroundStyle(p[model.cli == nil ? .failed : .ok])
                Text(model.runtimeSummary)
                    .metistryText(.mono, p, model.cli == nil ? .textSecondary : .textPrimary)
                    .textSelection(.enabled)
            }
            if !model.resolution.attempts.isEmpty {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text("Considered").metistryText(.caption2, p, .textSecondary)
                    ForEach(Array(model.resolution.attempts.enumerated()), id: \.offset) { _, attempt in
                        Text("· \(attempt)")
                            .metistryText(.caption1, p, .textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            folderField(
                label: "Product checkout",
                help: "A Metistry checkout with packages/cli/dist/main.js built. Only needed when the app has no runtime bundled inside it.",
                url: productDirectory,
                p: p
            ) { pickingProductDirectory = true }
            Button("Look again") { onRelocate() }
        }
        .metistryCard(p)
        .fileImporter(isPresented: $pickingProductDirectory, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { onChooseProductDirectory(url) }
        }
    }

    private func folderField(label: String, help: String, url: URL?, p: Palette, choose: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(label).metistryText(.caption2, p, .textSecondary)
            HStack(spacing: MetistrySpace.s2) {
                Text(url?.path ?? "none chosen")
                    .metistryText(.footnote, p, url == nil ? .textTertiary : .textPrimary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer(minLength: MetistrySpace.s2)
                Button("Choose…", action: choose)
            }
            Text(help).metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func command(_ step: FirstRunStep, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("Runs").metistryText(.caption2, p, .textSecondary)
            Text(model.plannedArguments(step)?.joined(separator: " ") ?? (step.verb ?? "nothing"))
                .metistryText(.mono, p, .textSecondary)
                .textSelection(.enabled)
                .padding(MetistrySpace.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
            HStack(spacing: MetistrySpace.s3) {
                Button {
                    if step == .runtime {
                        onRelocate()
                    } else {
                        Task { await model.run(step) }
                    }
                } label: {
                    if model.state(step) == .running {
                        HStack(spacing: MetistrySpace.s2) {
                            ProgressView().controlSize(.small)
                            Text("Running…")
                        }
                    } else {
                        Text(step == .runtime ? "Look again" : "Run")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(step != .runtime && !model.canRun(step))

                if case .failed(let why) = model.state(step) {
                    Text(why)
                        .metistryText(.footnote, p, .failed)
                        .lineLimit(2)
                }
                if case .succeeded(let what) = model.state(step) {
                    Text(what)
                        .metistryText(.footnote, p, .ok)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    private func deviceCodeCard(_ code: DeviceCode, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("Enter this code at GitHub").metistryText(.headline, p)
            Text(code.userCode)
                .font(.system(.largeTitle, design: .monospaced))
                .foregroundStyle(p[.accent])
                .textSelection(.enabled)
                .accessibilityLabel("Device code \(code.userCode.map(String.init).joined(separator: " "))")
            Button {
                if let url = URL(string: code.verificationURI) { openURL(url) }
            } label: {
                Label(code.verificationURI, systemImage: "arrow.up.forward.square")
            }
            Text("connect-repo is polling GitHub; it finishes on its own once you approve.")
                .metistryText(.caption1, p, .textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }

    @ViewBuilder
    private func log(_ step: FirstRunStep, _ p: Palette) -> some View {
        let lines = model.lines(step)
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text("Output").metistryText(.caption2, p, .textSecondary)
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(lines) { line in
                        Text(line.text)
                            .metistryText(.mono, p, line.stream == .standardError ? .degraded : .textSecondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(MetistrySpace.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
            }
        }
    }
}
