// The helper's socket protocol: one JSON object per line in, one per line
// out, the same shape as ek-helper and afm-helper.
//
//   {"id":1,"op":"check"}          grants, the transcriber, whether recording
//   {"id":2,"op":"status"}         the session read-back (no transcript text)
//   {"id":3,"op":"start","apps":["us.zoom.xos"],"app_audio":true,"microphone":true}
//   {"id":4,"op":"stop"}
//   {"id":5,"op":"keep_going"}     answers the two-hour reminder
//
// and three the bridge's own delivery loop sends, never a caller of the
// bridge (src/delivery.ts — no route reaches them):
//
//   {"id":6,"op":"owed"}                                   ended sessions not yet delivered
//   {"id":7,"op":"transcript","session_id":"…"}            one ended session's record and lines
//   {"id":8,"op":"delivered","session_id":"…","inbox_id":42}   POST /capture took it
//
// The socket is owner-only (0600) and its one client is the bridge, which
// admits `start`, `stop` and `keep_going` only on the control credential the
// owner's bar holds (src/index.ts). Every refusal is `ok: false` with a
// `code` the bridge maps onto core's error envelope and the owner's words in
// `error`.

import Foundation

/// A TCC grant's state as the helper can know it. Permission APIs are read
/// where macOS has one; where it has none, the state is what was observed.
public protocol GrantProbe {
    /// `microphone`, `audio_capture`, `screen_recording` → a state word.
    func grants(lastAppAudioObserved: Bool?) -> [String: String]
}

public struct TranscriberStatus: Equatable {
    /// `SpeechTranscriber` (macOS 26, on the Mac).
    public let engine: String
    public let available: Bool
    /// `installed`, `supported` (downloads on first use), `downloading`, `unsupported`, `unknown`.
    public let assets: String
    public let locale: String?
    /// Why it is not available, in the owner's words.
    public let reason: String?

    public init(engine: String, available: Bool, assets: String, locale: String?, reason: String?) {
        self.engine = engine
        self.available = available
        self.assets = assets
        self.locale = locale
        self.reason = reason
    }
}

public protocol TranscriberProbe {
    func status() -> TranscriberStatus
}

public final class HelperService {
    private let recorder: Recorder
    private let grants: GrantProbe
    private let transcriber: TranscriberProbe
    private let osVersion: String

    public init(recorder: Recorder, grants: GrantProbe, transcriber: TranscriberProbe, osVersion: String) {
        self.recorder = recorder
        self.grants = grants
        self.transcriber = transcriber
        self.osVersion = osVersion
    }

    /// One request line → one response line (without the newline).
    public func handle(_ line: String) -> String {
        encodeLine(respond(line))
    }

    func respond(_ line: String) -> [String: Any] {
        guard let data = line.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = req["op"] as? String
        else { return ["id": -1, "ok": false, "code": "invalid_request", "error": "bad request line"] }
        let id = (req["id"] as? Int) ?? -1

        switch op {
        case "check":
            let t = transcriber.status()
            return [
                "id": id, "ok": true,
                "probe": "read the microphone and screen grant state, the audio-capture grant as last observed, and SpeechTranscriber's availability and assets",
                "grants": grants.grants(lastAppAudioObserved: recorder.lastAppAudioObserved()),
                "transcriber": transcriberJSON(t),
                "recording": recorder.isRecording,
                "os": osVersion,
            ]

        case "status":
            return ["id": id, "ok": true].merging(statusJSON(recorder.status())) { a, _ in a }

        case "start":
            guard let apps = req["apps"] as? [String] else { return refusal(id, "invalid_request", "apps must be a list of bundle identifiers") }
            for key in ["app_audio", "microphone"] where req[key] != nil && !(req[key] is Bool) {
                return refusal(id, "invalid_request", "\(key) must be true or false")
            }
            do {
                let r = try recorder.start(StartRequest(apps: apps, appAudio: (req["app_audio"] as? Bool) ?? true, microphone: (req["microphone"] as? Bool) ?? true))
                return ["id": id, "ok": true, "session": recordJSON(r), "transcriber": transcriberJSON(transcriber.status())]
            } catch let e as RecorderError {
                return refusal(id, e.code, e.message)
            } catch {
                return refusal(id, "stream_failed", "\(error)")
            }

        case "stop":
            let r = recorder.stop(.owner)
            return ["id": id, "ok": true, "session": r.map(recordJSON) ?? NSNull()]

        case "keep_going":
            return ["id": id, "ok": true, "answered": recorder.keepGoing()]

        case "owed":
            return ["id": id, "ok": true, "sessions": recorder.owed().map(recordJSON)]

        case "transcript":
            guard let sessionID = req["session_id"] as? String else { return refusal(id, "invalid_request", "session_id is required") }
            do {
                let (record, lines) = try recorder.transcript(of: sessionID)
                return ["id": id, "ok": true, "session": recordJSON(record), "lines": lines]
            } catch let e as DeliveryError {
                return refusal(id, e.code, e.message)
            } catch {
                return refusal(id, "invalid_request", "\(error)")
            }

        case "delivered":
            guard let sessionID = req["session_id"] as? String else { return refusal(id, "invalid_request", "session_id is required") }
            guard let inboxID = req["inbox_id"] as? Int else { return refusal(id, "invalid_request", "inbox_id is the console's row id") }
            do {
                return ["id": id, "ok": true, "session": recordJSON(try recorder.markDelivered(sessionID, inboxID: inboxID))]
            } catch let e as DeliveryError {
                return refusal(id, e.code, e.message)
            } catch {
                return refusal(id, "invalid_request", "\(error)")
            }

        default:
            return refusal(id, "invalid_request", "unknown op \(op)")
        }
    }

    private func refusal(_ id: Int, _ code: String, _ message: String) -> [String: Any] {
        ["id": id, "ok": false, "code": code, "error": message]
    }
}

public func transcriberJSON(_ t: TranscriberStatus) -> [String: Any] {
    var o: [String: Any] = ["engine": t.engine, "available": t.available, "assets": t.assets, "locale": t.locale ?? NSNull()]
    if let r = t.reason { o["reason"] = r }
    return o
}

public func recordJSON(_ r: SessionRecord) -> [String: Any] {
    guard let data = try? sessionEncoder().encode(r),
          let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return [:] }
    return o
}

public func statusJSON(_ s: RecorderStatus) -> [String: Any] {
    let iso = ISO8601DateFormatter()
    return [
        "state": s.state,
        "session": s.session.map(recordJSON) ?? NSNull(),
        "elapsed_s": s.elapsedS ?? NSNull(),
        "stops_at": s.stopsAt.map { iso.string(from: $0) } ?? NSNull(),
        "reminder_due_hours": s.reminderDueHours ?? NSNull(),
        "disk_low_free_bytes": s.diskLowFreeBytes ?? NSNull(),
    ]
}

public func encodeLine(_ o: [String: Any]) -> String {
    (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{\"ok\":false}"
}
