// The window: a NavigationSplitView with the destinations this scaffold has.
//
// Design-system P6 names ten destinations — Feed, Chat, Agents, Projects,
// Artifacts, Capture, Needs You, Dashboard, Status, Devices — in the same order
// on every platform. Two of them exist today (Status, and First run, which is
// the install flow rather than one of the ten). The rest are not listed as
// greyed-out placeholders: an empty destination that pretends to be a
// destination is the thing §3.15 warns against.

import SwiftUI

public enum Destination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case status
    case firstRun

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .status: return "Status"
        case .firstRun: return "First Run"
        }
    }

    public var symbolName: String {
        switch self {
        case .status: return "waveform.path.ecg"
        case .firstRun: return "list.number"
        }
    }
}

public struct RootView: View {
    @Environment(\.colorScheme) private var scheme
    private let model: AppModel
    @State private var destination: Destination

    public init(model: AppModel) {
        self.model = model
        // A machine with no runtime located has one useful screen, and it is
        // step 1 — so start there rather than on an empty Status panel.
        _destination = State(initialValue: model.runtime == nil ? .firstRun : .status)
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
                StatusPanel(model: model.status, runtime: model.runtime)
                    .navigationTitle("Status")
            case .firstRun:
                FirstRunView(
                    model: model.firstRun,
                    productDirectory: model.chosenProductDir,
                    onRelocate: { model.relocate() },
                    onChooseProductDirectory: { model.chooseProductDirectory($0) }
                )
                .navigationTitle("First Run")
            }
        }
        .background(p[.bg])
    }
}

/// What the menu-bar item drops down: the doctor rows, exactly as §3.13 says
/// ("This row is the macOS menu-bar item: the worst state across components
/// becomes the menu-bar glyph, and the menu lists the rows").
public struct MenuBarContent: View {
    private let model: StatusModel
    private let openWindow: () -> Void

    public init(model: StatusModel, openWindow: @escaping () -> Void) {
        self.model = model
        self.openWindow = openWindow
    }

    public var body: some View {
        if let report = model.report {
            Text(report.summary)
            Divider()
            ForEach(report.rows.prefix(24)) { row in
                Text("\(row.status.label.padding(toLength: 15, withPad: " ", startingAt: 0))  \(row.name)")
            }
            if report.rows.count > 24 {
                Text("…and \(report.rows.count - 24) more")
            }
        } else if case .unavailable(let why) = model.phase {
            Text("doctor did not answer: \(why)")
        } else {
            Text(model.isChecking ? "running metistry doctor…" : "not checked yet")
        }
        Divider()
        Button("Check Again") { Task { await model.refresh() } }
            .disabled(model.isChecking)
        Button("Open Metistry", action: openWindow)
    }
}
