// GENERATED — do not edit.
// Source: docs/product/design/tokens.json (v2.6.2, 2026-09-19)
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
    case borderControl = "border-control"
    case textPrimary = "text-primary"
    case textSecondary = "text-secondary"
    case textTertiary = "text-tertiary"
    case accent = "accent"
    case accentHover = "accent-hover"
    case accentQuiet = "accent-quiet"
    case onAccent = "on-accent"
    case agent = "agent"
    case agentQuiet = "agent-quiet"
    case entityPerson = "entity-person"
    case entityPersonQuiet = "entity-person-quiet"
    case entityNote = "entity-note"
    case entityNoteQuiet = "entity-note-quiet"
    case entityProject = "entity-project"
    case entityProjectQuiet = "entity-project-quiet"
    case ok = "ok"
    case okQuiet = "ok-quiet"
    case degraded = "degraded"
    case degradedQuiet = "degraded-quiet"
    case failed = "failed"
    case failedQuiet = "failed-quiet"
    case absent = "absent"
    case absentQuiet = "absent-quiet"
    case stale = "stale"
    case staleQuiet = "stale-quiet"
    case presenceWorking = "presence-working"
    case presenceWorkingQuiet = "presence-working-quiet"
    case presenceQueued = "presence-queued"
    case presenceQueuedQuiet = "presence-queued-quiet"
    case presenceIdle = "presence-idle"
    case presenceIdleQuiet = "presence-idle-quiet"
    case presenceInterrupted = "presence-interrupted"
    case presenceInterruptedQuiet = "presence-interrupted-quiet"
    case presenceOverCap = "presence-over-cap"
    case presenceOverCapQuiet = "presence-over-cap-quiet"
    case presenceBlocked = "presence-blocked"
    case presenceBlockedQuiet = "presence-blocked-quiet"
    case destructive = "destructive"
    case onDestructive = "on-destructive"
    case affirmative = "affirmative"
    case onAffirmative = "on-affirmative"
    case chart1 = "chart-1"
    case chart2 = "chart-2"
    case chart3 = "chart-3"
    case focusRing = "focus-ring"
    case scrim = "scrim"
    case chart4 = "chart-4"
    case chart5 = "chart-5"
}

public extension MetistryColorRole {
    /// sRGB components in 0…1 for one scheme. Emitted as components rather than
    /// hex so the one rgba() token (`scrim`) needs no special case.
    func components(_ scheme: ColorScheme) -> (red: Double, green: Double, blue: Double, opacity: Double) {
        let dark = scheme == .dark
        switch self {
        case .bg: return dark ? (0.0549, 0.0706, 0.0863, 1.0) : (0.9686, 0.9569, 0.9333, 1.0)
        case .surface: return dark ? (0.0902, 0.1098, 0.1333, 1.0) : (1.0000, 0.9922, 0.9725, 1.0)
        case .elevated: return dark ? (0.1294, 0.1569, 0.1922, 1.0) : (1.0000, 0.9922, 0.9725, 1.0)
        case .sunken: return dark ? (0.0431, 0.0549, 0.0706, 1.0) : (0.9373, 0.9176, 0.8745, 1.0)
        case .border: return dark ? (0.1686, 0.2000, 0.2392, 1.0) : (0.8941, 0.8706, 0.8196, 1.0)
        case .borderStrong: return dark ? (0.2392, 0.2824, 0.3294, 1.0) : (0.7647, 0.7294, 0.6627, 1.0)
        case .borderControl: return dark ? (0.4078, 0.4431, 0.4863, 1.0) : (0.5569, 0.5255, 0.4627, 1.0)
        case .textPrimary: return dark ? (0.9137, 0.9294, 0.9451, 1.0) : (0.1020, 0.0941, 0.0824, 1.0)
        case .textSecondary: return dark ? (0.6549, 0.6941, 0.7373, 1.0) : (0.3412, 0.3176, 0.2902, 1.0)
        case .textTertiary: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.4353, 0.4118, 0.3765, 1.0)
        case .accent: return dark ? (0.4314, 0.7882, 0.8392, 1.0) : (0.0706, 0.3725, 0.4196, 1.0)
        case .accentHover: return dark ? (0.5608, 0.8471, 0.8863, 1.0) : (0.0510, 0.2902, 0.3294, 1.0)
        case .accentQuiet: return dark ? (0.1451, 0.2196, 0.2471, 1.0) : (0.8510, 0.8941, 0.8824, 1.0)
        case .onAccent: return dark ? (0.0275, 0.0863, 0.1020, 1.0) : (0.9686, 0.9569, 0.9333, 1.0)
        case .agent: return dark ? (0.7255, 0.6353, 0.9608, 1.0) : (0.4157, 0.2941, 0.7412, 1.0)
        case .agentQuiet: return dark ? (0.1922, 0.1922, 0.2667, 1.0) : (0.9059, 0.8824, 0.9373, 1.0)
        case .entityPerson: return dark ? (0.8824, 0.4902, 0.5451, 1.0) : (0.7412, 0.1725, 0.2510, 1.0)
        case .entityPersonQuiet: return dark ? (0.2314, 0.1882, 0.1922, 1.0) : (0.9294, 0.8784, 0.8824, 1.0)
        case .entityNote: return dark ? (0.1608, 0.6863, 0.4431, 1.0) : (0.1059, 0.4510, 0.2902, 1.0)
        case .entityNoteQuiet: return dark ? (0.1137, 0.2196, 0.1686, 1.0) : (0.8118, 0.9137, 0.8667, 1.0)
        case .entityProject: return dark ? (0.4902, 0.5961, 0.8824, 1.0) : (0.2039, 0.3647, 0.8118, 1.0)
        case .entityProjectQuiet: return dark ? (0.1529, 0.1961, 0.3059, 1.0) : (0.8706, 0.8902, 0.9412, 1.0)
        case .ok: return dark ? (0.4078, 0.8275, 0.5686, 1.0) : (0.1098, 0.4784, 0.2706, 1.0)
        case .okQuiet: return dark ? (0.1412, 0.2235, 0.2039, 1.0) : (0.9373, 0.9569, 0.9216, 1.0)
        case .degraded: return dark ? (0.9098, 0.7216, 0.2941, 1.0) : (0.5412, 0.3529, 0.0000, 1.0)
        case .degradedQuiet: return dark ? (0.2196, 0.2078, 0.1608, 1.0) : (0.9373, 0.9020, 0.8353, 1.0)
        case .failed: return dark ? (0.9569, 0.5137, 0.4863, 1.0) : (0.7020, 0.1490, 0.1176, 1.0)
        case .failedQuiet: return dark ? (0.2275, 0.1725, 0.1882, 1.0) : (0.9529, 0.8588, 0.8353, 1.0)
        case .absent: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.4353, 0.4118, 0.3765, 1.0)
        case .absentQuiet: return dark ? (0.1412, 0.1608, 0.1882, 1.0) : (0.9490, 0.9412, 0.9176, 1.0)
        case .stale: return dark ? (0.5882, 0.6431, 0.6902, 1.0) : (0.3529, 0.4000, 0.4392, 1.0)
        case .staleQuiet: return dark ? (0.1686, 0.1961, 0.2235, 1.0) : (0.9098, 0.9098, 0.8980, 1.0)
        case .presenceWorking: return dark ? (0.4078, 0.8275, 0.5686, 1.0) : (0.1098, 0.4784, 0.2706, 1.0)
        case .presenceWorkingQuiet: return dark ? (0.1412, 0.2235, 0.2039, 1.0) : (0.9373, 0.9569, 0.9216, 1.0)
        case .presenceQueued: return dark ? (0.9098, 0.7216, 0.2941, 1.0) : (0.5412, 0.3529, 0.0000, 1.0)
        case .presenceQueuedQuiet: return dark ? (0.2196, 0.2078, 0.1608, 1.0) : (0.9373, 0.9020, 0.8353, 1.0)
        case .presenceIdle: return dark ? (0.5451, 0.5882, 0.6314, 1.0) : (0.4353, 0.4118, 0.3765, 1.0)
        case .presenceIdleQuiet: return dark ? (0.1412, 0.1608, 0.1882, 1.0) : (0.9490, 0.9412, 0.9176, 1.0)
        case .presenceInterrupted: return dark ? (0.9569, 0.5137, 0.4863, 1.0) : (0.7020, 0.1490, 0.1176, 1.0)
        case .presenceInterruptedQuiet: return dark ? (0.2275, 0.1725, 0.1882, 1.0) : (0.9529, 0.8588, 0.8353, 1.0)
        case .presenceOverCap: return dark ? (0.9412, 0.6392, 0.3686, 1.0) : (0.6353, 0.2902, 0.0000, 1.0)
        case .presenceOverCapQuiet: return dark ? (0.2275, 0.1961, 0.1725, 1.0) : (0.9490, 0.8941, 0.8353, 1.0)
        case .presenceBlocked: return dark ? (0.7255, 0.6353, 0.9608, 1.0) : (0.4157, 0.2941, 0.7412, 1.0)
        case .presenceBlockedQuiet: return dark ? (0.1922, 0.1922, 0.2667, 1.0) : (0.9059, 0.8824, 0.9373, 1.0)
        case .destructive: return dark ? (0.5608, 0.1961, 0.1725, 1.0) : (0.7020, 0.1490, 0.1176, 1.0)
        case .onDestructive: return dark ? (1.0000, 0.9255, 0.9216, 1.0) : (1.0000, 1.0000, 1.0000, 1.0)
        case .affirmative: return dark ? (0.2824, 0.7216, 0.4824, 1.0) : (0.1098, 0.4196, 0.2588, 1.0)
        case .onAffirmative: return dark ? (0.0157, 0.0902, 0.0510, 1.0) : (1.0000, 1.0000, 1.0000, 1.0)
        case .chart1: return dark ? (0.1059, 0.4588, 0.5176, 1.0) : (0.0392, 0.1961, 0.2235, 1.0)
        case .chart2: return dark ? (0.1725, 0.6471, 0.7216, 1.0) : (0.0784, 0.3608, 0.4039, 1.0)
        case .chart3: return dark ? (0.4000, 0.7686, 0.8275, 1.0) : (0.1176, 0.4667, 0.5176, 1.0)
        case .focusRing: return dark ? (0.4314, 0.7882, 0.8392, 1.0) : (0.0706, 0.3725, 0.4196, 1.0)
        case .scrim: return dark ? (0.0000, 0.0000, 0.0000, 0.5500) : (0.1020, 0.0941, 0.0824, 0.3400)
        case .chart4: return dark ? (0.6667, 0.8510, 0.8824, 1.0) : (0.1647, 0.5451, 0.6039, 1.0)
        case .chart5: return dark ? (0.8471, 0.9176, 0.9294, 1.0) : (0.2157, 0.6078, 0.6706, 1.0)
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
        case .bg: return "the window canvas behind everything — warm paper, not a cool grey"
        case .surface: return "rows, cards, composer, list backgrounds"
        case .elevated: return "menus, popovers, sheets, the command palette"
        case .sunken: return "code blocks, wells, inset scroll regions"
        case .border: return "separators between rows and around inputs"
        case .borderStrong: return "separator and rule: table rules, list dividers, the hairline under a toolbar. A separator is decorative under 1.4.11 and is not held to 3:1 — it sits at ~1.8:1 on every ground by design, because a rule that meets 3:1 reads as a border. Anything that BOUNDS A CONTROL uses border-control instead."
        case .borderControl: return "the outline of a discrete control where the outline is what identifies it: secondary and bordered buttons, unselected filter chips, segmented controls, the composer field, select menus, the new-rows pill. Held to 3:1 (WCAG 1.4.11) on every ground it can sit on, because the warm light palette separates bg, surface and sunken by under 1.2:1 — so in light mode the outline is the only thing distinguishing a control from the page, and it has to carry that alone."
        case .textPrimary: return "body copy, titles, values"
        case .textSecondary: return "metadata that must still be read: timestamps, counts, actor ids"
        case .textTertiary: return "placeholders and de-emphasised hints; never the only carrier of meaning, and never on a tinted fill — only on bg, surface or elevated"
        case .accent: return "the one interactive colour: links, selected tab, primary button fill. Pinned as the brand colour; controlAccentColor drives only the controls Apple draws itself"
        case .accentHover: return "hover and pressed state of an accent surface"
        case .accentQuiet: return "selection and emphasis ground: a selected row, your own turn in the transcript, the selection bar. LEGAL INK ON IT, and nothing else: text-primary, text-secondary, accent, agent as text; ok, degraded, failed and stale as a GLYPH only (they clear 3:1 and not 4.5:1). text-tertiary is illegal on it — 4.17:1 light, 4.06:1 dark — as is any state colour used as words. This list exists because the same pair has now failed twice: a selection ground re-inks everything inside it, so every role that can appear in a row has to be checked against it, not just the ones a designer happens to think of."
        case .onAccent: return "text and glyphs on an accent fill"
        case .agent: return "the agent-sourced tint — marks a string an agent wrote, as data"
        case .agentQuiet: return "agent-sourced background wash: quoted tool output, agent comment"
        case .entityPerson: return "ENTITY HUE — a person — an @mention resolving to a People/ page. Hue here says WHAT KIND OF THING a chip points at, never how urgent it is. Only ever ink on its own *-quiet fill; never a background, never a border, never text on bg/surface. Urgency is carried by weight and fill (priority) and by the state tokens (something is wrong) — three channels that must not be mixed."
        case .entityPersonQuiet: return "the chip fill behind entity-person. Sits in the same band as the other quiet fills (~1.17:1 on bg light, ~1.48:1 dark) so an entity chip never outweighs a state chip."
        case .entityNote: return "ENTITY HUE — a note, a page, a document link — anything in the vault. Hue here says WHAT KIND OF THING a chip points at, never how urgent it is. Only ever ink on its own *-quiet fill; never a background, never a border, never text on bg/surface. Urgency is carried by weight and fill (priority) and by the state tokens (something is wrong) — three channels that must not be mixed."
        case .entityNoteQuiet: return "the chip fill behind entity-note. Sits in the same band as the other quiet fills (~1.17:1 on bg light, ~1.48:1 dark) so an entity chip never outweighs a state chip."
        case .entityProject: return "ENTITY HUE — a project or an area. Hue here says WHAT KIND OF THING a chip points at, never how urgent it is. Only ever ink on its own *-quiet fill; never a background, never a border, never text on bg/surface. Urgency is carried by weight and fill (priority) and by the state tokens (something is wrong) — three channels that must not be mixed."
        case .entityProjectQuiet: return "the chip fill behind entity-project. Sits in the same band as the other quiet fills (~1.17:1 on bg light, ~1.48:1 dark) so an entity chip never outweighs a state chip."
        case .ok: return "check passed, run succeeded, thread resolved"
        case .okQuiet: return "the fill an ok chip is actually painted on — declared so the checker sees the ground that ships"
        case .degraded: return "answering but not healthy: stale collector, fallback tier, queued over cap"
        case .degradedQuiet: return "the fill a degraded chip is actually painted on — declared so the checker sees the ground that ships"
        case .failed: return "check failed, run errored"
        case .failedQuiet: return "the fill a failed chip is actually painted on — declared so the checker sees the ground that ships"
        case .absent: return "not configured — a fact, not a fault"
        case .absentQuiet: return "the fill an absent chip is actually painted on — declared so the checker sees the ground that ships"
        case .stale: return "was answering and has not lately: the reading on screen is the last one, and its age is on the row"
        case .staleQuiet: return "the fill a stale chip is actually painted on — declared so the checker sees the ground that ships"
        case .presenceWorking: return "live lease with recent evidence"
        case .presenceWorkingQuiet: return "the tinted fill behind a working presence chip"
        case .presenceQueued: return "claimed or waiting behind a cap"
        case .presenceQueuedQuiet: return "the tinted fill behind a queued presence chip"
        case .presenceIdle: return "registered, nothing claimed"
        case .presenceIdleQuiet: return "the tinted fill behind an idle presence chip"
        case .presenceInterrupted: return "lease expired mid-claim"
        case .presenceInterruptedQuiet: return "the tinted fill behind an interrupted presence chip"
        case .presenceOverCap: return "at max bundles / over budget"
        case .presenceOverCapQuiet: return "the tinted fill behind an over-cap presence chip"
        case .presenceBlocked: return "waiting on you or another agent"
        case .presenceBlockedQuiet: return "the tinted fill behind a blocked presence chip"
        case .destructive: return "the fill of a destructive control — Decline, Revoke, Rotate. A fill, not a foreground: failed is the foreground role"
        case .onDestructive: return "text and glyphs on a destructive fill"
        case .affirmative: return "the fill of the affirming action — Approve, Add, Connect. A fill, where `ok` is the foreground role for a state: a button that starts something is not a status report about it"
        case .onAffirmative: return "text and glyphs on an affirmative fill"
        case .chart1: return "sequential ramp step 1 of 5, one hue off the accent — for magnitude and for series that are ordered (the compute tiers are). Never for identity: six or more series become small multiples, never more hues, because the state and presence roles own every other hue in the product. A non-text graphic, held to WCAG 1.4.11's 3:1"
        case .chart2: return "sequential ramp step 2 of 5, one hue off the accent — for magnitude and for series that are ordered (the compute tiers are). Never for identity: six or more series become small multiples, never more hues, because the state and presence roles own every other hue in the product. A non-text graphic, held to WCAG 1.4.11's 3:1"
        case .chart3: return "sequential ramp step 3 of 5, one hue off the accent — for magnitude and for series that are ordered (the compute tiers are). Never for identity: six or more series become small multiples, never more hues, because the state and presence roles own every other hue in the product. A non-text graphic, held to WCAG 1.4.11's 3:1"
        case .focusRing: return "keyboard focus, 2px, never suppressed"
        case .scrim: return "behind a sheet"
        case .chart4: return "sequential ramp step 4 of 5, one hue off the accent — for magnitude and for series that are ordered (the compute tiers are). Never for identity: six or more series become small multiples, never more hues, because the state and presence roles own every other hue in the product. A non-text graphic, held to WCAG 1.4.11's 3:1"
        case .chart5: return "sequential ramp step 5 of 5, one hue off the accent — for magnitude and for series that are ordered (the compute tiers are). Never for identity: six or more series become small multiples, never more hues, because the state and presence roles own every other hue in the product. A non-text graphic, held to WCAG 1.4.11's 3:1"
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
