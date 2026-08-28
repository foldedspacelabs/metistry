// PoC-15: Apple Foundation Models as a complexity-TIER scorer for the router.
// Recipe inherited from PoC-3 / PoC-14: fresh LanguageModelSession per item,
// GenerationOptions(sampling: .greedy), explicit Refusal handling as FAIL-OPEN.
//
// Fail-open for a tier scorer means: emit the configured default tier ("standard"),
// never crash, never silently drop the turn.

import Foundation
import FoundationModels

@Generable
enum Tier: String {
    case cheap
    case standard
    case deep
}

@Generable
struct TierVerdict {
    @Guide(description: "The complexity tier required to answer this message well.")
    let tier: Tier

    @Guide(description: "One short sentence, at most 20 words, saying why that tier.")
    let reason: String
}

let instructions = """
You are a router for a personal assistant. You do NOT answer the user's message. \
You only decide how much model capability is needed to answer it well.

Choose exactly one tier:
- cheap: a conversational reply, an acknowledgment, a simple lookup, or a single \
straightforward action. A small model handles it fine.
- standard: routine multi-step work that needs competence but not depth. Drafting, \
summarizing, triaging, scheduling around constraints, reorganizing notes.
- deep: genuine reasoning or real stakes. Multi-constraint planning, consequential \
decisions, money, health, legal, career, family, or hard analysis where a wrong \
answer costs the user something.

Rules that matter more than they look:
- Judge the ASK, not the amount of text. A long rambling message whose actual \
request is "add this to my calendar" is cheap. Venting, backstory, and thinking \
out loud are not the request.
- A very short message can be deep. "should i sell the house" is twelve words \
shorter than a packing list and far more consequential.
- If the user has already resolved a dilemma themselves and is only asking for a \
small action, that is cheap.
- When genuinely torn between two tiers, choose the higher one. Under-serving a \
high-stakes question is worse than spending too much on a trivial one.
"""

// v2: written AFTER seeing run A collapse the `cheap` class to zero.
// Changes: states the expected prior explicitly, gives concrete anchors for each
// tier, and drops the "when torn, choose higher" nudge that plausibly caused the
// collapse upward. Everything else identical.
let instructionsV2 = """
You are a router for a personal assistant. You do NOT answer the user's message. \
You only decide how much model capability is needed to answer it well.

Choose exactly one tier:

cheap - the assistant just has to say something back, look one thing up, or do \
one small action. Examples: "thanks, that works". "add milk to the list". \
"whats on my calendar friday". "remind me at 5". "yeah go ahead". \
"whats the wifi password". Most everyday messages to a personal assistant land here.

standard - real multi-step work, but nothing is at stake and no hard judgment is \
needed. Examples: "draft a reply to the landlord". "summarize the kitchen project \
this month". "plan tomorrow around my 3 meetings". "make the grocery list from our \
meal plan".

deep - the answer actually matters. Consequential decisions, money, health, legal, \
career, family, or analysis where being wrong costs the user something. Examples: \
"should i sell the house". "review this contract clause for risks". "help me think \
through the job offer".

How to judge:
- Judge the ASK, not the amount of text. Strip out venting, backstory, and thinking \
out loud. What is the user actually asking you to DO? A 500-word message that ends \
in "add plumber thursday to my calendar" is cheap.
- A twelve-character message can be deep. "quit or stay" is short and enormous.
- If the user already worked out their dilemma themselves and is only asking for a \
small action, that is cheap.
- Do not inflate a tier because the message sounds emotional or the topic is \
serious. Inflate only if answering the actual ask requires real reasoning.
"""

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

@main
struct AFMTier {
    static func main() async {
        let args = CommandLine.arguments
        let fixturePath = args.count > 1 ? args[1] : "fixtures.json"
        let outPath = args.count > 2 ? args[2] : "afm-run-A.jsonl"
        let runLabel = args.count > 3 ? args[3] : "A"
        let promptVer = args.count > 4 ? args[4] : "v1"
        let sys = (promptVer == "v2") ? instructionsV2 : instructions

        setvbuf(stdout, nil, _IOLBF, 0)
        print("=== PoC-15 AFM complexity-tier scorer (fresh session per item, greedy) ===")
        print("pid=\(getpid()) run=\(runLabel) prompt=\(promptVer)")

        let model = SystemLanguageModel.default
        print("availability: \(model.availability)")
        guard model.isAvailable else { print("FATAL: model unavailable"); exit(2) }

        guard let data = FileManager.default.contents(atPath: fixturePath),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fixtures = root["fixtures"] as? [[String: Any]] else {
            print("FATAL: cannot read/parse fixtures at \(fixturePath)"); exit(3)
        }
        print("items: \(fixtures.count)")

        var jsonl = ""
        var latencies: [Double] = []
        var refusals = 0, errors = 0
        let t0 = Date()

        for (i, fx) in fixtures.enumerated() {
            let id = fx["id"] as? String ?? "?"
            let text = fx["text"] as? String ?? ""
            if text.isEmpty { continue }

            var rec: [String: Any] = ["id": id, "run": runLabel, "prompt": promptVer, "input": text]
            let ti = nowMs()
            let session = LanguageModelSession(instructions: sys)
            do {
                let resp = try await session.respond(
                    to: "Message from the user:\n\(text)",
                    generating: TierVerdict.self,
                    options: GenerationOptions(sampling: .greedy)
                )
                let dt = nowMs() - ti
                latencies.append(dt)
                let v = resp.content
                rec["latency_ms"] = (dt * 100).rounded() / 100
                rec["tier"] = v.tier.rawValue
                rec["reason"] = v.reason
                rec["outcome"] = "ok"
                print(String(format: "[%02d] %-4@ %6.0fms %-8@ | %@",
                             i + 1, id as NSString, dt,
                             v.tier.rawValue as NSString, v.reason as NSString))
            } catch let err as LanguageModelSession.GenerationError {
                let dt = nowMs() - ti
                latencies.append(dt)
                rec["latency_ms"] = (dt * 100).rounded() / 100
                var isRefusal = false
                if case .refusal = err { isRefusal = true }
                if isRefusal {
                    refusals += 1
                    rec["outcome"] = "refusal"
                    rec["tier"] = "standard"   // FAIL-OPEN: configured default tier
                    rec["reason"] = "(refusal - fail-open to default tier)"
                    print(String(format: "[%02d] %-4@ %6.0fms REFUSAL -> fail-open to standard", i + 1, id as NSString, dt))
                } else {
                    errors += 1
                    rec["outcome"] = "error"
                    rec["tier"] = "standard"   // FAIL-OPEN
                    rec["reason"] = "(generation error - fail-open to default tier)"
                    rec["error"] = "\(err)".prefix(200).description
                    print(String(format: "[%02d] %-4@ %6.0fms GENERATION-ERROR %@", i + 1, id as NSString, dt, "\(err)".prefix(140) as NSString))
                }
            } catch {
                let dt = nowMs() - ti
                latencies.append(dt); errors += 1
                rec["latency_ms"] = (dt * 100).rounded() / 100
                rec["outcome"] = "error"
                rec["tier"] = "standard"
                rec["reason"] = "(error - fail-open to default tier)"
                rec["error"] = "\(error)".prefix(200).description
                print(String(format: "[%02d] %-4@ %6.0fms ERROR %@", i + 1, id as NSString, dt, "\(error)".prefix(140) as NSString))
            }

            if let d = try? JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys]),
               let s = String(data: d, encoding: .utf8) { jsonl += s + "\n" }
        }

        let total = Date().timeIntervalSince(t0)
        try? jsonl.write(toFile: outPath, atomically: true, encoding: .utf8)

        let sorted = latencies.sorted()
        print("---- SUMMARY (\(runLabel)) ----")
        print(String(format: "total wall: %.2f s over %d items", total, fixtures.count))
        print("refusals: \(refusals)  errors: \(errors)")
        if !sorted.isEmpty {
            func pct(_ p: Double) -> Double { sorted[min(sorted.count - 1, Int((p / 100.0) * Double(sorted.count)))] }
            print(String(format: "latency ms: mean %.0f  p50 %.0f  p90 %.0f  p95 %.0f  min %.0f  max %.0f  first %.0f",
                         latencies.reduce(0,+)/Double(latencies.count), pct(50), pct(90), pct(95),
                         sorted[0], sorted.last!, latencies[0]))
        }
        print("wrote \(outPath)")
        print("DONE")
    }
}
