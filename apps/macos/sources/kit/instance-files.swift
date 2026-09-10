// Reading the three files Settings shows: the instance's `identity.yaml` and
// `metistry.lock`, and the product's `package.json`.
//
// READ ONLY, and structurally so. `identity.yaml`, `deployment.yaml` and
// `metistry.lock` are §4.7 protected paths — only the `user` principal may write
// them (docs/ops/reconciler.md), which is invariant 2 in force: anything
// defining how the system behaves is a human change. So Settings renders the
// assistant's name and the product pin and offers no field to edit them; the
// place they change is the file, in the user's own hand or through
// `metistry init`.
//
// WHY A YAML READER LIVES HERE AT ALL. Nothing in the CLI reports the assistant
// name — no verb, and not `doctor --json` — so the alternative to these ~60
// lines is a Swift YAML dependency (a maintenance obligation for years,
// CLAUDE.md) for two files with a fixed, seed-generated shape. This is
// deliberately NOT a YAML parser: top-level and one-level-nested scalars, block
// scalars skipped, sequences of scalars. It is documented in
// docs/ops/mac-app.md as the thing a `metistry identity --json` would delete.

import Foundation

/// The subset of YAML the two seed-generated files use.
public struct YAMLScalars: Sendable, Equatable {
    /// Flattened with dots: `product.version`.
    public let values: [String: String]
    public let sequences: [String: [String]]

    public init(values: [String: String], sequences: [String: [String]] = [:]) {
        self.values = values
        self.sequences = sequences
    }

    public subscript(_ path: String) -> String? { values[path] }

    public static func parse(_ text: String) -> YAMLScalars {
        // Local, not static: a `Regex` is not Sendable, so a stored static one
        // is shared mutable state the compiler is right to refuse.
        let keyLine = #/^(?<indent>[ ]*)(?<key>[A-Za-z_][A-Za-z0-9_-]*):[ ]*(?<value>.*)$/#
        let itemLine = #/^(?<indent>[ ]*)-[ ]+(?<value>.+)$/#
        var values: [String: String] = [:]
        var sequences: [String: [String]] = [:]
        // (indent, key) for every open mapping, outermost first.
        var stack: [(indent: Int, key: String)] = []
        // A block scalar (`voice: >`) owns every line indented past its key.
        var skipDeeperThan: Int?

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            let indent = line.prefix { $0 == " " }.count
            if let limit = skipDeeperThan {
                if indent > limit { continue }
                skipDeeperThan = nil
            }

            if let m = line.firstMatch(of: itemLine) {
                let indent = m.indent.count
                // A sequence belongs to the key one level out.
                while let last = stack.last, last.indent >= indent { stack.removeLast() }
                if !stack.isEmpty {
                    sequences[stack.map(\.key).joined(separator: "."), default: []].append(unquote(String(m.value)))
                }
                continue
            }

            guard let m = line.firstMatch(of: keyLine) else { continue }
            let key = String(m.key)
            let value = String(m.value)
            while let last = stack.last, last.indent >= indent { stack.removeLast() }

            if value.isEmpty {
                stack.append((indent: indent, key: key))
                continue
            }
            if value == ">" || value == "|" || value.hasPrefix(">") || value.hasPrefix("|") {
                skipDeeperThan = indent
                continue
            }
            let path = (stack.map(\.key) + [key]).joined(separator: ".")
            values[path] = unquote(stripComment(value))
        }
        return YAMLScalars(values: values, sequences: sequences)
    }

    /// A trailing `# …` on an UNQUOTED value. A quoted value keeps everything,
    /// because `mention: "@ada # 1"` is a string, not a comment.
    static func stripComment(_ value: String) -> String {
        guard !(value.hasPrefix("\"") || value.hasPrefix("'")) else { return value }
        guard let hash = value.range(of: " #") else { return value }
        return String(value[value.startIndex..<hash.lowerBound]).trimmingCharacters(in: .whitespaces)
    }

    static func unquote(_ value: String) -> String {
        let v = value.trimmingCharacters(in: .whitespaces)
        for q in ["\"", "'"] where v.hasPrefix(q) && v.hasSuffix(q) && v.count >= 2 {
            return String(v.dropFirst().dropLast())
        }
        return v
    }
}

/// `<instance>/identity.yaml` — the only place the assistant is named
/// (CLAUDE.md). Every field is optional: a file the app cannot read is reported,
/// never guessed around.
public struct InstanceIdentity: Sendable, Equatable {
    public let assistantName: String?
    public let mention: String?
    public let icon: String?

    public init(assistantName: String?, mention: String?, icon: String?) {
        self.assistantName = assistantName
        self.mention = mention
        self.icon = icon
    }

    public init(yaml: YAMLScalars) {
        self.init(assistantName: yaml["name"], mention: yaml["mention"], icon: yaml["icon"])
    }
}

/// `<instance>/metistry.lock` — the product release this instance runs (plan
/// §4.16).
public struct InstancePin: Sendable, Equatable {
    public let version: String?
    public let commit: String?
    /// `git` (this install is a checkout) or `release` (published artifacts).
    public let source: String?
    public let updatedAt: String?
    public let migrationsApplied: Int

    public init(version: String?, commit: String?, source: String?, updatedAt: String?, migrationsApplied: Int) {
        self.version = version
        self.commit = commit
        self.source = source
        self.updatedAt = updatedAt
        self.migrationsApplied = migrationsApplied
    }

    public init(yaml: YAMLScalars) {
        self.init(
            version: yaml["product.version"],
            commit: yaml["product.commit"],
            source: yaml["product.source"],
            updatedAt: yaml["updated_at"],
            migrationsApplied: yaml.sequences["migrations_applied"]?.count ?? 0
        )
    }
}

public enum InstanceFileError: LocalizedError, Equatable {
    case missing(String)
    case unreadable(String, String)

    public var errorDescription: String? {
        switch self {
        case .missing(let path):
            return "\(path) is not there — is this an instance folder? `metistry init` creates one."
        case .unreadable(let path, let why):
            return "could not read \(path): \(why)"
        }
    }
}

public enum InstanceFiles {
    public static let identityFilename = "identity.yaml"
    public static let lockFilename = "metistry.lock"
    public static let deploymentFilename = "deployment.yaml"

    /// An instance folder is one holding `identity.yaml` — the same test the
    /// CLI's own resolution leans on.
    public static func looksLikeInstance(_ dir: URL, fileManager: FileManager = .default) -> Bool {
        fileManager.fileExists(atPath: dir.appendingPathComponent(identityFilename).path)
    }

    public static func identity(in dir: URL, fileManager: FileManager = .default) -> Result<InstanceIdentity, InstanceFileError> {
        read(dir.appendingPathComponent(identityFilename), fileManager: fileManager).map { InstanceIdentity(yaml: YAMLScalars.parse($0)) }
    }

    public static func pin(in dir: URL, fileManager: FileManager = .default) -> Result<InstancePin, InstanceFileError> {
        read(dir.appendingPathComponent(lockFilename), fileManager: fileManager).map { InstancePin(yaml: YAMLScalars.parse($0)) }
    }

    /// The product's own version, the way `packages/cli/src/env.ts`'s
    /// `productVersion()` reads it. `nil` when there is no checkout to read (a
    /// bare `metistry` on PATH resolves its own).
    public static func productVersion(inProductDir dir: URL, fileManager: FileManager = .default) -> String? {
        guard case .success(let text) = read(dir.appendingPathComponent("package.json"), fileManager: fileManager),
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object["version"] as? String
    }

    static func read(_ url: URL, fileManager: FileManager) -> Result<String, InstanceFileError> {
        guard fileManager.fileExists(atPath: url.path) else { return .failure(.missing(url.path)) }
        do {
            return .success(try String(contentsOf: url, encoding: .utf8))
        } catch {
            return .failure(.unreadable(url.path, error.localizedDescription))
        }
    }
}
