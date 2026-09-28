// Reading the generated tokens from a view.
//
// `MetistryColorRole.color(scheme)` is the generated accessor; this is the
// two-character way to call it, so a view body reads `p[.surface]` and never
// hard-codes a hue. No AppKit: the scheme comes from the environment, which is
// the same on iOS.

import SwiftUI

public struct Palette: Sendable {
    public let scheme: ColorScheme

    public init(_ scheme: ColorScheme) {
        self.scheme = scheme
    }

    public subscript(role: MetistryColorRole) -> Color {
        role.color(scheme)
    }
}

public extension View {
    /// A card: `surface` on `bg`, a hairline `border`, `radius.lg`. Elevation 1
    /// in dark mode is the hairline alone — dark raises a surface by lightening
    /// it, not by casting a bigger shadow (design-system §2.5).
    func metistryCard(_ p: Palette, padding: CGFloat = MetistrySpace.s4) -> some View {
        self
            .padding(padding)
            .background(p[.surface], in: RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: MetistryRadius.lg, style: .continuous)
                    .strokeBorder(p[.border], lineWidth: 1)
            )
    }

    /// A type step and its ink. The step grows with the text size on the Mac
    /// too (`metistryFont`, component-kit.swift): at `.large` it is the
    /// platform's semantic font, untouched; at any other size the Mac's own
    /// point size scaled by Dynamic Type's ratios — so Settings, drawn in this,
    /// grows longer at the largest text (plan §2.18.5) rather than not at all.
    func metistryText(_ style: MetistryTextStyle, _ p: Palette, _ role: MetistryColorRole = .textPrimary) -> some View {
        self.metistryFont(style).foregroundStyle(p[role])
    }
}
