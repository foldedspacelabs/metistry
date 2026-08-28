import Foundation
import FoundationModels

@Generable
enum Category: String {
    case todo
    case event
    case idea
    case link
    case note
}

@Generable
struct Classification {
    @Guide(description: "The single best category for this inbox item.")
    let category: Category

    @Guide(description: "true ONLY if the item states a concrete task the user personally must do. Pure information, reminders of facts, musings, and links with no stated intent are false.")
    let hasAction: Bool

    @Guide(description: "If hasAction is true, a short imperative action phrase of at most 8 words. If hasAction is false, the empty string.")
    let action: String
}

let instructions = """
You classify short personal-inbox capture items for a productivity assistant.

For each item choose exactly one category:
- todo: something the user needs to do
- event: a meeting, appointment, or dated calendar item
- idea: a thought, proposal, or speculation
- link: the item is primarily a URL
- note: a fact to remember, with nothing to do

Set has_action true ONLY when there is a concrete task the user must personally perform.
Be conservative: precision matters more than recall. If in doubt, set has_action false.
Do not invent tasks that the item does not state.
"""

@main
struct AFMClassify {
    static func main() async {
        let args = CommandLine.arguments
        let fixturePath = args.count > 1 ? args[1] : "inbox-50.txt"
        // mode: "fresh" = new LanguageModelSession per item, "reuse" = one session for all
        let mode = args.count > 2 ? args[2] : "fresh"

        setvbuf(stdout, nil, _IOLBF, 0)

        let host = ProcessInfo.processInfo.hostName
        print("=== AFM classifier ===")
        print("pid=\(getpid()) mode=\(mode) host=\(host)")
        print("SESSION_TYPE env: \(ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] ?? "<none>")")
        print("TERM: \(ProcessInfo.processInfo.environment["TERM"] ?? "<none>")")

        let model = SystemLanguageModel.default
        print("availability: \(model.availability)  isAvailable: \(model.isAvailable)")
        guard model.isAvailable else {
            print("FATAL: model unavailable, aborting")
            exit(2)
        }

        guard let raw = try? String(contentsOfFile: fixturePath, encoding: .utf8) else {
            print("FATAL: cannot read fixture at \(fixturePath)")
            exit(3)
        }
        let lines = raw.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        print("items: \(lines.count)")

        var sharedSession: LanguageModelSession? = nil
        if mode == "reuse" {
            let s = LanguageModelSession(instructions: instructions)
            s.prewarm()
            sharedSession = s
        }

        var latencies: [Double] = []
        var errors = 0
        var actionCount = 0
        let t0 = Date()
        var firstCallLatency: Double = 0

        for (i, line) in lines.enumerated() {
            let ti = Date()
            let session: LanguageModelSession
            if let s = sharedSession {
                session = s
            } else {
                session = LanguageModelSession(instructions: instructions)
            }
            do {
                let resp = try await session.respond(
                    to: "Inbox item:\n\(line)",
                    generating: Classification.self
                )
                let dt = Date().timeIntervalSince(ti)
                if i == 0 { firstCallLatency = dt }
                latencies.append(dt)
                let c = resp.content
                if c.hasAction { actionCount += 1 }
                let actionStr = c.hasAction ? c.action : "-"
                print(String(format: "[%02d] %.2fs | %-5@ | action=%@ | %@",
                             i + 1, dt, c.category.rawValue as NSString,
                             (c.hasAction ? "YES" : "no ") as NSString,
                             actionStr as NSString))
                print("      IN : \(line)")
            } catch {
                let dt = Date().timeIntervalSince(ti)
                if i == 0 { firstCallLatency = dt }
                latencies.append(dt)
                errors += 1
                print(String(format: "[%02d] %.2fs | ERROR: %@", i + 1, dt, "\(error)" as NSString))
                print("      IN : \(line)")
            }
            if mode == "reuse", let s = sharedSession {
                // observe context accumulation
                print("      transcript entries: \(s.transcript.count)")
            }
        }

        let total = Date().timeIntervalSince(t0)
        let sorted = latencies.sorted()
        let mem = memoryFootprintMB()
        print("---- SUMMARY ----")
        print(String(format: "total wall time: %.2f s", total))
        print(String(format: "items: %d  errors: %d  has_action=true: %d", lines.count, errors, actionCount))
        print(String(format: "items/sec: %.3f", Double(lines.count) / total))
        print(String(format: "first call: %.2f s", firstCallLatency))
        print(String(format: "mean: %.2f s  median: %.2f s  min: %.2f s  max: %.2f s",
                     latencies.reduce(0, +) / Double(latencies.count),
                     sorted[sorted.count / 2], sorted.first ?? 0, sorted.last ?? 0))
        if latencies.count > 1 {
            let rest = Array(latencies.dropFirst())
            print(String(format: "mean excluding first call: %.2f s -> %.3f items/sec steady",
                         rest.reduce(0, +) / Double(rest.count),
                         Double(rest.count) / rest.reduce(0, +)))
        }
        print(String(format: "peak-ish resident memory: %.1f MB", mem))
        print("DONE")
    }

    static func memoryFootprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return -1 }
        return Double(info.phys_footprint) / 1024.0 / 1024.0
    }
}
