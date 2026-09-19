// `InstanceStore`'s state machine, and the pins beside it.
//
// The four states are the whole contract — loading, loaded, failed, stale —
// and the two things that must never happen are what most of these tests are:
// a pane that BLANKS because a refresh failed, and a decision control that
// looks live while nothing is answering (P5 and O3). The console is a
// `ScriptedConsole`: an in-process transport with a script per route, so every
// transition is driven by something the console actually said.

import Foundation
import Testing

@testable import MetistryKit

// MARK: - Loading, loaded, failed, stale

@MainActor
@Test func aFirstLoadIsTheOnlyStateAProgressViewIsHonestUnder() async {
    let console = ScriptedConsole(["GET /api/q/activity_feed?hours=24&limit=100": .bytes(Fixtures.feed)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())

    #expect(store.feed.isFirstLoad)
    #expect(!store.feed.hasValue)

    await store.reloadFeed()
    #expect(store.feed.state == .loaded)
    #expect(store.feed.value?.rows.count == 3)
    #expect(!store.feed.isFirstLoad)
    #expect(!store.feed.isRefreshing)
    // `as_of` is the CONSOLE's claim about the data, not the moment the app
    // asked — those are two different facts and both are kept.
    #expect(store.feed.asOf == WireTime.date("2026-09-18T09:00:02.500Z"))
    #expect(store.feed.lastAttemptAt != nil)
    #expect(store.feed.problem == nil)
}

@MainActor
@Test func aRefreshThatFailsGoesStaleAndKeepsWhatIsOnScreen() async {
    let console = ScriptedConsole(["GET /api/q/activity_feed?hours=24&limit=100": .bytes(Fixtures.feed)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadFeed()
    #expect(store.feed.state == .loaded)

    await console.script("GET /api/q/activity_feed?hours=24&limit=100", .fail(.transport("connect ECONNREFUSED 127.0.0.1:8080")))
    await store.reloadFeed()

    // Stale, not failed: the rows are still the last true thing the console
    // said, and the section says they are old. A blank pane over a working
    // screen is what P5 forbids.
    guard case .stale(let detail) = store.feed.state else {
        Issue.record("a failed refresh over a loaded section was not stale: \(store.feed.state)"); return
    }
    #expect(detail.contains("ECONNREFUSED"))
    #expect(store.feed.value?.rows.count == 3)
    #expect(store.feed.problem?.contains("ECONNREFUSED") == true)
    #expect(store.consecutiveFailures == 1)
}

@MainActor
@Test func aFirstLoadThatFailsHasNothingToKeepAndSaysSo() async {
    let console = ScriptedConsole(["GET /api/identity": .fail(.transport("connect ECONNREFUSED 127.0.0.1:8080"))])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.refreshIdentity()

    guard case .failed = store.identity.state else {
        Issue.record("a first load with nothing to keep was not failed"); return
    }
    #expect(!store.identity.hasValue)
    #expect(!store.identity.allowsDecisions)
}

@MainActor
@Test func aBackgroundRefreshNeverLeavesLoadedSoNothingSpins() async {
    let console = ScriptedConsole([
        "GET /api/q/board": .bytes(Fixtures.board),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.refreshBoard()
    #expect(store.board.state == .loaded)

    // P2, as a property of the type rather than a note in a view: a refresh
    // over data already on screen sets a flag beside the state, and the state
    // stays `.loaded`. There is no fifth state a view could draw a spinner
    // from. (The flag is false again by the time the await returns, which is
    // why the assertion is about the STATE.)
    await store.refreshBoard(background: true)
    #expect(store.board.state == .loaded)
    #expect(!store.board.isRefreshing)

    // And on a section with nothing yet, `background: true` is still a first
    // load — there is nothing to be calm about.
    var empty = Section<Board>()
    empty.beginLoading(background: true)
    #expect(empty.state == .loading)

    var filled = Section<Board>()
    filled.loaded(Fixtures.decodedBoard, asOf: nil)
    filled.beginLoading(background: true)
    #expect(filled.state == .loaded)
    #expect(filled.isRefreshing)
}

@MainActor
@Test func aStoreWithNoRuntimeSaysSoRatherThanAnsweringTheQuestion() async {
    let store = InstanceStore(api: nil, instanceID: "i-1", defaults: scratchDefaults())
    #expect(!store.hasClient)
    await store.refreshIdentity()
    #expect(store.identity.state == .failed(CLIReadError.noRuntime.localizedDescription))
    #expect(!store.identity.allowsDecisions)
}

// MARK: - O3: nothing is decided while nothing is answering

@MainActor
@Test func decisionControlsAreDisabledWhileUnreachableAndTheRefusalIsExplainedHere() async {
    let console = ScriptedConsole([
        "GET /api/proposals": .fail(.http(status: 401, envelope: ConsoleErrorEnvelope(
            code: "unauthenticated", message: "authentication required"
        ))),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadRequests()

    // A 401 is the door refusing the owner, so nothing on the owner surface
    // can be done from here — O3 applies even though the Mac app is local-only.
    #expect(!store.requests.allowsDecisions)
    #expect(store.reachability == .unreachable("authentication required"))

    let row = RequestRow(id: 17, ts: "2026-09-18T09:00:00.001Z", kind: "improvement")
    guard case .failure(let error) = await store.answer(row, .approve) else {
        Issue.record("an answer was sent while the console was unreachable"); return
    }
    // Refused HERE, in a sentence, rather than as a request that fails
    // somewhere the user cannot see it (P4).
    #expect(error.localizedDescription.contains("not answering"))
    #expect(await console.calls.filter { $0.hasPrefix("POST") }.isEmpty)
}

@MainActor
@Test func aVerbThatCannotBeBatchedIsRefusedWithTheFieldNamedAndNothingIsSent() async {
    let console = ScriptedConsole(["GET /api/proposals": .bytes(Fixtures.proposals)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadRequests()
    #expect(store.requests.allowsDecisions)

    guard case .failure(let error) = await store.answerMany([17, 18], .approve) else {
        Issue.record("Approve was batched"); return
    }
    #expect(error.httpStatus == 400)
    #expect(error.namedField(among: ["decision", "ids"]) == "decision")
    #expect(error.refusal?.contains("one at a time") == true)
    #expect(await console.calls.filter { $0.contains("batch") }.isEmpty)

    // Later, Skip and Decline do go.
    await console.script("POST /api/proposals/batch", .bytes(Fixtures.batch))
    guard case .success = await store.answerMany([17, 18, 19], .skip) else {
        Issue.record("Skip was refused"); return
    }
}

@MainActor
@Test func theBellsCountIsThePendingRowsAndASnoozeIsNotOneOfThem() async {
    let console = ScriptedConsole(["GET /api/proposals": .bytes(Fixtures.proposals)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadRequests()
    // The only badge in the product (P2) — it moved to the bell, it did not
    // multiply.
    #expect(store.pendingRequestCount == 3)
}

// MARK: - Degraded is a fact the section states

@MainActor
@Test func computeThatCannotBeWrittenHereSaysSoBeforeAnythingIsSubmitted() async {
    let console = ScriptedConsole(["GET /api/compute": .bytes(Fixtures.computeNoSpend)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.refreshCompute()

    // Loaded — the report arrived and is true. Degraded — the write verbs will
    // not work here, which is a fact the pane states rather than discovers on
    // submit.
    #expect(store.compute.state == .loaded)
    #expect(store.compute.value?.writable == false)
    guard case .degraded(let note) = store.compute.reachability else {
        Issue.record("writable:false was not reported as degraded"); return
    }
    #expect(note.contains("read-only here"))
    // Degraded is still reachable: other controls are not disabled by it.
    #expect(store.compute.allowsDecisions)
}

@MainActor
@Test func searchCarriesTheBridgesDegradedNoteWithoutHidingTheResults() async {
    let console = ScriptedConsole(["GET /api/knowledge/search?q=sleep": .bytes(Fixtures.search)])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.search("sleep")

    #expect(store.knowledge.state == .loaded)
    #expect(store.knowledge.value?.hits.count == 2)
    // "keyword only — the embedder is down" is a fact the UI states, not an
    // error it swallows.
    #expect(store.knowledge.reachability == .degraded("keyword only — the embedder is down"))

    // An empty query is not a search: it clears rather than asking.
    await store.search("   ")
    #expect(store.knowledge.isFirstLoad)
    #expect(await console.calls.filter { $0.contains("knowledge/search") }.count == 1)
}

@MainActor
@Test func theVaultListAndTheSearchResultsAreTwoSectionsSoOneNeverBlanksTheOther() async {
    let console = ScriptedConsole([
        "GET /api/knowledge/pages?limit=2&prefix=Areas%2FHealth": .bytes(Fixtures.pages),
        "GET /api/knowledge/search?q=sleep": .bytes(Fixtures.search),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.refreshPages(prefix: "Areas/Health", limit: 2)

    #expect(store.pages.state == .loaded)
    #expect(store.pages.value?.pages.map(\.path) == ["Areas/Health/2026/taper.md", "Areas/Health/sleep.md"])
    #expect(store.pages.value?.nextOffset == 2)  // a full window, and there is no total to ask for

    // Browsing the vault and searching it are two questions: a search must
    // not blank the list you were reading.
    await store.search("sleep")
    #expect(store.knowledge.value?.hits.count == 2)
    #expect(store.pages.value?.pages.count == 2)

    // …and pointing the app at a second instance drops both, like every
    // other section — one instance's notes are not another's.
    store.adopt(api: nil, instanceID: "i-2", defaults: scratchDefaults())
    #expect(store.pages.isFirstLoad)
    #expect(store.knowledge.isFirstLoad)
}

// MARK: - The two cursors, from the store's side

@MainActor
@Test func aFeedRefreshAsksFromTheNewestRowItHasAndFoldsTheAnswerIn() async {
    let console = ScriptedConsole([
        "GET /api/q/activity_feed?hours=24&limit=100": .bytes(Fixtures.feed),
        "GET /api/q/activity_feed?limit=100&since=2026-09-18T09%3A00%3A02.000Z": .bytes(Fixtures.feedSince),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadFeed()
    await store.refreshFeed()

    // The `since` page repeated the boundary row and added one. Four rows, not
    // five, and newest first.
    #expect(store.feed.value?.rows.count == 4)
    #expect(store.feed.value?.rows.first?.ref == "runs:9002")
    #expect(store.feed.state == .loaded)

    // With nothing on screen there is no cursor to send, so a refresh is a
    // reload rather than a request with an empty `since`.
    let fresh = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await fresh.refreshFeed()
    #expect(fresh.feed.value?.rows.count == 3)
}

@MainActor
@Test func aQueueRefreshAsksWithTheOpaqueCursorItWasGiven() async {
    let console = ScriptedConsole([
        "GET /api/proposals": .bytes(Fixtures.proposals),
        "GET /api/proposals?since=2026-09-18%2009%3A00%3A00.003%2B00%7C19": .bytes(Fixtures.proposalsSince),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: scratchDefaults())
    await store.reloadRequests()
    await store.refreshRequests()

    // 17 came back decided and leaves the queue; 20 arrived. The cursor is
    // handed back verbatim — a `+` and a `|` in it are percent-encoded, never
    // parsed.
    #expect(store.requests.value?.proposals.map(\.id) == [20, 19, 18])
    #expect(store.pendingRequestCount == 3)
}

// MARK: - Switching instance

@MainActor
@Test func adoptingAnotherInstanceDropsEverySectionAndItsPins() async {
    let defaults = scratchDefaults()
    let console = ScriptedConsole([
        "GET /api/identity": .bytes(Fixtures.identity),
        "GET /api/q/board": .bytes(Fixtures.board),
    ])
    let store = InstanceStore(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: defaults)
    await store.refreshIdentity()
    await store.refreshBoard()
    store.pins.pin(.project("ops"))
    #expect(store.identity.hasValue)
    #expect(store.pins.items.count == 1)

    store.adopt(api: ConsoleAPI(transport: console), instanceID: "i-2", defaults: defaults)
    // A value belongs to the install it was asked about. Showing it beside a
    // different one is the thing this must never do.
    #expect(!store.identity.hasValue)
    #expect(!store.board.hasValue)
    #expect(store.identity.isFirstLoad)
    #expect(store.consecutiveFailures == 0)
    // And a pin points at something in ONE instance.
    #expect(store.pins.items.isEmpty)
    #expect(store.instanceID == "i-2")

    // Coming back finds the first instance's pins where they were left.
    store.adopt(api: ConsoleAPI(transport: console), instanceID: "i-1", defaults: defaults)
    #expect(store.pins.items.map(\.id) == ["project:ops"])
}

// MARK: - When to ask again

@Test func aViewsTaskCannotBecomeARequestOnEveryRedraw() {
    let policy = RefreshPolicy.feed
    let now = Date(timeIntervalSince1970: 1_780_000_000)
    #expect(policy.isDue(lastAttemptAt: nil, now: now))
    #expect(!policy.isDue(lastAttemptAt: now.addingTimeInterval(-1), now: now))
    #expect(policy.isDue(lastAttemptAt: now.addingTimeInterval(-21), now: now))

    // The backoff changes how often the app ASKS. It never changes what the
    // app claims — a stale section says it is stale at every interval.
    #expect(policy.nextDelay(consecutiveFailures: 0) == 20)
    #expect(policy.nextDelay(consecutiveFailures: 1) == 40)
    #expect(policy.nextDelay(consecutiveFailures: 4) == 300)     // the ceiling
    #expect(policy.nextDelay(consecutiveFailures: 400) == 300)
    #expect(!policy.isDue(lastAttemptAt: now.addingTimeInterval(-60), consecutiveFailures: 3, now: now))
}

// MARK: - Pins

@MainActor
@Test func pinsSurviveARelaunchInTheOrderTheyWerePutIn() {
    let defaults = scratchDefaults()
    let pins = PinnedItems(instanceID: "i-1", defaults: defaults)
    #expect(pins.isPersisted)

    pins.pin(.project("ops", displayName: "Ops"))
    pins.pin(.page("Areas/Health/sleep.md"))
    pins.pin(.search("wildcard cert"))
    pins.pin(.agent("drey", displayName: "Drey"))
    pins.pin(.board(project: "ops"))

    // The page's label is the leaf without its extension — what a person calls
    // a page.
    #expect(pins.items.map(\.displayName) == ["Ops", "sleep", "wildcard cert", "Drey", "Board — ops"])
    #expect(pins.items.map(\.kind) == [.project, .page, .search, .agent, .board])

    let reopened = PinnedItems(instanceID: "i-1", defaults: defaults)
    #expect(reopened.items == pins.items)
    // A pin holds a REFERENCE, not the object: the path, the slug, the query.
    #expect(reopened.items[1].reference == "Areas/Health/sleep.md")
}

@MainActor
@Test func pinningTwiceIsNotTwoRowsAndReorderTakesListsOwnArguments() {
    let pins = PinnedItems(instanceID: "i-1", defaults: scratchDefaults())
    pins.pin(.project("ops"))
    pins.pin(.project("ops"))
    // A sidebar with the same row twice is a bug the user cannot fix except by
    // unpinning both.
    #expect(pins.items.count == 1)

    pins.pin(.project("metistry"))
    pins.pin(.agent("drey"))
    pins.move(fromOffsets: IndexSet(integer: 2), toOffset: 0)
    #expect(pins.items.map(\.reference) == ["drey", "ops", "metistry"])

    pins.rename(id: "project:ops", to: "  Operations  ")
    #expect(pins.items[1].displayName == "Operations")
    // Renaming a shortcut must not repoint it.
    #expect(pins.items[1].reference == "ops")
    // An empty name is not a rename.
    pins.rename(id: "project:ops", to: "   ")
    #expect(pins.items[1].displayName == "Operations")

    pins.unpin(.project("ops"))
    #expect(pins.items.map(\.reference) == ["drey", "metistry"])
    pins.toggle(.project("ops"))
    #expect(pins.items.count == 3)
    pins.toggle(.project("ops"))
    #expect(pins.items.count == 2)
}

@MainActor
@Test func twoInstancesOnOneMacNeverSeeEachOthersPinsAndNothingIsWrittenUntilOneIsMade() {
    let suiteName = "com.foldedspacelabs.metistry.tests.pins.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }

    // Reading pins writes nothing.
    _ = PinnedItems(instanceID: "i-1", defaults: defaults)
    #expect((UserDefaults.standard.persistentDomain(forName: suiteName) ?? [:]).isEmpty)

    let first = PinnedItems(instanceID: "i-1", defaults: defaults)
    first.pin(.project("ops"))
    let second = PinnedItems(instanceID: "i-2", defaults: defaults)
    #expect(second.items.isEmpty)
    second.pin(.project("other"))
    #expect(PinnedItems(instanceID: "i-1", defaults: defaults).items.map(\.reference) == ["ops"])

    // One key per instance, and the key names the instance.
    let keys = Set((UserDefaults.standard.persistentDomain(forName: suiteName) ?? [:]).keys)
    #expect(keys == Set([
        PinnedItems.defaultsKey(instanceID: "i-1"),
        PinnedItems.defaultsKey(instanceID: "i-2"),
    ]))
    #expect(PinnedItems.defaultsKey(instanceID: "i-1") == "\(AppPreference.pinnedItemsPrefix.rawValue).i-1")

    // Unpinning the last one removes the key rather than leaving `[]` behind,
    // so the defaults domain carries only what the user actually chose.
    first.removeAll()
    #expect(!Set((UserDefaults.standard.persistentDomain(forName: suiteName) ?? [:]).keys)
        .contains(PinnedItems.defaultsKey(instanceID: "i-1")))
}

@MainActor
@Test func anUnstampedInstanceHoldsPinsInMemoryRatherThanUnderASharedKey() {
    let suiteName = "com.foldedspacelabs.metistry.tests.pins.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { UserDefaults.standard.removePersistentDomain(forName: suiteName) }

    let pins = PinnedItems(instanceID: nil, defaults: defaults)
    #expect(!pins.isPersisted)
    pins.pin(.project("ops"))
    #expect(pins.items.count == 1)
    // Filing them under a shared key would leak one install's sidebar into
    // another's, so nothing is filed at all.
    #expect((UserDefaults.standard.persistentDomain(forName: suiteName) ?? [:]).isEmpty)
}

@MainActor
@Test func aStoredListThatDoesNotDecodeCostsOneDragRatherThanTheLaunch() {
    let defaults = scratchDefaults()
    defaults.set(Data("not json".utf8), forKey: PinnedItems.defaultsKey(instanceID: "i-1"))
    let pins = PinnedItems(instanceID: "i-1", defaults: defaults)
    #expect(pins.items.isEmpty)
}

@MainActor
@Test func thereIsACeilingSoTheSidebarIsReadRatherThanSearched() {
    let pins = PinnedItems(instanceID: "i-1", defaults: scratchDefaults())
    for i in 0..<(PinnedItems.limit + 5) {
        pins.pin(.project("p\(i)"))
    }
    #expect(pins.items.count == PinnedItems.limit)
}

// MARK: - Helpers

private func scratchDefaults() -> UserDefaults {
    let name = "com.foldedspacelabs.metistry.tests.store.\(UUID().uuidString)"
    return UserDefaults(suiteName: name)!
}

/// A console that answers a script: bytes, or a refusal, per `<METHOD> <path>`.
/// An unlisted route is the console's own 404, so a mistyped path in a test
/// fails the way the console would.
private actor ScriptedConsole: ConsoleCallTransport {
    enum Answer {
        case bytes(Data)
        case fail(ConsoleError)
    }

    private var routes: [String: Answer]
    private(set) var calls: [String] = []

    init(_ routes: [String: Answer]) {
        self.routes = routes
    }

    func script(_ key: String, _ answer: Answer) {
        routes[key] = answer
    }

    func call(_ method: String, _ path: String, body: Data?) async -> Result<Data, ConsoleError> {
        let key = "\(method) \(path)"
        calls.append(key)
        switch routes[key] {
        case .bytes(let data): return .success(data)
        case .fail(let error): return .failure(error)
        case nil:
            return .failure(.http(status: 404, envelope: ConsoleErrorEnvelope(
                code: "not_found",
                message: "no such route in this stub: \(key)"
            )))
        }
    }
}

// MARK: - Fixtures this file adds to console-api-tests.swift's

extension Fixtures {
    /// An incremental feed page: the boundary row repeated (`since` is
    /// inclusive) plus one new event.
    static let feedSince = bytes("""
    {"rows":[
      {"ts":"2026-09-18T09:00:02.000Z","kind":"turn","group":"run","actor":"assistant",
       "subject":"turn","detail":"turn anthropic/claude-opus-4 $0.001234","ref":"runs:9001","turn_id":"t-77"},
      {"ts":"2026-09-18T09:00:03.000Z","kind":"tool","group":"run","actor":"mcp-brain",
       "subject":"knowledge_search","detail":"called knowledge_search","ref":"runs:9002","turn_id":"t-77"}
     ],"as_of":"2026-09-18T09:00:03.500Z"}
    """)

    /// `?since=<cursor>`: everything that CHANGED, oldest first, each row
    /// carrying its decision. 17 was answered elsewhere; 20 is new.
    static let proposalsSince = bytes("""
    {"proposals":[
      {"id":17,"ts":"2026-09-18T09:00:00.001Z","kind":"improvement","source_agent":"reply-review",
       "trust":"internal","payload":{"title":"Reply quality: 2 replies flagged"},
       "decision":"allow","decided_at":"2026-09-18T09:05:00.000Z","work_id":null,"snoozed_until":null,
       "cursor":"2026-09-18 09:05:00+00|17"},
      {"id":20,"ts":"2026-09-18T09:06:00.000Z","kind":"report","source_agent":"drey",
       "trust":"internal","payload":{"title":"the cert is renewed"},
       "decision":"pending","decided_at":null,"work_id":214,"snoozed_until":null,
       "cursor":"2026-09-18 09:06:00+00|20"}
     ],"cursor":"2026-09-18 09:06:00+00|20","more":false}
    """)

    static let decodedBoard = try! JSONDecoder().decode(Board.self, from: board)
}
