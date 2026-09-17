// What the app still knows about an instance directory from the outside: that a
// folder IS one, and which layout it is in.
//
// This file used to hold a ~60-line YAML scalar reader over `identity.yaml` and
// `metistry.lock`, and a `package.json` read for the product version, because
// nothing in the CLI reported the assistant's name or a version. docs/ops/mac-app.md
// named all three as the thing `metistry identity --json` and
// `metistry version --json` would delete. They did: those reads are verbs now
// (cli-facts.swift), and the app holds no parser for any file the CLI owns.
//
// What is left is a file EXISTENCE test, which is not a parse: the wizard needs
// to tell "you pointed at the instance repo" from "you pointed at its parent"
// before it runs anything, and it is the same test the CLI's own resolution
// leans on.
//
// THE TWO LAYOUTS. Since the 2026-09-17 ruling the instance directory IS the
// Obsidian vault and everything that is not knowledge lives under `.metistry/`
// (docs/ops/instance-layout.md). An instance that has not run
// `metistry migrate-layout` yet still has `identity.yaml` at its root, and the
// app has to adopt it — the migration is a verb the user runs when they choose
// to, not a gate the app puts in front of their own folder. So both spellings
// are accepted, the answer says WHICH, and the wizard shows a one-line notice
// naming the verb.
//
// This mirrors `packages/core/src/instance-layout.ts` (`INSTANCE_LAYOUT`,
// `detectLayout`), which is the source of truth. Two filenames and an existence
// test is the whole of what is restated here; the app parses nothing, and the
// authoritative reading is still `metistry doctor --json`'s `instance layout`
// row (doctor-report.swift), which the Status panel already renders.

import Foundation

public enum InstanceFiles {
    public static let identityFilename = "identity.yaml"
    public static let lockFilename = "metistry.lock"
    public static let deploymentFilename = "deployment.yaml"

    /// The dot-folder everything that is not knowledge lives in. Dot-prefixed so
    /// Obsidian ignores it, which is the whole reason for the dot.
    public static let metistryDirname = ".metistry"

    /// The pre-2026-09-17 vault directory. Named here and nowhere else, so a
    /// search for the old literal finds this comment rather than a live path.
    static let legacyVaultDirname = "Knowledge"

    /// Which shape an instance directory is in — core's `InstanceLayoutShape`.
    public enum Layout: String, Sendable, Equatable, CaseIterable {
        /// The instance directory is the vault; everything else under `.metistry/`.
        case flat
        /// Pre-2026-09-17: the vault in `Knowledge/`, config files at the root.
        case legacy
        /// Not an instance directory (or not stamped yet).
        case unknown

        /// One sentence for the user, or `nil` when there is nothing to say.
        /// Named after the verb, because the verb is the fix.
        public var notice: String? {
            switch self {
            case .flat:
                return nil
            case .legacy:
                return "Legacy layout — run `metistry migrate-layout`"
            case .unknown:
                return "No \(InstanceFiles.metistryDirname)/\(InstanceFiles.identityFilename) in that folder — pick the instance repo itself, or create a new instance instead."
            }
        }
    }

    /// `<dir>/.metistry/<name>` — how every config file is spelled now.
    public static func metistryPath(_ dir: URL, _ name: String) -> URL {
        dir.appendingPathComponent(metistryDirname, isDirectory: true).appendingPathComponent(name)
    }

    /// Which layout `dir` is in, by the same existence tests core's
    /// `detectLayout` makes: `.metistry/identity.yaml` is flat, a root
    /// `identity.yaml` (or a `Knowledge/` vault) is legacy, neither is not an
    /// instance directory at all.
    public static func layout(of dir: URL, fileManager: FileManager = .default) -> Layout {
        if fileManager.fileExists(atPath: metistryPath(dir, identityFilename).path) { return .flat }
        if fileManager.fileExists(atPath: dir.appendingPathComponent(identityFilename).path) { return .legacy }
        if fileManager.fileExists(atPath: dir.appendingPathComponent(legacyVaultDirname, isDirectory: true).path) { return .legacy }
        return .unknown
    }

    /// An instance folder is one holding an `identity.yaml`, in either layout.
    /// A legacy instance is still an instance: the app adopts it and says so.
    public static func looksLikeInstance(_ dir: URL, fileManager: FileManager = .default) -> Bool {
        layout(of: dir, fileManager: fileManager) != .unknown
    }

    /// Where `identity.yaml` actually is in this directory, whichever layout it
    /// is in. `nil` when the folder is not an instance.
    public static func identityURL(_ dir: URL, fileManager: FileManager = .default) -> URL? {
        switch layout(of: dir, fileManager: fileManager) {
        case .flat: return metistryPath(dir, identityFilename)
        case .legacy: return dir.appendingPathComponent(identityFilename)
        case .unknown: return nil
        }
    }
}
