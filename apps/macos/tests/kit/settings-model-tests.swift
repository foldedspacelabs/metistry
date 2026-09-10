// The settings model's one promise: what the app remembers, and what it reads
// through every time.
//
// The first test is the important one. "Every setting is a front for a
// CLI-owned file, never app-private state" is a rule that decays silently — one
// `defaults.set` in a view and the app has its own copy of something. So the
// test asserts a whole defaults domain rather than a list of properties: drive
// the models through a fresh suite, then check what reached disk. If a fourth
// key appears, this fails and somebody has to say why.
//
// A running app's real domain also holds keys its FRAMEWORKS wrote —
// Sparkle's `SUEnableAutomaticChecks`/`SULastCheckTime`, AppKit's window
// frames. Those are theirs, which is the point: the app keeps no copy of them
// either.

import Foundation
import Testing

@testable import MetistryKit

private func suite(_ name: String) -> (UserDefaults, () -> Void) {
    let id = "com.foldedspacelabs.metistry.tests.\(name).\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    return (defaults, { UserDefaults.standard.removePersistentDomain(forName: id) })
}

@MainActor
@Test func theAppPersistsThreePointersAndNothingElse() {
    let id = "com.foldedspacelabs.metistry.tests.domain.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: id)!
    defer { UserDefaults.standard.removePersistentDomain(forName: id) }

    let model = AppModel(bundleResourceURL: nil, runner: NoopRunner(), defaults: defaults)
    model.activateInstance(URL(fileURLWithPath: "/Users/you/instance"))
    model.chooseDeveloperProductDirectory(URL(fileURLWithPath: "/src/metistry"))
    // Exercise the read-through side too: none of it may reach disk.
    model.settings.section = .secrets
    model.firstRun.assistantName = "Ada"
    model.wizard.present()

    let domain = UserDefaults.standard.persistentDomain(forName: id) ?? [:]
    #expect(Set(domain.keys) == Set([
        AppPreference.activeInstance.rawValue,
        AppPreference.recentInstances.rawValue,
        AppPreference.developerProductDirectory.rawValue,
    ]))
}

@MainActor
@Test func recentsAreMostRecentFirstDeduplicatedAndCapped() {
    let (defaults, cleanup) = suite("recents")
    defer { cleanup() }
    let bookmarks = InstanceBookmarks(defaults: defaults)

    for i in 0..<(InstanceBookmarks.recentsLimit + 3) {
        bookmarks.activate(URL(fileURLWithPath: "/i/\(i)"))
    }
    #expect(bookmarks.recents.count == InstanceBookmarks.recentsLimit)
    #expect(bookmarks.recents.first?.path == "/i/\(InstanceBookmarks.recentsLimit + 2)")

    // Re-activating one already in the list moves it, never duplicates it.
    let again = bookmarks.recents[3]
    bookmarks.activate(again)
    #expect(bookmarks.recents.first?.path == again.path)
    #expect(bookmarks.recents.filter { $0.path == again.path }.count == 1)
    #expect(bookmarks.active?.path == again.path)
}

@MainActor
@Test func recentsAndTheActiveInstanceSurviveARelaunch() {
    let (defaults, cleanup) = suite("relaunch")
    defer { cleanup() }
    InstanceBookmarks(defaults: defaults).activate(URL(fileURLWithPath: "/Users/you/instance"))

    let reopened = InstanceBookmarks(defaults: defaults)
    #expect(reopened.active?.path == "/Users/you/instance")
    #expect(reopened.recents.map(\.path) == ["/Users/you/instance"])
}

@MainActor
@Test func forgettingTheActiveInstanceLeavesNoneRatherThanGuessing() {
    let (defaults, cleanup) = suite("forget")
    defer { cleanup() }
    let bookmarks = InstanceBookmarks(defaults: defaults)
    bookmarks.activate(URL(fileURLWithPath: "/a"))
    bookmarks.activate(URL(fileURLWithPath: "/b"))
    bookmarks.forget(URL(fileURLWithPath: "/b"))
    #expect(bookmarks.active == nil)
    #expect(bookmarks.recents.map(\.path) == ["/a"])
}

@MainActor
@Test func theScaffoldsProductDirectoryPreferenceIsMigratedOnceAndRemoved() {
    let (defaults, cleanup) = suite("migrate")
    defer { cleanup() }
    defaults.set("/src/metistry", forKey: AppPreference.legacyProductDirectory)

    let model = AppModel(bundleResourceURL: nil, runner: NoopRunner(), defaults: defaults)
    #expect(model.developerProductDir?.path == "/src/metistry")
    #expect(defaults.string(forKey: AppPreference.developerProductDirectory.rawValue) == "/src/metistry")
    #expect(defaults.string(forKey: AppPreference.legacyProductDirectory) == nil)
}

@MainActor
@Test func theActiveInstanceReachesEveryVerbAsAnEnvironmentVariable() {
    let (_, cleanup) = suite("env")
    defer { cleanup() }
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let none = MetistryCLI(runtime: runtime, runner: NoopRunner())
    #expect(none.baseEnvironment.isEmpty)
    let pointed = MetistryCLI(runtime: runtime, runner: NoopRunner(), instanceDir: URL(fileURLWithPath: "/Users/you/instance"))
    #expect(pointed.baseEnvironment == ["METISTRY_INSTANCE_DIR": "/Users/you/instance"])
}

// MARK: - Read-through: the two files Settings shows

@Test func identityYamlIsReadWithoutAYamlDependency() {
    // Verbatim shape of seed/identity.yaml, block scalar and all.
    let text = """
    # SEED TEMPLATE — the ONLY place the assistant is named.
    name: Ada
    mention: "@ada"
    voice: >
      Direct, warm, concise. Says what it knows, flags what it doesn't.
      Never pads. Reports contradictions instead of routing around them.
    icon: "🦉"
    """
    let identity = InstanceIdentity(yaml: YAMLScalars.parse(text))
    #expect(identity.assistantName == "Ada")
    #expect(identity.mention == "@ada")
    #expect(identity.icon == "🦉")
}

@Test func metistryLockIsReadIncludingItsNestedProductBlock() {
    let text = """
    # metistry.lock — the product release this instance runs.
    product:
      version: "0.4.0"
      commit: "91ca417c849364fe209e68f9cae11a4237e734c4"
      source: release
    updated_at: "2026-09-10T03:20:13.882Z"
    migrations_applied:
      - "0001_init.sql"
      - "0002_review_decisions.sql"
      - "0003_auth_enrollment.sql"
    """
    let pin = InstancePin(yaml: YAMLScalars.parse(text))
    #expect(pin.version == "0.4.0")
    #expect(pin.source == "release")
    #expect(pin.commit == "91ca417c849364fe209e68f9cae11a4237e734c4")
    #expect(pin.updatedAt == "2026-09-10T03:20:13.882Z")
    #expect(pin.migrationsApplied == 3)
}

@Test func aBlockScalarsBodyIsNotMistakenForKeys() {
    let text = """
    voice: >
      one: not a key
      two: also not a key
    name: Ada
    """
    let yaml = YAMLScalars.parse(text)
    #expect(yaml["name"] == "Ada")
    #expect(yaml["one"] == nil)
    #expect(yaml["two"] == nil)
}

@MainActor
@Test func anUnreadableIdentityFileIsReportedRatherThanDefaulted() {
    let status = StatusModel(cli: nil)
    let model = SettingsModel(status: status, cli: nil, instanceDir: URL(fileURLWithPath: "/nope/not/an/instance"))
    #expect(model.identity == nil)
    #expect(model.identityError != nil)
    // The assistant is named in identity.yaml or nowhere. No fallback name.
    #expect(model.assistantNameDisplay == "unknown")
}

@Test func theSecretListIsParsedByNameAndScopeOnly() {
    // Verbatim from packages/cli/src/secrets.ts renderSecretList.
    let text = """
    name                            keychain  .env
    ------------------------------------------------
    METISTRY_DB_PASSWORD            yes       set
    METISTRY_BRIDGE_TOKEN_EVENTKIT  yes       -
    CLAUDE_CODE_OAUTH_TOKEN         -         set
    METISTRY_VAPID_PRIVATE          -         -

    Values are never printed.
    """
    let rows = SecretListing.parse(text)
    #expect(rows.count == 4)
    #expect(rows[0] == SecretListing(name: "METISTRY_DB_PASSWORD", inKeychain: true, inEnv: true))
    #expect(rows[1] == SecretListing(name: "METISTRY_BRIDGE_TOKEN_EVENTKIT", inKeychain: true, inEnv: false))
    #expect(rows[2] == SecretListing(name: "CLAUDE_CODE_OAUTH_TOKEN", inKeychain: false, inEnv: true))
    #expect(rows[3].isSet == false)
    // The header, the rule and the closing sentence are not rows.
    #expect(rows.contains { $0.name == "name" } == false)
}

@MainActor
@Test func servicesAndConnectionsComeFromDoctorNotFromTheAppsOwnProbes() async throws {
    let (_, model) = await paneReading(sampleDoctorJSON)

    let deployment = try #require(model.deployment)
    #expect(deployment.shape == "compose")
    #expect(deployment.from == "seed/deployment.yaml")
    #expect(deployment.services["reconciler"] == "launchd")
    #expect(deployment.ordered.map(\.name) == ["console", "db", "reconciler"])

    // The repository's state is the reconciler's own report, not a git call.
    #expect(model.repositoryStatus.contains("pushed to origin"))
    #expect(model.reconciler?.queueDepth == 0)
    #expect(model.bridges.map(\.name) == ["apple-fm"])
}

@MainActor
@Test func anInstanceWithNoRemoteIsNotAnError() async throws {
    let json = sampleDoctorJSON.replacingOccurrences(
        of: #""last_push": { "at": "2026-09-10T03:14:49.937Z", "attempted": true, "ok": true, "remote": "origin" }"#,
        with: #""last_push": { "attempted": false }"#
    )
    let (_, model) = await paneReading(json)
    #expect(model.repositoryStatus.contains("no remote"))
    #expect(model.repositoryStatus.contains("connect-repo"))
}

/// A settings model whose doctor report is the given JSON — read the way the app
/// reads it, through `metistry doctor --json` and a runner, so no test-only
/// setter exists on StatusModel.
@MainActor
private func paneReading(_ json: String) async -> (StatusModel, SettingsModel) {
    let runtime = MetistryRuntime(
        source: .checkout,
        executable: URL(fileURLWithPath: "/usr/bin/node"),
        leadingArguments: ["/src/packages/cli/dist/main.js"],
        productDir: URL(fileURLWithPath: "/src")
    )
    let cli = MetistryCLI(runtime: runtime, runner: CannedRunner(stdout: json))
    let status = StatusModel(cli: cli)
    await status.refresh()
    return (status, SettingsModel(status: status, cli: cli, instanceDir: nil))
}

private struct CannedRunner: CommandRunner {
    let stdout: String

    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: stdout, stderr: "")
    }
}

private struct NoopRunner: CommandRunner {
    func run(
        executable: URL, arguments: [String], environment: [String: String],
        currentDirectory: URL?, onOutput: @escaping @Sendable (OutputLine) -> Void
    ) async throws -> CommandResult {
        CommandResult(exitCode: 0, stdout: "", stderr: "")
    }
}

/// Trimmed from a real `metistry doctor --json` on the Studio install: one row of
/// each kind the settings panes read, with the `meta` shapes intact.
let sampleDoctorJSON = """
{
  "as_of": "2026-09-10T03:24:20.694Z",
  "product_dir": "/Users/you/metistry",
  "shape": "compose",
  "ok": true,
  "rows": [
    {
      "kind": "deployment", "name": "deployment", "status": "ok", "latency_ms": 0,
      "probe": "deployment.yaml shape (seed/deployment.yaml)",
      "meta": {
        "shape": "compose",
        "from": "seed/deployment.yaml",
        "services": { "db": "compose", "console": "compose", "reconciler": "launchd" }
      }
    },
    {
      "kind": "bridge", "name": "apple-fm", "status": "ok", "latency_ms": 12,
      "probe": "real classification of a canned item through FoundationModels",
      "meta": { "probe": "real classification", "bridge_meta": { "category": "todo" } }
    },
    {
      "kind": "service", "name": "console", "status": "ok", "latency_ms": 8,
      "probe": "GET /health", "meta": { "url": "http://127.0.0.1:8080", "api_status": 401 }
    },
    {
      "kind": "service", "name": "reconciler", "status": "ok", "latency_ms": 20,
      "probe": "instance repo present, git runs, HEAD readable",
      "meta": {
        "bridge_meta": {
          "head": "0f5bc22704aa4649334999d7f22b949bc79d3924",
          "queue_depth": 0,
          "last_push": { "at": "2026-09-10T03:14:49.937Z", "attempted": true, "ok": true, "remote": "origin" }
        }
      }
    },
    {
      "kind": "db", "name": "migrations", "status": "ok", "latency_ms": 3,
      "probe": "schema_migrations rows = 13 files in db/migrations",
      "meta": { "applied": 13, "files": 13, "pending": [], "unknown": [] }
    },
    {
      "kind": "launchd", "name": "launchd:com.foldedspacelabs.metistry.watchdog", "status": "ok",
      "latency_ms": 1, "probe": "launchctl print", "meta": { "pid": 99141 }
    },
    {
      "kind": "container", "name": "compose:console", "status": "degraded", "latency_ms": 40,
      "probe": "docker compose ps --format json",
      "remediation": "running but starting — docker compose logs console",
      "meta": { "state": "running", "health": "starting", "status": "Up 3 minutes (starting)" }
    },
    {
      "kind": "collector", "name": "aws-costs", "status": "absent", "latency_ms": 0,
      "probe": "collectors/aws-costs/manifest.yaml validates",
      "remediation": "set METISTRY_AWS_* to fill this in"
    }
  ]
}
"""
