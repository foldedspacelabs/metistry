// `metistry secrets list` — names and where each one lives, never a value.
//
// The CLI prints a table (`renderSecretList`, packages/cli/src/secrets.ts) and
// has no `--json` for it, so this parses the table. That is the right trade for
// this one verb: the alternative is a CLI change owned by someone else, and a
// parse that stops matching degrades to "could not read the list" rather than to
// a wrong answer — there is no shape of this output that can be misread as a
// value, because the command has no code path that can print one.
//
// The app must never hold, request, display or log a secret value. This type
// carries three fields and none of them can be one.

import Foundation

public struct SecretListing: Sendable, Equatable, Identifiable {
    public let name: String
    public let inKeychain: Bool
    public let inEnv: Bool

    public var id: String { name }

    public init(name: String, inKeychain: Bool, inEnv: Bool) {
        self.name = name
        self.inKeychain = inKeychain
        self.inEnv = inEnv
    }

    /// Sentence case: this is prose, not a name (design-system P10).
    public var scopeLabel: String {
        switch (inKeychain, inEnv) {
        case (true, true): return "Keychain · .env"
        case (true, false): return "Keychain only"
        case (false, true): return ".env only — `metistry secrets sync --to keychain` moves it"
        case (false, false): return "not set"
        }
    }

    public var isSet: Bool { inKeychain || inEnv }

    /// `NAME    yes|-    set|-`, exactly the three columns the CLI renders. The
    /// header, the rule under it and the trailing "Values are never printed."
    /// line match nothing and are skipped.
    public static func parse(_ text: String) -> [SecretListing] {
        // Local, not static: `Regex` is not Sendable.
        let row = #/^(?<name>[A-Za-z_][A-Za-z0-9_]*)[ ]{2,}(?<keychain>yes|-)[ ]{2,}(?<env>set|-)[ ]*$/#
        return text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line in
            guard let m = String(line).firstMatch(of: row) else { return nil }
            return SecretListing(name: String(m.name), inKeychain: m.keychain == "yes", inEnv: m.env == "set")
        }
    }
}
