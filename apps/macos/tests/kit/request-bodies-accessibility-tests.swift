// §2.18.7 for the request card and the meeting card: each is put in a real
// window and the accessibility tree VoiceOver reads is walked
// (shell-accessibility-tests.swift's probe). Every control says something,
// nothing says "assistant", and the card's Spoken rows (components-02 §3)
// are there word for word.

#if os(macOS)
import AppKit
import SwiftUI
import Testing

@testable import MetistryKit

private let threeQuestionsPayload = #"{"title":"Three things","questions":[{"prompt":"Where should the Connections table live?","options":["Its own file, SettingsConnections.swift","Inside settings-view.swift"]},{"prompt":"Which columns?","options":["Name","Status"],"multi":true}],"context":{"prose":"Two calls before I start."}}"#

extension AXTree {
    /// The unlabeled controls, less the text fields — which are held to their
    /// prompts instead (`fieldsWithoutAPrompt`): SwiftUI on the Mac does not
    /// carry `.accessibilityLabel` onto the AppKit field (measured on macOS
    /// 26.4 — no variant does), and VoiceOver reads an empty field's prompt.
    var unlabeledBesidesFields: [AXNode] { unlabeledControls.filter { $0.role != "AXTextField" && $0.role != "AXTextArea" } }

    /// The editable text fields in the window, and what each says when empty.
    var fieldPrompts: [String] {
        func fields(_ view: NSView) -> [NSTextField] { (view as? NSTextField).map { [$0] } ?? view.subviews.flatMap(fields) }
        return (window.contentView.map(fields) ?? []).filter(\.isEditable).map { $0.cell?.accessibilityPlaceholderValue() ?? "" }
    }

    /// Every text field whose prompt is empty — it would say nothing at all.
    var fieldsWithoutAPrompt: [String] { fieldPrompts.filter(\.isEmpty) }
}

@MainActor
private func answering(_ row: RequestRow) -> RequestAnswering {
    RequestAnswering(row, store: ConsoleStores(transport: AnswerConsole { _, _ in AnswerConsole.ok() }), assistantName: assistantName)
}

@MainActor
private func tree(_ model: RequestAnswering, allowsDecisions: Bool = true) async throws -> AXTree {
    try await AccessibilityProbe.snapshot(
        RequestCardView(model, allowsDecisions: allowsDecisions, today: SampleClock.today, now: SampleClock.now, clock: SampleClock.clock)
            .frame(width: 520)
    )
}

@MainActor
@Test func aQuestionSpeaksItsStepItsAnswersAndLaterWithItsKey() async throws {
    let model = answering(try requestRow(1, "decision", payload: threeQuestionsPayload))
    let t = try await tree(model)
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    #expect(t.saysAssistant.isEmpty, "says assistant: \(t.saysAssistant)")
    #expect(t.labels.contains("Question 1 of 2. Where should the Connections table live?"), "labels: \(t.labels)")
    #expect(t.controlNames.contains("Its own file, SettingsConnections.swift. 1 of 3"), "controls: \(t.controlNames)")
    for name in ["Next", "Revise", "Decline", "Later, L"] {
        #expect(t.controlNames.contains(name), "\(name) — controls: \(t.controlNames)")
    }
}

@MainActor
@Test func somethingElsesFieldHasAName() async throws {
    let model = answering(try requestRow(1, "decision", payload: #"{"title":"Which fixture format?","options":["one file per route","one file per store"]}"#))
    await model.choose(2)
    let t = try await tree(model)
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    #expect(t.controlNames.contains("Send answers"), "controls: \(t.controlNames)")
    #expect(t.fieldPrompts == [ChoicesBody.somethingElse])
}

@MainActor
@Test func yourAnswersSpeaksEachEditAndSendAnswers() async throws {
    let model = answering(try requestRow(1, "decision", payload: threeQuestionsPayload))
    model.steps?.next()
    model.steps?.next()
    let t = try await tree(model)
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    for name in ["Edit question 1", "Edit question 2", "Send answers", "Back"] {
        #expect(t.controlNames.contains(name), "\(name) — controls: \(t.controlNames)")
    }
}

@MainActor
@Test func accessRevisesSpeaksItsFolderFieldAndItsButton() async throws {
    let payload = #"{"title":"devin asks to read Areas/Health","area":"Areas/Health","reason":"The sleep log is there.","current_tier":"index","current_areas":[],"current_scope":{"line":"external · titles · autonomy: observe"}}"#
    let model = answering(try requestRow(7, "access_request", payload: payload, trust: "external", agent: "devin"))
    await model.press(.revise)
    let t = try await tree(model)
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    #expect(t.fieldPrompts == ["Folder to grant instead"], "the one field, and what VoiceOver says for it")
    for name in ["Approve Health", "Cancel"] {
        #expect(t.controlNames.contains(name), "\(name) — controls: \(t.controlNames)")
    }
    #expect(t.labels.contains("from agent devin"), "the asker, with its prefix (components-01 §2.8)")
}

@MainActor
@Test func whileUnreachableTheCardStillSpeaksAndSaysWhy() async throws {
    let model = answering(try requestRow(2, "action", payload: #"{"title":"Comment on work #41","action":{"kind":"comment","args":{"work_id":41,"body":"Moved to Friday."}}}"#))
    let t = try await tree(model, allowsDecisions: false)
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    #expect(t.labels.contains(StateWords.unreachable) || t.texts.contains(StateWords.unreachable), "labels: \(t.labels)")
}

@MainActor
@Test func theMeetingCardSpeaksItsTwoVerbs() async throws {
    let parts = try (1...3).map { try requestRow($0, "knowledge", payload: #"{"title":"To-do \#($0)","meeting":"Vendor review"}"#) }
    let model = GroupAnswering(MeetingGroup(id: "g", parts: parts), store: ConsoleStores(transport: AnswerConsole { _, _ in AnswerConsole.ok() }), assistantName: assistantName)
    let t = try await AccessibilityProbe.snapshot(
        MeetingCardView(model, assistantName: assistantName, allowsDecisions: true, today: SampleClock.today, now: SampleClock.now, clock: SampleClock.clock).frame(width: 520)
    )
    defer { t.close() }
    #expect(t.unlabeledBesidesFields.isEmpty, "unlabeled: \(t.unlabeledBesidesFields)")
    #expect(t.fieldsWithoutAPrompt.isEmpty, "a field that says nothing: \(t.fieldsWithoutAPrompt)")
    #expect(t.saysAssistant.isEmpty)
    #expect(t.controlNames.contains("Accept All") && t.controlNames.contains("Decline All"), "controls: \(t.controlNames)")
    #expect(t.labels.contains("Vendor review"), "the meeting's name is its heading")
}
#endif
