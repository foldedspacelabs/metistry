import Foundation
import FoundationModels

@main
struct AFMCheck {
    static func main() async {
        let model = SystemLanguageModel.default
        print("isAvailable: \(model.isAvailable)")
        let a = model.availability
        print("availability (raw): \(a)")
        switch a {
        case .available:
            print("STATUS: available")
        case .unavailable(let reason):
            print("STATUS: unavailable")
            print("REASON (raw): \(reason)")
            switch reason {
            case .deviceNotEligible:
                print("REASON: .deviceNotEligible")
            case .appleIntelligenceNotEnabled:
                print("REASON: .appleIntelligenceNotEnabled")
            case .modelNotReady:
                print("REASON: .modelNotReady")
            @unknown default:
                print("REASON: unknown (\(reason))")
            }
        @unknown default:
            print("STATUS: unknown enum case")
        }
        print("supportedLanguages count: \(model.supportedLanguages.count)")

        // Try a trivial generation to confirm end-to-end
        if model.isAvailable {
            do {
                let t0 = Date()
                let session = LanguageModelSession()
                let r = try await session.respond(to: "Say OK.")
                print("SMOKE: '\(r.content)' in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s")
            } catch {
                print("SMOKE ERROR: \(error)")
            }
        }
    }
}
