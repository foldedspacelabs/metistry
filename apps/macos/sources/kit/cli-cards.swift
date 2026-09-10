// The pieces every screen in this app is built from.
//
// They exist because the app makes the same promise everywhere: here is the
// exact command, here is its own output, and here is what I cannot do. Three
// views, one place, so no screen quietly stops keeping it.
//
// No AppKit and no `Process`: an iOS target renders these unchanged
// (design-system P6 — one information architecture, three renderings).

import SwiftUI

/// "Runs" — the exact argument array, before it runs.
public struct CommandCard: View {
    @Environment(\.colorScheme) private var scheme
    private let title: String
    private let arguments: [[String]]
    private let placeholder: String?

    public init(title: String = "Runs", arguments: [[String]], placeholder: String? = nil) {
        self.title = title
        self.arguments = arguments
        self.placeholder = placeholder
    }

    public init(title: String = "Runs", argument: [String]?, placeholder: String? = nil) {
        self.init(title: title, arguments: argument.map { [$0] } ?? [], placeholder: placeholder)
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(title).metistryText(.caption2, p, .textSecondary)
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                if arguments.isEmpty {
                    Text(placeholder ?? "nothing")
                        .metistryText(.mono, p, .textTertiary)
                } else {
                    ForEach(Array(arguments.enumerated()), id: \.offset) { _, argv in
                        Text(argv.joined(separator: " "))
                            .metistryText(.mono, p, .textSecondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(MetistrySpace.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(p[.sunken], in: RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
        }
    }
}

/// The CLI's own output, as it arrived. stderr in `degraded`, so a warning is
/// visibly not a result.
public struct OutputLogView: View {
    @Environment(\.colorScheme) private var scheme
    private let title: String
    private let lines: [OutputLine]

    public init(title: String = "Output", lines: [OutputLine]) {
        self.title = title
        self.lines = lines
    }

    public var body: some View {
        let p = Palette(scheme)
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: MetistrySpace.s1) {
                Text(title).metistryText(.caption2, p, .textSecondary)
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

/// `absent`, rendered: a fact, not a fault and not an empty state (§3.15).
public struct NotYetCard: View {
    @Environment(\.colorScheme) private var scheme
    private let title: String
    private let reason: String

    public init(title: String = "Not yet", reason: String) {
        self.title = title
        self.reason = reason
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: CheckStatus.absent.symbolName).foregroundStyle(p[.absent])
                Text(title).metistryText(.headline, p, .absent)
            }
            Text(reason)
                .metistryText(.callout, p, .textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }
}

/// §3.16's error envelope: what could not be done, the reason verbatim, and the
/// command that produced it when there is one.
public struct UnavailableCard: View {
    @Environment(\.colorScheme) private var scheme
    private let what: String
    private let reason: String
    private let command: String?

    public init(what: String, reason: String, command: String? = nil) {
        self.what = what
        self.reason = reason
        self.command = command
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: CheckStatus.failed.symbolName).foregroundStyle(p[.failed])
                Text(what).metistryText(.headline, p)
            }
            Text(reason)
                .metistryText(.mono, p, .textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let command {
                Text(command).metistryText(.caption1, p, .textTertiary).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .metistryCard(p)
    }
}

/// A label above a value, the shape most of Settings is. `mono` for anything
/// that is an identifier or a path — P10's third case: never case-corrected,
/// because it is a key, not a word.
public struct FactRow: View {
    @Environment(\.colorScheme) private var scheme
    private let label: String
    private let value: String
    private let help: String?
    private let mono: Bool
    private let role: MetistryColorRole

    public init(_ label: String, _ value: String, help: String? = nil, mono: Bool = false, role: MetistryColorRole = .textPrimary) {
        self.label = label
        self.value = value
        self.help = help
        self.mono = mono
        self.role = role
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s1) {
            Text(label).metistryText(.caption2, p, .textSecondary)
            Text(value)
                .metistryText(mono ? .mono : .callout, p, role)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let help {
                Text(help)
                    .metistryText(.caption1, p, .textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A section inside a Settings pane: a Title Case heading and a card.
public struct SettingsSection<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    private let title: String
    private let content: Content

    public init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            Text(title).metistryText(.headline, p)
            VStack(alignment: .leading, spacing: MetistrySpace.s3) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .metistryCard(p)
        }
    }
}

/// A status dot plus its label, the §3.13 pair, at row scale.
public struct StatusDot: View {
    @Environment(\.colorScheme) private var scheme
    private let status: CheckStatus

    public init(_ status: CheckStatus) {
        self.status = status
    }

    public var body: some View {
        Image(systemName: status.symbolName)
            .foregroundStyle(Palette(scheme)[status.colorRole])
            .accessibilityLabel(status.label)
    }
}
