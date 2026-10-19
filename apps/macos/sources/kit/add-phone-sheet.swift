// The Add a Phone sheet (design-build-plan §2.22, X-77), drawn once: Settings
// ▸ Devices ▸ Add a Phone… and the wizard's step 6 both present this view over
// an `AddPhoneModel` (add-phone-model.swift holds every decision). The sheet
// says which state it is in and nothing it has not been told: Checking while
// `metistry enroll --json` runs; the refusal's own words, with Learn How, and
// NO QR when the CLI refused; the QR, the URL, Copy Link and the countdown
// when it minted; *Opened on your phone* in the QR's place once the console saw
// the phone's request arrive through the proxy listener (X-114); *This code
// expired* in the QR's place when the ten minutes ran out (and, when no phone
// ever reached the origin, what to try); *“iPhone” was added* when the phone
// arrived. Done in every state —
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
        // The window or the wizard closing under an open sheet never calls the
        // presenter's binding setter, so the code would stay live for its
        // ten minutes. A model that is still open when its view goes away is
        // closed the way Done closes it; one already closed (Done, Esc) is not
        // — which also keeps a late disappearance from closing a newer sheet.
        .onDisappear { if !model.isClosed { onDone() } }
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
        case .openedOnPhone(let code, let provider):
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    StatusDot(.ok)
                    Text(AddPhoneWords.openedTitle).metistryText(.headline, p)
                }
                Text(AddPhoneWords.opened(through: provider))
                    .metistryText(.callout, p)
                    .fixedSize(horizontal: false, vertical: true)
                Text(AddPhoneWords.openedNote)
                    .metistryText(.callout, p, .textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(code.countdown(at: context.date))
                        .metistryText(.footnote, p, .textSecondary)
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .combine)
            .metistryCard(p)
        case .expired(let code):
            VStack(alignment: .leading, spacing: MetistrySpace.s2) {
                HStack(spacing: MetistrySpace.s2) {
                    Image(systemName: CheckStatus.absent.symbolName).foregroundStyle(p[.absent]).accessibilityHidden(true)
                    Text(AddPhoneWords.expired).metistryText(.headline, p)
                }
                if !model.phoneReachedMac {
                    // the console never heard from a phone on the proxy listener: say so, and what to try
                    Text(AddPhoneWords.notReached(code.origin))
                        .metistryText(.callout, p)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
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
            case .ready, .openedOnPhone, .expired, .unavailable:
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
