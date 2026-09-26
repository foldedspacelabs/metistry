// Knowledge — the vault read path: search, a page, the index, a page's links,
// and the fold's three reads (design-build-plan §2.10, §2.16). A file's
// history, a version, a restore and a conflict are the vault's git, and live
// in `VaultStore`.

import Foundation

public protocol KnowledgeStore: Sendable {
    /// route: GET /api/knowledge/search
    func knowledgeSearch(_ q: String, mode: String?, limit: Int?) async -> Result<KnowledgeSearchReply, ConsoleError>
    /// route: GET /api/knowledge/page
    func knowledgePage(path: String) async -> Result<KnowledgePage, ConsoleError>
    /// route: GET /api/knowledge/pages
    func knowledgePages(area: String?, prefix: String?, limit: Int?, offset: Int?) async -> Result<KnowledgePageList, ConsoleError>
    /// route: GET /api/knowledge/links
    func knowledgeLinks(path: String, limit: Int?, offset: Int?) async -> Result<KnowledgePageLinkList, ConsoleError>
    /// route: GET /api/knowledge/fold
    func knowledgeFold(date: String?) async -> Result<KnowledgeFold, ConsoleError>
    /// route: GET /api/knowledge/drafts
    func knowledgeDrafts(limit: Int?, offset: Int?) async -> Result<KnowledgeDrafts, ConsoleError>
    /// route: GET /api/knowledge/areas
    func knowledgeAreas() async -> Result<KnowledgeAreas, ConsoleError>
}

/// `GET /api/knowledge/fold` (T1-6): the newest `Journal/Fold/*.md` and its links (`knowledge_fold_latest`).
public struct KnowledgeFold: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/knowledge/drafts` (T1-6): the drafts waiting on the owner — owner-only, never at the generic door (`knowledge_drafts`).
public struct KnowledgeDrafts: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }
/// `GET /api/knowledge/areas` (T1-6): area → description, count, last change, named by the fold (`knowledge_areas`).
public struct KnowledgeAreas: ConsoleBody { public let json: JSONValue; public init(json: JSONValue) { self.json = json } }

extension ConsoleStores: KnowledgeStore {
    public func knowledgeSearch(_ q: String, mode: String?, limit: Int?) async -> Result<KnowledgeSearchReply, ConsoleError> {
        await api.knowledgeSearch(q, mode: mode, limit: limit)
    }

    public func knowledgePage(path: String) async -> Result<KnowledgePage, ConsoleError> { await api.knowledgePage(path: path) }

    public func knowledgePages(area: String?, prefix: String?, limit: Int?, offset: Int?) async -> Result<KnowledgePageList, ConsoleError> {
        await api.knowledgePages(area: area, prefix: prefix, limit: limit, offset: offset)
    }

    public func knowledgeLinks(path: String, limit: Int?, offset: Int?) async -> Result<KnowledgePageLinkList, ConsoleError> {
        await api.knowledgeLinks(path: path, limit: limit, offset: offset)
    }

    public func knowledgeFold(date: String?) async -> Result<KnowledgeFold, ConsoleError> {
        await get("/api/knowledge/fold", ["date": date])
    }

    public func knowledgeDrafts(limit: Int?, offset: Int?) async -> Result<KnowledgeDrafts, ConsoleError> {
        await get("/api/knowledge/drafts", ["limit": limit.map(String.init), "offset": (offset ?? 0) == 0 ? nil : offset.map(String.init)])
    }

    public func knowledgeAreas() async -> Result<KnowledgeAreas, ConsoleError> { await get("/api/knowledge/areas") }
}
