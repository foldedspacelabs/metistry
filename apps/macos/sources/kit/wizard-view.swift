// The first-launch wizard, on screen.
//
// A fixed header (which step, of how many), one step's content in the middle,
// and a fixed footer (Back · Skip · Continue). The header and footer do not
// scroll, so moving between steps never moves the controls under the pointer
// (design-system P9's rule, applied to a sheet rather than a transcript).
//
// Every step keeps the same promise as the scaffold did: the exact argument
// array before it runs, the CLI's own output after. What is new is the WHY —
// each choice carries what it gets you and what it costs, because the person
// seeing this screen has no way to know that from the verb names.

import SwiftUI
import UniformTypeIdentifiers

public struct WizardView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private let model: WizardModel
    private let bridges: [DoctorRow]
    private let resolvedShape: String?
    private let developerProductDir: URL?
    private let onRelocate: () -> Void
    private let onChooseDeveloperProductDirectory: (URL) -> Void

    @State private var pickingInstanceDirectory = false
    @State private var pickingProductDirectory = false
    @State private var shapeUnderConsideration: String?

    public init(
        model: WizardModel,
        bridges: [DoctorRow],
        resolvedShape: String?,
        developerProductDir: URL?,
        onRelocate: @escaping () -> Void,
        onChooseDeveloperProductDirectory: @escaping (URL) -> Void
    ) {
        self.model = model
        self.bridges = bridges
        self.resolvedShape = resolvedShape
        self.developerProductDir = developerProductDir
        self.onRelocate = onRelocate
        self.onChooseDeveloperProductDirectory = onChooseDeveloperProductDirectory
    }

    private var steps: FirstRunModel { model.steps }

    public var body: some View {
        let p = Palette(scheme)
        VStack(spacing: 0) {
            header(p)
            Divider().overlay(p[.border])
            ScrollView {
                VStack(alignment: .leading, spacing: MetistrySpace.s4) {
                    body(for: model.current, p)
                }
                .padding(MetistrySpace.s5)
                .frame(maxWidth: MetistrySize.contentMax, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            Divider().overlay(p[.border])
            footer(p)
        }
        .frame(minWidth: 640, idealWidth: 760, minHeight: 520, idealHeight: 640)
        .background(p[.bg])
    }

    // MARK: - Chrome

    private func header(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s3) {
                Text("Set Up Metistry").metistryText(.title3, p)
                Spacer(minLength: MetistrySpace.s3)
                Text(model.progressLabel).metistryText(.footnote, p, .textSecondary).monospacedDigit()
            }
            // The dots are the whole progress indicator: seven steps is few
            // enough to show, and a bar that fills would imply time it cannot
            // know.
            HStack(spacing: MetistrySpace.s1) {
                ForEach(FirstRunStep.allCases) { step in
                    Circle()
                        .fill(dotColour(step, p))
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
                Text(WizardModel.reassurance)
                    .metistryText(.caption1, p, .textTertiary)
                    .padding(.leading, MetistrySpace.s2)
            }
        }
        .padding(.horizontal, MetistrySpace.s5)
        .padding(.vertical, MetistrySpace.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(p[.surface])
    }

    private func dotColour(_ step: FirstRunStep, _ p: Palette) -> Color {
        if step == model.current { return p[.accent] }
        if model.skipped.contains(step.rawValue) { return p[.absent] }
        switch steps.state(step) {
        case .succeeded: return p[.ok]
        case .failed: return p[.failed]
        case .notYet: return p[.absent]
        default: return p[.border]
        }
    }

    private func footer(_ p: Palette) -> some View {
        HStack(spacing: MetistrySpace.s3) {
            Button("Back") { model.back() }
                .disabled(!model.canGoBack)
            Spacer(minLength: MetistrySpace.s4)
            if model.canSkip {
                Button("Skip") { model.skip() }
            }
            Button(model.isOnLastStep ? "Done" : "Continue") { model.advance() }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canContinue)
                .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, MetistrySpace.s5)
        .padding(.vertical, MetistrySpace.s3)
        .frame(maxWidth: .infinity)
        .background(p[.surface])
    }

    // MARK: - Steps

    @ViewBuilder
    private func body(for step: FirstRunStep, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("\(step.rawValue). \(step.title)").metistryText(.title2, p)
            Text(step.summary)
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }

        if let reason = step.notYetReason {
            NotYetCard(reason: reason)
        } else {
            switch step {
            case .runtime: runtimeStep(p)
            case .instance: instanceStep(p)
            case .versioning: versioningStep(p)
            case .secrets: secretsStep(p)
            case .services: servicesStep(p)
            case .door, .claude: EmptyView()
            }
            runRow(step, p)
            if step == .versioning, let code = steps.deviceCode {
                deviceCodeCard(code, p)
            }
            OutputLogView(lines: steps.lines(step))
        }
    }

    // 1. Runtime
    private func runtimeStep(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(spacing: MetistrySpace.s2) {
                StatusDot(steps.cli == nil ? .failed : .ok)
                Text(steps.runtimeSummary)
                    .metistryText(.mono, p, steps.cli == nil ? .textSecondary : .textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !steps.resolution.attempts.isEmpty {
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text("Considered").metistryText(.caption2, p, .textSecondary)
                    ForEach(Array(steps.resolution.attempts.enumerated()), id: \.offset) { _, attempt in
                        Text("· \(attempt)")
                            .metistryText(.caption1, p, .textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            // Only a build with nothing bundled needs this, and it says so: a
            // downloaded Metistry.app carries its own runtime and this row is
            // never the answer.
            if steps.cli == nil {
                folderRow(
                    label: "Product checkout (developer)",
                    help: "A Metistry checkout with packages/cli/dist/main.js built. A release build finds its bundled runtime instead and never needs this; it lives in Settings → Advanced afterwards.",
                    url: developerProductDir,
                    p: p
                ) { pickingProductDirectory = true }
            }
            Button("Look Again") { onRelocate() }
        }
        .metistryCard(p)
        .fileImporter(isPresented: $pickingProductDirectory, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { onChooseDeveloperProductDirectory(url) }
        }
    }

    // 2. Instance
    private func instanceStep(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            options(WizardOptions.instanceMode, selection: steps.instanceMode, p) { mode in
                steps.instanceMode = mode
                // Choosing "use an existing folder" AFTER picking one is the
                // same act as picking one while already in that mode: the step
                // is satisfied either way, and Continue must not stay dark
                // because of the order the two were done in.
                steps.markAdopted()
            }
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                folderRow(
                    label: steps.instanceMode == .create ? "New instance folder" : "Existing instance folder",
                    help: steps.instanceMode == .create
                        ? "Where the private instance repo is created — vault, identity.yaml, config."
                        : "A folder that already holds an identity.yaml.",
                    url: steps.instanceDirectory,
                    p: p
                ) { pickingInstanceDirectory = true }
                if steps.instanceMode == .create {
                    VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                        Text("Assistant name").metistryText(.caption2, p, .textSecondary)
                        TextField("what you'll call it", text: Binding(get: { steps.assistantName }, set: { steps.assistantName = $0 }))
                            .textFieldStyle(.roundedBorder)
                        Text("Written to identity.yaml, and read from there by everything else. Leave it blank to take the seed's default.")
                            .metistryText(.caption1, p, .textTertiary)
                    }
                } else if let dir = steps.instanceDirectory, !InstanceFiles.looksLikeInstance(dir) {
                    Text("No identity.yaml in that folder — pick the instance repo itself, or create a new instance instead.")
                        .metistryText(.footnote, p, .degraded)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .metistryCard(p)
        }
        .fileImporter(isPresented: $pickingInstanceDirectory, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result {
                steps.instanceDirectory = url
                steps.markAdopted()
            }
        }
    }

    // 3. Versioning
    private func versioningStep(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            options(WizardOptions.repoPlan, selection: steps.repoPlan, p) { steps.repoPlan = $0 }
            if steps.repoPlan == .now {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text("Private repository URL").metistryText(.caption2, p, .textSecondary)
                    TextField("https://github.com/you/your-instance.git", text: Binding(get: { steps.remoteURL }, set: { steps.remoteURL = $0 }))
                        .textFieldStyle(.roundedBorder)
                    Text("Paste an existing private repository, or create an empty one first — connect-repo sets it as origin and refuses to repoint one that is already set.")
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .metistryCard(p)
                options(WizardOptions.repoAuth, selection: steps.repoAuth, p) { steps.repoAuth = $0 }
            }
        }
    }

    // 4. Secrets (and the bridges, because enabling one is minting its token)
    private func secretsStep(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                ForEach(SecretsDirection.allCases) { direction in
                    choiceRow(
                        title: direction.label,
                        detail: direction.detail,
                        selected: steps.secretsDirection == direction,
                        p: p
                    ) { steps.secretsDirection = direction }
                }
            }
            .metistryCard(p)

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Bridges").metistryText(.headline, p)
                if bridges.isEmpty {
                    Text("Doctor has not listed any bridges yet — it runs once the runtime is located, and the list is whatever this product has.")
                        .metistryText(.footnote, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ForEach(bridges) { row in
                        bridgeRow(row, p)
                    }
                }
                Text(WizardOptions.bridgeNote)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    private func bridgeRow(_ row: DoctorRow, _ p: Palette) -> some View {
        let selected = steps.bridgeSelection.contains(row.name)
        return Button {
            if selected { steps.bridgeSelection.remove(row.name) } else { steps.bridgeSelection.insert(row.name) }
        } label: {
            HStack(alignment: .top, spacing: MetistrySpace.s3) {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                    .foregroundStyle(p[selected ? .accent : .textTertiary])
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    HStack(spacing: MetistrySpace.s2) {
                        Text(row.name).metistryText(.mono, p)
                        StatusDot(row.status)
                        Text(row.status.label).metistryText(.caption2, p, row.status.colorRole)
                    }
                    Text(row.remediation ?? row.probe)
                        .metistryText(.caption1, p, .textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // 5. Services
    private func servicesStep(_ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                Text("`metistry up` renders every launchd plist into ~/Library/LaunchAgents and bootstraps it, brings the containers up if this install's shape uses them, and finishes with doctor — whose verdict is the exit code.")
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let resolvedShape {
                    Text("This install's shape is `\(resolvedShape)`, resolved from deployment.yaml.")
                        .metistryText(.footnote, p, .textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)

            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                Text("Deployment Shape").metistryText(.headline, p)
                ForEach(WizardOptions.shape) { option in
                    choiceRow(
                        title: option.title + (option.value == resolvedShape ? " — current" : ""),
                        detail: "\(option.pro)\n\(option.con)",
                        selected: (shapeUnderConsideration ?? resolvedShape) == option.value,
                        p: p
                    ) { shapeUnderConsideration = option.value }
                }
                // The honest part: the shape is deployment.yaml's to state, and
                // deployment.yaml is a §4.7 protected path — the user's own hand
                // writes it, and no metistry verb does. So the app explains, and
                // previews, and stops there.
                Text("Changing the shape is a one-line edit to the instance's deployment.yaml, in your own hand: it is a protected path, and no `metistry` verb writes it. The preview below shows exactly what the other shape would do, and changes nothing.")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if let shape = shapeUnderConsideration, shape != resolvedShape {
                    CommandCard(title: "Preview", argument: steps.plannedPreviewArguments(shape: shape))
                    Button("Preview This Shape") { Task { await steps.previewShape(shape) } }
                        .disabled(steps.state(.services) == .running)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    // MARK: - Run

    @ViewBuilder
    private func runRow(_ step: FirstRunStep, _ p: Palette) -> some View {
        let planned = steps.plannedArguments(step)
        let followUps = steps.plannedFollowUps(step)
        if planned != nil || !followUps.isEmpty || step == .runtime {
            VStack(alignment: .leading, spacing: MetistrySpace.s3) {
                CommandCard(
                    arguments: ([planned].compactMap { $0 }) + followUps,
                    placeholder: placeholder(for: step)
                )
                HStack(spacing: MetistrySpace.s3) {
                    Button {
                        if step == .runtime { onRelocate() } else { Task { await steps.run(step) } }
                    } label: {
                        if steps.state(step) == .running {
                            HStack(spacing: MetistrySpace.s2) {
                                ProgressView().controlSize(.small)
                                Text("Running…")
                            }
                        } else {
                            Text(step == .runtime ? "Look Again" : "Run")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(step != .runtime && !steps.canRun(step))

                    switch steps.state(step) {
                    case .failed(let why):
                        Text(why).metistryText(.footnote, p, .failed).lineLimit(2)
                    case .succeeded(let what):
                        Text(what).metistryText(.footnote, p, .ok).lineLimit(2)
                    default:
                        EmptyView()
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .metistryCard(p)
        }
    }

    private func placeholder(for step: FirstRunStep) -> String {
        switch step {
        case .runtime:
            return "nothing — this step only looks"
        case .instance:
            return steps.instanceMode == .adopt
                ? "nothing — the app just points at the folder you chose"
                : "choose a folder first"
        case .versioning:
            return steps.repoPlan == .later
                ? "nothing — `metistry connect-repo` does this whenever you want it"
                : (steps.repoAuth.runnableFromTheApp ? "paste a repository URL first" : "not from the app — see above")
        default:
            return "nothing"
        }
    }

    private func deviceCodeCard(_ code: DeviceCode, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text("Enter This Code at GitHub").metistryText(.headline, p)
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

    // MARK: - Choice rows

    /// A `WizardOption` list. Not a `Picker`: every option shows a pro and a con,
    /// and an unavailable one shows why — none of which fits in a picker row.
    private func options<Value: Hashable & Sendable>(
        _ options: [WizardOption<Value>],
        selection: Value,
        _ p: Palette,
        choose: @escaping (Value) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            ForEach(options) { option in
                choiceRow(
                    title: option.title,
                    detail: option.unavailable ?? "\(option.pro)\n\(option.con)",
                    selected: option.value == selection,
                    enabled: option.isAvailable,
                    p: p
                ) { choose(option.value) }
            }
        }
        .metistryCard(p)
    }

    private func choiceRow(
        title: String,
        detail: String,
        selected: Bool,
        enabled: Bool = true,
        p: Palette,
        choose: @escaping () -> Void
    ) -> some View {
        Button(action: choose) {
            HStack(alignment: .top, spacing: MetistrySpace.s3) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(p[enabled ? (selected ? .accent : .textTertiary) : .absent])
                VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                    Text(title).metistryText(.callout, p, enabled ? .textPrimary : .absent)
                    Text(detail)
                        .metistryText(.caption1, p, enabled ? .textSecondary : .absent)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, MetistrySpace.s1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func folderRow(
        label: String,
        help: String,
        url: URL?,
        p: Palette,
        choose: @escaping () -> Void
    ) -> some View {
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
}
