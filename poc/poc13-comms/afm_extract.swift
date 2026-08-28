import Foundation
import FoundationModels

@Generable
enum Category: String {
    case message
    case scheduling
    case logistics
    case commerce
    case social
    case other
}

@Generable
enum Urgency: String {
    case low
    case med
    case high
}

@Generable
struct Extraction {
    @Guide(description: "The single best category for this message.")
    let category: Category

    @Guide(description: "true ONLY if this message creates a concrete task the reader personally must do. Chit-chat, opinions, acknowledgements, jokes, statements of fact, and things already done are false.")
    let hasAction: Bool

    @Guide(description: "If has_action is true, a short imperative action phrase of at most 8 words, written generically. If has_action is false, the empty string.")
    let action: String

    @Guide(description: "The thing the action concerns: an object, place, appointment, order, or topic. At most 4 words. Empty string if none or if it would only be a person's name.")
    let entity: String

    @Guide(description: "Any time reference the message states, copied as a short phrase such as tomorrow, Friday, 3pm, next week. Empty string if the message states no time.")
    let dateRef: String

    @Guide(description: "How soon the action must happen: high only if today or explicitly urgent, med if within a few days, low otherwise.")
    let urgency: Urgency
}

let instructions = """
You extract action items from a person's own text messages for a private assistant \
that will show them a short daily list. The list must be trustworthy: a handful of \
accurate items is useful, a long list of guesses is worthless.

Choose exactly one category:
- message: ordinary conversation, no task
- scheduling: a meeting, appointment, or plan at a time
- logistics: errands, pickups, deliveries, chores, coordination
- commerce: purchases, orders, bills, payments, receipts
- social: invitations, greetings, personal chat with an ask
- other: anything else

Set has_action true ONLY when the message states a concrete, specific thing the \
reader must personally do, and it is not already completed. Be conservative.
Set has_action FALSE for: pleasantries and affection, reactions, opinions, \
questions that are just conversation, information the reader only needs to know, \
promotional or automated notifications, anything already finished, and anything \
where you would have to guess what the task is.
Never invent a task. If in doubt, has_action is false.
In action and entity, describe things generically. Do not copy sentences from the \
message, and do not include people's names, phone numbers, addresses, or codes.
"""

@main
struct AFMExtract {
    static func main() async {
        let args = CommandLine.arguments
        let fixturePath = args.count > 1 ? args[1] : "messages-200.tsv"
        let outPath = args.count > 2 ? args[2] : "stage2.jsonl"

        setvbuf(stdout, nil, _IOLBF, 0)
        print("=== PoC-13 AFM extractor (fresh session per item, greedy) ===")
        print("pid=\(getpid())")

        let model = SystemLanguageModel.default
        print("availability: \(model.availability)")
        guard model.isAvailable else { print("FATAL: model unavailable"); exit(2) }

        guard let raw = try? String(contentsOfFile: fixturePath, encoding: .utf8) else {
            print("FATAL: cannot read fixture at \(fixturePath)"); exit(3)
        }
        let lines = raw.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        print("items: \(lines.count)")

        var jsonl = ""
        var latencies: [Double] = []
        var errors = 0, actionCount = 0
        var catCounts: [String: Int] = [:]
        let t0 = Date()

        for (i, line) in lines.enumerated() {
            let parts = line.split(separator: "\t", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4 else { continue }
            let rowid = parts[0], fromMe = parts[1], conv = parts[2]
            var text = parts[3]
            if text.count > 900 { text = String(text.prefix(900)) }

            let ti = Date()
            let session = LanguageModelSession(instructions: instructions)
            var rec: [String: Any] = ["rowid": Int(rowid) ?? -1, "conv": conv, "is_from_me": Int(fromMe) ?? 0]
            do {
                let resp = try await session.respond(
                    to: "Message (sent by \(fromMe == "1" ? "the reader" : "someone else")):\n\(text)",
                    generating: Extraction.self,
                    options: GenerationOptions(sampling: .greedy)
                )
                let c = resp.content
                let dt = Date().timeIntervalSince(ti)
                latencies.append(dt)
                if c.hasAction { actionCount += 1 }
                catCounts[c.category.rawValue, default: 0] += 1
                rec["category"] = c.category.rawValue
                rec["has_action"] = c.hasAction
                rec["action"] = c.hasAction ? c.action : ""
                rec["entity"] = c.entity
                rec["date_ref"] = c.dateRef
                rec["urgency"] = c.urgency.rawValue
                rec["latency_s"] = (dt * 1000).rounded() / 1000
                print(String(format: "[%03d] %.2fs %-10@ action=%@ %@",
                             i + 1, dt, c.category.rawValue as NSString,
                             (c.hasAction ? "YES" : "no ") as NSString,
                             (c.hasAction ? c.action : "") as NSString))
            } catch {
                let dt = Date().timeIntervalSince(ti)
                latencies.append(dt); errors += 1
                rec["error"] = "\(error)".prefix(160).description
                print(String(format: "[%03d] %.2fs ERROR %@", i + 1, dt, "\(error)".prefix(120) as NSString))
            }
            if let d = try? JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) { jsonl += s + "\n" }
        }

        let total = Date().timeIntervalSince(t0)
        try? jsonl.write(toFile: outPath, atomically: true, encoding: .utf8)

        let sorted = latencies.sorted()
        print("---- SUMMARY ----")
        print(String(format: "total wall: %.2f s over %d items -> %.3f items/sec", total, lines.count, Double(lines.count) / total))
        print("errors: \(errors)  has_action=true: \(actionCount)")
        print("categories: \(catCounts.sorted { $0.key < $1.key })")
        if !sorted.isEmpty {
            print(String(format: "latency mean %.2fs median %.2fs min %.2fs max %.2fs",
                         latencies.reduce(0,+)/Double(latencies.count), sorted[sorted.count/2], sorted[0], sorted.last!))
            let rest = Array(latencies.dropFirst())
            if !rest.isEmpty {
                print(String(format: "steady-state (excl. first): %.3f items/sec", Double(rest.count) / rest.reduce(0,+)))
            }
        }
        print("DONE")
    }
}
