// `ConsoleAPI` against a stub console: every shape decoded, every refusal read
// back, and the two cursors folded.
//
// THE STUB IS IN-PROCESS AND THERE IS NO NETWORK AND NO SUBPROCESS. Two levels
// of it, because there are two things worth holding:
//
//   * `StubConsole` conforms to `ConsoleCallTransport` and answers a
//     `<METHOD> <path>` key with recorded bytes. It is what proves the MODELS
//     decode and the CURSORS fold.
//   * `StubRunner` conforms to `CommandRunner`, so `CLIConsoleCallTransport`
//     is exercised for real: the argument array, `--json`, a body that goes to
//     STDIN and not to argv, and the three things `metistry console call`
//     writes to stderr. That is the production transport, not a mock of it.
//
// THE FIXTURES ARE HAND-WRITTEN from the shapes `docs/ops/console-api.md`
// documents, and where the document was not specific enough the shape was read
// out of the source and the source is named beside it:
//
//   * `/api/q/<name>` is `{rows, as_of}` — `packages/queries/src/index.ts`'s
//     `QueryResult`; the columns are the `SELECT` lists in `seed/queries/`.
//   * `GET /api/agents` is `{agents:[…]}` with `grants`, `autonomy`, `remote`,
//     `approved_at` and a derived `pending` — `apps/console/src/agents.ts`'s
//     `listAgents`.
//   * The error envelope is `{code, message}` and carries NO `field` key —
//     `packages/core/src/errors.ts`. "A refusal names the field" puts the
//     field in the MESSAGE, which is why `namedField(among:)` takes the names
//     the caller already knows it sent rather than parsing prose.
//   * `numeric` columns are STRINGS on the wire (`pg` installs no type
//     parser), so `cost_usd` and `shadow_agreement` are quoted in the run
//     fixture on purpose.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - Every model decodes from the documented shape

@Test func identityDecodesTheSixCapabilitiesAndNothingAboutVoice() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/identity": Fixtures.identity]))
    let identity = try! (await api.identity()).get()
    #expect(identity.instanceID == "8b6a3a2e-0000-4000-8000-000000000001")
    #expect(identity.name == "Aide")
    #expect(identity.capabilities == ["artifacts", "capture", "dispatch", "knowledge", "queries", "tasks"])
    #expect(identity.has("knowledge"))
    #expect(!identity.has("compute"))
    #expect(identity.version == "0.8.0")
    #expect(WireTime.date(identity.asOf) != nil)
}

@Test func whoamiHasNoFieldATokenCouldLandInOnThisRouteEither() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/whoami": Fixtures.whoami]))
    let whoami = try! (await api.whoami()).get()
    #expect(whoami.principal == "user")
    #expect(whoami.via == "local_owner_token")
    #expect(whoami.management)
    // The shape has nowhere to put a secret, which is the control. A reply that
    // carried one would be decoded without it.
    #expect(!"\(whoami)".contains("not-a-real-secret"))
}

@Test func theFeedDecodesItsClosedGroupVocabularyAndTheRunRefItOpens() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/q/activity_feed?hours=24": Fixtures.feed]))
    let feed = try! (await api.activityFeed(hours: 24)).get()
    #expect(feed.rows.count == 3)
    #expect(feed.rows.map(\.group) == ["run", "capture", "proposal"])
    // A `runs:<id>` ref is what the drill-down opens; nothing else is one.
    #expect(feed.rows[0].runID == 9001)
    #expect(feed.rows[1].runID == nil)
    #expect(feed.rows[0].turnID == "t-77")
    #expect(feed.cursor == "2026-09-18T09:00:02.000Z")
    #expect(WireTime.date(feed.asOf) != nil)
}

@Test func aRequestOffersTheSixAnswersAndApproveAsWorkOnlyWhereTheRowSuggestsOne() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/proposals": Fixtures.proposals]))
    let page = try! (await api.requests()).get()
    #expect(page.proposals.count == 3)
    #expect(page.cursor == "2026-09-18 09:00:00.003+00|19")
    #expect(!page.more)

    // An `improvement` with no suggestion: five answers, no Approve as Work.
    let improvement = page.proposals[0]
    #expect(improvement.kind == "improvement")
    #expect(improvement.isPending)
    #expect(improvement.suggestedWork == nil)
    #expect(improvement.answers.map(\.wire) == ["allow", "accept_with_changes", "deny", "later", "skip"])

    // A `knowledge` row carrying `payload.suggested_work`: the sixth appears,
    // and it is the payload that puts it there — never the client.
    let knowledge = page.proposals[1]
    #expect(knowledge.suggestedWork?.title == "renew the wildcard cert")
    #expect(knowledge.suggestedWork?.project == nil)
    #expect(knowledge.answers.map(\.wire).contains("accept_as_work"))

    // A `decision` row is answered with ITS OWN options, plus Decline.
    let enrolment = page.proposals[2]
    #expect(enrolment.kind == "decision")
    #expect(enrolment.answers.map(\.wire) == ["approve", "deny", "deny", "later", "skip"])
    #expect(enrolment.title == "Devin wants to enrol")
}

@Test func anAccessRequestIsAnsweredWithApproveReviseAndDeclineAndReviseCarriesTheFolder() async {
    let stub = StubConsole([
        "GET /api/proposals": Fixtures.accessRequests,
        "POST /api/proposals/21": Data(#"{"ok":true,"granted":{"agent":"devin","area":"Areas/Health/Sleep","grants":{"tier":"areas","areas":["Areas/Health/Sleep"],"queries":false}}}"#.utf8),
    ])
    let api = ConsoleAPI(transport: stub)
    let row = try! (await api.requests()).get().proposals[0]

    // What the card reads off the row: the ask, the why, and the fact that
    // Approve costs this credential its vault-wide title browse.
    let ask = row.accessRequest
    #expect(ask?.area == "Areas/Health")
    #expect(ask?.reason == "knowledge_read pointed me here")
    #expect(ask?.currentTier == "index")
    #expect(ask?.tradesIndexBrowse == true)
    #expect(ask?.granted == nil)
    #expect(RequestRow(id: 1, ts: "t", kind: "report").accessRequest == nil) // the ROW says what it is

    // The three answers plus the quiet pair, and Revise pre-set to the ask.
    #expect(row.answers.map(\.wire) == ["allow", "accept_with_changes", "deny", "later", "skip"])
    #expect(row.answers.map(\.label) == ["Approve", "Revise", "Decline", "Later", "Skip"])
    #expect(row.answers[1].area == "Areas/Health")
    #expect(!RequestAnswer.reviseArea("  ").isSendable) // nothing to widen: a cancel, not a send
    #expect(!RequestAnswer.reviseArea("Areas/Health").isBatchable)

    // Revise sends the folder, not a reason — that is what the console needs
    // for this kind, and it refuses a bare reason.
    let result = try! (await api.answer(21, .reviseArea("Areas/Health/Sleep"), seenAt: row.cursor)).get()
    let sent = try! JSONValue.parse(await stub.bodies["POST /api/proposals/21"]!)
    #expect(sent.string("decision") == "accept_with_changes")
    #expect(sent.string("area") == "Areas/Health/Sleep")
    #expect(sent["feedback"] == nil)
    #expect(result.granted?.agent == "devin")
    #expect(result.granted?.area == "Areas/Health/Sleep")
    #expect(result.granted?.grants?.areas == ["Areas/Health/Sleep"])
}

@Test func laterIsNotAnAnswerAndASnoozedRowIsOutOfTheQueueWithoutBeingDecided() {
    let now = Date(timeIntervalSince1970: 1_780_000_000)
    let soon = ISO8601DateFormatter().string(from: now.addingTimeInterval(3600))
    let past = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3600))

    let snoozed = RequestRow(id: 1, ts: "2026-09-18T09:00:00.000Z", kind: "report", snoozedUntil: soon)
    #expect(snoozed.isPending)          // `later` settles nothing
    #expect(snoozed.isSnoozed(now: now))
    #expect(!snoozed.isInQueue(now: now))

    // It comes back by itself, and the only thing that brings it back is the clock.
    let returned = RequestRow(id: 1, ts: "2026-09-18T09:00:00.000Z", kind: "report", snoozedUntil: past)
    #expect(returned.isInQueue(now: now))
}

@Test func onlyLaterSkipAndDeclineMayBeBatchedAndReviseNeedsAReason() {
    #expect(RequestAnswer.later.isBatchable)
    #expect(RequestAnswer.skip.isBatchable)
    #expect(RequestAnswer.decline("guessed").isBatchable)
    #expect(!RequestAnswer.approve.isBatchable)
    #expect(!RequestAnswer.approveAsWork.isBatchable)
    #expect(!RequestAnswer.revise("say more").isBatchable)

    // An empty reason CANCELS rather than sends.
    #expect(!RequestAnswer.revise("   ").isSendable)
    #expect(RequestAnswer.revise("guessed instead of looking it up").isSendable)
    #expect(RequestAnswer.skip.isSendable)

    // Skip is not Decline, and the wire says so: skip's own marker is the
    // server's, so nothing here carries the user's words.
    #expect(RequestAnswer.skip.wire == "skip")
    #expect(RequestAnswer.skip.feedback == nil)
    #expect(RequestAnswer.decline("too vague").feedback == "too vague")
}

@Test func answeringSendsTheRenderedRowsOwnTimestampSoAChangedQuestionIsRefused() async {
    let stub = StubConsole(["POST /api/proposals/17": Data(#"{"ok":true}"#.utf8)])
    let api = ConsoleAPI(transport: stub)
    _ = await api.answer(17, .revise("name the page"), seenAt: "2026-09-16T08:01:02.003Z")

    let sent = await stub.bodies["POST /api/proposals/17"]
    let json = try! JSONValue.parse(sent!)
    #expect(json.string("decision") == "accept_with_changes")
    #expect(json.string("feedback") == "name the page")
    #expect(json["if_unchanged"]?.string("seen_at") == "2026-09-16T08:01:02.003Z")
}

@Test func aBatchIsAlwaysTwoHundredAndEachRowCarriesItsOwnOutcome() async {
    let api = ConsoleAPI(transport: StubConsole(["POST /api/proposals/batch": Fixtures.batch]))
    let result = try! (await api.answerMany([17, 18, 19], .skip)).get()
    #expect(result.results.count == 3)
    #expect(result.refused.map(\.id) == [19])
    let lost = result.refused[0]
    // The winner comes back, so a client shows what actually happened rather
    // than "failed".
    #expect(lost.reason == "already_decided")
    #expect(lost.decision == "allow")
    #expect(lost.error?.code == "conflict")
}

@Test func theBoardGroupsIntoTheFiveColumnsInTheQuerysOwnOrder() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/q/board": Fixtures.board]))
    let board = try! (await api.board()).get()
    #expect(board.columns.map(\.key) == ["backlog", "assigned", "in_progress", "blocked", "done"])
    // Each label is the word its key says (C2, C38).
    #expect(board.columns.map(\.label) == ["Backlog", "Assigned", "In Progress", "Blocked", "Done"])
    // An empty column is a fact about the board, not a reason to hide it.
    #expect(Board(rows: []).columns.map(\.key) == Board.columnOrder)
    #expect(Board(rows: []).columns.allSatisfy { $0.cards.isEmpty })
    // Reported is a facet of a Done card, not a column (C39).
    let done = board.columns.first { $0.key == "done" }!.cards
    #expect(done.map(\.reported) == [true, false])

    // blocked-by: the owner's todo, resolved beside the card; it surfaces and never gates
    let blocked = board.columns.first { $0.key == "blocked" }!.cards[0]
    #expect(blocked.blockedBy == "vault:Journal/2026-09-18.md#^mt-7f3k2a")
    #expect(blocked.blockedByTask == "Send the icon brief")
    #expect(blocked.blockedByTaskOpen == true)
    let unblocked = board.columns.first { $0.key == "backlog" }!.cards[0]
    #expect(unblocked.blockedBy == nil && unblocked.blockedByTask == nil && unblocked.blockedByTaskOpen == nil)

    let card = board.columns.first { $0.key == "in_progress" }!.cards[0]
    #expect(card.id == 214)
    #expect(card.claimedBy == "drey")
    #expect(card.ageHours == 4.5)
    #expect(card.hasThread)
    #expect(card.threadCount == 7)
    #expect(unblocked.threadCount == 0)
    #expect(card.escalated)
    // description (C85): the card detail's first section; nil when nobody wrote one
    #expect(card.description == "The *.home cert lapses on the 20th; the proxy reloads it.")
    #expect(unblocked.description == nil)
    // A lease in the past is not a lease that is held — which is what
    // `interrupted` reads on the presence chip.
    #expect(!card.isHeld(now: Date(timeIntervalSince1970: 4_000_000_000)))
}

@Test func aPatchThatMixesTheTwoArmsIsRefusedHereRatherThanOnSubmit() async {
    // The route answers 400 naming both fields, "because the looser gate must
    // never carry the stricter arm's write". So the type will not build one.
    #expect(TaskPatch(status: "closed", owner: "drey").wireBody == nil)
    #expect(TaskPatch().wireBody == nil)
    #expect(TaskPatch.moving(to: "blocked").status == "blocked")
    #expect(TaskPatch.addressing(to: "drey").wireBody?["owner"] as? String == "drey")
    // description rides the board arm (the owner's), so it cannot travel with a holder status either
    #expect(TaskPatch.describing("why this card exists").wireBody?["description"] as? String == "why this card exists")
    #expect(TaskPatch.describing("").wireBody?["description"] as? String == "") // blank clears it at the route
    #expect(TaskPatch(status: "blocked", description: "because").wireBody == nil)

    let api = ConsoleAPI(transport: StubConsole([:]))
    let refused = await api.updateTask(214, TaskPatch(status: "closed", title: "new"))
    guard case .failure(let error) = refused else { Issue.record("a mixed patch was sent"); return }
    #expect(error.httpStatus == 400)
    #expect(error.namedField(among: ["status", "title"]) == "status")
}

@Test func aRoomIsAHandleACountAndWhoIsInIt() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/q/rooms": Fixtures.rooms]))
    let rooms = try! (await api.rooms()).get()
    let room = rooms.rows[0]
    // The thread's id is TEXT on the wire (`cmt_…`), and stays text — it was
    // read as a number once, and every room's id was 0.
    #expect(room.threadID == "cmt_01M3FYT8PDPMAX22C9X769GV7Q")
    #expect(room.id == room.threadID)
    #expect(room.workID == 214)
    #expect(room.anchor == "work")
    #expect(room.messages == 7)
    #expect(room.agentTail == 3)
    #expect(room.cap == 10)
    #expect(room.participants.count == 2)
    #expect(room.participants.contains(Room.Participant(principal: "user", kind: "user")))
    #expect(room.escalated)
    #expect(room.proposalID == 88)
}

@Test func anAgentCarriesItsDefaultDenyGrantAndAPendingEnrolmentIsNeverPresent() async {
    let api = ConsoleAPI(transport: StubConsole([
        "GET /api/agents": Fixtures.agents,
        "GET /api/q/agent_presence": Fixtures.presence,
    ]))
    let registry = try! (await api.agents()).get()
    #expect(registry.agents.count == 2)

    let drey = registry.agents[0]
    #expect(drey.grantTier == "read")
    #expect(drey.grantAreas == ["Areas/Health"])
    #expect(drey.autonomyLevel == "propose")
    #expect(!drey.pending)

    // Every kind, resolved AND why (C46/C47) — read off `scope.autonomy.detailed`,
    // never recomputed here. `task_update` is the owner's own entry, honoured;
    // `dispatch` is nothing named, the level's own default; `comment` is the
    // ONE case where the owner's own setting (`allow`) is being overridden by
    // the level's ceiling (`propose`) — `asked` disagrees with `mode` only here.
    #expect(drey.actionsDetailed["dispatch"] == AgentActionEntry(mode: "propose", source: "defaulted", ceiling: "propose"))
    #expect(drey.actionsDetailed["task_update"] == AgentActionEntry(mode: "propose", source: "set", asked: "propose", ceiling: "propose"))
    #expect(drey.actionsDetailed["comment"] == AgentActionEntry(mode: "propose", source: "clamped", asked: "allow", ceiling: "propose"))
    #expect(drey.actionsDetailed["comment"]?.asked != drey.actionsDetailed["comment"]?.mode) // the mismatch IS the override

    // Approval is NOT a grant: a row let in still holds what it was minted
    // with. A pending row is listed and authenticates nothing.
    let devin = registry.agents[1]
    #expect(devin.remote)
    #expect(devin.pending)
    #expect(devin.grantTier == "none")
    #expect(devin.grantAreas.isEmpty)
    // no `scope` on this row (a console older than this app, or one this test
    // never gave one) — empty, never a guess at a table.
    #expect(devin.actionsDetailed.isEmpty)

    let presence = try! (await api.agentPresence()).get()
    #expect(presence.rows[0].state == "working")
    #expect(presence.rows[0].currentClaims.map(\.id) == [214])
    #expect(presence.rows[0].spendTodayUSD == 0.42)
    #expect(presence.rows[1].state == "interrupted")
    #expect(presence.rows[1].interruptedClaims.count == 1)
}

@Test func computeDecodesIntoTheSameFactsTheCliPaneAlreadyReadsPlusSpendAndWritable() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/compute": Fixtures.compute]))
    let compute = try! (await api.compute()).get()
    #expect(compute.facts.providers.map(\.name) == ["openrouter"])
    // Presence, never a value — and the NAME of the secret is not a secret.
    #expect(compute.facts.providers[0].secret == "METISTRY_OPENROUTER_API_KEY")
    #expect(compute.facts.providers[0].secretPresent == true)
    #expect(compute.facts.defaultRef == "openrouter/anthropic/claude-opus-4")
    #expect(compute.writable)
    #expect(compute.spend?.instance.daily == 1.25)
    #expect(compute.spend?.providers["openrouter"]?.monthly == 18.4)
}

@Test func spendIsNilRatherThanAGuessedZeroWhenTheQueryIsNotLoaded() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/compute": Fixtures.computeNoSpend]))
    let compute = try! (await api.compute()).get()
    #expect(compute.spend == nil)   // never a guessed zero
    #expect(!compute.writable)
}

@Test func searchCarriesDegradedAsAFactAndSaysWhenItIsAtTheBridgesCeiling() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/knowledge/search?q=sleep": Fixtures.search]))
    let reply = try! (await api.knowledgeSearch("sleep")).get()
    #expect(reply.mode == "keyword")
    #expect(reply.degraded == "keyword only — the embedder is down")
    #expect(reply.hits.count == 2)
    #expect(reply.hits[0].path == "Areas/Health/sleep.md")
    #expect(reply.hits[0].score == 0.87)
    #expect(!reply.isAtCeiling)
    #expect(KnowledgeSearchReply.maximumHits == 100)
}

@Test func aPageArrivesThroughTheBridgeWithItsHashAndItsLength() async {
    let api = ConsoleAPI(transport: StubConsole([
        "GET /api/knowledge/page?path=Areas%2FHealth%2Fsleep.md": Fixtures.page,
    ]))
    let page = try! (await api.knowledgePage(path: "Areas/Health/sleep.md")).get()
    #expect(page.path == "Areas/Health/sleep.md")
    #expect(page.content.hasPrefix("# Sleep"))
    #expect(page.bytes == 41)
}

@Test func thePageListDerivesItsAreaAndSaysWhereItEndsWithoutEverStatingATotal() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/knowledge/pages?limit=2&prefix=Areas%2FHealth": Fixtures.pages]))
    let list = try! (await api.knowledgePages(prefix: "Areas/Health", limit: 2)).get()
    #expect(list.pages.map(\.path) == ["Areas/Health/2026/taper.md", "Areas/Health/sleep.md"])
    #expect(list.pages[1].area == "Areas/Health")
    #expect(list.pages[1].title == "Sleep")
    #expect(list.pages[1].status == "clean")
    #expect(list.pages[0].title == "taper")  // no frontmatter title → the basename, decided server-side
    #expect(list.pages[0].status == "dirty")  // edited since the last walk
    #expect(list.prefix == "Areas/Health")
    #expect(list.area == nil)
    // A full window, so there may be more — and this is the ONLY way to say
    // so, because a total would publish the size of what the scope filtered.
    #expect(!list.isLastPage)
    #expect(list.nextOffset == 2)
    #expect(KnowledgePageList.maximumLimit == 500)
}

@Test func aVaultRootFileHasNoAreaAndAShortWindowIsTheEndOfTheList() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/knowledge/pages": Fixtures.pagesTail]))
    let list = try! (await api.knowledgePages()).get()
    // nil is the honest answer for `now.md`, not a missing field: the vault
    // root is not in an area.
    #expect(list.pages.map(\.area) == [nil])
    #expect(list.pages[0].path == "now.md")
    #expect(list.isLastPage)
    #expect(list.nextOffset == nil)
}

@Test func theFirstPageOfTheListHasOneSpellingHoweverTheCallerAsksForIt() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: Fixtures.pagesTailText, stderr: ""))
    let api = ConsoleAPI(cli: stubCLI(runner))
    _ = await api.knowledgePages(offset: 0)
    // `offset=0` is the default, so it is omitted rather than sent — one stub
    // key, one cache key, one line in a log for "the first page".
    #expect(await runner.invocations[0][4] == "/api/knowledge/pages")
}

@Test func aPagesLinksArriveInOneListWithTheDirectionOnEachEdge() async {
    let api = ConsoleAPI(transport: StubConsole([
        "GET /api/knowledge/links?limit=3&path=Areas%2FHealth%2Fsleep.md": Fixtures.pageLinks,
    ]))
    let links = try! (await api.knowledgeLinks(path: "Areas/Health/sleep.md", limit: 3)).get()
    #expect(links.path == "Areas/Health/sleep.md")
    // One list, in the server's order — outgoing first, then by path, then by
    // kind. The two sections are a view of it, not a second fetch.
    #expect(links.links.map(\.path) == ["Areas/Health/taper.md", "Areas/Health/nowhere.md", "Journal/2026-09-18.md"])
    #expect(links.outgoing.count == 2)
    #expect(links.incoming.map(\.path) == ["Journal/2026-09-18.md"])
    // An unresolved wikilink is a link, titled from its own path: a note that
    // has not been written yet, which is how a vault gets written.
    #expect(links.links[1].resolved == false)
    #expect(links.links[1].title == "nowhere")
    #expect(links.links[1].status == nil)
    #expect(links.links[0].resolved == true)
    #expect(links.links[0].kind == "wikilink")
    // A full window, and no total — the only way to say "there may be more".
    #expect(!links.isLastPage)
    #expect(links.nextOffset == 3)
    #expect(KnowledgePageLinkList.maximumLimit == 500)
}

@Test func theSameTargetReachedTwoWaysIsTwoEdgesWithTwoIdentities() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/knowledge/links?path=Areas%2FHealth%2Fsleep.md": Fixtures.pageLinksTail]))
    let links = try! (await api.knowledgeLinks(path: "Areas/Health/sleep.md")).get()
    // `wikilink` and `embed` at the same page are distinct rows, so the
    // identity a list renders by cannot be the path alone.
    #expect(links.links.map(\.kind) == ["embed", "wikilink"])
    #expect(Set(links.links.map(\.id)).count == 2)
    #expect(links.isLastPage)
    #expect(links.nextOffset == nil)
}

@Test func theFirstWindowOfALinkListHasOneSpellingHoweverTheCallerAsksForIt() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: Fixtures.pageLinksTailText, stderr: ""))
    let api = ConsoleAPI(cli: stubCLI(runner))
    _ = await api.knowledgeLinks(path: "Areas/Health/sleep.md", offset: 0)
    #expect(await runner.invocations[0][4] == "/api/knowledge/links?path=Areas%2FHealth%2Fsleep.md")
}

@Test func theCommandMenuIsGeneratedAndCarriesTheTierEachCommandResolvesToNow() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/commands": Fixtures.commands]))
    let menu = try! (await api.commands()).get()
    // Deterministic order: `/` commands first, then `@` agents, each by id.
    #expect(menu.commands.map(\.id) == ["/note", "/status"])
    #expect(menu.commands[1].routesTo == "fast_path")
    // A fast path's line IS the named query's own description.
    #expect(menu.commands[1].query == "open_work")
    #expect(menu.commands[1].takesArgument == false)
    #expect(menu.agents.map(\.id) == ["@drey"])
    #expect(menu.agents[0].present)
}

@Test func aRunDecodesItsNumericColumnsFromTheStringsPgActuallySends() async {
    let api = ConsoleAPI(transport: StubConsole(["GET /api/runs/9001": Fixtures.run]))
    let reply = try! (await api.run(9001)).get()
    let run = reply.run
    #expect(run.id == 9001)
    #expect(run.model == "anthropic/claude-opus-4")
    // `numeric(10,6)` arrives quoted. A Double-only decoder would have thrown.
    #expect(run.costUSD == 0.001234)
    #expect(run.shadowAgreement == 0.917)
    #expect(run.shadowAnswerSimilarity == 0.88)
    #expect(run.wasShadowed)
    // Joined exactly on `meta.turn_id`, never a time window.
    #expect(run.toolCalls.count == 2)
    #expect(run.toolCallsTotal == 2)
    #expect(run.toolCallsFailed == 1)
    #expect(run.toolCalls[1].ok == false)
}

// MARK: - The error envelope, read back

@Test func aRefusalCarriesTheCodeTheMessageAndTheFieldTheCallerAlreadyKnows() async {
    // The console's own words, through `console call`'s stderr render. Note the
    // message itself contains " — ", which the render's separator also is: the
    // reader rejoins the tail rather than truncating at the first one.
    let error = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 400 — invalid_request — effort must be one of low | medium | high — omit it to keep the effort already on this assignment",
        exitCode: 1
    )
    #expect(error.httpStatus == 400)
    #expect(error.code == "invalid_request")
    #expect(error.refusal?.hasSuffix("already on this assignment") == true)
    // The envelope has no `field` KEY, so attribution is to a name the caller
    // sent. Nothing is inferred from the sentence's shape.
    #expect(error.namedField(among: ["tier", "model", "effort"]) == "effort")
    #expect(error.namedField(among: ["daily", "monthly"]) == nil)

    // And where a `field` key does arrive one day, it wins over the prose.
    let keyed = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 400 — invalid_request — the request names two targets — (field: crew)",
        exitCode: 1
    )
    #expect(keyed.namedField(among: ["tier"]) == "crew")
}

@Test func fourOhOneIsUnreachableAndFourOhThreeIsNot() {
    let unauthenticated = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 401 — unauthenticated — authentication required",
        exitCode: 1
    )
    #expect(unauthenticated.isUnauthenticated)
    #expect(!unauthenticated.isForbidden)
    // The door refused the owner, so nothing on the owner surface can be done
    // and no control may pretend otherwise (O3).
    #expect(ConsoleReachability.after(unauthenticated) == .unreachable("authentication required"))
    #expect(!ConsoleReachability.after(unauthenticated).allowsDecisions)

    let forbidden = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 403 — forbidden — not granted",
        exitCode: 1
    )
    #expect(forbidden.isForbidden)
    #expect(!forbidden.isUnauthenticated)
    // One route declined this credential. That is a refusal to explain where it
    // happened (P4), not an outage — the console is reachable.
    #expect(ConsoleReachability.after(forbidden) == .reachable)
    #expect(ConsoleReachability.after(forbidden).allowsDecisions)
}

@Test func aFiveOhThreeIsDegradedBecauseAbsentIsAFactAndNotAFault() {
    let absent = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 503 — not_available — artifacts are not configured in this deployment — the console needs a vault bridge (METISTRY_RECONCILER_URL + METISTRY_BRIDGE_TOKEN_RECONCILER)",
        exitCode: 1
    )
    #expect(absent.isNotAvailable)
    guard case .degraded(let note) = ConsoleReachability.after(absent) else {
        Issue.record("a 503 was not read as degraded"); return
    }
    // The refusal names what would supply it, which is the whole of R3.
    #expect(note.contains("METISTRY_RECONCILER_URL"))
    #expect(ConsoleReachability.after(absent).allowsDecisions)
}

@Test func aConflictDecodesTheEnvelopeFromTheBodyOnStdoutNowThatOneIsThere() {
    // `--json` prints the console's own body for a >= 400 too (F-11), and
    // `fromConsoleCall` decodes the envelope from THAT real JSON — the
    // staleness/conflict shape `apps/console/src/server.ts`'s `conflictBody`
    // sends — rather than from `renderConsoleCallError`'s rendered stderr
    // line, which only ever carried `code` and `message`.
    // `conflictBodyIsUnavailable` said this could not happen; it is gone
    // because it now does.
    let stdout = #"{"error":{"code":"conflict","message":"the proposal changed after you saw it"},"reason":"stale","decision":null,"decided_at":null,"proposal":{"id":42,"decision":"pending"}}"#
    let conflict = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 409 — conflict — the proposal changed after you saw it",
        stdout: stdout,
        exitCode: 1
    )
    #expect(conflict.isConflict)
    #expect(conflict.code == "conflict")
    #expect(conflict.refusal == "the proposal changed after you saw it")
}

@Test func aFailureWithNoJSONOnStdoutStillDecodesFromTheRenderedStderrLine() {
    // An install whose CLI predates F-11 prints nothing on stdout for a >= 400
    // — the fallback this replaces still reads the envelope off stderr.
    let conflict = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: HTTP 409 — conflict — already decided",
        exitCode: 1
    )
    #expect(conflict.isConflict)
    #expect(conflict.code == "conflict")
    #expect(conflict.refusal == "already decided")
}

@Test func theProductionTransportDecodesAConflictBodyFromStdoutTooWhenTheCallFails() async {
    let stderr = "metistry console call: HTTP 409 — conflict — the proposal changed after you saw it\n"
    let stdout = #"{"error":{"code":"conflict","message":"the proposal changed after you saw it"},"reason":"stale","decision":null,"decided_at":null,"proposal":{"id":42,"decision":"pending"}}"#
    let runner = StubRunner(result: CommandResult(exitCode: 1, stdout: stdout, stderr: stderr))
    let transport = CLIConsoleCallTransport(cli: stubCLI(runner))

    let result = await transport.call("POST", "/api/proposals/42", body: Data(#"{"decision":"allow"}"#.utf8))
    guard case .failure(let error) = result else { Issue.record("a 409 was read as success"); return }
    #expect(error.isConflict)
    #expect(error.refusal == "the proposal changed after you saw it")
}

// MARK: - The production transport, for real

@Test func idempotencyKeyRidesAsAFlagAndIsAbsentWhenNoneIsGiven() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: #"{"id":42}"#, stderr: ""))
    let transport = CLIConsoleCallTransport(cli: stubCLI(runner))

    _ = await transport.call("POST", "/capture", body: Data(#"{}"#.utf8), idempotencyKey: "retry-1")
    _ = await transport.call("POST", "/capture", body: Data(#"{}"#.utf8), idempotencyKey: nil)

    let argv = await runner.invocations
    #expect(argv[0] == [
        "/src/packages/cli/dist/main.js", "console", "call", "POST", "/capture",
        "--json", "--body", "-", "--idempotency-key", "retry-1", "--product-dir", "/src",
    ])
    // The plain three-argument `call` every existing caller uses still sends
    // nothing extra — the flag is opt-in, not a default the CLI now always sees.
    #expect(!argv[1].contains("--idempotency-key"))
}

@Test func theRequestIsOneCliInvocationAndABodyGoesToStdinNotArgv() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: #"{"ok":true}"#, stderr: ""))
    let api = ConsoleAPI(cli: stubCLI(runner))
    _ = await api.answer(17, .approve)

    let argv = await runner.invocations
    #expect(argv.count == 1)
    #expect(argv[0] == [
        "/src/packages/cli/dist/main.js", "console", "call", "POST", "/api/proposals/17",
        "--json", "--body", "-", "--product-dir", "/src",
    ])
    // The body is on stdin, so it is not in a command line, a shell history or
    // a log — the same rule `compute providers add` follows.
    #expect(await runner.standardInputs[0] == #"{"decision":"allow"}"#)
    #expect(!argv[0].joined(separator: " ").contains("decision"))
}

@Test func aQueryStringIsSortedAndEncodesWhatWhatwgWouldOtherwiseReadAsASpace() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: Fixtures.searchText, stderr: ""))
    let api = ConsoleAPI(cli: stubCLI(runner))
    _ = await api.knowledgeSearch("C++ notes", mode: "hybrid", limit: 50)

    let path = await runner.invocations[0][4]
    // Sorted keys, so a stub and a reader agree on the exact path; `+` is
    // percent-encoded, because WHATWG query parsing decodes a raw one as a
    // space and the search would be for `C  notes`.
    #expect(path == "/api/knowledge/search?limit=50&mode=hybrid&q=C%2B%2B%20notes")
    #expect(ConsoleAPI.queryString(["a": nil, "b": "", "c": "1"]) == "?c=1")
    #expect(ConsoleAPI.queryString([:]).isEmpty)
}

@Test func aCliWithoutTheVerbSaysUpdateTheCliRatherThanReportingAConsoleFailure() async {
    // `packages/cli/src/main.ts`'s default branch: exit 2, `unknown command`.
    let runner = StubRunner(result: CommandResult(exitCode: 2, stdout: "", stderr: "unknown command: console\n"))
    let api = ConsoleAPI(cli: stubCLI(runner))
    guard case .failure(let error) = await api.identity() else { Issue.record("a stale CLI answered"); return }
    guard case .cliUnavailable(let detail) = error else { Issue.record("not read as a stale CLI: \(error)"); return }
    #expect(detail.contains("console call"))
    #expect(detail.contains("update it"))
    // The install works; this app's view of it does not — so the section is
    // unreachable rather than the console being blamed.
    #expect(!ConsoleReachability.after(error).allowsDecisions)
}

@Test func anUnmintedTokenAndANonLoopbackConsoleAreNotDressedAsRefusals() async {
    for stderr in [
        "metistry console call: METISTRY_LOCAL_OWNER_TOKEN is not set (env, <instance>/state/.env, or the login Keychain) — `metistry secrets sync --to env` mints one",
        "metistry console call: http://console.example is not loopback — the local owner token this verb presents is minted for THIS machine only",
    ] {
        let error = ConsoleError.fromConsoleCall(stderr: stderr, exitCode: 1)
        guard case .notConfigured(let detail) = error else {
            Issue.record("not read as an unconfigured door: \(error)"); return
        }
        // The CLI's own sentence, unedited, because it already names the fix.
        #expect(detail.contains("mints one") || detail.contains("THIS machine only"))
        #expect(error.httpStatus == nil)
    }
}

@Test func anUnreachableConsoleAndAProcessThatWouldNotStartAreBothUnreachable() async {
    let refused = ConsoleError.fromConsoleCall(
        stderr: "metistry console call: console unreachable at http://127.0.0.1:8080: connect ECONNREFUSED 127.0.0.1:8080",
        exitCode: 1
    )
    guard case .transport(let detail) = refused else { Issue.record("not read as transport"); return }
    #expect(detail.contains("ECONNREFUSED"))

    let api = ConsoleAPI(cli: stubCLI(ThrowingStubRunner()))
    guard case .failure(let error) = await api.identity() else { Issue.record("a dead runner answered"); return }
    #expect(error.localizedDescription.contains("could not run `metistry console call`"))
    #expect(!ConsoleReachability.after(error).allowsDecisions)
}

@Test func anExitZeroThatPrintsSomethingUnreadableIsAContractDisagreementNotAnOutage() async {
    let runner = StubRunner(result: CommandResult(exitCode: 0, stdout: "hello\n", stderr: ""))
    let api = ConsoleAPI(cli: stubCLI(runner))
    guard case .failure(let error) = await api.identity() else { Issue.record("prose decoded"); return }
    guard case .undecodable(let detail) = error else { Issue.record("not undecodable: \(error)"); return }
    #expect(detail.contains("GET /api/identity"))
    // Degraded, not unreachable: something answered, and it is the shape that
    // is wrong.
    guard case .degraded = ConsoleReachability.after(error) else {
        Issue.record("an unreadable reply was not read as degraded"); return
    }
}

// MARK: - The two cursors

@Test func theFeedsSinceIsInclusiveSoTheMergeDeduplicatesOnRefTsAndKind() {
    let first = ActivityFeed(rows: [
        ActivityFeedRow(ts: "2026-09-18T09:00:02.000Z", kind: "turn", ref: "runs:9001"),
        ActivityFeedRow(ts: "2026-09-18T09:00:01.000Z", kind: "capture", ref: "inbox:42"),
    ], asOf: "2026-09-18T09:00:02.500Z")
    #expect(first.cursor == "2026-09-18T09:00:02.000Z")

    // The `since` page repeats the boundary row — inclusive on purpose, because
    // two rows can share a microsecond across two branches of the union and a
    // strict `>` would drop the second forever.
    let next = ActivityFeed(rows: [
        ActivityFeedRow(ts: "2026-09-18T09:00:03.000Z", kind: "tool", ref: "runs:9002"),
        ActivityFeedRow(ts: "2026-09-18T09:00:02.000Z", kind: "turn", ref: "runs:9001"),
    ], asOf: "2026-09-18T09:00:03.500Z")

    let merged = first.merging(next)
    #expect(merged.rows.count == 3)
    #expect(merged.rows.map(\.ts) == [
        "2026-09-18T09:00:03.000Z", "2026-09-18T09:00:02.000Z", "2026-09-18T09:00:01.000Z",
    ])
    #expect(merged.asOf == "2026-09-18T09:00:03.500Z")

    // Two events on ONE work row are two events: `ref` alone is not the key.
    let twoOnOne = ActivityFeed(rows: [
        ActivityFeedRow(ts: "2026-09-18T09:00:04.000Z", kind: "work_history", ref: "work:214"),
        ActivityFeedRow(ts: "2026-09-18T09:00:05.000Z", kind: "work_history", ref: "work:214"),
    ])
    #expect(ActivityFeed(rows: []).merging(twoOnOne).rows.count == 2)
}

@Test func aSinceCursorOnTheQueueTeachesItWhatWasSettledWhileItWasAway() {
    let now = Date(timeIntervalSince1970: 1_780_000_000)
    let onScreen = RequestPage(proposals: [
        RequestRow(id: 19, ts: "2026-09-18T09:00:03.000Z", kind: "decision"),
        RequestRow(id: 18, ts: "2026-09-18T09:00:02.000Z", kind: "knowledge"),
        RequestRow(id: 17, ts: "2026-09-18T09:00:01.000Z", kind: "improvement"),
    ], cursor: "2026-09-18 09:00:03+00|19")

    // Answered on the phone, and snoozed from here before the reconnect.
    let changed = RequestPage(proposals: [
        RequestRow(id: 17, ts: "2026-09-18T09:00:01.000Z", kind: "improvement", decision: "allow", decidedAt: "2026-09-18T09:05:00.000Z"),
        RequestRow(id: 18, ts: "2026-09-18T09:00:02.000Z", kind: "knowledge", snoozedUntil: ISO8601DateFormatter().string(from: now.addingTimeInterval(7200))),
        RequestRow(id: 20, ts: "2026-09-18T09:06:00.000Z", kind: "report"),
    ], cursor: "2026-09-18 09:06:00+00|20", more: false)

    let merged = onScreen.merging(changed, now: now)
    // 17 was settled and 18 was put down; both leave. 20 arrived. 19 stands.
    #expect(merged.proposals.map(\.id) == [20, 19])
    #expect(merged.cursor == "2026-09-18 09:06:00+00|20")
}

// MARK: - The stubs

/// A console that is not there: a `<METHOD> <path>` key and the bytes it
/// answers. An unlisted route is a 404 in the console's own envelope, so a test
/// that mistypes a path fails the way the console would.
private actor StubConsole: ConsoleCallTransport {
    private let routes: [String: Data]
    private(set) var calls: [String] = []
    private(set) var bodies: [String: Data] = [:]
    private(set) var idempotencyKeys: [String: String] = [:]

    init(_ routes: [String: Data]) {
        self.routes = routes
    }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let key = "\(method) \(path)"
        calls.append(key)
        if let body { bodies[key] = body }
        if let idempotencyKey { idempotencyKeys[key] = idempotencyKey }
        guard let data = routes[key] else {
            return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(
                code: "not_found",
                message: "no such route in this stub: \(key)"
            )))
        }
        return .success(data)
    }
}

/// A `metistry` that is not there, recording exactly what it was asked to run.
@MainActor
private final class StubRunner: CommandRunner {
    let result: CommandResult
    private(set) var invocations: [[String]] = []
    private(set) var standardInputs: [String?] = []

    nonisolated init(result: CommandResult) { self.result = result }

    nonisolated func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        await record(arguments, standardInput)
        return result
    }

    private func record(_ argv: [String], _ input: String?) {
        invocations.append(argv)
        standardInputs.append(input)
    }
}

private struct ThrowingStubRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        throw CommandRunnerError.notExecutable(executable)
    }
}

private func stubCLI(_ runner: any CommandRunner) -> MetistryCLI {
    MetistryCLI(
        runtime: MetistryRuntime(
            source: .checkout,
            executable: URL(fileURLWithPath: "/usr/bin/node"),
            leadingArguments: ["/src/packages/cli/dist/main.js"],
            productDir: URL(fileURLWithPath: "/src")
        ),
        runner: runner
    )
}

// MARK: - The fixtures, by hand, from the documented shapes

enum Fixtures {
    static func bytes(_ text: String) -> Data { Data(text.utf8) }

    static let identity = bytes("""
    {"instance_id":"8b6a3a2e-0000-4000-8000-000000000001","name":"Aide","icon":"🦉",
     "capabilities":["artifacts","capture","dispatch","knowledge","queries","tasks"],
     "version":"0.8.0","as_of":"2026-09-18T09:00:00.001Z"}
    """)

    static let whoami = bytes("""
    {"principal":"user","via":"local_owner_token","management":true,
     "origin":"https://studio.example","as_of":"2026-09-18T09:00:00.002Z"}
    """)

    /// `{rows, as_of}` with activity_feed's own `SELECT` list: ts, kind,
    /// "group", actor, subject, detail, ref, turn_id.
    static let feed = bytes("""
    {"rows":[
      {"ts":"2026-09-18T09:00:02.000Z","kind":"turn","group":"run","actor":"assistant",
       "subject":"turn","detail":"turn anthropic/claude-opus-4 $0.001234","ref":"runs:9001","turn_id":"t-77"},
      {"ts":"2026-09-18T09:00:01.000Z","kind":"capture","group":"capture","actor":"shortcut",
       "subject":"renew the wildcard cert","detail":"shortcut · new","ref":"inbox:42","turn_id":null},
      {"ts":"2026-09-18T09:00:00.000Z","kind":"proposal","group":"proposal","actor":"inbox-drain",
       "subject":"knowledge","detail":"proposed a page","ref":"proposals:18","turn_id":null}
     ],"as_of":"2026-09-18T09:00:02.500Z"}
    """)

    /// One `access_request` as the console serves it (ruled 2026-09-19).
    static let accessRequests = bytes("""
    {"proposals":[
      {"id":21,"ts":"2026-09-19T09:00:00.001Z","kind":"access_request","source_agent":"devin",
       "trust":"external","payload":{"title":"devin asks to read Areas/Health","area":"Areas/Health",
       "reason":"knowledge_read pointed me here","current_tier":"index","current_areas":[]},
       "decision":"pending","decided_at":null,"work_id":null,"snoozed_until":null,
       "cursor":"2026-09-19 09:00:00.001+00|21"}
     ],"cursor":"2026-09-19 09:00:00.001+00|21","more":false}
    """)

    static let proposals = bytes("""
    {"proposals":[
      {"id":17,"ts":"2026-09-18T09:00:00.001Z","kind":"improvement","source_agent":"reply-review",
       "trust":"internal","payload":{"title":"Reply quality: 2 replies flagged"},
       "decision":"pending","decided_at":null,"work_id":null,"snoozed_until":null,
       "cursor":"2026-09-18 09:00:00.001+00|17"},
      {"id":18,"ts":"2026-09-18T09:00:00.002Z","kind":"knowledge","source_agent":"inbox-drain",
       "trust":"internal","payload":{"title":"a page about certs",
       "suggested_work":{"title":"renew the wildcard cert"}},
       "decision":"pending","decided_at":null,"work_id":null,"snoozed_until":null,
       "cursor":"2026-09-18 09:00:00.002+00|18"},
      {"id":19,"ts":"2026-09-18T09:00:00.003Z","kind":"decision","source_agent":"console",
       "trust":"internal","payload":{"title":"Devin wants to enrol","options":["approve","deny"],
       "enroll":{"agent":"devin"}},
       "decision":"pending","decided_at":null,"work_id":null,"snoozed_until":null,
       "cursor":"2026-09-18 09:00:00.003+00|19"}
     ],"cursor":"2026-09-18 09:00:00.003+00|19","more":false}
    """)

    static let batch = bytes("""
    {"results":[{"id":17,"ok":true},{"id":18,"ok":true},
      {"id":19,"ok":false,"error":{"code":"conflict","message":"already decided"},
       "reason":"already_decided","decision":"allow","decided_at":"2026-09-18T08:59:00.000Z"}]}
    """)

    /// board.yaml's final `SELECT`: "column", id, title, kind, project, owner,
    /// claimed_by, lease_expires_at, age_hours, last_report_at, reported,
    /// escalated, external_ref, artifact, has_thread, thread_count,
    /// blocked_by, blocked_by_task, blocked_by_task_open, status, due,
    /// updated_at.
    static let board = bytes("""
    {"rows":[
      {"column":"backlog","id":301,"title":"write the release note","kind":"task","project":"metistry",
       "owner":null,"claimed_by":null,"lease_expires_at":null,"age_hours":1.0,"last_report_at":null,
       "escalated":false,"external_ref":null,"artifact":null,"has_thread":false,"thread_count":0,
       "reported":false,"blocked_by":null,"blocked_by_task":null,"blocked_by_task_open":null,
       "status":"open","due":null,"updated_at":"2026-09-18T08:00:00.000Z"},
      {"column":"assigned","id":302,"title":"review the wireframes","kind":"review","project":"metistry",
       "owner":"drey","claimed_by":null,"lease_expires_at":null,"age_hours":12.5,"last_report_at":null,
       "escalated":false,"external_ref":null,"artifact":"metistry/app-ux","has_thread":false,"thread_count":0,
       "reported":false,"blocked_by":null,"blocked_by_task":null,"blocked_by_task_open":null,
       "status":"open","due":null,"updated_at":"2026-09-18T07:00:00.000Z"},
      {"column":"in_progress","id":214,"title":"renew the wildcard cert","description":"The *.home cert lapses on the 20th; the proxy reloads it.","kind":"task","project":"ops",
       "owner":"drey","claimed_by":"drey","lease_expires_at":"2026-09-18T10:00:00.000Z","age_hours":4.5,
       "last_report_at":null,"escalated":true,"external_ref":"gh:owner/repo#41","artifact":null,
       "has_thread":true,"thread_count":7,"reported":false,
       "blocked_by":null,"blocked_by_task":null,"blocked_by_task_open":null,
       "status":"in_progress","due":"2026-09-17","updated_at":"2026-09-18T09:00:00.000Z"},
      {"column":"blocked","id":215,"title":"decide the icon","kind":"task","project":"metistry",
       "owner":null,"claimed_by":null,"lease_expires_at":null,"age_hours":30.0,"last_report_at":null,
       "escalated":true,"external_ref":null,"artifact":null,"has_thread":false,"thread_count":0,
       "reported":false,"blocked_by":"vault:Journal/2026-09-18.md#^mt-7f3k2a",
       "blocked_by_task":"Send the icon brief","blocked_by_task_open":true,
       "status":"blocked","due":null,"updated_at":"2026-09-17T09:00:00.000Z"},
      {"column":"done","id":217,"title":"measure the cache hit rate","kind":"task","project":"metistry",
       "owner":null,"claimed_by":null,"lease_expires_at":null,"age_hours":80.0,"last_report_at":"2026-09-16T10:00:00.000Z",
       "escalated":false,"external_ref":null,"artifact":null,"has_thread":false,"thread_count":0,
       "reported":true,"blocked_by":null,"blocked_by_task":null,"blocked_by_task_open":null,
       "status":"closed","due":null,"updated_at":"2026-09-16T10:00:00.000Z"},
      {"column":"done","id":216,"title":"ship the compute routes","kind":"task","project":"metistry",
       "owner":null,"claimed_by":null,"lease_expires_at":null,"age_hours":72.0,"last_report_at":null,
       "escalated":false,"external_ref":null,"artifact":null,"has_thread":false,"thread_count":0,
       "reported":false,"blocked_by":null,"blocked_by_task":null,"blocked_by_task_open":null,
       "status":"closed","due":null,"updated_at":"2026-09-16T09:00:00.000Z"}
     ],"as_of":"2026-09-18T09:00:03.000Z"}
    """)

    static let rooms = bytes("""
    {"rows":[
      {"thread_id":"cmt_01M3FYT8PDPMAX22C9X769GV7Q","anchor":"work","project":"ops","title":"work #214 — renew the wildcard cert",
       "work_id":214,"artifact_id":null,"version_id":null,"path":null,"state":"open",
       "resolved_by":null,"resolved_at":null,"messages":7,
       "participants":[{"principal":"drey","kind":"agent"},{"principal":"user","kind":"user"}],
       "agent_tail":3,"cap":10,"last_at":"2026-09-18T08:55:00.000Z","last_author":"drey",
       "escalated":true,"reason":"ping_pong","proposal_id":88}
     ],"as_of":"2026-09-18T09:00:04.000Z"}
    """)

    /// `listAgents`: grants, autonomy, revoked, remote, approved_at, pending,
    /// and `scope` — the row rendered (`core`'s `describeScope`), `autonomy.detailed`
    /// included (C46/C47: `effectiveActionsDetailed`, `docs/ops/console-api.md`).
    static let agents = bytes("""
    {"agents":[
      {"id":"drey","display_name":"Drey","kind":"external",
       "grants":{"tier":"read","areas":["Areas/Health"]},"projects":["ops"],
       "autonomy":{"level":"propose","max_open_bundles":2},
       "scope":{"role":"agent","autonomy":{"level":"propose",
         "actions":{"dispatch":"propose","task_update":"propose","comment":"propose","capture":"deny"},
         "detailed":{
           "dispatch":{"mode":"propose","source":"defaulted","ceiling":"propose"},
           "task_update":{"mode":"propose","source":"set","ceiling":"propose","asked":"propose"},
           "comment":{"mode":"propose","source":"clamped","ceiling":"propose","asked":"allow"},
           "capture":{"mode":"deny","source":"set","ceiling":"propose","asked":"deny"}}}},
       "created_at":"2026-09-01T00:00:00.000Z","last_seen_at":"2026-09-18T08:59:00.000Z",
       "revoked":false,"remote":false,"approved_at":"2026-09-01T00:00:00.000Z","pending":false},
      {"id":"devin","display_name":"Devin","kind":"external",
       "grants":{"tier":"none","areas":[]},"projects":[],
       "autonomy":{"level":"observe"},
       "created_at":"2026-09-18T08:00:00.000Z","last_seen_at":null,
       "revoked":false,"remote":true,"approved_at":null,"pending":true}
     ]}
    """)

    static let presence = bytes("""
    {"rows":[
      {"id":"drey","display_name":"Drey","kind":"external","last_seen_at":"2026-09-18T08:59:00.000Z",
       "projects":["ops"],"state":"working","spend_today_usd":0.42,
       "current_claims":[{"id":214,"title":"renew the wildcard cert","lease_expires_at":"2026-09-18T10:00:00.000Z"}],
       "interrupted_claims":[],"blocked_bundles":[]},
      {"id":"devin","display_name":"Devin","kind":"external","last_seen_at":null,
       "projects":[],"state":"interrupted","spend_today_usd":0.0,
       "current_claims":[],
       "interrupted_claims":[{"id":220,"title":"index the vault","lease_expires_at":"2026-09-18T07:00:00.000Z"}],
       "blocked_bundles":[]}
     ],"as_of":"2026-09-18T09:00:05.000Z"}
    """)

    /// `compute show --json`'s report plus `spend`, `writable` and `as_of`.
    static let compute = bytes("""
    {"file":"/i/.metistry/compute.yaml","files":["/i/.metistry/compute.yaml"],
     "instance_file":"/i/.metistry/compute.yaml",
     "providers":[{"name":"openrouter","kind":"openai","locality":"off_machine",
       "base_url":"https://openrouter.ai/api/v1","zdr":true,
       "secret":"METISTRY_OPENROUTER_API_KEY","secret_present":true,
       "models_assigned":["anthropic/claude-opus-4"],
       "budget":{"daily_usd":5,"monthly_usd":60,"action":"stop"}}],
     "assignments":[{"target":"default","provider":"openrouter","model":"anthropic/claude-opus-4",
       "effort":"medium","warn_non_zdr":false}],
     "assigns_nothing":false,
     "instance_budget":{"daily_usd":10,"monthly_usd":120,"action":"warn"},
     "spend":{"instance":{"daily":1.25,"monthly":18.4},
              "providers":{"openrouter":{"daily":1.25,"monthly":18.4}}},
     "writable":true,"as_of":"2026-09-18T09:00:06.000Z"}
    """)

    /// The same report where the `spend` named query is not loaded, and the
    /// console has no instance mount to write through.
    static let computeNoSpend = bytes("""
    {"files":[],"instance_file":"/i/.metistry/compute.yaml","providers":[],"assignments":[],
     "assigns_nothing":true,"spend":null,"writable":false,"as_of":"2026-09-18T09:00:06.000Z"}
    """)

    static let searchText = """
    {"q":"sleep","mode":"keyword","hits":[
      {"path":"Areas/Health/sleep.md","title":"Sleep","description":"what works",
       "snippet":"…eight hours…","score":0.87,"source":"keyword"},
      {"path":"Journal/2026-09-01.md","title":null,"description":null,
       "snippet":"…slept badly…","score":0.41,"source":"keyword"}],
     "degraded":"keyword only — the embedder is down","as_of":"2026-09-18T09:00:07.000Z"}
    """
    static let search = bytes(searchText)

    static let page = bytes("""
    {"path":"Areas/Health/sleep.md","content":"# Sleep\\n\\nEight hours, dark room.\\n",
     "sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
     "bytes":41,"as_of":"2026-09-18T09:00:08.000Z"}
    """)

    /// `knowledge_pages`' columns. A full window (`pages.count == limit`), so
    /// there may be more — the route states no total, on purpose.
    static let pagesText = """
    {"pages":[
      {"path":"Areas/Health/2026/taper.md","area":"Areas/Health","title":"taper","description":null,
       "status":"dirty","modified":"2026-09-18T08:40:00.000Z","indexed_at":"2026-09-18T08:41:00.000Z"},
      {"path":"Areas/Health/sleep.md","area":"Areas/Health","title":"Sleep","description":"what works",
       "status":"clean","modified":"2026-09-17T19:02:00.000Z","indexed_at":"2026-09-17T19:05:00.000Z"}],
     "area":null,"prefix":"Areas/Health","limit":2,"offset":0,"as_of":"2026-09-18T09:00:11.000Z"}
    """
    static let pages = bytes(pagesText)

    /// The last window: shorter than `limit`, and a vault-root file, whose
    /// area is honestly `null` rather than absent.
    static let pagesTailText = """
    {"pages":[{"path":"now.md","area":null,"title":"Now","description":null,"status":"clean",
      "modified":"2026-09-18T07:00:00.000Z","indexed_at":"2026-09-18T07:01:00.000Z"}],
     "area":null,"prefix":null,"limit":100,"offset":0,"as_of":"2026-09-18T09:00:12.000Z"}
    """
    static let pagesTail = bytes(pagesTailText)

    /// `knowledge_page_links`' columns: both directions in one list, an
    /// unresolved target kept and marked, a full window (no total, ever).
    static let pageLinks = bytes("""
    {"path":"Areas/Health/sleep.md","links":[
      {"direction":"outgoing","path":"Areas/Health/taper.md","kind":"wikilink","title":"Taper",
       "description":"coming off it","status":"clean","resolved":true},
      {"direction":"outgoing","path":"Areas/Health/nowhere.md","kind":"wikilink","title":"nowhere",
       "description":null,"status":null,"resolved":false},
      {"direction":"incoming","path":"Journal/2026-09-18.md","kind":"wikilink","title":"2026-09-18",
       "description":null,"status":"clean","resolved":true}],
     "limit":3,"offset":0,"as_of":"2026-09-19T09:00:13.000Z"}
    """)

    /// The last window, and the pair a path-keyed list would collapse: the
    /// same target reached as an embed and as a wikilink is two edges.
    static let pageLinksTailText = """
    {"path":"Areas/Health/sleep.md","links":[
      {"direction":"outgoing","path":"Areas/Health/taper.md","kind":"embed","title":"Taper",
       "description":null,"status":"clean","resolved":true},
      {"direction":"outgoing","path":"Areas/Health/taper.md","kind":"wikilink","title":"Taper",
       "description":null,"status":"clean","resolved":true}],
     "limit":100,"offset":0,"as_of":"2026-09-19T09:00:14.000Z"}
    """
    static let pageLinksTail = bytes(pageLinksTailText)

    static let commands = bytes("""
    {"commands":[
      {"id":"/note","description":"File it and acknowledge — no model runs",
       "routes_to":"note","tier":null,"model":null,"effort":null,"query":null,"takes_argument":true},
      {"id":"/status","description":"Work items not yet closed, newest first",
       "routes_to":"fast_path","tier":null,"model":null,"effort":null,
       "query":"open_work","takes_argument":false}],
     "agents":[{"id":"@drey","description":"Drey","kind":"external","present":true,
       "last_seen_at":"2026-09-18T08:59:00.000Z"}],
     "as_of":"2026-09-18T09:00:09.000Z"}
    """)

    /// `run_detail`'s columns. `cost_usd`, `shadow_agreement` and
    /// `shadow_answer_similarity` are Postgres `numeric` and therefore STRINGS.
    static let run = bytes("""
    {"run":{"id":9001,"ts":"2026-09-18T09:00:02.000Z","started_at":"2026-09-18T09:00:00.000Z",
      "finished_at":"2026-09-18T09:00:02.000Z","component":"engine","kind":"turn",
      "session_id":"s-1","tool":null,"ok":true,"error":null,"duration_ms":2000,
      "provider":"openrouter","model":"anthropic/claude-opus-4",
      "tokens_in":1200,"tokens_out":340,"cache_read_tokens":800,"cache_write_tokens":0,
      "cost_usd":"0.001234","meta":{"turn_id":"t-77"},
      "shadow_provider":"lmstudio","shadow_model":"qwen3-30b","shadow_agreement":"0.917",
      "shadow_cost_usd":"0.000000","shadow_same_tool_sequence":true,
      "shadow_answer_similarity":"0.88","shadow_error":null,
      "tool_calls":[
        {"id":9002,"ts":"2026-09-18T09:00:01.000Z","component":"mcp-brain","tool":"knowledge_search",
         "ok":true,"error":null,"duration_ms":120},
        {"id":9003,"ts":"2026-09-18T09:00:01.500Z","component":"mcp-brain","tool":"tasks_update",
         "ok":false,"error":"held by drey","duration_ms":18}],
      "tool_calls_total":2,"tool_calls_failed":1},
     "as_of":"2026-09-18T09:00:10.000Z"}
    """)
}
