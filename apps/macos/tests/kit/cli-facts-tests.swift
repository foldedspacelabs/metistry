// `CLIDegradation.refusalMessage` — the one place a refusal's TEXT comes from.
//
// Most `metistry compute …` verbs answer a failure by RETURNING a `--json`
// object (`{"ok": false, …, "detail": "<why>"}`), pretty-printed, with exit 1
// — not by throwing. Reading "the last line of stdout" as a fallback then
// shows the closing `}` of that object and nothing else, which is the bug
// this file pins: the pane must read the JSON's own reason first, and only
// fall back to prose when there is none to parse.

import Foundation
import Testing

@testable import MetistryKit

@Test func aPrettyPrintedJsonRefusalReadsTheDetailNotTheClosingBrace() {
    // `JSON.stringify(r, null, 2)` — exactly what `providers test` prints on
    // stdout when the provider refused the credential, spanning several lines
    // with the closing brace alone on the last one.
    let stdout = """
    {
      "name": "openrouter",
      "ok": false,
      "url": "https://openrouter.ai/api/v1",
      "models": [],
      "detail": "https://openrouter.ai/api/v1/models → HTTP 401"
    }
    """
    let result = CommandResult(exitCode: 1, stdout: stdout, stderr: "")
    let message = CLIDegradation.refusalMessage(result, verb: "compute providers test")

    #expect(message == "https://openrouter.ai/api/v1/models → HTTP 401")
    #expect(message != "}")
}

@Test func anErrorEnvelopeReadsTheMessageAndTheCodeWhenBothAreThere() {
    // The other shape a `--json` error object can take: `{ok:false,
    // error:{code,message}}`. Named after the envelope `docs/ops/console-api.md`
    // documents for the console's own routes, in case a verb ever answers a
    // refusal that way instead of a bare `detail`.
    let stdout = """
    {
      "ok": false,
      "error": {
        "code": "provider_unreachable",
        "message": "the provider did not answer"
      }
    }
    """
    let result = CommandResult(exitCode: 1, stdout: stdout, stderr: "")
    let message = CLIDegradation.refusalMessage(result, verb: "compute providers test")

    #expect(message == "the provider did not answer (provider_unreachable)")
}

@Test func plainTextOnStderrIsShownVerbatimAndStdoutIsNotConsulted() {
    // A thrown `StepFailed` — `metistry compute` wraps it as
    // `metistry compute: <message>` on stderr, and prints nothing on stdout at
    // all. The plain-text path must keep working exactly as it did before.
    let stderr = "metistry compute: assignments.default is not set yet, and it is where every unnamed and unknown tier lands; /i/compute.yaml was NOT changed\n"
    let result = CommandResult(exitCode: 1, stdout: "", stderr: stderr)
    let message = CLIDegradation.refusalMessage(result, verb: "compute assign")

    #expect(message == "metistry compute: assignments.default is not set yet, and it is where every unnamed and unknown tier lands; /i/compute.yaml was NOT changed")
}

@Test func noOutputAtAllNamesTheVerbAndTheExitCode() {
    let result = CommandResult(exitCode: 1, stdout: "", stderr: "")
    let message = CLIDegradation.refusalMessage(result, verb: "compute providers test")

    #expect(message == "`metistry compute providers test` exited 1 with no output")
}
