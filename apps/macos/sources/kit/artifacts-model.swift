// Work ▸ Artifacts — the model (design-build-plan T6-9;
// screen-16-artifacts-and-rooms.md §1). The view is artifacts-view.swift.
//
// WHAT AN ARTIFACT IS. A folder in git (`Artifacts/<project>/<slug>/`); every
// version is one commit and the database is a rebuildable index (0010).
// Comments are on an EXACT version, optionally pinned to one file and a line
// (the anchor is the client's: `{line}`, as the PWA writes it). So a thread
// never moves: switching version shows that version's threads, and a thread
// about a line a later version changed stays where it was written — Compare
// says so, and offers the way back to it.
//
// WHAT IS READ, AND FROM WHERE. Every read is a served route (§2.16's
// `ArtifactsStore`, and one named query):
//   - the list: `GET /api/artifacts`;
//   - open threads across every version: `GET /api/q/rooms?anchor=artifact&
//     state=open` — one read for the whole list, counted per artifact and per
//     version;
//   - an artifact: `…/versions` (the rail — numbered here, oldest v1, the way
//     the PWA numbers them), `…/versions/:v/file` (the text on screen) and
//     `…/comments?version=` (its threads);
//   - Compare: `…/diff?from=&to=`, a unified diff, parsed here for what it
//     changed of the FROM version.
// Nothing is guessed. An older version's file is served only while its hash
// still matches the working tree (packages/artifacts `readFile`); past that
// the console says so, and the screen says it too — *v1 was replaced on
// disk* · Show v2 — with that version's threads listed, never placed on
// lines it cannot draw.
//
// THE MARGIN (§1). A thread sits level with its line. When two would collide
// the lower one moves down — 8 pt between cards — and keeps a leader to its
// line (`ThreadMarginPlacement`, measured in artifacts-view-tests.swift).

import Foundation
import Observation
import SwiftUI

// MARK: - An artifact, as the console serves it

public struct ArtifactRecord: Sendable, Equatable, Identifiable {
    public let id: String
    public let project: String
    public let slug: String
    /// `markdown`, `text`, `json`, `csv`, `html`, `image`, `pdf`, `binary` or `bundle`.
    public let kind: String
    public let currentVersion: String?
    public let createdBy: String?
    public let updatedAt: Date?

    public init(id: String, project: String, slug: String, kind: String, currentVersion: String? = nil, createdBy: String? = nil, updatedAt: Date? = nil) {
        self.id = id
        self.project = project
        self.slug = slug
        self.kind = kind
        self.currentVersion = currentVersion
        self.createdBy = createdBy
        self.updatedAt = updatedAt
    }

    init?(json: JSONValue) {
        guard let id = json.string("id"), let project = json.string("project"), let slug = json.string("slug") else { return nil }
        self.init(
            id: id, project: project, slug: slug, kind: json.string("kind") ?? "bundle",
            currentVersion: json.string("current_version"), createdBy: json.string("created_by"),
            updatedAt: WireTime.date(json.string("updated_at"))
        )
    }

    /// `GET /api/artifacts`' `artifacts`, newest first as served.
    static func list(_ json: JSONValue) -> [ArtifactRecord] {
        (json["artifacts"]?.arrayValue ?? []).compactMap(ArtifactRecord.init(json:))
    }
}

/// One file of a version, from its manifest.
public struct ArtifactFileEntry: Sendable, Equatable, Identifiable {
    public let path: String
    public let kind: String
    public let bytes: Int
    public var id: String { path }

    public init(path: String, kind: String, bytes: Int) {
        self.path = path
        self.kind = kind
        self.bytes = bytes
    }

    /// Text the Mac draws line by line. HTML is drawn as its source — agent
    /// markup never renders here; images, PDFs and binaries open in Obsidian.
    public var isText: Bool { ["markdown", "text", "json", "csv", "html"].contains(kind) }
}

public struct ArtifactVersionRecord: Sendable, Equatable, Identifiable {
    public let id: String
    /// 1 for the first version. The wire has ids, not numbers; the rail counts
    /// them oldest first, as the PWA does.
    public let number: Int
    public let author: String
    public let message: String
    public let createdAt: Date?
    /// `Artifacts/<project>/<slug>` — where the files are in the vault.
    public let pathPrefix: String
    /// The manifest, by path.
    public let files: [ArtifactFileEntry]

    public init(id: String, number: Int, author: String, message: String, createdAt: Date?, pathPrefix: String, files: [ArtifactFileEntry]) {
        self.id = id
        self.number = number
        self.author = author
        self.message = message
        self.createdAt = createdAt
        self.pathPrefix = pathPrefix
        self.files = files
    }

    /// *v2*.
    public var label: String { "v\(number)" }
    public var bytes: Int { files.reduce(0) { $0 + $1.bytes } }

    /// The file a version opens on: an entry file when there is one (as the
    /// service picks an artifact's kind), else the first by path.
    public var entry: ArtifactFileEntry? {
        for name in ["index.md", "README.md", "index.html", "index.json"] {
            if let f = files.first(where: { $0.path == name }) { return f }
        }
        return files.first
    }

    public func file(_ path: String?) -> ArtifactFileEntry? {
        path.flatMap { p in files.first { $0.path == p } }
    }

    /// `GET /api/artifacts/:id/versions`' `versions`, served newest first,
    /// numbered from the oldest.
    static func list(_ json: JSONValue) -> [ArtifactVersionRecord] {
        let rows = json["versions"]?.arrayValue ?? []
        return rows.enumerated().compactMap { i, v in
            guard let id = v.string("id") else { return nil }
            var files: [ArtifactFileEntry] = []
            if case .object(let manifest)? = v["manifest"] {
                files = manifest.map { path, meta in
                    ArtifactFileEntry(path: path, kind: meta.string("kind") ?? "binary", bytes: meta["bytes"]?.intValue ?? 0)
                }
                .sorted { $0.path < $1.path }
            }
            return ArtifactVersionRecord(
                id: id, number: rows.count - i, author: v.string("author_principal") ?? "",
                message: v.string("message") ?? "", createdAt: WireTime.date(v.string("created_at")),
                pathPrefix: v.string("path_prefix") ?? "", files: files
            )
        }
    }
}

/// A comment thread's root, or one of its replies.
public struct ArtifactThreadRecord: Sendable, Equatable, Identifiable {
    public let id: String
    public let versionID: String
    public let path: String?
    /// The anchor's line, 1-based, when the thread has one.
    public let line: Int?
    public let body: String
    /// `open` or `resolved`.
    public let state: String
    public let author: String
    /// `human` or `agent`.
    public let authorKind: String
    public let at: Date?
    public let replies: [ArtifactThreadRecord]

    public init(id: String, versionID: String, path: String? = nil, line: Int? = nil, body: String, state: String = "open", author: String = BoardRules.owner, authorKind: String = "human", at: Date? = nil, replies: [ArtifactThreadRecord] = []) {
        self.id = id
        self.versionID = versionID
        self.path = path
        self.line = line
        self.body = body
        self.state = state
        self.author = author
        self.authorKind = authorKind
        self.at = at
        self.replies = replies
    }

    init?(json: JSONValue) {
        guard let id = json.string("id"), let version = json.string("version_id") else { return nil }
        self.init(
            id: id, versionID: version, path: json.string("path"),
            line: json["anchor"]?["line"]?.intValue.flatMap { $0 > 0 ? $0 : nil },
            body: json.string("body") ?? "", state: json.string("state") ?? "open",
            author: json.string("author_principal") ?? "", authorKind: json.string("author_kind") ?? "human",
            at: WireTime.date(json.string("created_at")),
            replies: (json["replies"]?.arrayValue ?? []).compactMap(ArtifactThreadRecord.init(json:))
        )
    }

    public var isOpen: Bool { state != "resolved" }
    public var isAgent: Bool { authorKind == "agent" }

    /// `GET …/comments?version=`' `threads` — only the ones on that version.
    /// The route is asked for one version; a thread is never shown on another.
    static func list(_ json: JSONValue, version: String) -> [ArtifactThreadRecord] {
        (json["threads"]?.arrayValue ?? []).compactMap(ArtifactThreadRecord.init(json:)).filter { $0.versionID == version }
    }
}

/// A file's text, as `…/file?path=` serves it.
public struct ArtifactText: Sendable, Equatable {
    public let path: String
    public let kind: String
    public let lines: [String]

    public init(path: String, kind: String, content: String) {
        self.path = path
        self.kind = kind
        var lines = content.components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        self.lines = lines
    }
}

/// Open threads across every version — `GET /api/q/rooms?anchor=artifact&state=open`, counted.
public struct ArtifactOpenThreads: Sendable, Equatable {
    public let byArtifact: [String: Int]
    public let byVersion: [String: Int]
    /// The read hit its limit: every count is *at least*.
    public let capped: Bool

    public static let limit = 500

    public init(byArtifact: [String: Int] = [:], byVersion: [String: Int] = [:], capped: Bool = false) {
        self.byArtifact = byArtifact
        self.byVersion = byVersion
        self.capped = capped
    }

    init(_ rooms: RoomList, limit: Int = Self.limit) {
        var a: [String: Int] = [:], v: [String: Int] = [:]
        for r in rooms.rows where r.anchor == "artifact" && r.state != "resolved" {
            if let id = r.artifactID { a[id, default: 0] += 1 }
            if let id = r.versionID { v[id, default: 0] += 1 }
        }
        self.init(byArtifact: a, byVersion: v, capped: rooms.rows.count >= limit)
    }
}

// MARK: - Compare: what a diff changed

public struct ArtifactDiffLine: Sendable, Equatable {
    public enum Kind: String, Sendable { case hunk, added, removed, context }
    public let kind: Kind
    public let text: String
    /// The line's number in the FROM version, where it has one.
    public let fromLine: Int?

    public init(_ kind: Kind, _ text: String, fromLine: Int? = nil) {
        self.kind = kind
        self.text = text
        self.fromLine = fromLine
    }
}

public struct ArtifactDiffFile: Sendable, Equatable, Identifiable {
    /// The file's path inside the artifact.
    public let path: String
    public let lines: [ArtifactDiffLine]
    /// Lines of the FROM version this diff removed or replaced.
    public let changedFromLines: Set<Int>
    public var id: String { path }

    public var added: Int { lines.filter { $0.kind == .added }.count }
    public var removed: Int { lines.filter { $0.kind == .removed }.count }
}

/// `GET …/diff`'s unified diff, read: per file, its lines and which lines of
/// the FROM version it changed. Takes `git diff`'s own form (`diff --git`,
/// `@@ -a,b +c,d @@` hunks) and the header-only form with no hunk line, which
/// starts at line 1.
public struct ArtifactDiffReading: Sendable, Equatable {
    public let files: [ArtifactDiffFile]

    public init(files: [ArtifactDiffFile]) {
        self.files = files
    }

    public init(diff: String, pathPrefix: String) {
        var files: [ArtifactDiffFile] = []
        var path: String?
        var lines: [ArtifactDiffLine] = []
        var changed = Set<Int>()
        var old = 1
        var inBody = false
        let gitForm = diff.hasPrefix("diff --git ") || diff.contains("\ndiff --git ")

        func flush() {
            if let path { files.append(ArtifactDiffFile(path: path, lines: lines, changedFromLines: changed)) }
            path = nil
            lines = []
            changed = []
            old = 1
            inBody = false
        }
        func inside(_ header: Substring) -> String {
            var p = String(header)
            if let tab = p.firstIndex(of: "\t") { p = String(p[..<tab]) }
            if p.hasPrefix("a/") || p.hasPrefix("b/") { p = String(p.dropFirst(2)) }
            let prefix = pathPrefix.hasSuffix("/") ? pathPrefix : pathPrefix + "/"
            if !pathPrefix.isEmpty, p.hasPrefix(prefix) { p = String(p.dropFirst(prefix.count)) }
            return p
        }

        let raw = diff.components(separatedBy: "\n")
        var i = 0
        while i < raw.count {
            let l = raw[i]
            if l.hasPrefix("diff --git ") {
                flush()
                i += 1
                continue
            }
            let next = i + 1 < raw.count ? raw[i + 1] : ""
            let header = l.hasPrefix("--- ") && next.hasPrefix("+++ ")
            // Mid-body, only the header-only form starts a file without `diff --git`.
            if header && (!inBody || (!gitForm && l.hasPrefix("--- a/") && next.hasPrefix("+++ b/"))) {
                if inBody { flush() }
                let from = l.dropFirst(4), to = next.dropFirst(4)
                path = inside(from == "/dev/null" ? to : from)
                inBody = true
                i += 2
                continue
            }
            i += 1
            guard inBody else { continue }
            if l.hasPrefix("@@") {
                let parts = l.split(separator: " ")
                if parts.count > 2, parts[1].hasPrefix("-") {
                    old = Int(parts[1].dropFirst().split(separator: ",").first ?? "") ?? old
                }
                lines.append(ArtifactDiffLine(.hunk, l))
            } else if l.hasPrefix("+") {
                lines.append(ArtifactDiffLine(.added, String(l.dropFirst())))
            } else if l.hasPrefix("-") {
                changed.insert(old)
                lines.append(ArtifactDiffLine(.removed, String(l.dropFirst()), fromLine: old))
                old += 1
            } else if l.hasPrefix("\\") {
                continue
            } else if l.isEmpty && i == raw.count {
                continue // the text's own last newline
            } else {
                lines.append(ArtifactDiffLine(.context, l.hasPrefix(" ") ? String(l.dropFirst()) : l, fromLine: old))
                old += 1
            }
        }
        flush()
        self.files = files
    }

    /// Whether the diff changed this line of the FROM version.
    public func changed(path: String, line: Int) -> Bool {
        files.first { $0.path == path }?.changedFromLines.contains(line) ?? false
    }

    public var isEmpty: Bool { files.allSatisfy { $0.added == 0 && $0.removed == 0 } }
}

/// Compare's sentence about the FROM version's threads (§1): *1 thread on v2
/// is about a line v3 changed. It stays on v2.*
public struct ArtifactStayingThreads: Sendable, Equatable {
    public let versionID: String
    public let threads: [ArtifactThreadRecord]
    public let sentence: String
    /// **Open on v2 →**.
    public let action: String

    /// The FROM version's open threads whose line the diff changed; nil when there are none.
    public init?(threads: [ArtifactThreadRecord], diff: ArtifactDiffReading, from: ArtifactVersionRecord, to: ArtifactVersionRecord) {
        let staying = threads.filter { t in
            guard t.isOpen, t.versionID == from.id, let path = t.path, let line = t.line else { return false }
            return diff.changed(path: path, line: line)
        }
        guard !staying.isEmpty else { return nil }
        versionID = from.id
        self.threads = staying
        let n = staying.count
        sentence = "\(n) \(n == 1 ? "thread" : "threads") on \(from.label) \(n == 1 ? "is" : "are") about \(n == 1 ? "a line" : "lines") \(to.label) changed. \(n == 1 ? "It stays" : "They stay") on \(from.label)."
        action = "Open on \(from.label) →"
    }
}

// MARK: - The margin

/// Where each margin card goes (§1): level with its line, unless the card
/// above would overlap it — then just below that card, `gap` apart, with a
/// leader back to its line. Wants and heights are in anchor order.
public enum ThreadMarginPlacement {
    public static let gap: CGFloat = 8

    public static func place(wants: [CGFloat], heights: [CGFloat], gap: CGFloat = gap) -> [CGFloat] {
        var floor = -CGFloat.infinity
        var out: [CGFloat] = []
        for (want, height) in zip(wants, heights) {
            let y = max(want, floor)
            out.append(y)
            floor = y + height + gap
        }
        return out
    }
}

// MARK: - The model

/// One of the screen's own reads, in one of three states.
public enum ArtifactRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case waiting(since: Date)
    case loaded(Value)
    case failed(String, code: String?)

    public var value: Value? { if case .loaded(let v) = self { return v } else { return nil } }
}

/// Compare's two versions and what the diff said.
public struct ArtifactComparison: Sendable, Equatable {
    public let from: String
    public let to: String
    public var diff: ArtifactRead<ArtifactDiffReading>
    /// The FROM version's threads, for the sentence.
    public var fromThreads: [ArtifactThreadRecord]
}

@MainActor
@Observable
public final class ArtifactsModel {
    public let artifacts: SectionModel<[ArtifactRecord]>
    public let openThreads: SectionModel<ArtifactOpenThreads>

    /// The list's selection; ↩ opens it.
    public var selection: String?
    /// The artifact on screen; nil is the list.
    public private(set) var opened: String?
    public private(set) var versions: ArtifactRead<[ArtifactVersionRecord]>?
    /// The version on screen, and its file.
    public private(set) var shownVersion: String?
    public private(set) var shownPath: String?
    public private(set) var text: ArtifactRead<ArtifactText>?
    public private(set) var threads: ArtifactRead<[ArtifactThreadRecord]>?
    /// Set while Compare is on screen.
    public private(set) var comparison: ArtifactComparison?
    /// Threads whose replies are unfolded.
    public var unfolded: Set<String> = []

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored private var threadsDue = false
    @ObservationIgnored public let now: () -> Date
    @ObservationIgnored public let clock: ClockTime

    public static let policy = RefreshPolicy.board

    public init(session: ConsoleSession, timeZone: TimeZone = .current, now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        // No event names a publication, so the list polls.
        artifacts = SectionModel(session: session, policy: Self.policy) { stores in
            await stores.artifacts(project: nil, limit: nil).map { (ArtifactRecord.list($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        openThreads = SectionModel(session: session, policy: Self.policy, topics: [.threads]) { stores in
            await stores.rooms(state: "open", project: nil, anchor: "artifact", limit: ArtifactOpenThreads.limit).map { (ArtifactOpenThreads($0), WireTime.date($0.asOf)) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.close()
            self.selection = nil
            return true
        }
        session.events.watch([.threads]) { [weak self] event in
            guard let self else { return false }
            if case .threadChanged(_, let artifact) = event.change, artifact != nil, artifact == self.opened { self.threadsDue = true }
            return true
        }
    }

    // MARK: Reading

    public func refreshIfDue() async {
        await artifacts.refreshIfDue(now: now())
        await openThreads.refreshIfDue(now: now())
        if threadsDue {
            threadsDue = false
            await readThreads()
        }
    }

    /// Ask everything now (Try Again).
    public func load() async {
        await artifacts.refresh(background: artifacts.section.hasValue)
        await openThreads.refresh(background: openThreads.section.hasValue)
    }

    public var list: [ArtifactRecord] { artifacts.section.value ?? [] }
    public func artifact(_ id: String) -> ArtifactRecord? { list.first { $0.id == id } }

    public var paint: FirstPaint {
        // Components-03 gives Artifacts no stale state: an artifact's versions
        // are commits and do not age, so the list is never banded by the clock.
        FirstPaint.paint(artifacts.section, loadingSince: nil, ageLimit: .greatestFiniteMagnitude, waitingFor: ArtifactsWords.reading, now: now())
    }

    /// Open threads on an artifact across every version; nil until the rooms have answered.
    public func openThreadCount(_ id: String) -> ArtifactsWords.Count? {
        openThreads.section.value.map { ArtifactsWords.Count(n: $0.byArtifact[id] ?? 0, atLeast: $0.capped) }
    }

    public func openThreadCount(version id: String) -> ArtifactsWords.Count? {
        openThreads.section.value.map { ArtifactsWords.Count(n: $0.byVersion[id] ?? 0, atLeast: $0.capped) }
    }

    public var versionList: [ArtifactVersionRecord] { versions?.value ?? [] }
    public func version(_ id: String?) -> ArtifactVersionRecord? { id.flatMap { v in versionList.first { $0.id == v } } }
    public var shown: ArtifactVersionRecord? { version(shownVersion) }
    public var shownFile: ArtifactFileEntry? { shown?.file(shownPath) }

    // MARK: Moving about

    /// Opens an artifact on its latest version.
    public func open(_ id: String) async {
        guard let session, artifact(id) != nil else { return }
        close()
        selection = id
        opened = id
        let generation = session.generation
        versions = .waiting(since: now())
        let answer = await session.stores.versions(ofArtifact: id)
        guard session.generation == generation, opened == id else { return }
        switch answer {
        case .success(let reply):
            let list = ArtifactVersionRecord.list(reply.json)
            versions = .loaded(list)
            let current = artifact(id)?.currentVersion
            if let v = list.first(where: { $0.id == current }) ?? list.first { await show(version: v.id) }
        case .failure(let e):
            versions = .failed(Self.problem(e), code: e.code)
        }
    }

    public func back() {
        close()
    }

    private func close() {
        opened = nil
        versions = nil
        shownVersion = nil
        shownPath = nil
        text = nil
        threads = nil
        comparison = nil
        unfolded = []
        threadsDue = false
    }

    /// Show one version — its entry file, or the file on screen when it has
    /// one of that path — and that version's threads.
    public func show(version id: String) async {
        guard let v = version(id) else { return }
        comparison = nil
        shownVersion = id
        let path = v.file(shownPath)?.path ?? v.entry?.path
        await readThreads()
        await show(file: path)
    }

    public func show(file path: String?) async {
        guard let session, let artifact = opened, let v = shown else { return }
        shownPath = path
        guard let path, let entry = v.file(path) else {
            text = nil
            return
        }
        guard entry.isText else {
            text = nil
            return
        }
        let generation = session.generation
        let key = (v.id, path)
        text = .waiting(since: now())
        let answer = await session.stores.file(path, version: v.id, ofArtifact: artifact)
        guard session.generation == generation, shownVersion == key.0, shownPath == key.1 else { return }
        switch answer {
        case .success(let f):
            if let content = f["content"]?.stringValue {
                text = .loaded(ArtifactText(path: path, kind: f["kind"]?.stringValue ?? entry.kind, content: content))
            } else {
                text = .failed(ArtifactsWords.notText(path), code: nil)
            }
        case .failure(let e):
            text = .failed(Self.problem(e), code: e.code)
        }
    }

    func readThreads() async {
        guard let session, let artifact = opened, let v = shownVersion else { return }
        let generation = session.generation
        if threads?.value == nil { threads = .waiting(since: now()) }
        let answer = await session.stores.comments(onArtifact: artifact, version: v)
        guard session.generation == generation, shownVersion == v else { return }
        switch answer {
        case .success(let reply):
            threads = .loaded(ArtifactThreadRecord.list(reply.json, version: v))
        case .failure(let e):
            if threads?.value != nil { return }
            threads = .failed(Self.problem(e), code: e.code)
        }
    }

    /// The version the failed state offers: the latest when the one on
    /// screen is older, else the one before it.
    public var fallbackVersion: ArtifactVersionRecord? {
        guard let v = shown else { return nil }
        let list = versionList
        if let current = opened.flatMap({ artifact($0) })?.currentVersion, current != v.id, let c = version(current) { return c }
        return list.first { $0.number == v.number - 1 }
    }

    // MARK: The margin

    /// The root threads drawn in the margin: on the file on screen, on a line
    /// it has — in line order.
    public var marginThreads: [ArtifactThreadRecord] {
        guard let t = text?.value, let all = threads?.value else { return [] }
        return all.filter { $0.path == t.path && ($0.line.map { $0 <= t.lines.count } ?? false) }
            .sorted { ($0.line ?? 0, $0.at ?? .distantPast) < ($1.line ?? 0, $1.at ?? .distantPast) }
    }

    /// The version's threads that have no line to sit on here: another file,
    /// no anchor, a line past the end, or a file that could not be drawn.
    public var otherThreads: [ArtifactThreadRecord] {
        let placed = Set(marginThreads.map(\.id))
        return (threads?.value ?? []).filter { !placed.contains($0.id) }
    }

    /// The lines with a thread — highlighted.
    public var threadLines: Set<Int> { Set(marginThreads.compactMap(\.line)) }

    public func toggleReplies(_ id: String) {
        if unfolded.contains(id) { unfolded.remove(id) } else { unfolded.insert(id) }
    }

    // MARK: Compare

    /// Compare needs two versions.
    public var canCompare: Bool { versionList.count > 1 }

    /// From the version before the one on screen to it; from v1, to the latest.
    public func beginCompare() async {
        guard canCompare, let v = shown else { return }
        let list = versionList
        let latest = list.max { $0.number < $1.number }
        if let before = list.first(where: { $0.number == v.number - 1 }) {
            await compare(from: before.id, to: v.id)
        } else if let latest, latest.id != v.id {
            await compare(from: v.id, to: latest.id)
        }
    }

    public func compare(from: String, to: String) async {
        guard let session, let artifact = opened, let f = version(from), version(to) != nil, from != to else { return }
        let generation = session.generation
        comparison = ArtifactComparison(from: from, to: to, diff: .waiting(since: now()), fromThreads: [])
        async let diff = session.stores.diff(ofArtifact: artifact, from: from, to: to)
        async let comments = session.stores.comments(onArtifact: artifact, version: from)
        let (d, c) = await (diff, comments)
        guard session.generation == generation, comparison?.from == from, comparison?.to == to else { return }
        let fromThreads = (try? c.get()).map { ArtifactThreadRecord.list($0.json, version: from) } ?? []
        switch d {
        case .success(let reply):
            comparison = ArtifactComparison(from: from, to: to, diff: .loaded(ArtifactDiffReading(diff: reply["diff"]?.stringValue ?? "", pathPrefix: f.pathPrefix)), fromThreads: fromThreads)
        case .failure(let e):
            comparison = ArtifactComparison(from: from, to: to, diff: .failed(Self.problem(e), code: e.code), fromThreads: fromThreads)
        }
    }

    public func endCompare() {
        comparison = nil
    }

    /// Compare's sentence, once the diff is read.
    public var staying: ArtifactStayingThreads? {
        guard let c = comparison, let diff = c.diff.value, let f = version(c.from), let t = version(c.to) else { return nil }
        return ArtifactStayingThreads(threads: c.fromThreads, diff: diff, from: f, to: t)
    }

    /// The vault path ⌘O opens: the file on screen, else the artifact's folder.
    public var obsidianPath: String? {
        guard let v = shown, !v.pathPrefix.isEmpty else { return nil }
        return shownPath.map { "\(v.pathPrefix)/\($0)" } ?? v.pathPrefix
    }

    nonisolated static func problem(_ e: ConsoleError) -> String {
        e.refusal ?? e.localizedDescription
    }
}

// MARK: - The words

/// The screen's fixed words, in one place.
public enum ArtifactsWords {
    public static let title = "Artifacts"
    public static let back = "Artifacts"
    public static let reading = "Reading your artifacts"
    public static let versions = "Versions"
    public static let threads = "Threads"
    public static let notOnALine = "Not on a line"
    public static let compare = "Compare"
    public static let from = "From"
    public static let to = "To"
    public static let latest = "latest"
    public static let noChanges = "These versions have the same content."
    public static let htmlAsSource = "HTML is shown as its source — it never runs here."
    public static let openInObsidian = "Open in Obsidian"

    /// Components-03's Artifacts empty state.
    public static let emptyTitle = "No Artifacts Yet"
    public static let emptySentence = "An artifact appears here when you or an agent publishes one — every version kept, each one a commit."

    /// A count that may be *at least*.
    public struct Count: Sendable, Equatable {
        public let n: Int
        public let atLeast: Bool

        public var number: String { atLeast ? "\(n)+" : "\(n)" }
    }

    /// *1 open thread* · *No open threads* · *500+ open threads*.
    public static func openThreads(_ c: Count) -> String {
        c.n == 0 && !c.atLeast ? "No open threads" : "\(c.number) open \(c.n == 1 && !c.atLeast ? "thread" : "threads")"
    }

    /// *updated 2 hours ago*.
    public static func updated(_ at: Date?, now: Date) -> String? {
        at.map { "updated \(ClockTime.age(now.timeIntervalSince($0)))" }
    }

    /// Who made a version or wrote a thread: *You* for the owner, the
    /// configured name for the instance's own agent, an agent by its id.
    public static func author(_ principal: String, assistantName: String?) -> String {
        if principal == BoardRules.owner { return "You" }
        if principal == AgentChipModel.assistantPrincipal, let assistantName { return assistantName }
        return principal
    }

    /// *66 bytes* · *2.1 MB*.
    public static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// Components-03's wait: *Opening vendor-summary · v3 · 2.1 MB*.
    public static func opening(_ slug: String, _ v: ArtifactVersionRecord, bytes: Int) -> String {
        "Opening \(slug) · \(v.label) · \(size(bytes))"
    }

    /// A file that could not be read, and why.
    public static func unreadableTitle(_ v: ArtifactVersionRecord) -> String { "Couldn't Show \(v.label)" }

    /// The service's `not_available`: an older version's file was replaced on the working tree.
    public static func replaced(_ path: String, _ v: ArtifactVersionRecord) -> String {
        "\(path) at \(v.label) was replaced on disk, so it can't be shown. Its threads are listed below."
    }

    public static func show(_ v: ArtifactVersionRecord) -> String { "Show \(v.label)" }

    public static func notText(_ path: String) -> String { "\(path) came back without text." }

    /// A binary file: where it opens instead.
    public static func notDrawn(_ f: ArtifactFileEntry) -> String {
        let what = f.kind == "image" ? "an image" : f.kind == "pdf" ? "a PDF" : "a binary file"
        return "\(f.path) is \(what). It opens in Obsidian."
    }

    /// *v2 · You · 2 hours ago*.
    public static func versionLine(_ v: ArtifactVersionRecord, assistantName: String?, now: Date) -> String {
        ([v.label, author(v.author, assistantName: assistantName)] + (v.createdAt.map { [ClockTime.age(now.timeIntervalSince($0))] } ?? [])).joined(separator: " · ")
    }

    /// *2 replies*.
    public static func replies(_ n: Int) -> String { "\(n) \(n == 1 ? "reply" : "replies")" }

    public static func line(_ n: Int) -> String { "Line \(n)" }

    /// A highlighted line, as VoiceOver reads it: its words, then that it has a thread.
    public static func markedLine(_ text: String, number: Int, threads: Int) -> String {
        let said = text.trimmingCharacters(in: .whitespaces)
        let lead = said.isEmpty ? "" : ".!?:;".contains(said.last!) ? "\(said) " : "\(said). "
        return "\(lead)\(line(number)), \(threads) \(threads == 1 ? "thread" : "threads")"
    }

    public static func compareHeading(_ from: ArtifactVersionRecord, _ to: ArtifactVersionRecord) -> String {
        "Compare \(from.label) and \(to.label)"
    }
}
