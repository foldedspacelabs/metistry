// Settings ▸ Variables (T6-14, screen-19 §2): name · value · used in, New
// Variable, Edit and Remove — each a `metistry variables set|unset` (M14)
// shown with its exact command before it runs.
//
// A value that looks like a key is refused at Save with **Store as Secret**
// and nothing else: screen 19 §2's *Save as Variable* override is not drawn,
// because the plan (§2.14) and the CLI (T4-4) refuse the value outright
// (variables-model.swift).

import SwiftUI

public struct VariablesPaneView: View {
    @Environment(\.colorScheme) private var scheme
    let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    private var settings: SettingsModel { model.settings }
    private var pane: VariablesModel { settings.variablesPane }

    public var body: some View {
        let p = Palette(scheme)
        SettingsSection("Variables") {
            SettingsControls {
                Button("New Variable…") { settings.beginNewVariable() }
                if pane.phase == .reading {
                    ProgressView().controlSize(.small).accessibilityLabel("Reading the variables")
                }
                Text(pane.rows.count == 1 ? "1 variable" : "\(pane.rows.count) variables")
                    .metistryText(.caption1, p, .textTertiary)
                    .monospacedDigit()
            }
            if case .unavailable(let why) = pane.phase {
                UnavailableCard(what: "Could not read the variables", reason: why, command: "GET /api/variables — on this Mac, `metistry variables list` says the same")
            } else if pane.rows.isEmpty {
                Text(pane.phase == .read
                    ? "No variables yet. New Variable adds a plain value agents can read — a team name, a list of repositories."
                    : "Reading this instance's variables…")
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(pane.rows) { variable in
                VariableRowView(variable: variable, settings: settings)
            }
            Text(VariablesModel.note)
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task(id: model.instances.active) { await settings.refreshVariablesPane() }
        .accessEditorSheet(settings)
    }
}

struct VariableRowView: View {
    @Environment(\.colorScheme) private var scheme
    let variable: SharedVariable
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        SettingsControls {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(variable.name).metistryText(.mono, p)
                Text(variable.value)
                    .metistryText(.callout, p)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Used in: \(variable.usedInLine)")
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: MetistrySpace.s2)
            Button("Edit…") { settings.beginEditVariable(variable) }
                .accessibilityLabel("Edit \(variable.name)")
            Button("Remove…") { settings.proposeVariableRemoval(variable) }
                .accessibilityLabel("Remove \(variable.name)")
        }
        .padding(.vertical, MetistrySpace.s1)
    }
}

/// New Variable and Edit. The sheet shows the exact command before its button
/// runs it — except while the value looks like a key, when there is no
/// command to show: only Store as Secret.
struct VariableEditorView: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    private var pane: VariablesModel { settings.variablesPane }

    private func binding(_ key: WritableKeyPath<VariableDraft, String>) -> Binding<String> {
        Binding(
            get: { pane.draft?[keyPath: key] ?? "" },
            set: { value in
                pane.draft?[keyPath: key] = value
                pane.draft?.refusal = nil
            }
        )
    }

    var body: some View {
        let p = Palette(scheme)
        let draft = pane.draft ?? VariableDraft()
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text(draft.editing.map { "Edit \($0)" } ?? "New Variable")
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            if draft.editing == nil {
                LabeledContent("Name") {
                    TextField("lowercase, like team_name", text: binding(\.name))
                        .textFieldStyle(.roundedBorder)
                }
            }
            LabeledContent("Value") {
                TextField("one line of plain text agents may read", text: binding(\.value))
                    .textFieldStyle(.roundedBorder)
            }

            if let refusal = draft.refusal {
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    HStack(alignment: .firstTextBaseline, spacing: MetistrySpace.s2) {
                        Image(systemName: CheckStatus.failed.symbolName)
                            .foregroundStyle(p[.failed])
                            .accessibilityHidden(true)
                        Text(refusal.words)
                            .metistryText(.callout, p)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    if refusal.storeAsSecret {
                        Text("A secret is filled in on the way out and never shown to an agent or a model.")
                            .metistryText(.caption1, p, .textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Store as Secret") { settings.storeVariableAsSecret() }
                            .keyboardShortcut(.defaultAction)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .metistryCard(p)
            } else {
                CommandCard(argument: settings.plannedVariableCommand(draft), placeholder: KeyShape.looksLikeKey(draft.value) ? "nothing — this value looks like a key" : "name the variable and give it a value")
            }

            HStack(spacing: MetistrySpace.s3) {
                Spacer(minLength: 0)
                Button("Cancel") { settings.cancelVariableDraft() }
                    .keyboardShortcut(.cancelAction)
                if draft.refusal?.storeAsSecret != true {
                    Button("Save Variable") { Task { await settings.saveVariable() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!draft.canSave || settings.running != nil)
                }
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 520)
        .background(p[.bg])
    }
}
