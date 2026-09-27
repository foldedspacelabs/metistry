// Every store method has a fixture, speaks its route, and reads its reply
// (design-build-plan §2.16, F-7 — "every protocol method has a fixture").
//
// THREE HALVES, HELD TOGETHER HERE:
//
//   * the protocols — `sources/kit/stores/*.swift`, parsed as text: every
//     requirement of every `…Store` protocol carries one `/// route:` line;
//   * the fixtures — `tests/kit/fixtures/<stem>.json`, one per route, recorded
//     from a scratch console (`apps/console/scripts/record-client-fixtures.mjs`)
//     or, for a row frozen ahead of its ticket, written from the contract;
//   * `ConsoleStores` — driven method by method against `FixtureConsole`, with
//     the arguments the fixture's own request was made with, so a method must
//     send EXACTLY the request the real console accepted (the path, the query,
//     the body, the Idempotency-Key) and decode EXACTLY what it answered.
//
// The other direction — every row of `packages/core/src/client-api.ts` has a
// fixture, and nothing else does — is `apps/console/test/client-fixtures.test.ts`,
// which can read the table. Together: table ⇄ fixtures ⇄ protocols.

import Foundation
import SwiftUI
import Testing

@testable import MetistryKit

// MARK: - The protocols, as written

private struct Requirement: Sendable, CustomStringConvertible {
    let store: String
    let signature: String
    let route: String
    var description: String { "\(store).\(signature) — \(route)" }
}

/// Every requirement of every `…Store` protocol, with the route its doc comment names.
private func storeRequirements() throws -> (requirements: [Requirement], unannotated: [String]) {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("sources/kit/stores")
    var requirements: [Requirement] = []
    var unannotated: [String] = []
    for name in try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted() where name.hasSuffix(".swift") {
        let lines = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8).components(separatedBy: "\n")
        var store: String?
        var pending: String?
        for line in lines {
            if let range = line.range(of: #"^public protocol (\w+Store)\b"#, options: .regularExpression) {
                store = String(line[range].split(separator: " ")[2])
                continue
            }
            guard let current = store else { continue }
            if line.hasPrefix("}") {
                store = nil
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("/// route: ") {
                pending = String(trimmed.dropFirst("/// route: ".count))
            } else if trimmed.hasPrefix("func ") {
                let signature = String(trimmed.dropFirst(5).prefix { $0 != "(" }) + "(" + labels(trimmed) + ")"
                if let route = pending {
                    requirements.append(Requirement(store: current, signature: signature, route: route))
                } else {
                    unannotated.append("\(current).\(signature)")
                }
                pending = nil
            }
        }
    }
    return (requirements, unannotated)
}

/// `func pause(routine name: String)` → `routine:`.
private func labels(_ line: String) -> String {
    guard let open = line.firstIndex(of: "("), let close = line.lastIndex(of: ")") else { return "" }
    let inside = line[line.index(after: open)..<close]
    var depth = 0
    var params: [String] = []
    var current = ""
    for ch in inside {
        if ch == "(" || ch == "[" || ch == "<" { depth += 1 }
        if ch == ")" || ch == "]" || ch == ">" { depth -= 1 }
        if ch == "," && depth == 0 {
            params.append(current)
            current = ""
        } else {
            current.append(ch)
        }
    }
    if !current.trimmingCharacters(in: .whitespaces).isEmpty { params.append(current) }
    return params.map { p in
        let label = p.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init) ?? "_"
        return (label.hasSuffix(":") ? String(label.dropLast()) : label) + ":"
    }.joined()
}

/// A route line's fixture stem: the method, then the path's segments, a parameter losing its colon.
private func stem(_ route: String) -> String {
    let parts = route.split(separator: " ", maxSplits: 1).map(String.init)
    return ([parts[0].lowercased()] + parts[1].split(separator: "/").map { $0.hasPrefix(":") ? String($0.dropFirst()) : String($0) }).joined(separator: "-")
}

@Test func everyStoreRequirementNamesOneRouteAndNoRouteHasTwoMethods() throws {
    let (requirements, unannotated) = try storeRequirements()
    #expect(unannotated.isEmpty, "requirements with no `/// route:` line: \(unannotated)")
    let stores = Set(requirements.map(\.store))
    // §2.16's fourteen domain stores, every one of them
    #expect(stores == [
        "NeedsYouStore", "TodayStore", "ChatStore", "ActivityStore", "KnowledgeStore", "AgentsStore", "ScheduledStore",
        "WorkStore", "ArtifactsStore", "UsageStore", "SettingsStore", "CaptureStore", "EventsStore", "VaultStore",
    ])
    let routes = requirements.map(\.route)
    let doubled = Dictionary(grouping: routes, by: { $0 }).filter { $0.value.count > 1 }.keys.sorted()
    #expect(doubled.isEmpty, "one method per route — these have more: \(doubled)")
    for route in routes {
        #expect(route.range(of: #"^(GET|POST|PUT|PATCH|DELETE) /[a-z0-9_/:\-]*$"#, options: .regularExpression) != nil, "\(route) is not METHOD /path")
    }
}

@Test func everyProtocolMethodHasAFixtureAndEveryFixtureAMethod() throws {
    let (requirements, _) = try storeRequirements()
    let fixtures = Dictionary(uniqueKeysWithValues: try ConsoleFixture.loadAll().map { ($0.stem, $0) })
    for r in requirements {
        let s = stem(r.route)
        guard let f = fixtures[s] else {
            Issue.record("\(r) has no fixture — record it (apps/console/scripts/record-client-fixtures.mjs) or, for a route not served yet, write its contract fixture")
            continue
        }
        // the fixture is for the row this method names — `/api/q/<query>` for the one row with several
        let template = r.route.hasPrefix("GET /api/q/") ? "GET /api/q/:name" : r.route
        #expect(f.route == template, "\(s).json is for \(f.route), \(r.signature) says \(r.route)")
        #expect(f.source == "recorded" || (f.source == "contract" && f.ticket != nil), "\(s).json: a contract fixture names the ticket that serves it")
    }
    let claimed = Set(requirements.map { stem($0.route) })
    let orphans = fixtures.keys.filter { !claimed.contains($0) }.sorted()
    #expect(orphans.isEmpty, "fixtures no store method reads: \(orphans)")
}

// MARK: - Every method, driven against its fixture

/// The fixture's own request, read back as the arguments a store method takes.
private struct Args: Sendable {
    let fixture: ConsoleFixture
    let params: [String: String]

    init(_ fixture: ConsoleFixture) {
        self.fixture = fixture
        let template = fixture.route.split(separator: " ", maxSplits: 1)[1].split(separator: "/").map(String.init)
        let concrete = fixture.pathOnly.split(separator: "/").map(String.init)
        var params: [String: String] = [:]
        for (name, value) in zip(template, concrete) where name.hasPrefix(":") {
            params[String(name.dropFirst())] = value.removingPercentEncoding ?? value
        }
        self.params = params
    }

    func p(_ name: String) -> String { params[name] ?? "" }
    func pInt(_ name: String) -> Int { Int(p(name)) ?? -1 }
    func q(_ name: String) -> String? { fixture.query[name].map { $0.removingPercentEncoding ?? $0 } }
    func qInt(_ name: String) -> Int? { q(name).flatMap { Int($0) } }
    func b(_ key: String) -> String? { fixture.body?[key]?.stringValue }
    func bInt(_ key: String) -> Int? { fixture.body?[key]?.intValue }
    func bDouble(_ key: String) -> Double? { fixture.body?[key]?.doubleValue }
    func bBool(_ key: String) -> Bool? { fixture.body?[key]?.boolValue }
    func bTexts(_ key: String) -> [String]? { fixture.body?[key]?.arrayValue?.compactMap(\.stringValue) }
    func bInts(_ key: String) -> [Int] { fixture.body?[key]?.arrayValue?.compactMap(\.intValue) ?? [] }
    var key: String { fixture.idempotencyKey ?? "" }
}

private typealias Drive = @Sendable (ConsoleStores, Args) async -> Result<Void, ConsoleError>

private func done<T>(_ result: Result<T, ConsoleError>) -> Result<Void, ConsoleError> { result.map { _ in () } }

private func schedule(_ json: JSONValue?) -> RoutineSchedule {
    if let every = json?["every"]?.stringValue { return .interval(every) }
    let days = json?["days"].flatMap { $0.stringValue.map { [$0] } ?? $0.arrayValue?.compactMap(\.stringValue) } ?? []
    return .timeOfDay(days: days, at: json?["at"]?.arrayValue?.compactMap(\.stringValue) ?? [], tz: json?["tz"]?.stringValue)
}

private func assignment(_ a: Args) -> RoutineAssignment {
    RoutineAssignment(
        actor: a.b("actor") ?? "", task: a.b("task") ?? "",
        read: a.fixture.body?["grants"]?["read"]?.arrayValue?.compactMap(\.stringValue) ?? [],
        write: a.fixture.body?["grants"]?["write"]?.arrayValue?.compactMap(\.stringValue) ?? [],
        schedule: schedule(a.fixture.body?["schedule"]), paused: a.bBool("paused")
    )
}

private func pull(_ a: Args) -> PullRequestRef { PullRequestRef(owner: a.p("owner"), repo: a.p("repo"), number: a.pInt("number")) }

/// One entry per route: how the store is called with the fixture's own request.
private let drives: [String: Drive] = [
    // Settings
    "GET /health": { s, _ in done(await s.health()) },
    "GET /api/identity": { s, _ in done(await s.identity()) },
    "GET /api/whoami": { s, _ in done(await s.whoami()) },
    "GET /api/devices": { s, _ in done(await s.devices()) },
    "POST /api/devices/:id/revoke": { s, a in done(await s.revokeDevice(a.pInt("id"))) },
    "GET /api/status": { s, _ in done(await s.status()) },
    "GET /api/instances": { s, _ in done(await s.instances()) },
    "GET /api/connections": { s, _ in done(await s.connections()) },
    "GET /api/connections/:name": { s, a in done(await s.connection(a.p("name"))) },
    "GET /api/secrets": { s, _ in done(await s.secrets()) },
    "GET /api/variables": { s, _ in done(await s.variables()) },
    "POST /api/sessions/purge": { s, a in done(await s.purgeSessions(SessionPurge(confirm: a.bBool("confirm") ?? false))) },
    // Needs You
    "GET /api/proposals": { s, a in done(await s.requests(limit: a.qInt("limit"), since: a.q("since"))) },
    "POST /api/proposals/:id": { s, a in done(await s.answer(a.pInt("id"), .option(a.b("decision") ?? ""), seenAt: nil)) },
    "POST /api/proposals/batch": { s, a in done(await s.answerMany(a.bInts("ids"), a.b("decision") == "later" ? .later : .skip)) },
    "GET /api/needs-you/count": { s, _ in done(await s.waitingCount()) },
    // Today
    "GET /api/today": { s, a in done(await s.today(date: a.q("date"))) },
    "GET /api/vault-tasks": { s, a in done(await s.vaultTasks(where: a.q("where") ?? "")) },
    "PUT /api/today/order": { s, a in done(await s.setOrder(date: a.b("date") ?? "", taskKeys: a.bTexts("task_keys") ?? [])) },
    "POST /api/vault-tasks/:task_key/check": { s, a in
        done(await s.check(a.p("task_key"), checked: a.bBool("checked") ?? false, seenText: a.b("seen_text") ?? "", idempotencyKey: a.key))
    },
    "POST /api/vault-tasks/:task_key/schedule": { s, a in
        done(await s.schedule(a.p("task_key"), a.b("do").map(TaskDeferral.on) ?? .someday, seenText: a.b("seen_text") ?? "", idempotencyKey: a.key))
    },
    "POST /api/vault-tasks/:task_key/link": { s, a in done(await s.link(a.p("task_key"), ref: a.b("ref") ?? "", seenText: a.b("seen_text") ?? "")) },
    "POST /api/today/close": { s, a in done(await s.closeDay(a.b("day") ?? "", line: a.b("line"))) },
    "POST /api/meetings/:event_id/note": { s, a in done(await s.meetingNote(eventID: a.p("event_id"))) },
    "POST /api/calendar/events/:id/move": { s, a in
        done(await s.moveEvent(a.p("id"), EventMove(start: a.b("start") ?? "", end: a.b("end") ?? "", confirmToken: a.b("confirm_token"))))
    },
    "POST /api/calendar/invitations/:id/respond": { s, a in
        done(await s.respond(toInvitation: a.p("id"), InvitationResponse(rawValue: a.b("response") ?? "") ?? .tentative))
    },
    "POST /api/mail/messages/:id/draft": { s, a in done(await s.draftReply(toMessage: a.p("id"), body: a.b("body") ?? "")) },
    "POST /api/trackers/:connection/issues": { s, a in done(await s.createIssue(connection: a.p("connection"), taskKey: a.b("task_key") ?? "", title: a.b("title"))) },
    "POST /api/trackers/:connection/issues/:key/complete": { s, a in done(await s.completeIssue(connection: a.p("connection"), key: a.p("key"))) },
    "POST /api/prose/:id/feedback": { s, a in done(await s.rateProse(a.p("id"), Rating(rawValue: a.bInt("rating") ?? 0) ?? .up, note: a.b("note"))) },
    "DELETE /api/prose/:id/feedback": { s, a in done(await s.clearProseRating(a.p("id"))) },
    // Chat
    "POST /message": { s, a in done(await s.send(a.b("text") ?? "", threadID: a.b("thread_id"), tier: a.b("tier"))) },
    "GET /api/messages": { s, a in done(await s.messages(limit: a.qInt("limit"), since: a.q("since"))) },
    "POST /api/messages/:id/feedback": { s, a in done(await s.rate(message: a.pInt("id"), Rating(rawValue: a.bInt("rating") ?? 0) ?? .up, note: a.b("note"))) },
    "DELETE /api/messages/:id/feedback": { s, a in done(await s.clearRating(message: a.pInt("id"))) },
    "GET /api/commands": { s, _ in done(await s.commands()) },
    "GET /api/turns/:turn_id/progress": { s, a in done(await s.turnProgress(a.p("turn_id"))) },
    "GET /api/sessions/:id": { s, a in done(await s.session(a.p("id"))) },
    // Activity
    "GET /api/q/activity_feed": { s, a in
        done(await s.activityFeed(hours: a.qInt("hours"), limit: a.qInt("limit"), kind: a.q("kind"), project: a.q("project"), agent: a.q("agent"), since: a.q("since")))
    },
    "GET /api/runs/:id": { s, a in done(await s.run(a.pInt("id"))) },
    "GET /api/runs/export": { s, a in done(await s.exportRuns(since: a.q("since"), until: a.q("until"), component: a.q("component"), limit: a.qInt("limit"))) },
    // Knowledge
    "GET /api/knowledge/search": { s, a in done(await s.knowledgeSearch(a.q("q") ?? "", mode: a.q("mode"), limit: a.qInt("limit"))) },
    "GET /api/knowledge/page": { s, a in done(await s.knowledgePage(path: a.q("path") ?? "")) },
    "GET /api/knowledge/pages": { s, a in done(await s.knowledgePages(area: a.q("area"), prefix: a.q("prefix"), limit: a.qInt("limit"), offset: a.qInt("offset"))) },
    "GET /api/knowledge/links": { s, a in done(await s.knowledgeLinks(path: a.q("path") ?? "", limit: a.qInt("limit"), offset: a.qInt("offset"))) },
    "GET /api/knowledge/fold": { s, a in done(await s.knowledgeFold(date: a.q("date"))) },
    "GET /api/knowledge/drafts": { s, a in done(await s.knowledgeDrafts(limit: a.qInt("limit"), offset: a.qInt("offset"))) },
    "GET /api/knowledge/areas": { s, _ in done(await s.knowledgeAreas()) },
    // Agents
    "GET /api/agents": { s, _ in done(await s.agents()) },
    "GET /api/q/agent_presence": { s, a in done(await s.agentPresence(limit: a.qInt("limit"))) },
    "POST /api/agents": { s, a in
        done(await s.registerAgent(AgentRegistration(id: a.b("id") ?? "", displayName: a.b("display_name") ?? "", kind: a.b("kind"), remote: a.bBool("remote") ?? false)))
    },
    "PUT /api/agents/:id/grants": { s, a in done(await s.setGrants(a.p("id"), tier: a.b("tier") ?? "", areas: a.bTexts("areas"), queries: a.bBool("queries"))) },
    "PUT /api/agents/:id/projects": { s, a in done(await s.setProjects(a.p("id"), a.bTexts("projects") ?? [])) },
    "PUT /api/agents/:id/autonomy": { s, a in done(await s.setAutonomy(a.p("id"), AgentAutonomyUpdate(level: a.b("level")))) },
    "POST /api/agents/:id/revoke": { s, a in done(await s.revokeAgent(a.p("id"))) },
    "POST /api/agents/:id/rotate": { s, a in done(await s.rotateAgent(a.p("id"))) },
    "POST /api/agents/:id/approve": { s, a in done(await s.approveAgent(a.p("id"))) },
    "GET /api/agents/:id/definition": { s, a in done(await s.agentDefinition(a.p("id"))) },
    // Scheduled
    "GET /api/scheduled": { s, _ in done(await s.scheduled()) },
    "GET /api/scheduled/routines/:name": { s, a in done(await s.routine(a.p("name"))) },
    "GET /api/scheduled/syncs/:name": { s, a in done(await s.sync(a.p("name"))) },
    "PUT /api/scheduled/routines/:name/schedule": { s, a in done(await s.setSchedule(routine: a.p("name"), schedule(a.fixture.body))) },
    "POST /api/scheduled/routines/:name/pause": { s, a in done(await s.pause(routine: a.p("name"))) },
    "POST /api/scheduled/routines/:name/resume": { s, a in done(await s.resume(routine: a.p("name"))) },
    "POST /api/scheduled/routines/:name/run": { s, a in done(await s.runNow(routine: a.p("name"))) },
    "DELETE /api/scheduled/routines/:name": { s, a in done(await s.resetToDefault(routine: a.p("name"))) },
    "PUT /api/scheduled/routines/:name/assignment": { s, a in done(await s.setAssignment(routine: a.p("name"), assignment(a))) },
    "POST /api/scheduled/routines": { s, a in done(await s.newRoutine(a.b("name") ?? "", assignment(a))) },
    "PUT /api/scheduled/syncs/:name": { s, a in
        let raise = a.fixture.body?["raise"].flatMap { r -> [String: Bool]? in
            guard case .object(let o) = r else { return nil }
            return o.compactMapValues(\.boolValue)
        }
        return done(await s.updateSync(a.p("name"), SyncSettings(every: a.b("every"), paused: a.bBool("paused"), raise: raise)))
    },
    "POST /api/scheduled/syncs/:name/run": { s, a in done(await s.runNow(sync: a.p("name"))) },
    // Work
    "GET /api/q/board": { s, a in done(await s.board(project: a.q("project"), limit: a.qInt("limit"))) },
    "GET /api/q/rooms": { s, a in done(await s.rooms(state: a.q("state"), project: a.q("project"), anchor: a.q("anchor"), limit: a.qInt("limit"))) },
    "GET /api/projects": { s, _ in done(await s.projects()) },
    "PUT /api/projects/:slug": { s, a in
        done(await s.updateProject(a.p("slug"), ProjectUpdate(mode: a.b("mode"), dailyBudgetUSD: a.bDouble("daily_budget_usd"), maxOpenBundles: a.bInt("max_open_bundles"), title: a.b("title"), area: a.b("area"))))
    },
    "GET /api/targets": { s, _ in done(await s.targets()) },
    "POST /api/tasks/:id/dispatch": { s, a in done(await s.dispatchTask(a.pInt("id"), TaskDispatch(target: a.b("target") ?? "", brief: a.b("brief") ?? ""))) },
    "PATCH /api/tasks/:id": { s, a in
        done(await s.updateTask(a.pInt("id"), TaskPatch(status: a.b("status"), owner: a.b("owner"), project: a.b("project"), title: a.b("title"), description: a.b("description"))))
    },
    "POST /api/tasks/:id/claim": { s, a in done(await s.claimTask(a.pInt("id"), leaseSeconds: a.bInt("lease_seconds"))) },
    "POST /api/tasks/:id/release": { s, a in done(await s.releaseTask(a.pInt("id"), note: a.b("note"))) },
    "POST /api/tasks/:id/renew": { s, a in done(await s.renewTask(a.pInt("id"), note: a.b("note"), leaseSeconds: a.bInt("lease_seconds"))) },
    "GET /api/work/:id/thread": { s, a in done(await s.taskRoom(a.pInt("id"))) },
    "POST /api/work/:id/comments": { s, a in done(await s.comment(onTask: a.pInt("id"), a.b("body") ?? "")) },
    "POST /api/work/:id/thread/resolve": { s, a in done(await s.resolveRoom(a.pInt("id"))) },
    "POST /api/work/:id/thread/reopen": { s, a in done(await s.reopenRoom(a.pInt("id"))) },
    "POST /api/github/pulls/:owner/:repo/:number/review": { s, a in
        done(await s.review(pull(a), PullRequestReview(event: a.b("event") ?? "", body: a.b("body") ?? "", headSHA: a.b("head_sha") ?? "")))
    },
    "POST /api/github/pulls/:owner/:repo/:number/threads/:id/reply": { s, a in
        done(await s.reply(pull(a), thread: a.p("id"), body: a.b("body") ?? "", headSHA: a.b("head_sha") ?? ""))
    },
    "POST /api/github/pulls/:owner/:repo/:number/threads/:id/resolve": { s, a in done(await s.resolve(pull(a), thread: a.p("id"), headSHA: a.b("head_sha") ?? "")) },
    // Artifacts
    "GET /api/artifacts": { s, a in done(await s.artifacts(project: a.q("project"), limit: a.qInt("limit"))) },
    "POST /api/artifacts": { s, a in
        let files = a.fixture.body?["files"]?.arrayValue?.map { ArtifactPublication.File(path: $0["path"]?.stringValue ?? "", content: $0["content"]?.stringValue ?? "") } ?? []
        return done(await s.publish(ArtifactPublication(
            project: a.b("project") ?? "", slug: a.b("slug") ?? "", idempotencyKey: a.b("idempotency_key") ?? "",
            message: a.b("message") ?? "", files: files, kind: a.b("kind"), expectedCurrentVersion: a.b("expected_current_version")
        )))
    },
    "GET /api/artifacts/:id": { s, a in done(await s.artifact(a.p("id"))) },
    "GET /api/artifacts/:id/versions": { s, a in done(await s.versions(ofArtifact: a.p("id"))) },
    "GET /api/artifacts/:id/versions/:version": { s, a in done(await s.version(a.p("version"), ofArtifact: a.p("id"))) },
    "GET /api/artifacts/:id/versions/:version/file": { s, a in done(await s.file(a.q("path") ?? "", version: a.p("version"), ofArtifact: a.p("id"))) },
    "GET /api/artifacts/:id/diff": { s, a in done(await s.diff(ofArtifact: a.p("id"), from: a.q("from") ?? "", to: a.q("to"))) },
    "GET /api/artifacts/:id/comments": { s, a in done(await s.comments(onArtifact: a.p("id"), version: a.q("version") ?? "")) },
    "POST /api/artifacts/:id/comments": { s, a in
        let comment: ArtifactComment = a.b("parent").map { .reply(parent: $0, body: a.b("body") ?? "") }
            ?? .thread(version: a.b("version") ?? "", body: a.b("body") ?? "", path: a.b("path"), line: a.fixture.body?["anchor"]?["line"]?.intValue)
        return done(await s.comment(onArtifact: a.p("id"), comment))
    },
    "POST /api/artifacts/:id/comments/:comment/resolve": { s, a in done(await s.resolveComment(a.p("comment"), onArtifact: a.p("id"))) },
    "POST /api/artifacts/:id/comments/:comment/reopen": { s, a in done(await s.reopenComment(a.p("comment"), onArtifact: a.p("id"))) },
    "POST /api/dispatches": { s, a in
        done(await s.requestReview(ReviewRequest(
            artifact: a.b("artifact") ?? "", version: a.b("version") ?? "", threadIDs: a.bTexts("thread_ids") ?? [],
            toAgent: a.b("to_agent") ?? "", message: a.b("message"), idempotencyKey: a.b("idempotency_key")
        )))
    },
    "GET /api/dispatches/:id": { s, a in done(await s.reviewStatus(a.pInt("id"))) },
    // Usage
    "GET /api/compute": { s, _ in done(await s.compute()) },
    "GET /api/compute/models": { s, a in done(await s.computeModels(provider: a.q("provider"))) },
    "POST /api/compute/assign": { s, a in
        let target: ComputeAssignTarget = a.b("crew").map(ComputeAssignTarget.crew) ?? .tier(a.b("tier") ?? "")
        return done(await s.assignCompute(target, model: a.b("model") ?? "", effort: a.b("effort")))
    },
    "POST /api/compute/budget": { s, a in
        done(await s.setComputeBudget(scope: a.b("scope") ?? "", daily: a.bDouble("daily"), monthly: a.bDouble("monthly"), action: a.b("action") ?? ""))
    },
    "POST /api/compute/providers/test": { s, a in done(await s.testComputeProvider(a.b("name") ?? "", complete: a.bBool("complete") ?? false)) },
    // Capture
    "POST /capture": { s, a in done(await s.capture(.note(a.b("note") ?? ""), idempotencyKey: a.key)) },
    "GET /api/recordings/:id": { s, a in done(await s.recording(a.p("id"))) },
    // Vault
    "GET /api/vault/status": { s, _ in done(await s.vaultStatus()) },
    "GET /api/knowledge/history": { s, a in done(await s.history(path: a.q("path") ?? "")) },
    "GET /api/knowledge/version": { s, a in done(await s.version(path: a.q("path") ?? "", sha: a.q("sha") ?? "")) },
    "POST /api/knowledge/restore": { s, a in done(await s.restore(path: a.b("path") ?? "", sha: a.b("sha") ?? "", seenSHA: a.b("seen_sha") ?? "")) },
    "POST /api/knowledge/conflicts/resolve": { s, a in
        done(await s.resolveConflict(path: a.b("path") ?? "", keep: ConflictSide(rawValue: a.b("keep") ?? "") ?? .mine, seenSHA: a.b("seen_sha") ?? ""))
    },
    "POST /api/vault/rollback": { s, a in
        let target: RollbackTarget = a.b("commit").map(RollbackTarget.commit) ?? a.b("to").map(RollbackTarget.to) ?? .file(a.b("file") ?? "")
        return done(await s.rollback(target))
    },
]

@Test func everyStoreMethodSendsItsFixturesRequestAndReadsItsReply() async throws {
    let (requirements, _) = try storeRequirements()
    let console = try FixtureConsole.recorded()
    let stores = ConsoleStores(transport: console, stream: console)
    let byStem = Dictionary(uniqueKeysWithValues: console.fixtures.map { ($0.stem, $0) })

    // the stream is driven by its own test below; every other route is here
    let driven = Set(drives.keys)
    let declared = Set(requirements.map(\.route)).subtracting(["GET /api/events"])
    #expect(driven == declared, "drive table and protocols disagree — missing: \(declared.subtracting(driven).sorted()), extra: \(driven.subtracting(declared).sorted())")

    for r in requirements where r.route != "GET /api/events" {
        guard let fixture = byStem[stem(r.route)], let drive = drives[r.route] else { continue }
        console.reset()
        let result = await drive(stores, Args(fixture))
        if case .failure(let error) = result {
            Issue.record("\(r): \(error.localizedDescription)")
        }
        let calls = console.calls
        guard calls.count == 1, let call = calls.first else {
            Issue.record("\(r) made \(calls.count) requests; a store method is one route")
            continue
        }
        #expect(call.servedBy == fixture.stem, "\(r) reached \(call.method) \(call.path), which \(call.servedBy.map { "\($0).json answers" } ?? "no fixture answers")")
        #expect(call.method == fixture.method, "\(r): sent \(call.method)")
        #expect(call.path.split(separator: "?").first == fixture.path.split(separator: "?").first, "\(r): sent \(call.path), the fixture's request was \(fixture.path)")
        #expect(ConsoleFixture.query(of: call.path) == fixture.query, "\(r): query \(ConsoleFixture.query(of: call.path)) — the fixture's was \(fixture.query)")
        #expect(call.body == fixture.body, "\(r): body \(String(describing: call.body)) — the fixture's was \(String(describing: fixture.body))")
        #expect(call.idempotencyKey == fixture.idempotencyKey, "\(r): Idempotency-Key \(call.idempotencyKey ?? "none")")
    }
}

// MARK: - The typed replies, read from what the console really said

@Test func theTypedRepliesReadTheRecordedBodies() async throws {
    let console = try FixtureConsole.recorded()
    let stores = ConsoleStores(transport: console)

    let health = try await stores.health().get()
    #expect(health.ok && health.apiVersion == 1)

    let capture = try await stores.capture(.note("Ask Dana about the fixture format on Thursday."), idempotencyKey: "fixture-capture-0001").get()
    #expect(capture.path.hasPrefix("Inbox/"))
    #expect(capture.sha256.count == 64)

    let sent = try await stores.send("What's on today?").get()
    #expect(!sent.messageID.isEmpty)

    let credential = try await stores.registerAgent(AgentRegistration(id: "devin", displayName: "Devin", remote: true)).get()
    #expect(credential.pending == true)
    #expect(credential.proposalID != nil)
    // a minted bearer never lands in the repository: the recorder writes a placeholder
    #expect(credential.token == "fixture-token-not-a-secret")

    let export = try await stores.exportRuns(since: nil, until: nil, component: nil, limit: 3).get()
    #expect(export.rows.count == 3)
    #expect(export.cursor?.contains("|") == true)

    let count = try await stores.waitingCount().get()
    #expect(count.waiting == 3)
}

@Test func noFixtureIsReadAsAnAnswerForARouteItDoesNotServe() async throws {
    let console = try FixtureConsole.recorded()
    let stores = ConsoleStores(transport: console)
    // a path the table has no row for is a 404 from the fake exactly as from the console — never another route's body
    let wrong: Result<ConsoleHealth, ConsoleError> = await stores.get("/api/bogus")
    #expect(wrong.failureStatus == 404)
    // and a named query the kit keeps no fixture for is not answered by another query's
    let other: Result<Board, ConsoleError> = await stores.get("/api/q/open_work")
    #expect(other.failureStatus == 404)
}

// MARK: - The event stream

@Test func theEventStreamReadsOneTypedEventPerCatalogueType() async throws {
    let console = try FixtureConsole.recorded()
    // no `stream:` — a transport that can hold one open is its own stream, as the session transport is
    let stores = ConsoleStores(transport: console)
    var events: [ConsoleEvent] = []
    for try await event in stores.events(lastEventID: nil) { events.append(event) }
    let fixture = try ConsoleFixture.load("get-api-events")
    #expect(events.map(\.id) == fixture.stream?.map(\.id))
    #expect(!events.contains { if case .unknown = $0.change { true } else { false } }, "every frame is a catalogue type this build reads")
    #expect(events.contains(.init(id: "4106", change: .needsYouChanged(waiting: 3))))
    #expect(events.contains(.init(id: "4109", change: .threadChanged(workID: nil, artifactID: "art_01M3FY9WJ7M4N2ZAJFNZBVH8KK"))))
    #expect(console.calls.map(\.path) == ["/api/events"])

    // a reconnect resumes after the last id it saw
    var resumed: [String?] = []
    for try await event in stores.events(lastEventID: "4117") { resumed.append(event.id) }
    #expect(resumed == ["4118", "4119"])
}

@Test func aTypeThisBuildDoesNotKnowIsIgnoredNotFatal() throws {
    let unknown = try ConsoleEvent(frame: ConsoleLiveEvent(id: "9", type: "something.new", data: .object([:])))
    #expect(unknown.change == .unknown(type: "something.new"))
    #expect(throws: ConsoleEventError.self) {
        try ConsoleEvent(frame: ConsoleLiveEvent(id: "10", type: "work.changed", data: .object([:])))
    }
}

/// A transport that can answer a request and cannot hold a stream open — `metistry console call`'s shape.
private struct CallOnly: ConsoleCallTransport {
    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        .failure(.transport("nothing answers here"))
    }
}

@Test func withNoStreamTransportTheEventsEndAndSayWhy() async {
    let stores = ConsoleStores(transport: CallOnly())
    do {
        for try await _ in stores.events(lastEventID: nil) {}
        Issue.record("a stream with no transport must end with an error, not silently")
    } catch {
        #expect(error as? ConsoleEventError == .noStream)
    }
}

// MARK: - A view, built with no console running (the ticket's acceptance)

/// A stand-in for a Needs You row: what a view does with a store, and nothing
/// a real screen would add. It lives in the tests on purpose — the screens are
/// T5/T6's — and it proves the path they will take: store → fixture → view.
private struct WaitingRow: View {
    let count: NeedsYouCount
    let titles: [String]

    var body: some View {
        VStack(alignment: .leading) {
            Text("Needs You · \(count.waiting)")
            ForEach(titles, id: \.self) { Text($0) }
        }
        .padding()
    }
}

@MainActor
@Test func aViewIsBuiltFromTheFixturesWithNoConsoleRunning() async throws {
    let console = try FixtureConsole.recorded()
    let store: any NeedsYouStore = ConsoleStores(transport: console)
    let count = try await store.waitingCount().get()
    let page = try await store.requests().get()
    let view = WaitingRow(count: count, titles: page.proposals.map { $0.payload?["title"]?.stringValue ?? $0.kind })

    let renderer = ImageRenderer(content: view)
    #expect(renderer.cgImage != nil, "the view rendered")
    #expect(count.waiting == 3)
    #expect(!page.proposals.isEmpty)
    // everything came from the fixtures: two requests, both answered by one
    #expect(console.calls.map(\.servedBy) == ["get-api-needs-you-count", "get-api-proposals"])
}

// MARK: - Management verbs: §2.2's closed set, at the type

@Test func aManagementCommandIsOnlyEverOneOfSection2point2sVerbs() {
    #expect(ManagementRow.allCases.map(\.rawValue) == (1...18).map { "M\($0)" })
    for row in ManagementRow.allCases {
        #expect(!row.verbs.isEmpty && !row.whyNotTheAPI.isEmpty, "\(row.rawValue)")
    }
    #expect(ManagementCommand(.services, ["restart", "console"]) != nil)
    #expect(ManagementCommand(.vaultGit, ["vault", "rollback", "--to", "2026-09-20"]) != nil)
    #expect(ManagementCommand(.computeProviders, ["compute", "providers", "add", "--from", "openrouter"], standardInput: "sk-not-in-argv")?.standardInput == "sk-not-in-argv")
    // misuse: a verb another row owns, a verb §2.2 does not list, and the generic console client
    #expect(ManagementCommand(.services, ["doctor"]) == nil)
    #expect(ManagementCommand(.secrets, ["secrets", "list"]) == nil)
    #expect(ManagementCommand(.install, ["console", "call", "POST", "/api/agents"]) == nil)
    #expect(ManagementCommand(.install, []) == nil)
}

// MARK: - Every method over the session transport (T5-1)

/// `metistry console session --stdio` as the CLI runs it
/// (`packages/cli/src/console-client.ts`, `runConsoleSession`), answering from
/// the fixtures instead of a console: one request line in, one terminal line
/// `{id, status, body}` out, where `body` is what `readConsoleResponse` makes
/// of the console's bytes — the parsed JSON, or the raw text when it is not
/// JSON — and a stream is `{id, event}` frames and then `{id, ended}`.
private final class FixtureChild: SessionProcess, @unchecked Sendable {
    let lines: AsyncStream<String>
    private let out: AsyncStream<String>.Continuation
    private let console: FixtureConsole
    private let lock = NSLock()
    private var raw: [String] = []
    private var ended: CommandResult?
    private var waiters: [CheckedContinuation<CommandResult, Never>] = []

    init(_ console: FixtureConsole) {
        self.console = console
        (lines, out) = AsyncStream<String>.makeStream()
    }

    var sent: [[String: Any]] {
        lock.withLock { raw }.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }

    func clear() { lock.withLock { raw.removeAll() } }

    func send(_ line: String) throws {
        let dead: Bool = lock.withLock {
            if ended != nil { return true }
            raw.append(line)
            return false
        }
        if dead { throw CocoaError(.fileWriteUnknown) }
        guard let request = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let id = request["id"] as? String, request["cancel"] == nil else { return }
        let method = request["method"] as? String ?? ""
        let path = request["path"] as? String ?? ""
        if request["stream"] as? Bool == true {
            let lastEventID = request["last_event_id"] as? String
            Task {
                do {
                    for try await frame in await self.console.events(lastEventID: lastEventID) {
                        let data = try JSONSerialization.jsonObject(with: JSONEncoder().encode(frame.data), options: [.fragmentsAllowed])
                        self.emit(["id": id, "event": ["id": frame.id as Any, "type": frame.type, "data": data]])
                    }
                    self.emit(["id": id, "ended": "closed"])
                } catch {
                    self.emit(["id": id, "status": 404, "body": ["error": ["code": "not_found", "message": "no stream"]]])
                }
            }
            return
        }
        guard let fixture = console.match(method, path) else {
            emit(["id": id, "status": 404, "body": ["error": ["code": "not_found", "message": "no fixture for \(method) \(path)"]]])
            return
        }
        // readConsoleResponse: JSON when it parses, the raw text when it does not, null when empty
        let text = String(decoding: fixture.reply, as: UTF8.self)
        let body: Any = text.isEmpty ? NSNull() : ((try? JSONSerialization.jsonObject(with: fixture.reply, options: [.fragmentsAllowed])) ?? text)
        emit(["id": id, "status": fixture.status, "body": body])
    }

    private func emit(_ object: [String: Any]) {
        out.yield(String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self))
    }

    func termination() async -> CommandResult {
        await withCheckedContinuation { waiter in
            let done: CommandResult? = lock.withLock {
                if let ended { return ended }
                waiters.append(waiter)
                return nil
            }
            if let done { waiter.resume(returning: done) }
        }
    }

    func terminate() {
        let result = CommandResult(exitCode: 15, stdout: "", stderr: "")
        let pending: [CheckedContinuation<CommandResult, Never>] = lock.withLock {
            ended = result
            defer { waiters.removeAll() }
            return waiters
        }
        out.finish()
        for w in pending { w.resume(returning: result) }
    }
}

private struct FixtureSpawner: SessionSpawner {
    let child: FixtureChild
    func spawn(executable: URL, arguments: [String], environment: [String: String], currentDirectory: URL?) throws -> any SessionProcess { child }
}

@MainActor
@Test(.timeLimit(.minutes(1)))
func everyStoreMethodSpeaksItsRouteOverTheSessionTransport() async throws {
    let (requirements, _) = try storeRequirements()
    let console = try FixtureConsole.recorded()
    let child = FixtureChild(console)
    let cli = MetistryCLI(
        runtime: MetistryRuntime(source: .checkout, executable: URL(fileURLWithPath: "/usr/bin/node"), leadingArguments: ["/src/packages/cli/dist/main.js"], productDir: URL(fileURLWithPath: "/src")),
        runner: RefuseToRun()
    )
    // production wiring: the session child, the gate, the stores
    let session = ConsoleSession(cli: cli, spawner: FixtureSpawner(child: child))
    let byStem = Dictionary(uniqueKeysWithValues: console.fixtures.map { ($0.stem, $0) })

    for r in requirements where r.route != "GET /api/events" {
        guard let fixture = byStem[stem(r.route)], let drive = drives[r.route] else { continue }
        child.clear()
        if case .failure(let error) = await drive(session.stores, Args(fixture)) {
            Issue.record("\(r) over the session: \(error.localizedDescription)")
        }
        let lines = child.sent
        guard lines.count == 1, let line = lines.first else {
            Issue.record("\(r) wrote \(lines.count) request lines; a store method is one route"); continue
        }
        let path = line["path"] as? String ?? ""
        #expect(line["method"] as? String == fixture.method, "\(r)")
        #expect(path.split(separator: "?").first == fixture.path.split(separator: "?").first, "\(r): sent \(path)")
        #expect(ConsoleFixture.query(of: path) == fixture.query, "\(r): query")
        let body = try line["body"].map { try JSONValue.parse(JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed])) }
        #expect(body == fixture.body, "\(r): the body on the line is not the body the console accepted")
        #expect(line["idempotency_key"] as? String == fixture.idempotencyKey, "\(r): Idempotency-Key")
    }

    // the reply that is not JSON — the export's NDJSON — survives the line as rows, not as one quoted string
    let export = try await session.stores.exportRuns(since: nil, until: nil, component: nil, limit: 3).get()
    #expect(export.rows.count == 3)
    #expect(export.cursor?.contains("|") == true)

    // and the event stream rides the same child
    var ids: [String?] = []
    for try await event in session.stores.events(lastEventID: "4117") { ids.append(event.id) }
    #expect(ids == ["4118", "4119"])
}

@Test func aOneRowExportPrettyPrintedByConsoleCallIsStillOneRow() throws {
    // `metistry console call --json` pretty-prints a body that parses as JSON, and a one-row export does
    let pretty = Data("{\n  \"id\": 7,\n  \"cursor\": \"2026-09-26 10:00:00+00|7\"\n}".utf8)
    let one = try RunExport(ndjson: pretty)
    #expect(one.rows.count == 1)
    #expect(one.cursor == "2026-09-26 10:00:00+00|7")
    let many = try RunExport(ndjson: Data("{\"id\":1}\n{\"id\":2}\n".utf8))
    #expect(many.rows.count == 2)
    #expect(throws: (any Error).self) { try RunExport(ndjson: Data("{\"id\":1}\nnot json\n".utf8)) }
}

/// A runner for a session whose every request goes down the child: running anything else is the bug.
private struct RefuseToRun: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, standardInput: String?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        Issue.record("a one-shot process was run: \(arguments)")
        return CommandResult(exitCode: 1, stdout: "", stderr: "")
    }
}

// MARK: - O3 over every method: unreachable → every decision refused before it is sent (T5-1)

/// The fixtures behind a switch. While `down`, every request fails the way a
/// console that is not there fails — and is still counted, so a test can tell
/// "refused before sending" from "sent, and nothing answered".
private final class Unplugged: ConsoleCallTransport, ConsoleEventTransport, @unchecked Sendable {
    let console: FixtureConsole
    private let lock = NSLock()
    private var _down = false
    private var _reached: [String] = []

    init(_ console: FixtureConsole) {
        self.console = console
    }

    var down: Bool {
        get { lock.withLock { _down } }
        set { lock.withLock { _down = newValue } }
    }

    var reached: [String] { lock.withLock { _reached } }
    func clear() { lock.withLock { _reached.removeAll() } }

    func call(_ method: String, _ path: String, body: Data?, idempotencyKey: String?) async -> Result<Data, ConsoleError> {
        let down: Bool = lock.withLock {
            _reached.append("\(method) \(path)")
            return _down
        }
        if down { return .failure(.transport("connect ECONNREFUSED 127.0.0.1:8080")) }
        return await console.call(method, path, body: body, idempotencyKey: idempotencyKey)
    }

    func events(lastEventID: String?) async -> AsyncThrowingStream<ConsoleLiveEvent, any Error> {
        await console.events(lastEventID: lastEventID)
    }
}

@Test func o3SortsEveryRouteTheKitSpeaksAndOnlyTheNamedAppendsAreAppends() throws {
    let fixtures = try ConsoleFixture.loadAll()
    var appends: Set<String> = []
    for f in fixtures {
        let act = ConsoleAct.of(f.method, f.path)
        if f.method == "GET" { #expect(act == .read, "\(f.route) is a read") }
        if act == .append { appends.insert(f.route) }
    }
    // capture, tick, defer — the table's `key` rows — and the two rating doors
    // each way. Nothing else; and every one of them is a real route.
    #expect(appends == Set(ConsoleAct.appends))
    #expect(fixtures.filter { ConsoleAct.of($0.method, $0.path) == .decision }.count > 50)
}

@MainActor
@Test func whileUnreachableEveryDecisionIsRefusedBeforeItIsSentAndReadsAndAppendsStillGo() async throws {
    let (requirements, _) = try storeRequirements()
    let console = try FixtureConsole.recorded()
    let unplugged = Unplugged(console)
    let session = ConsoleSession(transport: unplugged, management: nil)
    let byStem = Dictionary(uniqueKeysWithValues: console.fixtures.map { ($0.stem, $0) })
    #expect(session.allowsDecisions, "nothing has been said yet, so nothing is closed")

    // The console stops answering, and a READ is what says so — no timer, no ping.
    unplugged.down = true
    _ = await session.stores.health()
    #expect(!session.allowsDecisions)
    #expect(session.reachability == .unreachable("connect ECONNREFUSED 127.0.0.1:8080"))
    #expect(session.decisionsUnavailableReason == "the instance is unreachable — decisions are never queued — connect ECONNREFUSED 127.0.0.1:8080")

    var refused = 0
    for r in requirements where r.route != "GET /api/events" {
        guard let fixture = byStem[stem(r.route)], let drive = drives[r.route] else {
            Issue.record("\(r) has no fixture or no drive"); continue
        }
        unplugged.clear()
        let result = await drive(session.stores, Args(fixture))
        let held: Bool = { if case .failure(let e) = result { return e.wasHeldForReachability } else { return false } }()
        switch ConsoleAct.of(fixture.method, fixture.path) {
        case .decision:
            #expect(unplugged.reached.isEmpty, "\(r): a decision reached the transport while the console was unreachable")
            #expect(held, "\(r): refused, but not in O3's sentence")
            refused += 1
        case .read, .append:
            #expect(unplugged.reached.count == 1, "\(r): not sent — only a decision waits for the connection")
            #expect(!held, "\(r) was held like a decision")
        }
        // nothing it did re-opened the gate
        #expect(!session.allowsDecisions, "\(r) re-opened decisions without an answer")
    }
    #expect(refused > 50)

    // The console comes back; the next read notices; every decision goes again.
    unplugged.down = false
    _ = await session.stores.health()
    #expect(session.allowsDecisions)
    #expect(session.decisionsUnavailableReason == nil)
    for r in requirements where r.route != "GET /api/events" {
        guard let fixture = byStem[stem(r.route)], let drive = drives[r.route],
              ConsoleAct.of(fixture.method, fixture.path) == .decision else { continue }
        unplugged.clear()
        _ = await drive(session.stores, Args(fixture))
        #expect(unplugged.reached.count == 1, "\(r): still held after the console answered")
    }
}

private extension Result {
    var failureStatus: Int? {
        if case .failure(let error) = self, let e = error as? ConsoleError { return e.httpStatus }
        return nil
    }
}
