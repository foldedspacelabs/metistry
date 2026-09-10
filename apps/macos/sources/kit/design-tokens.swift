// GENERATED — do not edit.
// Source: docs/product/design/tokens.json (v1.1.0, 2026-09-08)
// Rebuild: node ops/scripts/build-design-tokens.mjs   (--check fails on drift)
//
// The design system's semantic roles, for SwiftUI. No token names a hue, a
// screen or a component, so a role can be re-pointed without touching a call
// site (docs/product/design-system.md §2).
//
// Colours resolve against the ColorScheme a view already has from the
// environment rather than through an AppKit dynamic NSColor: MetistryKit stays
// AppKit-free so an iOS target can share it unchanged. Type steps map to
// Apple's own semantic Font values (design-system P7): Dynamic Type,
// VoiceOver and Increase Contrast then come free.

import SwiftUI

// MARK: - Colour roles

public enum MetistryColorRole: String, CaseIterable, Sendable {
    case bg = "bg"
    case surface = "surface"
    case elevated = "elevated"
    case sunken = "sunken"
    case border = "border"
    case borderStrong = "border-strong"
    case textPrimary = "text-primary"
    case textSecondary = "text-secondary"
    case textTertiary = "text-tertiary"
    case accent = "accent"
    case accentHover = "accent-hover"
    case accentQuiet = "accent-quiet"
    case onAccent = "on-accent"
    case agent = "agent"
    case agentQuiet = "agent-quiet"
    case ok = "ok"
    case degraded = "degraded"
    case failed = "failed"
    case absent = "absent"
    case presenceWorking = "presence-working"
    case presenceQueued = "presence-queued"
    case presenceIdle = "presence-idle"
    case presenceInterrupted = "presence-interrupted"
    case presenceOverCap = "presence-over-cap"
    case presenceBlocked = "presence-blocked"
    case focusRing = "focus-ring"
    case scrim = "scrim"
}

public extension MetistryColorRole {
    /// sRGB components in 0…1 for one scheme. Emitted as components rather than
    /// hex so the one rgba() token (`scrim`) needs no special case.
    func components(_ scheme: ColorScheme) -> (red: Double, green: Double, blue: Double, opacity: Double) {
        let dark = scheme == .dark
        switch self {
        case .bg: return dark ? (0.0549, 0.0706, 0.0863, 1.0) : (0.9647, 0.9686, 0.9765, 1.0)
        case .surface: return dark ? (0.0902, 0.1098, 0.1333, 1.0) : (1.0000, 1.0000, 1.0000, 1.0)
        case .elevated: return dark ? (0.1294, 0.1569, 0.1922, 1.0) : (1.0000, 1.0000, 1.0000, 1.0)
        case .sunken: return dark ? (0.0431, 0.0549, 0.0706, 1.0) : (0.9333, 0.9412, 0.9529, 1.0)
        case .border: return dark ? (0.1686, 0.2000, 0.2392, 1.0) : (0.8510, 0.8706, 0.8941, 1.0)
        case .borderStrong: return dark ? (0.2392, 0.2824, 0.3294, 1.0) : (0.7137, 0.7451, 0.7843, 1.0)
        case .textPrimary: return dark ? (0.9137, 0.9294, 0.9451, 1.0) : (0.0706, 0.0902, 0.1098, 1.0)
        case .textSecondary: return dark ? (0.6549, 0.6941, 0.7373, 1.0) : (0.3020, 0.3373, 0.3725, 1.0)
        case .textTertiary: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.3922, 0.4275, 0.4667, 1.0)
        case .accent: return dark ? (0.4941, 0.6627, 1.0000, 1.0) : (0.1686, 0.3725, 0.8157, 1.0)
        case .accentHover: return dark ? (0.6157, 0.7451, 1.0000, 1.0) : (0.1373, 0.3059, 0.6627, 1.0)
        case .accentQuiet: return dark ? (0.1059, 0.1529, 0.2235, 1.0) : (0.9020, 0.9294, 0.9882, 1.0)
        case .onAccent: return dark ? (0.0431, 0.0706, 0.1255, 1.0) : (1.0000, 1.0000, 1.0000, 1.0)
        case .agent: return dark ? (0.7255, 0.6353, 0.9608, 1.0) : (0.4157, 0.2941, 0.7412, 1.0)
        case .agentQuiet: return dark ? (0.1176, 0.1020, 0.1725, 1.0) : (0.9451, 0.9255, 0.9882, 1.0)
        case .ok: return dark ? (0.4078, 0.8275, 0.5686, 1.0) : (0.1098, 0.4784, 0.2706, 1.0)
        case .degraded: return dark ? (0.9098, 0.7216, 0.2941, 1.0) : (0.5412, 0.3529, 0.0000, 1.0)
        case .failed: return dark ? (0.9569, 0.5137, 0.4863, 1.0) : (0.7020, 0.1490, 0.1176, 1.0)
        case .absent: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.3922, 0.4275, 0.4667, 1.0)
        case .presenceWorking: return dark ? (0.4078, 0.8275, 0.5686, 1.0) : (0.1098, 0.4784, 0.2706, 1.0)
        case .presenceQueued: return dark ? (0.9098, 0.7216, 0.2941, 1.0) : (0.5412, 0.3529, 0.0000, 1.0)
        case .presenceIdle: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.3922, 0.4275, 0.4667, 1.0)
        case .presenceInterrupted: return dark ? (0.9569, 0.5137, 0.4863, 1.0) : (0.7020, 0.1490, 0.1176, 1.0)
        case .presenceOverCap: return dark ? (0.9412, 0.6392, 0.3686, 1.0) : (0.6353, 0.2902, 0.0000, 1.0)
        case .presenceBlocked: return dark ? (0.7255, 0.6353, 0.9608, 1.0) : (0.4157, 0.2941, 0.7412, 1.0)
        case .focusRing: return dark ? (0.4941, 0.6627, 1.0000, 1.0) : (0.1686, 0.3725, 0.8157, 1.0)
        case .scrim: return dark ? (0.0000, 0.0000, 0.0000, 0.5500) : (0.0706, 0.0902, 0.1098, 0.3200)
        }
    }

    func color(_ scheme: ColorScheme) -> Color {
        let c = components(scheme)
        return Color(.sRGB, red: c.red, green: c.green, blue: c.blue, opacity: c.opacity)
    }

    /// What this role is for, verbatim from tokens.json — so a reader of the
    /// Swift never has to open the JSON to know why a role exists.
    var role: String {
        switch self {
        case .bg: return "the window canvas behind everything"
        case .surface: return "rows, cards, composer, list backgrounds"
        case .elevated: return "menus, popovers, sheets, the command palette"
        case .sunken: return "code blocks, wells, inset scroll regions"
        case .border: return "separators between rows and around inputs"
        case .borderStrong: return "focused input, selected row outline, table rules"
        case .textPrimary: return "body copy, titles, values"
        case .textSecondary: return "metadata that must still be read: timestamps, counts, actor ids"
        case .textTertiary: return "placeholders and de-emphasised hints; never the only carrier of meaning"
        case .accent: return "the one interactive colour: links, selected tab, primary button fill"
        case .accentHover: return "hover and pressed state of an accent surface"
        case .accentQuiet: return "accent at low weight: selected sidebar row, chip fill, focus halo"
        case .onAccent: return "text and glyphs on an accent fill"
        case .agent: return "the agent-sourced tint — marks a string an agent wrote, as data"
        case .agentQuiet: return "agent-sourced background wash: quoted tool output, agent comment"
        case .ok: return "check passed, run succeeded, thread resolved"
        case .degraded: return "answering but not healthy: stale collector, fallback tier, queued over cap"
        case .failed: return "the check failed, the run errored, the drop was refused"
        case .absent: return "not configured — a fact, not a fault (no VAPID keys, no AWS collector)"
        case .presenceWorking: return "a live lease with evidence in the last interval"
        case .presenceQueued: return "work claimed or waiting behind the project's cap"
        case .presenceIdle: return "registered, reachable, nothing claimed"
        case .presenceInterrupted: return "lease expired mid-claim — the run stopped without saying so"
        case .presenceOverCap: return "at max open bundles or over the daily budget"
        case .presenceBlocked: return "waiting on a decision from you or on another agent"
        case .focusRing: return "keyboard focus indicator — 2px, always visible, never suppressed"
        case .scrim: return "behind a sheet or modal"
        }
    }
}

// MARK: - Type scale

public enum MetistryTextStyle: String, CaseIterable, Sendable {
    case largeTitle = "large-title"
    case title1 = "title-1"
    case title2 = "title-2"
    case title3 = "title-3"
    case headline = "headline"
    case body = "body"
    case callout = "callout"
    case subhead = "subhead"
    case footnote = "footnote"
    case caption1 = "caption-1"
    case caption2 = "caption-2"
    case mono = "mono"
}

public extension MetistryTextStyle {
    /// Apple's semantic style for this step, from tokens.json's `apple` field.
    var font: Font {
        switch self {
        case .largeTitle: return .largeTitle
        case .title1: return .title
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .body: return .body
        case .callout: return .callout
        case .subhead: return .subheadline
        case .footnote: return .footnote
        case .caption1: return .caption
        case .caption2: return .caption2
        case .mono: return .body.monospaced()
        }
    }

    /// The step's design weight. Apple's styles carry their own, so this is
    /// only applied where tokens.json asks for more than the style gives.
    var weight: Font.Weight {
        switch self {
        case .largeTitle: return .bold
        case .title1: return .bold
        case .title2: return .semibold
        case .title3: return .semibold
        case .headline: return .semibold
        case .body: return .regular
        case .callout: return .regular
        case .subhead: return .regular
        case .footnote: return .regular
        case .caption1: return .regular
        case .caption2: return .medium
        case .mono: return .regular
        }
    }
}

// MARK: - Spacing, size, radius (the 4pt grid — 4pt. Every gap, pad and inset is a multiple of 4; nothing in the system uses an odd number.)

public enum MetistrySpace {
    public static let s1: CGFloat = 4
    public static let s2: CGFloat = 8
    public static let s3: CGFloat = 12
    public static let s4: CGFloat = 16
    public static let s5: CGFloat = 20
    public static let s6: CGFloat = 24
    public static let s8: CGFloat = 32
    public static let s10: CGFloat = 40
    public static let s12: CGFloat = 48
    public static let s16: CGFloat = 64
}

public enum MetistrySize {
    public static let touchTarget: CGFloat = 44
    public static let pointerTarget: CGFloat = 28
    public static let iconSm: CGFloat = 16
    public static let iconMd: CGFloat = 20
    public static let iconLg: CGFloat = 24
    public static let sidebar: CGFloat = 248
    public static let contentMax: CGFloat = 760
    public static let wideBreakpoint: CGFloat = 900
}

public enum MetistryRadius {
    public static let xs: CGFloat = 6
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 10
    public static let lg: CGFloat = 14
    public static let xl: CGFloat = 20
    public static let pill: CGFloat = 999
}
