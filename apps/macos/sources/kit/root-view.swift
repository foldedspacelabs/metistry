// The window: a NavigationSplitView with the destinations this scaffold has.
//
// Design-system P6 names ten destinations — Feed, Chat, Agents, Projects,
// Artifacts, Capture, Needs You, Dashboard, Status, Devices — in the same order
// on every platform. One of them exists today (Status). The rest are not listed
// as greyed-out placeholders: an empty destination that pretends to be a
// destination is the thing §3.15 warns against.
//
// "First run" used to be a destination here, and is not any more. Setting an
// install up is not a place you navigate to and leave things in — it is a task
// with an order, so it is a SHEET (wizard-view.swift), presented when there is
// no instance yet and re-enterable from Settings → Instance. Configuration went
// the same way: to the `Settings` scene, where macOS users look for it.

import SwiftUI

public enum Destination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case status

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .status: return "Status"
        }
    }

    public var symbolName: String {
        switch self {
        case .status: return "waveform.path.ecg"
        }
    }
}

public struct RootView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: AppModel
    @State private var destination: Destination = .status

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        let p = Palette(scheme)
        NavigationSplitView {
            List(Destination.allCases, selection: Binding(get: { Optional(destination) }, set: { destination = $0 ?? .status })) { d in
                Label(d.title, systemImage: d.symbolName).tag(d)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: MetistrySize.sidebar, max: 320)
        } detail: {
            switch destination {
            case .status:
                StatusPanel(model: model.status, signIn: model.consoleSignIn, runtime: model.runtime)
                    .navigationTitle("Status")
            }
        }
        .background(p[.bg])
    }
}
