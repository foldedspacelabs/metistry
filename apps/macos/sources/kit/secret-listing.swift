// `metistry secrets list --json` — names, scope and where each one lives, never
// a value.
//
// The scaffold parsed the verb's TABLE, because there was no `--json`. That was
// already wrong by the time it shipped: `secrets list` grew a `scope` column
// when instance directories became self-contained
// (`packages/cli/src/secrets.ts`, `renderSecretList` — `name  scope  keychain
// .env`), and a three-column regex matched none of it. A parser of somebody
// else's table is a bug with a delay on it; this reads the verb's own JSON.
//
// The app must never hold, request, display or log a secret value. This type
// carries four fields and none of them can be one — and the verb it reads has
// no code path that can print one, which is the control that actually matters
// (CLAUDE.md: enforce at the tool, never by prompting).

import Foundation

public struct SecretListing: Sendable, Equatable, Identifiable {
    public let name: String
    /// Where this secret BELONGS: `instance` (filed under the instance's
    /// `instance_id`) or `user` (the per-Mac account every instance shares).
    /// `packages/cli/src/secrets.ts`'s `SECRET_SCOPES` is the only table that
    /// decides this, and the app does not keep a copy of it.
    public let scope: String?
    /// The account an item was actually found under. `scope: instance` with
    /// `foundUnder: user` reads "not migrated yet", which the next
    /// `secrets sync --to env` fixes — and the CLI says so itself.
    public let foundUnder: String?
    public let inKeychain: Bool
    public let inEnv: Bool

    public var id: String { name }

    public init(name: String, scope: String? = nil, foundUnder: String? = nil, inKeychain: Bool, inEnv: Bool) {
        self.name = name
        self.scope = scope
        self.foundUnder = foundUnder
        self.inKeychain = inKeychain
        self.inEnv = inEnv
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        let foundUnder = json.string("found_under", "foundUnder")
        self.init(
            name: name,
            scope: json.string("scope"),
            foundUnder: foundUnder,
            inKeychain: json.bool("in_keychain", "inKeychain") ?? (foundUnder != nil),
            inEnv: json.bool("in_env", "inEnv") ?? false
        )
    }

    /// Sentence case: this is prose, not a name (design-system P10).
    public var scopeLabel: String {
        var parts: [String] = []
        switch (inKeychain, inEnv) {
        case (true, true): parts.append("Keychain · .env")
        case (true, false): parts.append("Keychain only")
        case (false, true): parts.append(".env only — `metistry secrets sync --to keychain` moves it")
        case (false, false): parts.append("not set")
        }
        if let scope {
            parts.append(scope == "user"
                ? "user-scoped — one per Mac, shared by every instance"
                : "instance-scoped — filed under this instance's instance_id")
        }
        if let scope, let foundUnder, scope == "instance", foundUnder == "user" {
            parts.append("still under the user account; the next `metistry secrets sync --to env` copies it across")
        }
        return parts.joined(separator: " · ")
    }

    public var isSet: Bool { inKeychain || inEnv }

    /// The verb prints either a bare array or an object with the rows under a
    /// key; both are read, because which one it settles on is the CLI's to
    /// decide (cli-facts.swift, "ON KEY SPELLINGS").
    public static func decode(_ json: JSONValue) -> [SecretListing]? {
        let rows = json.arrayValue ?? json["secrets"]?.arrayValue
        return rows.map { $0.compactMap(SecretListing.init(json:)) }
    }
}
