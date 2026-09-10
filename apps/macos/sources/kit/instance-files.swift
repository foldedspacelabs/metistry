// What the app still knows about an instance directory from the outside: that a
// folder IS one.
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

import Foundation

public enum InstanceFiles {
    public static let identityFilename = "identity.yaml"
    public static let lockFilename = "metistry.lock"
    public static let deploymentFilename = "deployment.yaml"

    /// An instance folder is one holding `identity.yaml`.
    public static func looksLikeInstance(_ dir: URL, fileManager: FileManager = .default) -> Bool {
        fileManager.fileExists(atPath: dir.appendingPathComponent(identityFilename).path)
    }
}
