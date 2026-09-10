// A read-only view of an arbitrary JSON value.
//
// It exists for exactly one field: a doctor row's `meta`. Every row carries a
// different shape there (`packages/core/src/check.ts` types it
// `Record<string, unknown>` on purpose — the deployment row reports a shape and
// a service plan, a container reports docker's state, the reconciler reports a
// HEAD and a push result), so a `Codable` struct per row kind would be a
// catalogue of the CLI's internals that goes stale the first time one of them
// grows a field.
//
// The rule this keeps: the app READS what the CLI said and never computes
// health itself. A missing or differently-shaped key is `nil`, and the panel
// that wanted it says so — it is never a decode failure that blanks the whole
// report (design-system P5).

import Foundation

public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else if let v = try? c.decode([String: JSONValue].self) {
            self = .object(v)
        } else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

public extension JSONValue {
    /// `meta["bridge_meta"]?["last_push"]?["remote"]` — nil all the way down
    /// rather than a trap, because every one of those keys is optional in the
    /// wire shape.
    subscript(key: String) -> JSONValue? {
        guard case .object(let o) = self else { return nil }
        return o[key]
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var intValue: Int? {
        if case .number(let d) = self, d.isFinite { return Int(d) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// Keys in sorted order with their string values — the generic "show me
    /// what the CLI reported" rendering, used where the app has no opinion
    /// about a particular key.
    var objectKeys: [String] {
        guard case .object(let o) = self else { return [] }
        return o.keys.sorted()
    }
}
