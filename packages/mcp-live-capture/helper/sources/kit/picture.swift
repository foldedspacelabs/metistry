// The ONE path that decides what a recording may SEE (plan §2.15, C76;
// screen 11 §5–§6; research 2026-09-21 §2.2). *Window* and *Screen* are an
// `SCStream` whose content filter is the one the system picker
// (`SCContentSharingPicker`) built from the owner's click — and nothing else.
//
// Why this file has to exist at all: the Screen Recording grant is global to
// the binary. A process holding it can enumerate every window and build any
// filter it likes; nothing in macOS ties it to the picker's answer. So the
// picker makes the scope visible and user-chosen, and what makes it
// ENFORCED is that this helper has no second way to get a filter:
//
//   * No request names content. A start for `window` or `screen` carries the
//     mode and two switches; a window id, a display id, a bundle id or an app
//     list in it is refused before the picker is asked (wire.swift). The
//     only thing that can choose is the owner, in the system's own sheet.
//   * The helper never constructs a filter. The adapter
//     (sources/helper/screen.swift) holds the `SCContentFilter` object the
//     picker's observer received, under a handle; `PickedContent` is that
//     handle plus what the kit may read about it, and `openPicture` opens a
//     stream from the handle's filter only. The helper's sources contain no
//     `SCContentFilter(` initialiser and no `SCShareableContent` enumeration
//     — test/helper-kit.test.ts reads them to hold that.
//   * A cancelled picker is no choice: refused, never read as "everything".
//     A pick of the wrong kind (a display for Window, an application for
//     either) is refused, never adapted. The helper's own content is never a
//     pick.
//   * A pick is per session and never re-asked behind the owner's back: a
//     wake reopens the SAME filter, or ends the session — it does not present
//     the picker again, and it never widens.
//
// *Screen* is a whole display, by the owner's choice in the picker — the one
// mode that sees more than one app, which is why it is its own act on the
// record sheet and never a fallback of *Window*.

import Foundation

/// What a recording takes (the record sheet's segmented control).
public enum CaptureMode: String, Codable, Equatable, CaseIterable {
    /// A Core Audio process tap over named apps — no picture (scope.swift).
    case audioOnly = "audio_only"
    /// One window, chosen in the system picker, with its app's sound.
    case window
    /// One display, chosen in the system picker, with the system's sound.
    case screen

    /// True for the modes that take a picture.
    public var takesPicture: Bool { self != .audioOnly }
}

/// The picker's answer as the kit may read it. The filter itself stays in the
/// adapter under `handle`: the kit never sees, builds or edits one.
public struct PickedContent: Equatable {
    public enum Kind: String, Codable, Equatable {
        case window, display, application, unknown
    }

    /// The adapter's key for the `SCContentFilter` the picker handed over.
    public let handle: Int
    public let kind: Kind
    /// The picked window's app, when macOS says (15.2+); nil otherwise.
    public let bundleID: String?

    public init(handle: Int, kind: Kind, bundleID: String?) {
        self.handle = handle
        self.kind = kind
        self.bundleID = bundleID
    }
}

public enum PictureError: Error, Equatable {
    /// The owner closed the picker without choosing. Never read as "everything".
    case nothingChosen
    /// The picker answered with something other than the act the owner started.
    case wrongKind(expected: PickedContent.Kind, got: PickedContent.Kind)
    /// The pick is the helper's own content.
    case ownContent
    /// A picture was asked for in a mode that has none.
    case notAPictureMode

    public var message: String {
        switch self {
        case .nothingChosen: return "nothing was chosen in the picker — a recording never sees everything"
        case .wrongKind(let expected, let got): return "the picker chose a \(got.rawValue), and this recording takes one \(expected.rawValue)"
        case .ownContent: return "the recorder cannot record itself"
        case .notAPictureMode: return "audio only takes no picture"
        }
    }
}

/// What the stream is opened from: the picker's handle and the two switches.
public struct PicturePlan: Equatable {
    public let mode: CaptureMode
    public let picked: PickedContent
    /// `SCStreamConfiguration.capturesAudio` — the picked content's sound,
    /// scoped by the same filter as the picture.
    public let appAudio: Bool
    /// `captureMicrophone` on the same stream (macOS 15). False with the
    /// microphone on means a second session carries it (below macOS 15).
    public let microphoneInStream: Bool
}

/// The kind a mode's picker must answer with.
public func expectedKind(_ mode: CaptureMode) throws -> PickedContent.Kind {
    switch mode {
    case .window: return .window
    case .screen: return .display
    case .audioOnly: throw PictureError.notAPictureMode
    }
}

/// Turn the picker's answer into the stream's plan. The only function in the
/// helper that decides what a recording sees: nil (cancelled) is refused, a
/// pick of the wrong kind is refused, the helper's own window is refused, and
/// the plan carries the picker's handle unchanged.
public func planPicture(mode: CaptureMode, picked: PickedContent?, appAudio: Bool, microphone: Bool, streamMicrophone: Bool, ownBundleID: String) throws -> PicturePlan {
    let expected = try expectedKind(mode)
    guard let picked else { throw PictureError.nothingChosen }
    guard picked.kind == expected else { throw PictureError.wrongKind(expected: expected, got: picked.kind) }
    if let app = picked.bundleID, belongs(app, to: ownBundleID) { throw PictureError.ownContent }
    return PicturePlan(mode: mode, picked: picked, appAudio: appAudio, microphoneInStream: microphone && streamMicrophone)
}

/// What the record keeps of a pick: its kind and its app — never a window
/// title, never a frame. `status` is a tool's read, and a title is content.
public struct PictureRecord: Codable, Equatable {
    public let kind: PickedContent.Kind
    public let bundleID: String?

    public init(kind: PickedContent.Kind, bundleID: String?) {
        self.kind = kind
        self.bundleID = bundleID
    }

    enum CodingKeys: String, CodingKey { case kind, bundleID = "bundle_id" }
}

/// A running picture stream. Besides the frames it may carry the picked
/// content's sound and (macOS 15) the microphone, each transcribed as it
/// arrives and handed to `onSegment` with its source.
public protocol PictureStream: CaptureStream {
    /// True once any frame has been written.
    var observedFrames: Bool { get }
    /// False once the stream has stopped — by `stop`, or by the system (the
    /// window closed, the grant was withdrawn). The display sense reads this.
    var isRunning: Bool { get }
}

/// What the recorder needs from ScreenCaptureKit.
public protocol PictureBackend: AnyObject {
    /// `SCStreamConfiguration.captureMicrophone` (macOS 15).
    var streamMicrophoneAvailable: Bool { get }
    /// Present the system picker for one window (`.window`) or one display
    /// (`.screen`), with the helper's own bundle excluded, and wait for the
    /// owner's choice. nil when the owner cancelled.
    func pick(_ mode: CaptureMode, excludingBundleID: String) throws -> PickedContent?
    /// Open the stream from the filter the picker handed over under
    /// `plan.picked.handle` — and from nothing else.
    func openPicture(plan: PicturePlan, directory: URL, onSegment: @escaping (AudioSource, Double, Double, String) -> Void) throws -> PictureStream
    /// The session is over: the adapter lets go of the picker's filter.
    func release(_ handle: Int)
}

/// `<base>.<ext>`, or `<base>-2.<ext>`, `-3`… — the first name not yet in
/// `directory`. A stream reopened after a sleep writes a new file beside the
/// first; it never truncates what was already recorded.
public func nextMediaURL(in directory: URL, base: String, ext: String, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
    var n = 1
    while true {
        let url = directory.appendingPathComponent(n == 1 ? "\(base).\(ext)" : "\(base)-\(n).\(ext)")
        if !exists(url) { return url }
        n += 1
    }
}
