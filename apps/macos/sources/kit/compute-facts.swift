// `metistry compute show --json` — where this instance's work runs, what it may
// cost, and whether the key each provider names is present. Never a key's value:
// the verb has no code path that can print one (`packages/cli/src/compute.ts`,
// `ProviderRow.secret` is a NAME and `secret_present` is a boolean).
//
// The same rule `SecretListing` is built on, for the same reason: a type that
// cannot hold a secret is a control; a promise not to display one is not.

import Foundation

public struct ComputeProviderFacts: Sendable, Equatable, Identifiable {
    public let name: String
    public let kind: String
    public let locality: String
    public let baseURL: String
    /// Zero data retention as the provider states it. `false`/`nil` on an
    /// off-machine provider is a warning, never a block (C13).
    public let zdr: Bool?
    /// The NAME of the secret this provider authenticates with, if any.
    public let secret: String?
    /// Whether an item of that name is in the login Keychain. Presence only.
    public let secretPresent: Bool?

    public var id: String { name }

    public init(name: String, kind: String, locality: String, baseURL: String, zdr: Bool? = nil, secret: String? = nil, secretPresent: Bool? = nil) {
        self.name = name
        self.kind = kind
        self.locality = locality
        self.baseURL = baseURL
        self.zdr = zdr
        self.secret = secret
        self.secretPresent = secretPresent
    }

    public init?(json: JSONValue) {
        guard let name = json.string("name") else { return nil }
        self.init(
            name: name,
            kind: json.string("kind") ?? "",
            locality: json.string("locality") ?? "",
            baseURL: json.string("base_url", "baseUrl") ?? "",
            zdr: json.bool("zdr"),
            secret: json.string("secret"),
            secretPresent: json.bool("secret_present", "secretPresent")
        )
    }

    /// Sentence case: prose, not a name.
    public var summary: String {
        var parts = [locality == "on_machine" ? "on this machine, no cost" : "off this machine"]
        if locality == "off_machine" && zdr != true { parts.append("no zero-retention claim") }
        if let secret {
            parts.append(secretPresent == true ? "\(secret) is in the Keychain" : "\(secret) is NOT set")
        }
        return parts.joined(separator: " · ")
    }
}

public struct ComputeAssignmentFacts: Sendable, Equatable, Identifiable {
    /// `default`, a tier name, or `crew:<name>`.
    public let target: String
    public let provider: String
    public let model: String
    public let effort: String
    public let warnNonZDR: Bool

    public var id: String { target }

    public init(target: String, provider: String, model: String, effort: String, warnNonZDR: Bool = false) {
        self.target = target
        self.provider = provider
        self.model = model
        self.effort = effort
        self.warnNonZDR = warnNonZDR
    }

    public init?(json: JSONValue) {
        guard let target = json.string("target"), let provider = json.string("provider"), let model = json.string("model") else { return nil }
        self.init(
            target: target,
            provider: provider,
            model: model,
            effort: json.string("effort") ?? "medium",
            warnNonZDR: json.bool("warn_non_zdr", "warnNonZdr") ?? false
        )
    }

    public var ref: String { "\(provider)/\(model)" }
}

public struct ComputeFacts: Sendable, Equatable {
    /// The file the effective configuration came from; `nil` = none exists yet.
    public let file: String?
    /// The instance's own file — what the verbs edit, whether or not it exists.
    public let instanceFile: String?
    public let providers: [ComputeProviderFacts]
    public let assignments: [ComputeAssignmentFacts]
    /// True while nothing is assigned — which now means there is no engine.
    public let assignsNothing: Bool

    public init(file: String?, instanceFile: String?, providers: [ComputeProviderFacts], assignments: [ComputeAssignmentFacts], assignsNothing: Bool) {
        self.file = file
        self.instanceFile = instanceFile
        self.providers = providers
        self.assignments = assignments
        self.assignsNothing = assignsNothing
    }

    public init?(json: JSONValue) {
        guard case .object = json else { return nil }
        self.init(
            file: json.string("file"),
            instanceFile: json.string("instance_file", "instanceFile"),
            providers: (json["providers"]?.arrayValue ?? []).compactMap(ComputeProviderFacts.init(json:)),
            assignments: (json["assignments"]?.arrayValue ?? []).compactMap(ComputeAssignmentFacts.init(json:)),
            assignsNothing: json.bool("assigns_nothing", "assignsNothing") ?? true
        )
    }

    /// What `assignments.default` resolves to, as `<provider>/<model>`.
    public var defaultRef: String? {
        assignments.first { $0.target == "default" }?.ref
    }

    /// The one line Settings and the wizard both show. Sentence case.
    public var engineSummary: String {
        guard let row = assignments.first(where: { $0.target == "default" }) else {
            return "no engine — compute.yaml assigns no default, so the assistant is not started and queued turns wait"
        }
        return "\(row.ref) at \(row.effort) effort"
    }
}
