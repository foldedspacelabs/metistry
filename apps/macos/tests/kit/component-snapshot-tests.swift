// Snapshots of the shared components (T5-3): one per component, light and
// dark, and the largest text.
//
// WHY A TEXT BASELINE AND NOT A PNG. A pixel baseline recorded on one macOS
// fails on the next — CI builds on macos-15, a laptop on something newer, and
// the system font's metrics differ between them — so it would be re-recorded
// until nobody reads it. What a component DECIDES is deterministic: its words,
// their order, the type step and weight of each, the ink and the ground it is
// painted on (resolved to the hex each scheme ships), the point size at the
// largest text, and what VoiceOver says. That is the baseline: a component's
// presentation walked field by field and written to
// `tests/kit/snapshots/<component>.txt`, reviewable in a diff.
//
// The pixels are still drawn, and checked for what does not depend on the
// font: every sample renders in light and dark at the standard and the
// largest text, never wider than the column it was offered (§2.18.5 — grow
// longer, never wider), taller at the largest text than at the standard, and
// different in dark from light. Every ink is checked against the ground it
// actually sits on in both schemes (amendments §1.7), and every control has
// words for VoiceOver (§2.18.7).
//
// To re-record after a deliberate change:
//
//     METISTRY_RECORD_SNAPSHOTS=1 swift test --package-path apps/macos --filter Snapshot
//
// and read the diff before committing it.

import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The variants

enum SnapshotVariant: String, CaseIterable, Sendable {
    case light, dark
    case largest = "largest text"

    var scheme: ColorScheme { self == .dark ? .dark : .light }
    var size: DynamicTypeSize { self == .largest ? .accessibility5 : .large }
}

// MARK: - The dump

struct SnapshotDump {
    let variant: SnapshotVariant

    static func hex(_ role: MetistryColorRole, _ scheme: ColorScheme) -> String {
        let c = role.components(scheme)
        let v = [c.red, c.green, c.blue].map { String(format: "%02x", Int(($0 * 255).rounded())) }.joined()
        return c.opacity < 1 ? "#\(v)@\(String(format: "%.2f", c.opacity))" : "#\(v)"
    }

    func role(_ r: MetistryColorRole) -> String { "\(r.rawValue) \(Self.hex(r, variant.scheme))" }

    func type(_ style: MetistryTextStyle, _ design: TypeDesign, _ weight: TypeWeight?) -> String {
        let points = MetistryType.pointSize(style, variant.size)
        return "\(style.rawValue) \(Int(points))pt \(design.rawValue)\(weight.map { " \($0.rawValue)" } ?? "")"
    }

    func mark(_ m: Mark) -> String {
        var parts = ["mark \(m.shape.rawValue) \(quote(m.text))"]
        if let g = m.glyph { parts.append("glyph=\(g.rawValue)\(m.glyphAfter ? " after" : "")\(m.glyphInk.map { " " + role($0) } ?? "")") }
        parts.append(type(m.style, m.design, m.weight))
        parts.append("ink=\(role(m.ink))")
        if let plate = m.plate { parts.append("plate=\(role(plate))") }
        parts.append("on=\(role(m.on))")
        if let outline = m.outline { parts.append("outline=\(role(outline))") }
        if m.uppercase { parts.append("uppercase") }
        parts.append(String(format: "contrast=%.2f", Contrast.ratio(m.ink, m.ground, variant.scheme)))
        parts.append("says \(quote(m.voice))")
        return parts.joined(separator: " · ")
    }

    func control(_ c: ControlSpec) -> String {
        var parts = ["control \(c.role.rawValue) \(quote(c.label))"]
        if let g = c.glyph { parts.append("glyph=\(g.rawValue)") }
        if c.selected { parts.append("selected") }
        if let why = c.disabledBecause { parts.append("off: \(quote(why))") }
        parts.append("says \(quote(c.spoken))")
        return parts.joined(separator: " · ")
    }

    func quote(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n") + "\"" }

    /// A value, field by field, in declaration order — deterministic for the
    /// kit's own value types, which hold no dictionaries.
    func lines(_ value: Any, _ label: String? = nil, _ indent: Int = 0) -> [String] {
        let pad = String(repeating: "  ", count: indent)
        let head = label.map { "\(pad)\($0): " } ?? pad
        switch value {
        case let m as Mark: return [head + mark(m)]
        case let c as ControlSpec: return [head + control(c)]
        case let r as MetistryColorRole: return [head + role(r)]
        case let s as String: return [head + quote(s)]
        case let d as Date: return [head + ISO8601DateFormatter().string(from: d)]
        default: break
        }
        let mirror = Mirror(reflecting: value)
        switch mirror.displayStyle {
        case .optional:
            guard let wrapped = mirror.children.first else { return [head + "nil"] }
            return lines(wrapped.value, label, indent)
        case .collection, .set:
            if mirror.children.isEmpty { return [head + "[]"] }
            var out = [head + "[\(mirror.children.count)]"]
            let items = mirror.children.map { lines($0.value, "-", indent + 1) }
            out += (mirror.displayStyle == .set ? items.sorted { $0.joined() < $1.joined() } : items).flatMap { $0 }
            return out
        case .enum:
            guard let payload = mirror.children.first else { return [head + "\(value)"] }
            return [head + (payload.label ?? "\(value)")] + lines(payload.value, nil, indent + 1)
        case .struct, .class, .tuple:
            if mirror.children.isEmpty { return [head + "\(Swift.type(of: value))"] }
            return [head + "\(Swift.type(of: value))"] + mirror.children.flatMap { lines($0.value, $0.label, indent + 1) }
        default:
            return [head + "\(value)"]
        }
    }
}

/// Every `Mark` and `ControlSpec` inside a presentation.
func collect(_ value: Any) -> (marks: [Mark], controls: [ControlSpec]) {
    if let m = value as? Mark { return ([m], []) }
    if let c = value as? ControlSpec { return ([], [c]) }
    var marks: [Mark] = [], controls: [ControlSpec] = []
    for child in Mirror(reflecting: value).children {
        let found = collect(child.value)
        marks += found.marks
        controls += found.controls
    }
    return (marks, controls)
}

// MARK: - The baselines

private let snapshotDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("snapshots")

private func baseline(for component: String, _ samples: [ComponentSample]) -> String {
    var out = ["# \(component) — generated by component-snapshot-tests.swift; re-record with METISTRY_RECORD_SNAPSHOTS=1", ""]
    for variant in SnapshotVariant.allCases {
        out.append("## \(variant.rawValue)")
        for sample in samples {
            out.append("")
            out.append("### \(sample.name) (on \(SnapshotDump(variant: variant).role(sample.ground)))")
            out += SnapshotDump(variant: variant).lines(sample.presentation)
        }
        out.append("")
    }
    return out.joined(separator: "\n")
}

@Test func everyComponentMatchesItsSnapshotInLightDarkAndTheLargestText() async throws {
    let samples = try await componentSamples()
    let byComponent = Dictionary(grouping: samples, by: \.component)
    let record = ProcessInfo.processInfo.environment["METISTRY_RECORD_SNAPSHOTS"] == "1"
    let expected = Set(byComponent.keys.map { "\($0).txt" })
    for (component, group) in byComponent.sorted(by: { $0.key < $1.key }) {
        let file = snapshotDirectory.appendingPathComponent("\(component).txt")
        let actual = baseline(for: component, group)
        if record {
            try FileManager.default.createDirectory(at: snapshotDirectory, withIntermediateDirectories: true)
            try actual.write(to: file, atomically: true, encoding: .utf8)
            continue
        }
        guard let committed = try? String(contentsOf: file, encoding: .utf8) else {
            Issue.record("no snapshot for \(component) — record one with METISTRY_RECORD_SNAPSHOTS=1 and review it")
            continue
        }
        if committed != actual {
            let a = committed.components(separatedBy: "\n"), b = actual.components(separatedBy: "\n")
            let first = zip(a, b).enumerated().first { $0.element.0 != $0.element.1 }
            let line = first?.offset ?? min(a.count, b.count)
            Issue.record("\(component).txt differs at line \(line + 1):\n  committed: \(line < a.count ? a[line] : "<end>")\n  now:       \(line < b.count ? b[line] : "<end>")")
        }
    }
    // A snapshot whose component is gone is a snapshot nobody checks.
    let onDisk = Set((try? FileManager.default.contentsOfDirectory(atPath: snapshotDirectory.path)) ?? []).filter { $0.hasSuffix(".txt") }
    #expect(onDisk == expected || record, "snapshots without a component, or components without one: \(onDisk.symmetricDifference(expected).sorted())")
}

// MARK: - Drawn: light, dark, the largest text

/// The width a component is offered: a detail column.
private let column: CGFloat = 480

private struct Framed: View {
    let content: AnyView
    let ground: MetistryColorRole
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content.padding(MetistrySpace.s4).background(Palette(scheme)[ground])
    }
}

@MainActor
private func render(_ sample: ComponentSample, _ variant: SnapshotVariant) -> CGImage? {
    guard let view = sample.view else { return nil }
    let renderer = ImageRenderer(content: Framed(content: view(), ground: sample.ground)
        .environment(\.colorScheme, variant.scheme)
        .environment(\.dynamicTypeSize, variant.size))
    renderer.proposedSize = ProposedViewSize(width: column, height: nil)
    renderer.scale = 1
    return renderer.cgImage
}

private func bytes(_ image: CGImage) -> Data {
    let data = image.dataProvider?.data.map { $0 as Data } ?? Data()
    return data
}

@MainActor
@Test func everyComponentRendersInLightAndDarkAndGrowsLongerNeverWiderAtTheLargestText() async throws {
    let samples = try await componentSamples()
    #expect(samples.count >= 20)
    var drawn: [String: [SnapshotVariant: CGImage]] = [:]
    for sample in samples where sample.view != nil {
        let id = "\(sample.component) / \(sample.name)"
        for variant in SnapshotVariant.allCases {
            guard let image = render(sample, variant) else {
                Issue.record("\(id) did not render in \(variant.rawValue)")
                continue
            }
            drawn[id, default: [:]][variant] = image
            // Never wider than the column it was offered — at any text size.
            #expect(CGFloat(image.width) <= column, "\(id) is \(image.width)pt wide in \(variant.rawValue), offered \(Int(column))")
        }
        guard let light = drawn[id]?[.light], let dark = drawn[id]?[.dark], let largest = drawn[id]?[.largest] else { continue }
        #expect(bytes(light) != bytes(dark), "\(id) draws the same in dark as in light — the scheme is not reaching it")
        #expect(largest.height > light.height, "\(id) did not grow at the largest text (\(light.height) → \(largest.height))")
    }
    if let dir = ProcessInfo.processInfo.environment["METISTRY_SNAPSHOT_PNG_DIR"] {
        // For a human to look at: every drawing, as a PNG. Nothing reads them back.
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for (id, variants) in drawn {
            for (variant, image) in variants {
                let name = "\(id)-\(variant.rawValue)".replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: " ", with: "_")
                let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
                if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
                    CGImageDestinationAddImage(dest, image, nil)
                    CGImageDestinationFinalize(dest)
                }
            }
        }
    }
}

// MARK: - The ground actually painted, and the words VoiceOver says

@Test func everyInkClearsItsGroundInBothSchemes() async throws {
    for sample in try await componentSamples() {
        for mark in collect(sample.presentation).marks {
            for scheme in [ColorScheme.light, .dark] {
                let words = !mark.text.isEmpty
                // Words 4.5:1; a mark that is only a glyph 3:1 (WCAG 1.4.11).
                let floor = words ? 4.5 : 3.0
                let ratio = Contrast.ratio(mark.ink, mark.ground, scheme)
                #expect(ratio >= floor, "\(sample.component) / \(sample.name): \(mark.ink.rawValue) on \(mark.ground.rawValue) is \(String(format: "%.2f", ratio)):1 in \(scheme) — \(mark.text)")
                if let glyphInk = mark.glyphInk, mark.glyph != nil {
                    let g = Contrast.ratio(glyphInk, mark.ground, scheme)
                    #expect(g >= 3, "\(sample.component) / \(sample.name): glyph \(glyphInk.rawValue) on \(mark.ground.rawValue) is \(String(format: "%.2f", g)):1 in \(scheme)")
                }
                if let outline = mark.outline {
                    let o = Contrast.ratio(outline, mark.on, scheme)
                    #expect(o >= 3, "\(sample.component) / \(sample.name): outline \(outline.rawValue) on \(mark.on.rawValue) is \(String(format: "%.2f", o)):1 in \(scheme)")
                }
                // `text-tertiary` is never on a tinted fill (its token's own rule).
                if mark.ink == .textTertiary {
                    #expect([.bg, .surface, .elevated].contains(mark.ground), "\(sample.component) / \(sample.name): text-tertiary on \(mark.ground.rawValue)")
                }
            }
        }
    }
}

@Test func everyControlAndEveryMarkSaysSomethingToVoiceOver() async throws {
    for sample in try await componentSamples() {
        let found = collect(sample.presentation)
        for control in found.controls {
            #expect(!control.spoken.isEmpty, "\(sample.component) / \(sample.name): a control with nothing to say")
            if control.label.isEmpty {
                // A glyph-only control speaks its NAME, not the symbol's.
                #expect(control.name != nil, "\(sample.component) / \(sample.name): glyph-only control \(control.glyph?.rawValue ?? "?") has no name")
            }
        }
        for mark in found.marks where mark.text != "·" {
            #expect(!mark.voice.isEmpty, "\(sample.component) / \(sample.name): a mark with nothing to say — \(mark.glyph?.rawValue ?? mark.text)")
        }
    }
}
