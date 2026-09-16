// afm-helper — the FoundationModels-touching half of the apple-fm bridge
// (Swift-only framework; PoC-3). JSON-lines protocol on stdio, one object
// per line in, one per line out:
//
//   {"id":1,"text":"..."}                     -> {"id":1,"ok":true,"classification":{...}}
//   {"id":2,"op":"check"}                     -> {"id":2,"ok":true,"probe":"…","category":"todo"}
//   {"id":3,"op":"models"}                    -> {"id":3,"ok":true,"models":[{"id":"foundation-model",…}]}
//   {"id":4,"op":"complete","prompt":"…",     -> {"id":4,"ok":true,"completion":{"content":"…",…}}
//    "instructions":"…","schema":{…},
//    "temperature":0.2,"max_tokens":256}
//
// The last two are the `/v1` surface's engine room. THE HTTP IS NOT HERE:
// the bridge's node front owns the listener, the bearer and the OpenAI
// request/response shapes, and this process owns only what macOS requires a
// Swift process for (invariant 6). PoC-19 served `/v1` from Swift directly
// because it was a scratch server with no wire contract to honour; a shipped
// bridge has one, and it already exists in TypeScript.
//
// The JSON Schema -> `DynamicGenerationSchema` translation below is lifted
// from docs/poc/poc19-apple-fm-v1/afm-v1.swift, which proved the whole
// approach (PASS, 2026-09-16): runtime-assembled schemas go through
// `GenerationSchema(root:dependencies:)` into `session.respond(to:schema:)`
// with no `@Generable` type anywhere on the path.
//
// SERIAL BY DESIGN. The loop at the bottom reads a line, awaits the answer,
// and only then reads the next: one generation at a time, per process. Apple
// Foundation Models is one shared system daemon, PoC-19 measured nothing
// about parallel sessions, and a queue of one is the only behaviour we can
// honestly describe. Callers see it as latency, never as an error.
//
// One resident process amortizes model load; a FRESH LanguageModelSession
// per request (PoC-3, reconfirmed by PoC-19: the context window is per
// session, so a reused one eventually dies). No TCC required.

import Foundation
import FoundationModels

/// The one id this provider serves. `compute.yaml` pins it as
/// `<provider>/<model-id>` — `applefm/foundation-model` with the shipped
/// template — so the provider name already says "Apple" and the id does not
/// repeat it. (PoC-19 used `apple/foundation-model`; the prefix was dropped
/// on the way in, and nothing outside this constant and the template knows.)
let MODEL_ID = "foundation-model"

/// PoC-3's finding, unchanged in PoC-19: 4096 tokens, and with
/// `includeSchemaInPrompt` the SCHEMA sits inside it (~32 tokens per
/// described field). Fixed because it is the model's, not ours.
let CONTEXT_TOKENS = 4096

/// What the preflight leaves for the answer when the caller named no
/// `max_tokens`. Generous enough for the structured outputs this exists for
/// (PoC-19's 80-field case completed in 1117), small enough that a prompt
/// over the budget is genuinely over it.
let DEFAULT_RESPONSE_RESERVE = 1200

// ------------------------------------------------- JSON Schema -> Apple schema

struct SchemaError: Error, CustomStringConvertible {
    let description: String
    /// The wire code the bridge turns into an HTTP status: `unsupported_schema` (400) or `not_available` (503).
    let code: String
    init(_ d: String, code: String = "unsupported_schema") {
        description = d
        self.code = code
    }
}

/// The subset of JSON Schema this translates, and what each maps onto.
///
///   object  properties/required        DynamicGenerationSchema(name:properties:)
///   string  (+ enum of strings)        String.self  /  (name:anyOf: [String])
///   integer                            Int.self
///   number                             Double.self
///   boolean                            Bool.self
///   null                               .null                        (macOS 26.4+)
///   array   items/minItems/maxItems    DynamicGenerationSchema(arrayOf:...)
///   anyOf   [subschema]                (name:anyOf: [DynamicGenerationSchema])
///
/// NOT translated, and REFUSED LOUDLY rather than silently ignored: `$ref`,
/// `$defs`, `oneOf`/`allOf`/`not`, `patternProperties`, tuple-form `items`.
/// Dropping a constraint quietly would make the provider a liar about
/// `strict: true`. `additionalProperties` is ignored on purpose — Apple's
/// schemas are closed by construction, which is what `strict: true` asks for.
///
/// Property ORDER: `JSONSerialization` hands back an unordered dictionary, so
/// the order here is `required` first (in the caller's order) then the rest
/// alphabetically. JSON objects are unordered by spec, so this loses nothing
/// semantically. It is also why callers must PARSE the answer and never
/// string-match it (PoC-19 result 3: 20 identical generations, 20 different
/// byte strings, one value).
func dynamicSchema(from node: Any, name: String, description: String?, depth: Int = 0) throws -> DynamicGenerationSchema {
    guard depth < 12 else { throw SchemaError("schema nests deeper than 12 levels") }
    guard let node = node as? [String: Any] else { throw SchemaError("schema node at \(name) is not an object") }

    for unsupported in ["$ref", "$defs", "definitions", "oneOf", "allOf", "not", "patternProperties"] {
        if node[unsupported] != nil { throw SchemaError("`\(unsupported)` is not supported at \(name)") }
    }
    let desc = description ?? node["description"] as? String

    if let choices = node["enum"] as? [Any] {
        let strings = choices.compactMap { $0 as? String }
        guard !strings.isEmpty, strings.count == choices.count else {
            throw SchemaError("`enum` at \(name) must be a non-empty array of strings")
        }
        return DynamicGenerationSchema(name: name, description: desc, anyOf: strings)
    }

    if let branches = node["anyOf"] as? [Any] {
        guard !branches.isEmpty else { throw SchemaError("`anyOf` at \(name) is empty") }
        let subs = try branches.enumerated().map {
            try dynamicSchema(from: $0.element, name: "\(name)_any\($0.offset)", description: nil, depth: depth + 1)
        }
        return DynamicGenerationSchema(name: name, description: desc, anyOf: subs)
    }

    let type = node["type"] as? String ?? (node["properties"] != nil ? "object" : nil)
    switch type {
    case "object":
        let props = node["properties"] as? [String: Any] ?? [:]
        let required = (node["required"] as? [String]) ?? []
        let ordered = required.filter { props[$0] != nil } + props.keys.filter { !required.contains($0) }.sorted()
        let properties: [DynamicGenerationSchema.Property] = try ordered.map { key in
            let child = props[key]!
            let childDesc = (child as? [String: Any])?["description"] as? String
            return DynamicGenerationSchema.Property(
                name: key,
                description: childDesc,
                schema: try dynamicSchema(from: child, name: "\(name)_\(key)", description: childDesc, depth: depth + 1),
                isOptional: !required.contains(key))
        }
        return DynamicGenerationSchema(name: name, description: desc, properties: properties)

    case "array":
        guard let items = node["items"] else { throw SchemaError("`array` at \(name) needs `items`") }
        return DynamicGenerationSchema(
            arrayOf: try dynamicSchema(from: items, name: "\(name)_item", description: nil, depth: depth + 1),
            minimumElements: node["minItems"] as? Int,
            maximumElements: node["maxItems"] as? Int)

    case "string": return DynamicGenerationSchema(type: String.self)
    case "integer": return DynamicGenerationSchema(type: Int.self)
    case "number": return DynamicGenerationSchema(type: Double.self)
    case "boolean": return DynamicGenerationSchema(type: Bool.self)
    case "null":
        // `.null` is macOS 26.4+. On 26.0-26.3 this is genuinely absent, so
        // it is `not_available` (503) and not a bad request: the caller's
        // schema is fine, this Mac is older.
        guard #available(macOS 26.4, *) else {
            throw SchemaError("`type: null` at \(name) needs macOS 26.4 (DynamicGenerationSchema.null); this Mac is older", code: "not_available")
        }
        return .null
    case .some(let t): throw SchemaError("unsupported `type: \(t)` at \(name)")
    case nil: throw SchemaError("no `type` and no `properties` at \(name)")
    }
}

// ------------------------------------------------------- the classify surface

@Generable
enum Category: String {
    case todo, event, idea, link, note
}

@Generable
struct Classification {
    @Guide(description: "The single best category for this inbox item.")
    let category: Category
    @Guide(description: "true ONLY if the item states a concrete task the user personally must do. Pure information, musings, and links with no stated intent are false.")
    let hasAction: Bool
    @Guide(description: "If hasAction is true, a short imperative action phrase of at most 8 words. If hasAction is false, the empty string.")
    let action: String
}

let instructions = """
You classify short personal-inbox capture items for a productivity assistant.
Choose exactly one category: todo (user must do), event (dated calendar item),
idea (thought or speculation), link (primarily a URL), note (fact, nothing to do).
Set hasAction true ONLY for a concrete task the user must personally perform.
Be conservative: precision matters more than recall. Do not invent tasks.
"""

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

// ------------------------------------------------------------- the completion

let model = SystemLanguageModel.default

struct Completion {
    let content: String
    let promptTokens: Int
    let completionTokens: Int
    /// false on macOS < 26.4, where `tokenCount(for:)` does not exist: the
    /// counts are then zeros and the bridge says so rather than reporting
    /// a confident 0.
    let usageOk: Bool
    let schemaMode: String
    let respondMs: Double
}

/// Prompt-side tokens through the model's own tokenizer: instructions +
/// prompt + THE SCHEMA, because with `includeSchemaInPrompt` the schema is
/// what actually fills the window (PoC-19 result 4). macOS 26.4+ only;
/// `nil` when the API is not there.
@available(macOS 26.4, *)
func promptTokens(instructions: String?, prompt: String, schema: GenerationSchema?) async -> Int? {
    do {
        var n = try await model.tokenCount(for: prompt)
        if let instructions { n += try await model.tokenCount(for: instructions) }
        if let schema { n += try await model.tokenCount(for: schema) }
        return n
    } catch {
        return nil
    }
}

func complete(instructions: String?, prompt: String, schemaNode: Any?, temperature: Double?, maxTokens: Int?) async throws -> Completion {
    var built: GenerationSchema? = nil
    var schemaMode = "text"
    if let schemaNode {
        let dynamic = try dynamicSchema(from: schemaNode, name: "Response", description: nil)
        built = try GenerationSchema(root: dynamic, dependencies: [])
        schemaMode = "dynamic"
    }

    // PREFLIGHT, not a post-mortem. PoC-19 result 4: past the window the SDK
    // raises `exceededContextWindowSize` mid-generation, which is a 500 for
    // something the caller could have been told about before paying for it.
    // `tokenCount` makes it a 400 that names the oversized field.
    var counted: Int? = nil
    if #available(macOS 26.4, *) {
        counted = await promptTokens(instructions: instructions, prompt: prompt, schema: built)
        if let n = counted {
            let reserve = maxTokens ?? DEFAULT_RESPONSE_RESERVE
            if n + reserve > CONTEXT_TOKENS {
                let field = built == nil ? "messages" : "response_format.json_schema.schema"
                throw SchemaError(
                    "\(field) would not fit: \(n) prompt tokens + \(reserve) reserved for the answer exceeds this model's \(CONTEXT_TOKENS)-token window " +
                    "(the schema is charged to the prompt — roughly 32 tokens per described field). Shorten \(field), or lower max_tokens.",
                    code: "context_length_exceeded")
            }
        }
    }

    // PoC-3: fresh session per item, never reused.
    let session = LanguageModelSession(instructions: instructions)
    var options = GenerationOptions(sampling: .greedy)
    if let t = temperature, t > 0 { options = GenerationOptions(temperature: t) }
    if let maxTokens {
        options = GenerationOptions(sampling: options.sampling, temperature: options.temperature, maximumResponseTokens: maxTokens)
    }

    let t0 = Date()
    let content: String
    if let built {
        content = try await session.respond(to: prompt, schema: built, includeSchemaInPrompt: true, options: options).content.jsonString
    } else {
        content = try await session.respond(to: prompt, options: options).content
    }
    let respondMs = Date().timeIntervalSince(t0) * 1000

    // Apple exposes no per-response usage object, so completion tokens are
    // the output text measured through the same tokenizer. Cost is 0 either
    // way; the counts are for the `runs` row, not for a bill.
    var completionTokens = 0
    var usageOk = false
    if #available(macOS 26.4, *) {
        if let n = counted {
            usageOk = true
            completionTokens = (try? await model.tokenCount(for: content)) ?? 0
            return Completion(content: content, promptTokens: n, completionTokens: completionTokens, usageOk: usageOk, schemaMode: schemaMode, respondMs: respondMs)
        }
    }
    return Completion(content: content, promptTokens: 0, completionTokens: completionTokens, usageOk: usageOk, schemaMode: schemaMode, respondMs: respondMs)
}

// ------------------------------------------------------------------- the loop

@main
struct AFMHelper {
    static func classify(_ text: String) async throws -> Classification {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(to: text, generating: Classification.self)
        return response.content
    }

    static func handle(_ req: [String: Any], id: Int) async -> [String: Any] {
        let op = req["op"] as? String

        if op == "models" {
            return ["id": id, "ok": true, "models": [["id": MODEL_ID, "owned_by": "apple"]]]
        }

        if op == "complete" {
            guard let prompt = req["prompt"] as? String, !prompt.isEmpty else {
                return ["id": id, "ok": false, "error": "`prompt` is required", "code": "invalid_request"]
            }
            do {
                let c = try await complete(
                    instructions: req["instructions"] as? String,
                    prompt: prompt,
                    schemaNode: req["schema"],
                    temperature: req["temperature"] as? Double,
                    maxTokens: req["max_tokens"] as? Int)
                return ["id": id, "ok": true, "completion": [
                    "content": c.content,
                    "prompt_tokens": c.promptTokens,
                    "completion_tokens": c.completionTokens,
                    "usage_ok": c.usageOk,
                    "schema_mode": c.schemaMode,
                    "respond_ms": (c.respondMs * 10).rounded() / 10,
                ] as [String: Any]]
            } catch let e as SchemaError {
                return ["id": id, "ok": false, "error": e.description, "code": e.code]
            } catch {
                return ["id": id, "ok": false, "error": "\(error)", "code": "generation_failed"]
            }
        }

        do {
            if op == "check" {
                // behavioral probe: run the REAL privileged path (hard req 3)
                let c = try await classify("buy milk tomorrow")
                return ["id": id, "ok": true, "probe": "classified canned item end-to-end", "category": c.category.rawValue]
            }
            if let text = req["text"] as? String {
                let c = try await classify(text)
                return ["id": id, "ok": true, "classification": [
                    "category": c.category.rawValue,
                    "has_action": c.hasAction,
                    "action": c.action,
                ] as [String: Any]]
            }
            return ["id": id, "ok": false, "error": "no text", "code": "invalid_request"]
        } catch {
            return ["id": id, "ok": false, "error": "\(error)", "code": "generation_failed"]
        }
    }

    static func main() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        guard model.isAvailable else {
            emit(["id": 0, "ok": false, "error": "FoundationModels unavailable: \(model.availability)", "code": "not_available"])
            exit(2)
        }
        emit(["id": 0, "ok": true, "ready": true, "model": MODEL_ID])

        // Serial: one line, one generation, then the next.
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = req["id"] as? Int else {
                emit(["id": -1, "ok": false, "error": "bad request line", "code": "invalid_request"])
                continue
            }
            emit(await handle(req, id: id))
        }
    }
}
