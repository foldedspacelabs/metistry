// Settings ▸ Instance's two sheets: the assistant's identity, edited, and
// *Link an Instance…*. Neither writes anything — each hands over to the
// window's confirmation, which names the exact §2.2 verb (M10, M11) before it
// runs. Return and Esc are the sheet's own default and cancel buttons, as in
// every other sheet in the app; no other key is bound.

import SwiftUI

/// The assistant's name, mention and mark, edited. Save… hands over to the
/// confirmation; nothing is written from here.
struct IdentityEditorView: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        let draft = Binding(get: { settings.identityDraft ?? IdentityDraft() }, set: { settings.identityDraft = $0 })
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text("Edit \(settings.assistantNameDisplay)")
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            TextField("Name", text: draft.name, prompt: Text("Name"))
            TextField("Mention", text: draft.mention, prompt: Text("@mention"))
            TextField("Mark", text: draft.mark, prompt: Text("A glyph"))
            Text("A new name brings its mention along when the mention was the one made from the old name. Every field is checked by `metistry identity set`, and an invalid one writes nothing.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { settings.identityDraft = nil }
                    .keyboardShortcut(.cancelAction)
                Button("Save…") { settings.proposeIdentityChange() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(settings.identityDraft.flatMap(settings.identityCommand) == nil)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 420)
    }
}

/// *Link an Instance…*: its origin. Link… hands over to the confirmation.
struct LinkInstanceView: View {
    @Environment(\.colorScheme) private var scheme
    let settings: SettingsModel

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text("Link an Instance")
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            TextField("Origin", text: Binding(get: { settings.linkOrigin ?? "" }, set: { settings.linkOrigin = $0 }), prompt: Text("https://second.example.com"))
            Text("This instance asks the origin who it is — its one unauthenticated read — and records what it says.")
                .metistryText(.caption1, p, .textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { settings.linkOrigin = nil }
                    .keyboardShortcut(.cancelAction)
                Button("Link…") { settings.proposeLink() }
                    .keyboardShortcut(.defaultAction)
                    .disabled((settings.linkOrigin ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(MetistrySpace.s5)
        .frame(width: 420)
    }
}
