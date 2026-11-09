// The recorder's control key — where the bar gets it, and the one place in
// this app that reads the login Keychain.
//
// WHY THE APP READS IT AT ALL. Plan §2.2 puts "controlling a recording" in
// the device-local column: no CLI verb and no console route — the app talks
// to the local live-capture bridge directly. The bridge admits start, stop
// and Keep Going only on its CONTROL credential (T8-2a), so the bar has to
// present one. Everything else this app does still goes through a `metistry`
// verb that keeps credentials out of this process (console-client.swift).
//
// WHERE IT LIVES. Where every install variable lives: the login Keychain,
// generic password, service `metistry:METISTRY_LIVE_CAPTURE_CONTROL_TOKEN`,
// account = this instance's `instance_id` (packages/cli/src/keychain.ts,
// plan §2.14 — one instance, one account). `metistry secrets mint
// METISTRY_LIVE_CAPTURE_CONTROL_TOKEN` puts it there and in `.env`, which is
// what the bridge is started with. ONE value, so the bar and the bridge
// cannot drift apart without the bridge saying so (a 401 the bar reports).
//
// WHAT THIS FILE WILL NOT DO — each held by a test that reads the source
// (console-sign-in-tests.swift, capture-bar-tests.swift):
//
//   * Write, update or delete an item. `SecItemCopyMatching` is the only
//     Keychain call; the CLI owns the item.
//   * Read any other service. The service string is a constant, and neither
//     the console's local owner token nor the bridge's TOOL token — the one a
//     tool caller presents — is named anywhere in this app's sources: the bar
//     never holds the credential an agent holds.
//   * Keep it anywhere but memory. `LiveCaptureControlKey` has no `Codable`,
//     describes itself as a placeholder, and is never put in a preference, a
//     file, a log line or an error message.
//
// The first read may show macOS's "Metistry wants to use … in your keychain"
// sheet, because the item was made by `security`, not by this app: that
// sheet is the Keychain's own access control, answered once with *Always
// Allow*. It is not a permission this app asks for, and the owner checklist
// in the PR names it.

import Foundation
#if canImport(Security)
import Security
#endif

/// The recorder's control credential, in memory. Its value is reachable only
/// inside MetistryKit (the transport sets it as the bearer), and it prints as
/// a placeholder everywhere — `print`, string interpolation, `dump`, a
/// debugger's summary.
public struct LiveCaptureControlKey: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let value: String

    public init(_ value: String) {
        self.value = value
    }

    public var description: String { "<live-capture control key>" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

public enum LiveCaptureKeyLookup: Sendable, Equatable {
    case found(LiveCaptureControlKey)
    /// No item for this instance — the lost-key state.
    case missing
    /// The Keychain answered with an error, in its words (never the value).
    case unreadable(String)
}

/// Where the control key comes from. Named `…Source`, not `…Store`:
/// `store-fixtures-tests.swift` holds every `…Store` to a console route, and
/// this is the Keychain, not a route.
public protocol LiveCaptureKeySource: Sendable {
    func controlKey(instanceID: String) async -> LiveCaptureKeyLookup
}

/// The production source: one read-only Keychain query, off the main actor
/// (the Keychain's own access sheet can block it).
public struct KeychainLiveCaptureKeySource: LiveCaptureKeySource {
    /// `packages/cli/src/keychain.ts`'s `serviceFor("METISTRY_LIVE_CAPTURE_CONTROL_TOKEN")`.
    public static let service = "metistry:METISTRY_LIVE_CAPTURE_CONTROL_TOKEN"

    public init() {}

    public func controlKey(instanceID: String) async -> LiveCaptureKeyLookup {
        await Task.detached(priority: .userInitiated) { Self.read(account: instanceID) }.value
    }

    static func read(account: String) -> LiveCaptureKeyLookup {
        #if canImport(Security)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let text = String(data: data, encoding: .utf8) else { return .unreadable("the item is not text") }
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? .missing : .found(LiveCaptureControlKey(value))
        case errSecItemNotFound:
            return .missing
        case errSecUserCanceled, errSecAuthFailed:
            return .unreadable("access was not allowed")
        default:
            let words = SecCopyErrorMessageString(status, nil) as String?
            return .unreadable(words ?? "error \(status)")
        }
        #else
        return .missing
        #endif
    }
}
