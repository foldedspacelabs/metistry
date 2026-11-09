// ProcessCommandRunner against real children (X-98).
//
// A task's cancellation ends its child ONLY when the caller asked
// (`terminateOnCancel`, the Compute pane's Cancel Download). Everything else —
// `doctor --json` under a menu that closes, a view that goes away — must see
// its verb finish. These run `/bin/sh`, no metistry.

import Foundation
import Testing

@testable import Metistry
@testable import MetistryKit

private final class Started: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var done = false

    func fire() {
        let pending = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            done = true
            defer { waiters.removeAll() }
            return waiters
        }
        for waiter in pending { waiter.resume() }
    }

    func wait() async {
        await withCheckedContinuation { waiter in
            let ready = lock.withLock { () -> Bool in
                if done { return true }
                waiters.append(waiter)
                return false
            }
            if ready { waiter.resume() }
        }
    }
}

private func shell(_ script: String, terminateOnCancel: Bool, started: Started? = nil) -> Task<CommandResult, any Error> {
    Task {
        try await ProcessCommandRunner().run(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script],
            environment: [:],
            currentDirectory: nil,
            standardInput: nil,
            terminateOnCancel: terminateOnCancel,
            onOutput: { line in if line.text.contains("started") { started?.fire() } }
        )
    }
}

@Test func cancellingATaskThatAskedEndsItsChild() async throws {
    let started = Started()
    // `exec` so the sleep IS the child: nothing is left holding the pipes
    let task = shell("echo started; exec sleep 60", terminateOnCancel: true, started: started)
    await started.wait()
    let begin = Date()
    task.cancel()
    let result = try await task.value
    #expect(Date().timeIntervalSince(begin) < 20, "it did not wait out the sleep")
    #expect(result.exitCode != 0, "the child was ended, not finished")
}

@Test func cancellingATaskThatDidNotAskLetsItsChildFinish() async throws {
    let started = Started()
    let task = shell("echo started; sleep 1; echo finished", terminateOnCancel: false, started: started)
    await started.wait()
    task.cancel()
    let result = try await task.value
    #expect(result.exitCode == 0)
    #expect(result.stdout.contains("finished"), "stdout: \(result.stdout)")
}

@Test func aTaskCancelledBeforeItStartsStillGetsItsExitEitherWay() async throws {
    // the exit callback is set before the child exists, so a task that is
    // already cancelled neither misses it nor hangs
    let asked = shell("exec sleep 60", terminateOnCancel: true)
    asked.cancel()
    #expect(try await asked.value.exitCode != 0)

    let notAsked = shell("echo quick", terminateOnCancel: false)
    notAsked.cancel()
    let result = try await notAsked.value
    #expect(result.exitCode == 0)
    #expect(result.stdout.contains("quick"))
}
