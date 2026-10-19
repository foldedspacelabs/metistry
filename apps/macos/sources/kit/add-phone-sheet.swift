// The Add a Phone sheet (design-build-plan §2.22, X-77), drawn once: Settings
// ▸ Devices ▸ Add a Phone… and the wizard's step 6 both present this view over
// an `AddPhoneModel` (add-phone-model.swift holds every decision). The sheet
// says which state it is in and nothing it has not been told: Checking while
// `metistry enroll --json` runs; the refusal's own words, with Learn How, and
// NO QR when the CLI refused; the QR, the URL, Copy Link and the countdown
// when it minted; *This code expired* in the QR's place when the ten minutes
// ran out; *“iPhone” was added* when the phone arrived. Done in every state —
// and closing cancels a live code (the model's `close()`).
//
// Accessibility (§2.18): the QR is an image VoiceOver names *QR code for
// adding a phone* whose value is the URL — the accessible alternative; the
// URL is also selectable text. Every button says its act. Esc is Done. The
// countdown is a `TimelineView`, not an animation, so Reduce Motion changes
// nothing; the modules are drawn at integer pixels with no interpolation.

import SwiftUI

public struct AddPhoneSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private let model: AddPhoneModel
    private let onDone: () -> Void

    /// `onDone` closes the presentation; the presenter runs the model's `close()`.
    public init(model: AddPhoneModel, onDone: @escaping () -> Void) {
        self.model = model
        self.onDone = onDone
    }

    /// The sheet's width — the QR with its quiet zone, and a URL beside it.
    public static let width: CGFloat = 460

    public var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: MetistrySpace.s4) {
            Text(AddPhoneWords.title)
                .metistryText(.title3, p)
                .accessibilityAddTraits(.isHeader)
            content(p)
                .frame(maxWidth: .infinity, alignment: .leading)
            footer(p)
        }
        .padding(MetistrySpace.s5)
        .frame(width: Self.width)
        .background(p[.bg])
        #if os(macOS)
        .onExitCommand { onDone() }
        #endif
    }

    // MARK: - The states

    @ViewBuilder
    private func content(_ p: Palette) -> some View {
        switch model.phase {
        case .checking:
            HStack(spacing: MetistrySpace.s2) {
                ProgressView().controlSize(.small)
                Text(AddPhoneWords.checking).metistryText(.callout, p, .textSecondary)
            }
            .accessibilityElement(children: .combine)
            Text(AddPhoneWords.mintCommand)
                .metistryText(.caption1, p, .textTertiary)
                .textSelection(.enabled)
        case .refused(let refusal):
            refused(refusal, p)
        case .ready(let code):
            ready(code, p)
        case .expired:
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    Image(systemName: CheckStatus.absent.symbolName).foregroundStyle(p[.absent]).accessibilityHidden(true)
                    Text(AddPhoneWords.expired).metistryText(.headline, p)
                }
                Text("A code works for 10 minutes. Make a new one and scan it with your phone.")
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .metistryCard(p)
        case .added(let label):
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(.ok)
                    Text(AddPhoneWords.added(label)).metistryText(.headline, p)
                }
                Text(AddPhoneWords.addedNote)
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .metistryCard(p)
        case .unavailable(let why):
            UnavailableCard(what: AddPhoneWords.unavailableTitle, reason: why, command: AddPhoneWords.mintCommand)
        }
    }

    /// The refusal's own words (§3.16), the fix it names, and nothing drawn
    /// that would lead the phone nowhere.
    private func refused(_ refusal: EnrollmentRefusal, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s2) {
            HStack(spacing: MetistrySpace.s2) {
                Image(systemName: CheckStatus.failed.symbolName).foregroundStyle(p[.failed]).accessibilityHidden(true)
                Text(AddPhoneWords.refusedTitle).metistryText(.headline, p)
            }
            Text(refusal.message)
                .metistryText(.callout, p)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = refusal.detail {
                Text(detail)
                    .metistryText(.mono, p, .textSecondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(refusal.fix)
                .metistryText(.caption1, p, .textTertiary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .metistryCard(p)
    }

    private func ready(_ code: EnrollmentCode, _ p: Palette) -> some View {
        VStack(alignment: .leading, spacing: MetistrySpace.s3) {
            HStack(alignment: .top, spacing: MetistrySpace.s4) {
                if let qr = model.qr {
                    // Integer pixels, no interpolation: every module stays a
                    // square. Dark on light in both appearances (the bitmap
                    // carries its own white quiet zone).
                    Image(qr, scale: 1, label: Text(AddPhoneWords.qrLabel))
                        .interpolation(.none)
                        .accessibilityValue(Text(code.url))
                        .clipShape(RoundedRectangle(cornerRadius: MetistryRadius.sm, style: .continuous))
                }
                VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                    Text(AddPhoneWords.scan)
                        .metistryText(.callout, p)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(AddPhoneWords.mustOpen(code.host))
                        .metistryText(.callout, p, .textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    // A timeline, not an animation: one redraw a second, and
                    // the model's own timer decides when Expired is reached.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(code.countdown(at: context.date))
                            .metistryText(.footnote, p, .textSecondary)
                            .monospacedDigit()
                    }
                }
            }
            Text(code.url)
                .metistryText(.mono, p, .accent)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Enrolment link: \(code.url)")
            Button(AddPhoneWords.copyLink) { model.copyLink() }
        }
        .metistryCard(p)
    }

    // MARK: - The buttons

    @ViewBuilder
    private func footer(_ p: Palette) -> some View {
        HStack(spacing: MetistrySpace.s3) {
            Spacer(minLength: 0)
            switch model.phase {
            case .refused:
                Button(AddPhoneWords.learnHow) { openURL(AddPhoneWords.guideURL) }
            case .ready, .expired, .unavailable:
                Button(AddPhoneWords.makeANewCode) { Task { await model.makeNewCode() } }
            case .checking, .added:
                EmptyView()
            }
            Button(AddPhoneWords.done, action: onDone)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
    }
}
