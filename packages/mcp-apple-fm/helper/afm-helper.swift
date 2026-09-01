// afm-helper — the FoundationModels-touching half of the apple-fm bridge
// (Swift-only framework; PoC-3). JSON-lines protocol on stdio:
//   in:  {"id":1,"text":"..."}          out: {"id":1,"ok":true,"classification":{...}}
//   in:  {"id":2,"op":"check"}          out: {"id":2,"ok":true,"probe":"classified canned item","category":"todo"}
// One resident process amortizes model load; a FRESH LanguageModelSession
// per item (PoC-3: byte-identical, avoids context bleed). No TCC required.

import Foundation
import FoundationModels

@Generable
enum Category: String {
    case todo, event, idea, link, note
}

@Generable
struct Classification {
    @Guide(description: "The single best category for this inbox item.")
    let category: Category
    @Guide(description: "true ONLY if the item states a concrete task the user personally must do. Pure information, musings, and links with no stated intent are false.")
    let hasAction: Bool
    @Guide(description: "If hasAction is true, a short imperative action phrase of at most 8 words. If hasAction is false, the empty string.")
    let action: String
}

let instructions = """
You classify short personal-inbox capture items for a productivity assistant.
Choose exactly one category: todo (user must do), event (dated calendar item),
idea (thought or speculation), link (primarily a URL), note (fact, nothing to do).
Set hasAction true ONLY for a concrete task the user must personally perform.
Be conservative: precision matters more than recall. Do not invent tasks.
"""

struct Request: Decodable {
    let id: Int
    let text: String?
    let op: String?
}

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

@main
struct AFMHelper {
    static func classify(_ text: String) async throws -> Classification {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(to: text, generating: Classification.self)
        return response.content
    }

    static func main() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        let model = SystemLanguageModel.default
        guard model.isAvailable else {
            emit(["id": 0, "ok": false, "error": "FoundationModels unavailable: \(model.availability)"])
            exit(2)
        }
        emit(["id": 0, "ok": true, "ready": true])

        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let req = try? JSONDecoder().decode(Request.self, from: data) else {
                emit(["id": -1, "ok": false, "error": "bad request line"])
                continue
            }
            do {
                if req.op == "check" {
                    // behavioral probe: run the REAL privileged path (hard req 3)
                    let c = try await classify("buy milk tomorrow")
                    emit(["id": req.id, "ok": true, "probe": "classified canned item end-to-end", "category": c.category.rawValue])
                } else if let text = req.text {
                    let c = try await classify(text)
                    emit(["id": req.id, "ok": true, "classification": [
                        "category": c.category.rawValue,
                        "has_action": c.hasAction,
                        "action": c.action,
                    ] as [String: Any]])
                } else {
                    emit(["id": req.id, "ok": false, "error": "no text"])
                }
            } catch {
                emit(["id": req.id, "ok": false, "error": "\(error)"])
            }
        }
    }
}
