// A dependency-free test harness: the kit's tests compile with the kit into
// one executable (scripts/test-helper.sh) — no Package.swift, no XCTest — and
// exit non-zero on the first run with a failure. Nothing here touches a
// microphone, a process tap, a TCC grant or the owner's instance: every
// machine-facing piece is a fake (fakes.swift).

import Foundation

var failures = 0
var checks = 0
var currentTest = ""

func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("  FAIL \(currentTest): \(message()) (\(file):\(line))")
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: @autoclosure () -> String = "", file: StaticString = #fileID, line: UInt = #line) {
    expect(a == b, "\(message()) — got \(a), expected \(b)", file: file, line: line)
}

func test(_ name: String, _ body: () throws -> Void) {
    currentTest = name
    let before = failures
    do { try body() } catch {
        failures += 1
        print("  FAIL \(name): threw \(error)")
    }
    print(failures == before ? "  ok   \(name)" : "  --   \(name)")
}

/// A fresh capture directory under the test process's own temp dir.
func tempCaptureDir() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lc-tests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func transcriptLines(_ store: FileSessionStore, _ sessionID: String) -> [[String: Any]] {
    let url = store.directory(for: sessionID).appendingPathComponent(transcriptFile)
    guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
    return text.split(separator: "\n").compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
}
