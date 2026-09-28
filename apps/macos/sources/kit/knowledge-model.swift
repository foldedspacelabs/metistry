// Knowledge — the model (design-build-plan T6-4; screen-10-knowledge.md).
//
// WHAT THE SCREEN IS FOR. Where the owner reads what the system learned and
// settles what it could not decide alone — not a file browser (§1). Its top is
// the fold, then Needs your eye, then Areas, then one sources line; a page,
// an area's page list and search sit behind those (§5, §7).
//
// WHAT IT READS, each through a §2.16 store and nothing else:
//
//   * the fold — `GET /api/knowledge/fold` (T1-6) names the newest
//     `Journal/Fold/*.md` and its links; its words are that file's bytes,
//     `GET /api/knowledge/page`. The route never names a draft (§3.2).
//   * Needs your eye — the Needs You queue (`GET /api/proposals`) narrowed to
//     the three knowledge kinds, and the owner-only drafts
//     (`GET /api/knowledge/drafts`). One pending thing, read from two places:
//     an answer here is the same `POST /api/proposals/:id` Needs You sends
//     (§3.1), so answering it here answers it there.
//   * Areas — `GET /api/knowledge/areas`; an area's pages,
//     `GET /api/knowledge/pages?area=`.
//   * the sources line — the syncs `GET /api/scheduled` lists, and
//     `collector_health` per sync once a door serves it. Until then the line
//     says *freshness unknown* (§6, P5): no route serves the query yet
//     (seed/queries/collector_health.yaml is `expose: route` with no route).
//   * a page — `GET /api/knowledge/page` and `GET /api/knowledge/links`; its
//     history, `GET /api/knowledge/history`, and one version of it,
//     `GET /api/knowledge/version` (T10-4, drawn by T10-7).
//
// WHAT IT WRITES, and nothing else: a request's answer (the Needs You card,
// unchanged), a conflict settled through T2-10's door
// (`POST /api/knowledge/conflicts/resolve`), and a restore ASKED for —
// `POST /api/knowledge/restore` (T10-5) raises a Needs You request and writes
// nothing; the page then shows that request inline, and answering it there
// answers it in Needs You (screen 10 §3.1). Restore is reach `local` (ruling
// 7): drawn and sent only while `GET /api/whoami` says this client is the
// local owner token (vault-history-model.swift). The conflict's Undo is the
// client's (C136; knowledge-routes.ts): Keep Mine or Take the Other is held
// here for ten seconds and only then sent, so Undo sends nothing at all.
//
// THE NAME. Labels template the configured name; until the console has said
// it, words are shown without an author — never a default, never the
// principal id.

import Foundation
import Observation

// MARK: - The fold

/// `GET /api/knowledge/fold`'s `fold`, and the file's words.
public struct KnowledgeFoldRead: Sendable, Equatable {
    public var path: String
    /// `YYYY-MM-DD`, from the file's name.
    public var date: String
    public var title: String?
    public var modified: Date?
    /// The fold's outgoing links, as the index has them — never a draft.
    public var links: [KnowledgeLinkRef]
    /// Nil when the page could not be read; the header still names the file.
    public var document: FoldDocument?

    public init(path: String, date: String, title: String? = nil, modified: Date? = nil, links: [KnowledgeLinkRef] = [], document: FoldDocument? = nil) {
        self.path = path
        self.date = date
        self.title = title
        self.modified = modified
        self.links = links
        self.document = document
    }

    /// The route's `fold` object; nil for `fold: null` (no fold yet).
    static func from(_ json: JSONValue?) -> KnowledgeFoldRead? {
        guard let f = json, let path = f.string("path"), let date = f.string("date") else { return nil }
        let links = (f["links"]?.arrayValue ?? []).compactMap(KnowledgeLinkRef.from)
        return KnowledgeFoldRead(path: path, date: date, title: f.string("title"), modified: WireTime.date(f.string("modified")), links: links)
    }
}

/// One link the fold (or a page) makes: where to, how, and whether anything is there yet.
public struct KnowledgeLinkRef: Sendable, Equatable, Identifiable {
    public var path: String
    public var title: String?
    /// `wikilink`, `frontmatter` or `embed`.
    public var kind: String?
    /// False: a note that has not been written yet — shown, never followed.
    public var resolved: Bool

    public var id: String { "\(kind ?? "")|\(path)" }

    public init(path: String, title: String? = nil, kind: String? = nil, resolved: Bool = true) {
        self.path = path
        self.title = title
        self.kind = kind
        self.resolved = resolved
    }

    static func from(_ j: JSONValue) -> KnowledgeLinkRef? {
        guard let path = j.string("path") else { return nil }
        return KnowledgeLinkRef(path: path, title: j.string("title"), kind: j.string("kind"), resolved: j.bool("resolved") ?? true)
    }
}

/// `Journal/Fold/<date>.md` as `knowledge-fold` renders it from
/// `Templates/Fold.md`: its `##` sections, each one's words. A slot still
/// pending (`<!-- metistry:prose … -->`) is a section with no words yet.
public struct FoldDocument: Sendable, Equatable {
    public struct Part: Sendable, Equatable {
        /// The `##` heading, verbatim; nil for words before the first one.
        public var heading: String?
        /// The words, markers stripped; nil while the slot is still pending.
        public var text: String?
    }

    public var parts: [Part]

    public init(parts: [Part]) {
        self.parts = parts
    }

    /// Everything the fold says, in one string — what VoiceOver reads.
    public var plain: String {
        parts.compactMap { part in
            guard let text = part.text else { return nil }
            return [part.heading, FoldText.plain(text)].compactMap { $0 }.joined(separator: ". ")
        }.joined(separator: "\n")
    }

    public static func parse(_ markdown: String) -> FoldDocument {
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        // Frontmatter: `---` … `---` at the very top.
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---", let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            lines = Array(lines[(end + 1)...])
        }
        var parts: [Part] = []
        var heading: String?
        var body: [String] = []
        var sawPending = false
        func flush() {
            while body.first?.isEmpty == true { body.removeFirst() }
            while body.last?.isEmpty == true { body.removeLast() }
            if heading != nil || !body.isEmpty || sawPending {
                parts.append(Part(heading: heading, text: body.isEmpty ? nil : body.joined(separator: "\n")))
            }
            body = []
            sawPending = false
        }
        var titleDropped = false
        for raw in lines {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("## ") {
                flush()
                heading = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                continue
            }
            if !titleDropped, heading == nil, body.allSatisfy(\.isEmpty), line.hasPrefix("# ") {
                titleDropped = true
                continue
            }
            if FoldText.isPending(line) {
                sawPending = true
                continue
            }
            let clean = FoldText.stripMarkers(raw)
            if clean.trimmingCharacters(in: .whitespaces).isEmpty {
                if !body.isEmpty && body.last != "" { body.append("") }
                continue
            }
            body.append(clean)
        }
        flush()
        return FoldDocument(parts: parts)
    }
}

/// The fold's words, and the one thing in them that is not text: a page name.
public enum FoldText {
    static let pendingMarker = try! NSRegularExpression(pattern: #"<!--\s*metistry:prose\b[^>]*-->"#)
    static let anyMarker = try! NSRegularExpression(pattern: #"\s*<!--\s*metistry:[^>]*-->"#)
    /// `[[target]]`, `[[target|alias]]`, `![[embed]]`.
    static let wikilink = try! NSRegularExpression(pattern: #"(!?)\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|([^\]]+))?\]\]"#)

    /// The scheme a page name opens by — handled by the view, never the system.
    public static let scheme = "metistry-knowledge"

    static func isPending(_ line: String) -> Bool {
        pendingMarker.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
    }

    static func stripMarkers(_ line: String) -> String {
        anyMarker.stringByReplacingMatches(in: line, range: NSRange(line.startIndex..., in: line), withTemplate: "")
    }

    /// A wikilink's target as a vault path: `Areas/Health/Sleep` → `Areas/Health/Sleep.md`.
    public static func vaultPath(_ target: String) -> String {
        let t = target.trimmingCharacters(in: .whitespaces)
        // A name with an extension is a file already (`.md`, an embedded image); a bare name is a note.
        let last = t.split(separator: "/").last.map(String.init) ?? t
        return last.contains(".") ? t : t + ".md"
    }

    /// Every page the words name, in order, once each.
    public static func links(in text: String) -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        for m in wikilink.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let r = Range(m.range(at: 2), in: text) else { continue }
            let path = vaultPath(String(text[r]))
            if seen.insert(path).inserted { out.append(path) }
        }
        return out
    }

    /// The words with each wikilink read as its alias or its name — what VoiceOver says.
    public static func plain(_ text: String) -> String {
        var out = ""
        var cursor = text.startIndex
        for m in wikilink.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(m.range, in: text), let target = Range(m.range(at: 2), in: text) else { continue }
            out += text[cursor..<whole.lowerBound]
            out += Range(m.range(at: 3), in: text).map { String(text[$0]) } ?? displayName(String(text[target]))
            cursor = whole.upperBound
        }
        out += text[cursor...]
        return out
    }

    /// `Areas/Health/Sleep` → `Sleep`.
    static func displayName(_ target: String) -> String {
        let last = target.split(separator: "/").last.map(String.init) ?? target
        return last.hasSuffix(".md") ? String(last.dropLast(3)) : last
    }

    /// The words, with each page name a link the view opens in place (a path
    /// is a reference, not an action — following one changes nothing, §2).
    public static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString()
        var cursor = text.startIndex
        for m in wikilink.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(m.range, in: text), let target = Range(m.range(at: 2), in: text) else { continue }
            out += AttributedString(String(text[cursor..<whole.lowerBound]))
            let label = Range(m.range(at: 3), in: text).map { String(text[$0]) } ?? displayName(String(text[target]))
            var link = AttributedString(label)
            link.link = url(for: vaultPath(String(text[target])))
            out += link
            cursor = whole.upperBound
        }
        out += AttributedString(String(text[cursor...]))
        return out
    }

    public static func url(for path: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "page"
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        return c.url
    }

    /// The vault path a link from `attributed` carries; nil for any other URL.
    public static func path(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "page" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
    }
}

// MARK: - Needs your eye

/// `GET /api/knowledge/drafts`' row: a note whose frontmatter says `status: draft`.
public struct KnowledgeDraftRow: Sendable, Equatable, Identifiable {
    public var path: String
    public var area: String?
    public var title: String?
    public var description: String?
    public var modified: Date?
    public var id: String { path }

    public init(path: String, area: String? = nil, title: String? = nil, description: String? = nil, modified: Date? = nil) {
        self.path = path
        self.area = area
        self.title = title
        self.description = description
        self.modified = modified
    }

    static func list(_ json: JSONValue) -> [KnowledgeDraftRow] {
        (json["drafts"]?.arrayValue ?? []).compactMap { d in
            guard let path = d.string("path") else { return nil }
            return KnowledgeDraftRow(path: path, area: d.string("area"), title: d.string("title"), description: d.string("description"), modified: WireTime.date(d.string("modified")))
        }
    }
}

/// One row of Needs your eye: *what it is · which page · why it is here · the verb* (§3).
public struct KnowledgeEyeItem: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable, CaseIterable {
        case draft = "Draft"
        case conflict = "Conflict"
        case suggestion = "Suggestion"

        var glyph: MetistryGlyph {
            switch self {
            case .draft: return .edit
            case .conflict: return .degraded
            case .suggestion: return .spark
            }
        }

        /// The row's verb, and what opening it does.
        var verb: String {
            switch self {
            case .draft: return "Review"
            case .conflict: return "Resolve"
            case .suggestion: return "Read"
            }
        }
    }

    public var kind: Kind
    /// Which page — vault-relative.
    public var path: String
    /// Why it is here, in a line.
    public var why: String
    /// The request that answers it. Nil: a draft nothing has asked about yet.
    public var request: RequestRow?

    public var id: String { request.map { "request:\($0.id)" } ?? "draft:\(path)" }

    /// The kinds of request that are Knowledge's (§3): a draft settlement, a
    /// knowledge conflict (T2-9's `review`), and the assistant's suggested write.
    static func kind(of row: RequestRow) -> Kind? {
        switch row.kind {
        case "draft_settle": return .draft
        case "knowledge": return .suggestion
        case "review": return row.payload?.string("event") == KnowledgeConflict.event ? .conflict : nil
        default: return nil
        }
    }

    /// Drafts first, then conflicts, then suggestions; a draft already asked
    /// about is its request's row, not a second one.
    public static func items(requests: [RequestRow], drafts: [KnowledgeDraftRow]) -> [KnowledgeEyeItem] {
        var out: [KnowledgeEyeItem] = []
        var asked: Set<String> = []
        for row in requests {
            guard let kind = kind(of: row) else { continue }
            let path: String
            let why: String
            switch kind {
            case .conflict:
                let c = KnowledgeConflict(row)
                path = c?.original ?? c?.copy ?? row.payload?.string("path") ?? ""
                why = "Two versions of this note — a sync kept both"
            case .draft, .suggestion:
                path = row.payload?.string("path") ?? ""
                why = row.payload?.string("summary", "title", "note") ?? drafts.first { $0.path == path }?.description ?? "Waiting for your answer"
            }
            if kind == .draft { asked.insert(path) }
            out.append(KnowledgeEyeItem(kind: kind, path: path, why: why, request: row))
        }
        for d in drafts where !asked.contains(d.path) {
            out.append(KnowledgeEyeItem(kind: .draft, path: d.path, why: d.description ?? d.title ?? "Marked status: draft", request: nil))
        }
        let order: [Kind: Int] = [.draft: 0, .conflict: 1, .suggestion: 2]
        return out.enumerated().sorted { (order[$0.element.kind]!, $0.offset) < (order[$1.element.kind]!, $1.offset) }.map(\.element)
    }

    /// The row, spoken as one: *Draft, Areas/Health/Sleep.md, the taper. Review*.
    public var spoken: String { "\(kind.rawValue), \(path), \(why). \(kind.verb)" }
}

/// A knowledge conflict's request (T2-9): the copy a sync tool kept beside a
/// note, both sides' words and hashes. The hashes are what T2-10's door checks.
public struct KnowledgeConflict: Sendable, Equatable {
    /// `payload.event` on a conflict's request (apps/reconciler/src/indexer.ts `CONFLICT_EVENT`).
    public static let event = "knowledge_conflict"

    public var requestID: Int
    /// The copy — the one path the index has in `conflict`, and what the door is asked about.
    public var copy: String
    /// The note it copies; nil when the note itself is gone.
    public var original: String?
    /// The copy's hash — given up by Keep Mine. Nil: not there.
    public var otherSHA: String?
    /// The note's hash — given up by Take the Other. Nil: not there.
    public var mineSHA: String?
    public var mine: String
    public var other: String
    public var truncated: Bool
    /// When the reconciler raised it — the one time the request knows.
    public var foundAt: Date?

    public init?(_ row: RequestRow) {
        guard let p = row.payload, p.string("event") == Self.event, let c = p["conflict"], let copy = c.string("path") else { return nil }
        requestID = row.id
        self.copy = copy
        original = c.string("original")
        otherSHA = c.string("sha256")
        mineSHA = c.string("original_sha256")
        let body = p["body"]
        mine = body?["before"]?.string("text") ?? ""
        other = body?["after"]?.string("text") ?? ""
        truncated = body?["before"]?.bool("truncated") == true || body?["after"]?.bool("truncated") == true
        foundAt = WireTime.date(row.ts)
    }

    /// The `conflict` a `409 stale` carries back: the same four fields, fresh.
    mutating func repaint(_ fresh: JSONValue) {
        if let path = fresh.string("path") { copy = path }
        original = fresh.string("original")
        otherSHA = fresh.string("sha256")
        mineSHA = fresh.string("original_sha256")
    }

    /// `seen_sha`: the hash of the side being GIVEN UP, as it was shown; "" when that side does not exist.
    public func seenSHA(keeping side: ConflictSide) -> String {
        (side == .mine ? otherSHA : mineSHA) ?? ""
    }

    /// `-` is yours, `+` is the other's (§4.3).
    public var diff: [DiffLine] { ConflictDiff.lines(mine: mine, other: other) }
}

/// A line diff — the longest common run of lines kept as context.
public enum ConflictDiff {
    /// Past this many lines a side, the diff is the two sides whole: Obsidian compares better.
    static let lineCeiling = 1500

    public static func lines(mine: String, other: String) -> [DiffLine] {
        let a = mine.components(separatedBy: "\n")
        let b = other.components(separatedBy: "\n")
        guard a.count <= lineCeiling, b.count <= lineCeiling else {
            return a.map { DiffLine(.removed, $0) } + b.map { DiffLine(.added, $0) }
        }
        let n = a.count, m = b.count
        var table = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var out: [DiffLine] = []
        var i = 0, j = 0
        while i < n || j < m {
            if i < n, j < m, a[i] == b[j] {
                out.append(DiffLine(.context, a[i])); i += 1; j += 1
            } else if i < n, j == m || table[i + 1][j] >= table[i][j + 1] {
                // Yours goes first: `-` then `+`, as a diff reads.
                out.append(DiffLine(.removed, a[i])); i += 1
            } else {
                out.append(DiffLine(.added, b[j])); j += 1
            }
        }
        return out
    }
}

/// Keep Mine or Take the Other — held ten seconds, then sent (C136).
@MainActor
@Observable
public final class ConflictResolution {
    public enum Phase: Equatable {
        case open
        /// Chosen, not sent: Undo takes it back and nothing leaves the Mac.
        case holding(ConflictSide, since: Date)
        case sending(ConflictSide)
        case settled(String)
        /// Refused, in the console's own words; still answerable.
        case refused(String)
        /// Nothing is in conflict at that path any more.
        case gone(String)
    }

    public private(set) var conflict: KnowledgeConflict
    public private(set) var phase: Phase = .open
    /// A `409 stale` repainted the hashes: the files moved after they were shown.
    public private(set) var repainted = false

    @ObservationIgnored private let store: any VaultStore
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let hold: Duration
    @ObservationIgnored private var pending: Task<Void, Never>?
    /// Called once the conflict is settled or gone, so the list asks again.
    @ObservationIgnored var onSettled: (@MainActor () async -> Void)?

    public init(_ conflict: KnowledgeConflict, store: any VaultStore, hold: Duration = .seconds(UndoWindow.seconds), now: @escaping () -> Date = Date.init) {
        self.conflict = conflict
        self.store = store
        self.hold = hold
        self.now = now
    }

    /// The two verbs, in the order they are drawn, with the words the request is served with.
    public static func label(_ side: ConflictSide, row: RequestRow?) -> String {
        let served = side == .mine ? row?.request?.primary?.label : row?.request?.revise?.label
        return served ?? (side == .mine ? "Keep Mine" : "Take the Other")
    }

    public var isHolding: Bool { if case .holding = phase { return true } else { return false } }

    /// Act at once — on screen. The request leaves only when the window closes.
    public func choose(_ side: ConflictSide) {
        switch phase {
        case .open, .refused: break
        default: return
        }
        phase = .holding(side, since: now())
        pending?.cancel()
        let hold = self.hold
        pending = Task { [weak self] in
            try? await Task.sleep(for: hold)
            guard !Task.isCancelled else { return }
            await self?.send()
        }
    }

    /// Undo: nothing was sent, so nothing is sent back.
    public func undo() {
        guard case .holding = phase else { return }
        pending?.cancel()
        pending = nil
        phase = .open
    }

    /// The receipt the hold shows, with Undo.
    public var undoWindow: UndoWindow? {
        guard case .holding(let side, let since) = phase else { return nil }
        return UndoWindow(side == .mine ? "Keeping your version" : "Taking the other version", actedAt: since)
    }

    /// The hold is over: send it. Also what a test calls instead of waiting.
    func send() async {
        guard case .holding(let side, _) = phase else { return }
        pending = nil
        phase = .sending(side)
        let result = await store.resolveConflict(path: conflict.copy, keep: side, seenSHA: conflict.seenSHA(keeping: side))
        switch result {
        case .success(let reply):
            let path = reply["path"]?.stringValue ?? conflict.original ?? conflict.copy
            phase = .settled(side == .mine ? "Kept your version of \(path)" : "Took the other version of \(path)")
            await onSettled?()
        case .failure(let error):
            if error.wasHeldForReachability {
                phase = .refused(StateWords.unreachable)
            } else if error.conflictReason == "stale" {
                if case .object = error.details["conflict"], let fresh = error.details["conflict"] {
                    conflict.repaint(fresh)
                    repainted = true
                    phase = .refused("These files changed after you saw them — look again before you choose")
                } else {
                    phase = .gone("Already settled elsewhere — nothing changed from here")
                    await onSettled?()
                }
            } else {
                phase = .refused(error.refusal ?? error.localizedDescription)
            }
        }
    }
}

// MARK: - Areas

/// `GET /api/knowledge/areas`' row: the area, its written line, why it is in front of the owner.
public struct KnowledgeAreaRow: Sendable, Equatable, Identifiable {
    public var area: String
    /// Its `README.md`'s one-line description — nil until one is written (C68).
    public var description: String?
    public var pages: Int
    public var lastChange: Date?
    public var namedByFold: Bool
    public var id: String { area }

    public init(area: String, description: String? = nil, pages: Int = 0, lastChange: Date? = nil, namedByFold: Bool = false) {
        self.area = area
        self.description = description
        self.pages = pages
        self.lastChange = lastChange
        self.namedByFold = namedByFold
    }

    static func list(_ json: JSONValue) -> [KnowledgeAreaRow] {
        (json["areas"]?.arrayValue ?? []).compactMap { a in
            guard let area = a.string("area") else { return nil }
            return KnowledgeAreaRow(area: area, description: a.string("description"), pages: a["pages"]?.intValue ?? 0, lastChange: WireTime.date(a.string("last_change")), namedByFold: a.bool("named_by_fold") ?? false)
        }
    }

    /// No line yet — said, not left blank (C68).
    public static let noLine = "No line written for this area yet"

    public var line: String { description ?? Self.noLine }

    /// Why it is here — provenance, never a rank (P5): the fold named it, or when it last changed.
    public func provenance(now: Date) -> String {
        if namedByFold { return "Named by the latest fold" }
        if let lastChange { return "Changed \(ClockTime.age(now.timeIntervalSince(lastChange)))" }
        return "Nothing indexed here yet"
    }

    public func spoken(now: Date) -> String { "\(area), \(line), \(provenance(now: now))" }
}

// MARK: - Sources

/// `collector_health`'s row for one component (§2.10, T1-5).
public struct CollectorHealth: Sendable, Equatable {
    public var lastOK: Date?
    public var lastFailure: Date?
    public var lastError: String?
    /// Consecutive failures since `lastOK`; 0 once the latest run succeeded.
    public var streak: Int

    public init(lastOK: Date? = nil, lastFailure: Date? = nil, lastError: String? = nil, streak: Int = 0) {
        self.lastOK = lastOK
        self.lastFailure = lastFailure
        self.lastError = lastError
        self.streak = streak
    }
}

/// One sync, as `GET /api/scheduled` lists it.
public struct KnowledgeSource: Sendable, Equatable, Identifiable {
    public var name: String
    public var title: String
    /// `5m`, `1h`, `6h` — how often it runs.
    public var every: String?
    public var paused: Bool
    public var lastRunAt: Date?
    public var lastRunOK: Bool?
    public var lastRunError: String?
    public var id: String { name }

    public init(name: String, title: String, every: String? = nil, paused: Bool = false, lastRunAt: Date? = nil, lastRunOK: Bool? = nil, lastRunError: String? = nil) {
        self.name = name
        self.title = title
        self.every = every
        self.paused = paused
        self.lastRunAt = lastRunAt
        self.lastRunOK = lastRunOK
        self.lastRunError = lastRunError
    }

    static func list(_ json: JSONValue) -> [KnowledgeSource] {
        (json["syncs"]?.arrayValue ?? []).compactMap { s in
            guard let name = s.string("name") else { return nil }
            let last = s["last_run"]
            return KnowledgeSource(
                name: name, title: s.string("title") ?? name, every: s["every"]?.string("value"),
                paused: s["paused"]?.bool("value") ?? false,
                lastRunAt: WireTime.date(last?.string("at")), lastRunOK: last?.bool("ok"), lastRunError: last?.string("error")
            )
        }
    }

    /// `every` in seconds; nil for a cadence this build cannot read.
    var interval: TimeInterval? {
        guard let every, let unit = every.last, let n = Double(every.dropLast()) else { return nil }
        switch unit {
        case "s": return n
        case "m": return n * 60
        case "h": return n * 3600
        case "d": return n * 86_400
        default: return nil
        }
    }
}

/// §6: one line, until something is wrong — and the four states inside it.
public struct SourcesLine: Sendable, Equatable {
    public enum State: String, Sendable {
        case current, stale, failed, unknown, paused

        var glyph: MetistryGlyph? {
            switch self {
            case .current: return nil
            case .stale: return .stale
            case .failed: return .failed
            case .unknown: return .empty
            case .paused: return .later
            }
        }

        var ink: MetistryColorRole {
            switch self {
            case .current: return .ok
            case .stale: return .stale
            case .failed: return .failed
            case .unknown, .paused: return .textSecondary
            }
        }
    }

    public struct Row: Sendable, Equatable, Identifiable {
        public var name: String
        public var title: String
        public var state: State
        /// What is true, in words: *last succeeded 2 days ago · token expired*.
        public var detail: String
        public var id: String { name }
        public var spoken: String { "\(title), \(state.rawValue), \(detail)" }
    }

    public var rows: [Row]
    /// The line: *4 sources · freshness unknown*.
    public var text: String
    /// Something is wrong: the line opens itself (§6 "expanded by a fault").
    public var faulted: Bool

    public var spoken: String { text }

    /// The word for "current" is said only when every source's
    /// `collector_health` answers it (P5). A run the scheduler reports failed
    /// is a fault the line can name without it; a healthy-looking run is not
    /// a "current" the line may claim.
    public static func make(_ sources: [KnowledgeSource], health: [String: CollectorHealth], now: Date) -> SourcesLine {
        let rows = sources.map { row($0, health: health[$0.name], now: now) }
        let count = sources.count == 1 ? "1 source" : "\(sources.count) sources"
        let behind = rows.filter { $0.state == .failed || $0.state == .stale }.count
        let text: String
        if sources.isEmpty {
            text = "No sources yet"
        } else if behind > 0 {
            text = "\(count) · \(behind) behind"
        } else if rows.allSatisfy({ $0.state == .current || $0.state == .paused }), sources.allSatisfy({ health[$0.name] != nil || $0.paused }), rows.contains(where: { $0.state == .current }) {
            text = "\(count), all current"
        } else {
            text = "\(count) · freshness unknown"
        }
        return SourcesLine(rows: rows, text: text, faulted: behind > 0)
    }

    static func row(_ s: KnowledgeSource, health h: CollectorHealth?, now: Date) -> Row {
        func ago(_ d: Date) -> String { ClockTime.age(now.timeIntervalSince(d)) }
        if s.paused { return Row(name: s.name, title: s.title, state: .paused, detail: "paused") }
        if let h {
            if h.streak > 0 {
                // Failed carries two timestamps: the last success, and why (§6).
                let since = h.lastOK.map { "last succeeded \(ago($0))" } ?? "has never succeeded"
                return Row(name: s.name, title: s.title, state: .failed, detail: [since, h.lastError].compactMap { $0 }.joined(separator: " · "))
            }
            guard let ok = h.lastOK else { return Row(name: s.name, title: s.title, state: .unknown, detail: "not run yet") }
            // Stale annotates; it never replaces: the age rides the name.
            if let interval = s.interval, now.timeIntervalSince(ok) > max(interval * 3, 3600) {
                return Row(name: s.name, title: s.title, state: .stale, detail: "checked \(ago(ok)) · \(ClockTime.duration(now.timeIntervalSince(ok))) old")
            }
            return Row(name: s.name, title: s.title, state: .current, detail: "checked \(ago(ok))")
        }
        if s.lastRunOK == false, let at = s.lastRunAt {
            let why = s.lastRunError.map { " · \($0)" } ?? ""
            return Row(name: s.name, title: s.title, state: .failed, detail: "last run failed \(ago(at))\(why) · last success not known")
        }
        if let at = s.lastRunAt, s.lastRunOK == true {
            return Row(name: s.name, title: s.title, state: .unknown, detail: "last ran \(ago(at))")
        }
        return Row(name: s.name, title: s.title, state: .unknown, detail: "not run yet")
    }
}

// MARK: - A page

/// A page on screen: its words, and what points each way (§7).
public struct KnowledgePageRead: Sendable, Equatable {
    public var path: String
    public var content: String
    /// The content hash as served — what a restore sends as `seen_sha`.
    public var sha256: String? = nil
    public var outgoing: [KnowledgePageLink]
    public var incoming: [KnowledgePageLink]
    /// The links could not be read; the words still stand.
    public var linksProblem: String?

    public var title: String {
        for line in content.components(separatedBy: "\n") where line.hasPrefix("# ") {
            return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        }
        return FoldText.displayName(path)
    }

    /// A link's kind, in words — a frontmatter link and an embed mean something different from a wikilink.
    public static func kindWord(_ kind: String?) -> String {
        switch kind {
        case "wikilink": return "link"
        case "frontmatter": return "frontmatter"
        case "embed": return "embed"
        case let other?: return other
        case nil: return "link"
        }
    }

    public static func spoken(_ link: KnowledgePageLink) -> String {
        let name = link.title ?? FoldText.displayName(link.path)
        let unwritten = link.resolved == false ? ", not written yet" : ""
        return "\(name), \(kindWord(link.kind)), \(link.path)\(unwritten)"
    }
}

// MARK: - A page's history

/// One commit of a page's history (`GET /api/knowledge/history`, T10-4).
public struct KnowledgeCommit: Sendable, Equatable, Identifiable {
    public var sha: String
    /// The page's name AS IT WAS in this commit — across a rename, the old one.
    public var path: String
    /// `added` · `modified` · `deleted` · `renamed` · …; nil on a merge that carried it.
    public var change: String?
    public var subject: String
    public var author: String?
    /// `Brain-Source:` — provenance to show, never authority.
    public var source: String?
    public var at: Date?
    public var id: String { sha }

    public init(sha: String, path: String, change: String? = nil, subject: String = "", author: String? = nil, source: String? = nil, at: Date? = nil) {
        self.sha = sha
        self.path = path
        self.change = change
        self.subject = subject
        self.author = author
        self.source = source
        self.at = at
    }

    public var short: String { String(sha.prefix(7)) }

    static func list(_ json: JSONValue) -> [KnowledgeCommit] {
        (json["commits"]?.arrayValue ?? []).compactMap { c in
            guard let sha = c.string("sha"), let path = c.string("path") else { return nil }
            return KnowledgeCommit(sha: sha, path: path, change: c.string("change"), subject: c.string("subject") ?? "", author: c.string("author"), source: c.string("source"), at: WireTime.date(c.string("at")))
        }
    }

    /// *Rename the plan to the roadmap, by You, 28 Sep, 1:10 PM, renamed, 4c1d2e3* — the row, as one.
    public func spoken(assistantName: String?, clock: ClockTime, now: Date) -> String {
        var parts = [subject.isEmpty ? "No subject" : subject]
        if let who = VaultWho.name(source: source, author: author, assistantName: assistantName) { parts.append("by \(who)") }
        if let at { parts.append(clock.moment(at, now: now)) }
        if let change { parts.append(change) }
        parts.append(short)
        return parts.joined(separator: ", ")
    }
}

/// What a history row offers (§2.21): Restore, or why not.
public enum KnowledgeRestoreOffer: Sendable, Equatable {
    /// The newest commit is the page as it stands — nothing to restore.
    case current
    /// The commit names the page by an earlier name; the door restores this name only.
    case renamed
    /// The commit that deleted it has no bytes to restore.
    case deleted
    /// This client is not the local owner (ruling 7): no Restore is drawn at all.
    case notHere
    /// Restore — off, with the fact that turned it off, when one did.
    case offered(disabledBecause: String?)
}

/// A restore request (T10-5) for one page: the improvement THIS console
/// raised, found by its `payload.restore.path`. The console decides what
/// Approve may do; this only finds the row to draw.
public enum KnowledgeRestoreRequest {
    public static func path(of row: RequestRow) -> String? {
        guard row.kind == "improvement", row.sourceAgent == "console", row.decision == nil || row.decision == "pending" else { return nil }
        return row.payload?["restore"]?.string("path")
    }
}

/// A restore asked for on a page: in flight, or refused.
public struct KnowledgeRestoreNote: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        case sending(sha: String)
        case refused(String)
    }

    public var path: String
    public var phase: Phase
}

/// Where on the screen the owner is.
public enum KnowledgePlace: Sendable, Equatable {
    case home
    case area(String)
    case page(String)
    case search(String)
    /// One row of Needs your eye, by its id.
    case item(String)
}

/// What a read behind the home screen is doing.
public enum KnowledgeRead<Value: Sendable & Equatable>: Sendable, Equatable {
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? { if case .loaded(let v) = self { return v } else { return nil } }
}

// MARK: - The model

@MainActor
@Observable
public final class KnowledgeModel {
    public let fold: SectionModel<KnowledgeFoldRead?>
    public let requests: SectionModel<[RequestRow]>
    public let drafts: SectionModel<[KnowledgeDraftRow]>
    public let areas: SectionModel<[KnowledgeAreaRow]>
    public let sources: SectionModel<[KnowledgeSource]>

    /// Where the owner is; `back` walks it.
    public private(set) var place: KnowledgePlace = .home
    public private(set) var trail: [KnowledgePlace] = []
    public private(set) var page: KnowledgeRead<KnowledgePageRead>?
    public private(set) var areaPages: KnowledgeRead<[KnowledgePageEntry]>?
    public private(set) var search: KnowledgeRead<KnowledgeSearchReply>?
    /// The page on screen's commits, newest first.
    public private(set) var history: KnowledgeRead<[KnowledgeCommit]>?
    /// One version of the page, opened from its history, by commit.
    public private(set) var versions: [String: KnowledgeRead<String>] = [:]
    /// A restore asked for on the page on screen.
    public private(set) var restoreNote: KnowledgeRestoreNote?
    /// Whether this client may restore (ruling 7) — asked once per instance.
    public private(set) var reach: ClientReach = .unknown
    public var query = ""
    /// Filter (⌘F) asked for the box; the view focuses it and clears this.
    public var wantsSearchFocus = false
    /// The sources line, opened by the owner — a fault opens it regardless.
    public var sourcesOpen = false
    /// The fold on screen is an earlier one than the newest.
    public private(set) var foldDate: String?

    /// The conflicts being settled, by request id — held here, not by a view,
    /// so a Keep Mine chosen then walked away from is still sent (or undone).
    public private(set) var conflicts: [Int: ConflictResolution] = [:]

    /// An answer or a settle changed the queue: the shell's count asks again.
    @ObservationIgnored public var onQueueChanged: (@MainActor () async -> Void)?

    @ObservationIgnored private weak var session: ConsoleSession?
    @ObservationIgnored public let now: () -> Date
    @ObservationIgnored public let clock: ClockTime
    @ObservationIgnored private let conflictHold: Duration
    @ObservationIgnored private var requestCards: (name: String, generation: Int, cards: RequestCards)?
    @ObservationIgnored private let foldBox: FoldDateBox
    @ObservationIgnored private var reachAsked = false

    /// The newest fold on or before a day — `Earlier Folds` moves it back.
    private final class FoldDateBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _date: String?
        var date: String? {
            get { lock.withLock { _date } }
            set { lock.withLock { _date = newValue } }
        }
    }

    public init(session: ConsoleSession, timeZone: TimeZone = .current, conflictHold: Duration = .seconds(UndoWindow.seconds), now: @escaping () -> Date = Date.init) {
        self.session = session
        self.now = now
        self.clock = ClockTime(timeZone: timeZone)
        self.conflictHold = conflictHold
        let box = FoldDateBox()
        self.foldBox = box
        fold = SectionModel(session: session, policy: .configuration, topics: [.knowledge]) { stores in
            await Self.readFold(stores, date: box.date)
        }
        requests = SectionModel(session: session, policy: .requests, topics: [.needsYou]) { stores in
            // Needs your eye's three kinds, and a page's restore request (T10-7).
            await stores.requests().map { page in (page.proposals.filter { KnowledgeEyeItem.kind(of: $0) != nil || KnowledgeRestoreRequest.path(of: $0) != nil }, nil) }
        }
        drafts = SectionModel(session: session, policy: .board, topics: [.knowledge]) { stores in
            await stores.knowledgeDrafts(limit: 50, offset: nil).map { (KnowledgeDraftRow.list($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        areas = SectionModel(session: session, policy: .configuration, topics: [.knowledge]) { stores in
            await stores.knowledgeAreas().map { (KnowledgeAreaRow.list($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        sources = SectionModel(session: session, policy: .configuration, topics: [.scheduled]) { stores in
            await stores.scheduled().map { (KnowledgeSource.list($0.json), WireTime.date($0["as_of"]?.stringValue)) }
        }
        session.register { [weak self] in
            guard let self else { return false }
            self.dropPlace()
            return true
        }
    }

    nonisolated static func readFold(_ stores: ConsoleStores, date: String?) async -> Result<(KnowledgeFoldRead?, Date?), ConsoleError> {
        switch await stores.knowledgeFold(date: date) {
        case .failure(let e): return .failure(e)
        case .success(let reply):
            let asOf = WireTime.date(reply["as_of"]?.stringValue)
            guard var fold = KnowledgeFoldRead.from(reply["fold"]) else { return .success((nil, asOf)) }
            // The words are the file's own bytes; a fold whose page cannot be
            // read is still named, with nothing invented in its place.
            if case .success(let page) = await stores.knowledgePage(path: fold.path) {
                fold.document = FoldDocument.parse(page.content)
            }
            return .success((fold, asOf))
        }
    }

    // MARK: Reading

    /// Every home section, on first sight and when due.
    public func refreshIfDue() async {
        await fold.refreshIfDue(now: now())
        await requests.refreshIfDue(now: now())
        await drafts.refreshIfDue(now: now())
        await areas.refreshIfDue(now: now())
        await sources.refreshIfDue(now: now())
    }

    /// Ask every section now (Try Again).
    public func load() async {
        await fold.refresh()
        await requests.refresh()
        await drafts.refresh()
        await areas.refresh()
        await sources.refresh()
    }

    /// The home screen as a whole: the first load, or a console that could not
    /// be read at all — otherwise each section says its own state.
    public enum Panel: Equatable {
        case placeholders
        case failed(StatePanelModel)
        case page
    }

    public var panel: Panel {
        let all: [(hasValue: Bool, isFirstLoad: Bool, problem: String?)] = [
            (fold.section.hasValue, fold.section.isFirstLoad, fold.section.problem),
            (areas.section.hasValue, areas.section.isFirstLoad, areas.section.problem),
        ]
        if all.contains(where: \.hasValue) { return .page }
        if all.contains(where: \.isFirstLoad) { return .placeholders }
        let reason = all.compactMap(\.problem).first
        if let reason, Self.isVaultMissing(reason) {
            return .failed(StatePanelModel(.failed, title: "Vault Not Found", sentence: "Knowledge reads the vault this instance keeps, and it isn't there.", reason: reason, action: KnowledgeWords.chooseFolder))
        }
        return .failed(StatePanelModel(.failed, title: "Knowledge Isn't Answering", sentence: "The vault's index could not be read.", reason: reason, action: StateWords.tryAgain))
    }

    static func isVaultMissing(_ reason: String) -> Bool {
        let r = reason.lowercased()
        return r.contains("vault") && (r.contains("not found") || r.contains("no such") || r.contains("missing") || r.contains("does not exist"))
    }

    /// Needs your eye, as it stands. A draft never reaches this list through
    /// anything but the owner-only drafts route (§3.2, C66).
    public var eye: [KnowledgeEyeItem] {
        KnowledgeEyeItem.items(requests: requests.section.value ?? [], drafts: drafts.section.value ?? [])
    }

    public var sourcesLine: SourcesLine? {
        guard let list = sources.section.value else { return nil }
        // No door serves `collector_health` yet: every source's freshness is
        // unknown, and the line says so rather than inferring it (P5).
        return SourcesLine.make(list, health: [:], now: now())
    }

    public var sourcesExpanded: Bool { sourcesOpen || sourcesLine?.faulted == true }

    // MARK: Moving about

    public func go(to place: KnowledgePlace) async {
        guard place != self.place else { return }
        trail.append(self.place)
        self.place = place
        await enter(place)
    }

    public var canGoBack: Bool { !trail.isEmpty }

    public func back() async {
        guard let previous = trail.popLast() else { return }
        place = previous
        await enter(previous)
    }

    public func home() {
        trail = []
        place = .home
    }

    private func dropPlace() {
        home()
        page = nil
        areaPages = nil
        search = nil
        history = nil
        versions = [:]
        restoreNote = nil
        reach = .unknown
        reachAsked = false
        conflicts = [:]
        requestCards = nil
        foldDate = nil
        foldBox.date = nil
    }

    private func enter(_ place: KnowledgePlace) async {
        switch place {
        case .home: return
        case .item(let id): prepare(item: id)
        case .page(let path): await readPage(path)
        case .area(let area): await readArea(area)
        case .search(let q): await runSearch(q)
        }
    }

    /// `quietly` keeps what is on screen until the new answer replaces it —
    /// a page re-read after a restore, not one being opened.
    func readPage(_ path: String, quietly: Bool = false) async {
        guard let session else { return }
        if !quietly || page?.value?.path != path {
            page = .loading
            history = nil
            versions = [:]
        }
        if restoreNote?.path != path { restoreNote = nil }
        let generation = session.generation
        let words = await session.stores.knowledgePage(path: path)
        guard session.generation == generation, place == .page(path) else { return }
        switch words {
        case .failure(let e):
            page = .failed(Self.problem(e))
        case .success(let p):
            var read = KnowledgePageRead(path: path, content: p.content, sha256: p.sha256, outgoing: [], incoming: [], linksProblem: nil)
            switch await session.stores.knowledgeLinks(path: path, limit: nil, offset: nil) {
            case .success(let l):
                read.outgoing = l.outgoing
                read.incoming = l.incoming
            case .failure(let e):
                read.linksProblem = Self.problem(e)
            }
            guard session.generation == generation, place == .page(path) else { return }
            page = .loaded(read)
            await readHistory(path)
            await askReachIfNeeded()
        }
    }

    // MARK: A page's history (T10-7)

    func readHistory(_ path: String) async {
        guard let session else { return }
        if history?.value == nil { history = .loading }
        let generation = session.generation
        let answer = await session.stores.history(path: path)
        guard session.generation == generation, place == .page(path) else { return }
        switch answer {
        case .success(let reply): history = .loaded(KnowledgeCommit.list(reply.json))
        case .failure(let e): history = .failed(Self.problem(e))
        }
    }

    /// `GET /api/whoami`, once per instance: whether this client is the local owner.
    func askReachIfNeeded() async {
        guard !reachAsked, let session else { return }
        reachAsked = true
        let generation = session.generation
        let answer = await session.stores.whoami()
        guard session.generation == generation else { return }
        switch answer {
        case .success(let who): reach = .of(via: who.via)
        case .failure:
            // Unknown is not local: no Restore is drawn.
            reach = .unknown
            reachAsked = false
        }
    }

    /// Show This Version: the page's bytes at one commit, under its name then.
    public func toggleVersion(_ commit: KnowledgeCommit) async {
        if versions[commit.sha] != nil {
            versions[commit.sha] = nil
            return
        }
        guard let session, case .page(let path) = place else { return }
        versions[commit.sha] = .loading
        let generation = session.generation
        let answer = await session.stores.version(path: commit.path, sha: commit.sha)
        guard session.generation == generation, place == .page(path), versions[commit.sha] != nil else { return }
        switch answer {
        case .success(let v): versions[commit.sha] = .loaded(v["content"]?.stringValue ?? "")
        case .failure(let e): versions[commit.sha] = .failed(Self.problem(e))
        }
    }

    /// The page on screen, by its path.
    public var pagePath: String? { if case .page(let path) = place { return path } else { return nil } }

    /// The restore request waiting for a page, if one is.
    public func restoreRequest(for path: String) -> RequestRow? {
        (requests.section.value ?? []).first { KnowledgeRestoreRequest.path(of: $0) == path }
    }

    /// What one row of the page's history offers.
    public func restoreOffer(_ commit: KnowledgeCommit, isNewest: Bool, on path: String) -> KnowledgeRestoreOffer {
        if commit.change == "deleted" { return .deleted }
        if commit.path != path { return .renamed }
        if isNewest { return .current }
        guard reach.rewindsHistory else { return .notHere }
        if !allowsDecisions { return .offered(disabledBecause: StateWords.unreachable) }
        if restoreRequest(for: path) != nil { return .offered(disabledBecause: VaultHistoryWords.restoreWaiting) }
        if restoreNote?.path == path, case .sending = restoreNote?.phase { return .offered(disabledBecause: "asking…") }
        return .offered(disabledBecause: nil)
    }

    /// Restore: ask. Nothing changes until Approve — here, inline, or in
    /// Needs You. Refused with nothing sent unless this client is the local
    /// owner (ruling 7); the console refuses it too.
    public func restore(_ commit: KnowledgeCommit) async {
        guard case .page(let path) = place, let read = page?.value, read.path == path, commit.path == path else { return }
        guard reach.rewindsHistory else {
            restoreNote = KnowledgeRestoreNote(path: path, phase: .refused(VaultHistoryWords.onlyTheMac))
            return
        }
        guard let session else { return }
        if case .sending = restoreNote?.phase, restoreNote?.path == path { return }
        restoreNote = KnowledgeRestoreNote(path: path, phase: .sending(sha: commit.sha))
        let generation = session.generation
        let answer = await session.stores.restore(path: path, sha: commit.sha, seenSHA: read.sha256 ?? "")
        guard session.generation == generation else { return }
        switch answer {
        case .success:
            restoreNote = nil
            // The request is Needs You's; the page draws it inline from there.
            await answered()
        case .failure(let e):
            if case .http(403, let envelope) = e, envelope?.code == "local_only" {
                // The console says this client is not the Mac: Restore goes.
                reach = .remote(via: "local_only")
                restoreNote = KnowledgeRestoreNote(path: path, phase: .refused(VaultHistoryWords.onlyTheMac))
            } else if e.wasHeldForReachability {
                restoreNote = KnowledgeRestoreNote(path: path, phase: .refused(StateWords.unreachable))
            } else if e.conflictReason == "stale" {
                restoreNote = KnowledgeRestoreNote(path: path, phase: .refused("This page changed after you read it — it is shown as it stands now; restore again from there."))
                await readPage(path, quietly: true)
            } else {
                restoreNote = KnowledgeRestoreNote(path: path, phase: .refused(Self.problem(e)))
            }
        }
    }

    /// The inline restore request was answered: the queue asks again, and the
    /// page — whose words Approve just changed — is read again.
    public func restoreAnswered(_ path: String) async {
        await answered()
        guard place == .page(path) else { return }
        await readPage(path, quietly: true)
    }

    func readArea(_ area: String) async {
        guard let session else { return }
        areaPages = .loading
        let generation = session.generation
        let answer = await session.stores.knowledgePages(area: area, prefix: nil, limit: nil, offset: nil)
        guard session.generation == generation, place == .area(area) else { return }
        switch answer {
        case .success(let list): areaPages = .loaded(list.pages)
        case .failure(let e): areaPages = .failed(Self.problem(e))
        }
    }

    func runSearch(_ q: String) async {
        guard let session else { return }
        search = .loading
        let generation = session.generation
        let answer = await session.stores.knowledgeSearch(q, mode: nil, limit: nil)
        guard session.generation == generation, place == .search(q) else { return }
        switch answer {
        case .success(let reply): search = .loaded(reply)
        case .failure(let e): search = .failed(Self.problem(e))
        }
    }

    /// Search what is typed; an empty box is home.
    public func submitSearch() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty {
            home()
            return
        }
        if case .search = place {
            place = .search(q)
            await runSearch(q)
        } else {
            await go(to: .search(q))
        }
    }

    /// Go ▸ Filter (⌘F): the search box.
    public func askForTheBox() {
        wantsSearchFocus = true
    }

    /// The row a path opens: a page, or — for a folder — its area.
    public func open(path: String) async {
        await go(to: .page(path))
    }

    // MARK: The fold

    /// Earlier Folds: the newest one before the one on screen.
    public func earlierFold() async {
        guard let shown = fold.section.value??.date, let day = Self.day(before: shown) else { return }
        foldDate = day
        foldBox.date = day
        await fold.refresh()
    }

    /// Back to the newest fold.
    public func newestFold() async {
        foldDate = nil
        foldBox.date = nil
        await fold.refresh()
    }

    static func day(before ymd: String) -> String? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let f = DateFormatter()
        f.calendar = cal
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = cal.timeZone
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: ymd), let prev = cal.date(byAdding: .day, value: -1, to: d) else { return nil }
        return f.string(from: prev)
    }

    // MARK: Answering

    /// One card per request, shared by the row's detail and the Item menu.
    public func cards(assistantName: String) -> RequestCards? {
        guard let session else { return nil }
        if let held = requestCards, held.name == assistantName, held.generation == session.generation {
            held.cards.keep(only: Set((requests.section.value ?? []).map(\.id)))
            return held.cards
        }
        let cards = RequestCards(store: session.stores, assistantName: assistantName)
        requestCards = (assistantName, session.generation, cards)
        return cards
    }

    public var allowsDecisions: Bool { session?.allowsDecisions ?? false }

    /// Opening a conflict makes its view's model — once, here, never while a view is drawn.
    func prepare(item id: String) {
        guard let row = eye.first(where: { $0.id == id })?.request, KnowledgeEyeItem.kind(of: row) == .conflict else { return }
        _ = resolution(for: row)
    }

    /// The conflict view's model for a conflict's request.
    @discardableResult
    public func resolution(for row: RequestRow) -> ConflictResolution? {
        if let held = conflicts[row.id] { return held }
        guard let session, let conflict = KnowledgeConflict(row) else { return nil }
        let r = ConflictResolution(conflict, store: session.stores, hold: conflictHold, now: now)
        r.onSettled = { [weak self] in await self?.answered() }
        conflicts[row.id] = r
        return r
    }

    /// Something was answered here: the queue and the drafts ask again, and so does the shell's count.
    public func answered() async {
        requests.invalidate()
        drafts.invalidate()
        await requests.refresh(background: true)
        await drafts.refresh(background: true)
        await onQueueChanged?()
    }

    /// The owner's day, for the dates a card's body prints.
    public var today: TaskDay {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = clock.timeZone
        let d = calendar.dateComponents([.year, .month, .day], from: now())
        return TaskDay(String(format: "%04d-%02d-%02d", d.year ?? 1970, d.month ?? 1, d.day ?? 1))!
    }

    static func problem(_ e: ConsoleError) -> String {
        e.refusal ?? e.localizedDescription
    }
}

/// The screen's fixed words, in one place.
public enum KnowledgeWords {
    public static let title = "Knowledge"
    public static let fold = "The Fold"
    public static let openFold = "Open the Fold"
    public static let earlierFolds = "Earlier Folds"
    public static let newestFold = "Newest Fold"
    public static let noFold = "No fold yet. The Knowledge Fold writes one each evening, and it will be here."
    public static let pending = "Still being written."
    public static let needsYourEye = "Needs Your Eye"
    public static let nothingNeedsYourEye = "Nothing needs your eye."
    public static let areas = "Areas"
    public static let areasNote = "Why each is here, not how much of it there is"
    public static let sources = "Sources"
    public static let search = "Search the Vault"
    public static let chooseFolder = "Choose Folder"
    public static let back = "Back"
    public static let openInObsidian = "Open in Obsidian"
    public static let outgoing = "Links From This Page"
    public static let incoming = "Links to This Page"
    public static let noOutgoing = "This page links nowhere."
    public static let noIncoming = "Nothing links here yet."
    public static let pagesTitle = "Pages"
    public static let noPages = "No pages in this area yet."
    public static let notAskedYet = "Nothing has asked about this draft yet, so there is no request to answer — settle it in Obsidian by removing status: draft."
    public static let answeredThere = "This arrived as a request, so answering it here answers it in Needs You."
    public static let neitherLost = "Neither version was lost: the sync stopped rather than choosing."
    public static let mergeInObsidian = "Merge in Obsidian"
    public static let restoreWaiting = "Restore Waiting"

    // One architectural rule per section, in situ (§1).
    /// §2, C102 — the name is templated, never written here.
    public static func foldRule(_ name: String?) -> String {
        let who = name ?? "It"
        return "\(who) writes here, in its own voice, as its own commit. In your daily note it writes only its own section, between its markers; the rest of the note is yours."
    }

    public static let draftRule = "A draft is never served to an agent. Marking a note status: draft is how you keep it from your own agents until you have read it."
    public static let conflictRule = "One writer per file is what makes the vault safe to share with agents. A conflict is that rule holding — the alternative is a silent overwrite."
    public static let areaRule = "A folder is a permission boundary: a grant names a path prefix, so organising your vault is also configuring what an agent can reach."

    /// components-03's *no match* state.
    public static func noMatch(_ q: String) -> String { "Nothing matches “\(q)”" }
}
