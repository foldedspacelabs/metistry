// PoC-19 — an OpenAI-compatible /v1 surface over Apple Foundation Models.
//
// Proves (or disproves) the open question behind compute PR 4: can the Swift
// helper serve a JSON schema supplied AT RUNTIME by the caller, or is Apple's
// structured output limited to `@Generable` types compiled into the binary?
//
//   GET  /v1/models            -> one model, `apple/foundation-model`
//   POST /v1/chat/completions  -> messages + optional
//                                 response_format: {type: json_schema, ...}
//   GET  /healthz              -> availability probe
//
// Scratch code. NOT the shipped bridge: loopback only, no auth, no manifest,
// one request at a time. The real thing lands in packages/mcp-apple-fm.
//
// Session shape is PoC-3's finding, kept verbatim: a FRESH LanguageModelSession
// per request (the 4096-token context is per session; a reused one dies).
//
// Build: ./build.sh     Run: ./afm-v1 [port]     (default 7841)

import Darwin
import Foundation
import FoundationModels

// ---------------------------------------------------------------- JSON output

/// Minimal JSON writer. JSONSerialization can't emit a bare `Double` without
/// `.fragmentsAllowed` gymnastics and reorders keys; OpenAI clients are happier
/// with stable key order, so responses are assembled by hand.
enum J {
    case s(String), n(Double), i(Int), b(Bool), null
    case a([J]), o([(String, J)])

    var text: String {
        switch self {
        case .s(let v): return J.quote(v)
        case .n(let v): return v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v)
        case .i(let v): return String(v)
        case .b(let v): return v ? "true" : "false"
        case .null: return "null"
        case .a(let items): return "[" + items.map(\.text).joined(separator: ",") + "]"
        case .o(let pairs):
            return "{" + pairs.map { "\(J.quote($0.0)):\($0.1.text)" }.joined(separator: ",") + "}"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
            }
        }
        return out + "\""
    }
}

// ------------------------------------------------- JSON Schema -> Apple schema

struct SchemaError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
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
/// NOT translated (rejected loudly rather than silently ignored): `$ref`,
/// `$defs`, `oneOf`/`allOf`/`not`, `patternProperties`, tuple-form `items`.
/// `additionalProperties` is ignored — Apple's schemas are closed by
/// construction, which is what `strict: true` asks for anyway.
///
/// Property ORDER: JSONSerialization hands back an unordered dictionary, so the
/// order here is `required` first (in the caller's order) then the rest
/// alphabetically. JSON objects are unordered by spec, so this loses nothing
/// semantically; it only means the emitted key order is not necessarily the
/// caller's `properties` order.
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
        guard #available(macOS 26.4, *) else { throw SchemaError("`type: null` needs macOS 26.4") }
        return .null
    case .some(let t): throw SchemaError("unsupported `type: \(t)` at \(name)")
    case nil: throw SchemaError("no `type` and no `properties` at \(name)")
    }
}

// ------------------------------------------------------------- the model calls

let model = SystemLanguageModel.default

struct Completion {
    let text: String
    let respondMs: Double
    let usageMs: Double
    let promptTokens: Int
    let completionTokens: Int
    let schemaMode: String
}

func complete(instructions: String?, prompt: String, schemaNode: Any?, options: GenerationOptions) async throws -> Completion {
    // PoC-3: fresh session per item, never reused.
    let session = LanguageModelSession(instructions: instructions)
    var schemaMode = "text"
    var builtSchema: GenerationSchema? = nil
    let t0 = Date()
    let output: String
    if let schemaNode {
        let dynamic = try dynamicSchema(from: schemaNode, name: "Response", description: nil)
        let schema = try GenerationSchema(root: dynamic, dependencies: [])
        builtSchema = schema
        schemaMode = "dynamic"
        let r = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
        output = r.content.jsonString
    } else {
        output = try await session.respond(to: prompt, options: options).content
    }
    let respondMs = Date().timeIntervalSince(t0) * 1000

    // Real token counts: SystemLanguageModel.tokenCount (macOS 26.4+). Apple
    // exposes no per-response usage, so completion tokens are the output text
    // measured through the same tokenizer. The SCHEMA counts too — with
    // includeSchemaInPrompt it is what actually fills the context window — so
    // it is billed to prompt_tokens. Cost is 0 either way.
    let t1 = Date()
    var promptTokens = 0, completionTokens = 0
    if #available(macOS 26.4, *) {
        do {
            promptTokens = try await model.tokenCount(for: prompt)
            if let instructions { promptTokens += try await model.tokenCount(for: instructions) }
            if let builtSchema { promptTokens += try await model.tokenCount(for: builtSchema) }
            completionTokens = try await model.tokenCount(for: output)
        } catch { /* usage is informational; never fail a completion over it */ }
    }
    return Completion(text: output, respondMs: respondMs, usageMs: Date().timeIntervalSince(t1) * 1000,
                      promptTokens: promptTokens, completionTokens: completionTokens, schemaMode: schemaMode)
}

// ------------------------------------------------------------------- HTTP glue

func httpResponse(_ status: Int, _ body: String) -> String {
    let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error", 503: "Service Unavailable"][status] ?? "OK"
    let bytes = body.utf8.count
    return "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(bytes)\r\nConnection: close\r\n\r\n\(body)"
}

func errorBody(_ message: String, type: String, code: String) -> String {
    J.o([("error", .o([("message", .s(message)), ("type", .s(type)), ("code", .s(code))]))]).text
}

func handle(method: String, path: String, body: String) async -> (Int, String) {
    let created = Int(Date().timeIntervalSince1970)

    if method == "GET", path == "/healthz" {
        let avail: String
        switch model.availability {
        case .available: avail = "available"
        case .unavailable(let why): avail = "unavailable: \(why)"
        }
        return (model.isAvailable ? 200 : 503, J.o([("status", .s(avail))]).text)
    }

    if path == "/v1/models" {
        guard method == "GET" else { return (405, errorBody("use GET", type: "invalid_request_error", code: "method_not_allowed")) }
        return (200, J.o([
            ("object", .s("list")),
            ("data", .a([.o([
                ("id", .s("apple/foundation-model")),
                ("object", .s("model")),
                ("created", .i(created)),
                ("owned_by", .s("apple")),
            ])])),
        ]).text)
    }

    guard path == "/v1/chat/completions" else {
        return (404, errorBody("no such endpoint: \(path)", type: "invalid_request_error", code: "not_found"))
    }
    guard method == "POST" else { return (405, errorBody("use POST", type: "invalid_request_error", code: "method_not_allowed")) }
    guard model.isAvailable else {
        return (503, errorBody("Apple Foundation Models unavailable: \(model.availability)", type: "server_error", code: "model_unavailable"))
    }
    guard let data = body.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        return (400, errorBody("body is not a JSON object", type: "invalid_request_error", code: "bad_json"))
    }
    guard let messages = req["messages"] as? [[String: Any]], !messages.isEmpty else {
        return (400, errorBody("`messages` is required and must be a non-empty array", type: "invalid_request_error", code: "missing_messages"))
    }
    if req["stream"] as? Bool == true {
        return (400, errorBody("streaming is not implemented in this PoC", type: "invalid_request_error", code: "stream_unsupported"))
    }
    if req["tools"] != nil {
        return (400, errorBody("tool calling is out of scope for v1", type: "invalid_request_error", code: "tools_unsupported"))
    }

    // system/developer messages become Instructions; the rest become one
    // prompt — unlabelled when there is only one, role-labelled when the
    // caller sent a multi-turn history.
    var systemParts: [String] = [], turns: [(String, String)] = []
    for m in messages {
        let role = m["role"] as? String ?? "user"
        let content = m["content"] as? String ?? ""
        if role == "system" || role == "developer" { systemParts.append(content) } else { turns.append((role, content)) }
    }
    let instructions = systemParts.isEmpty ? nil : systemParts.joined(separator: "\n\n")
    let prompt = turns.count == 1 ? turns[0].1 : turns.map { "\($0.0): \($0.1)" }.joined(separator: "\n")

    var schemaNode: Any? = nil
    if let rf = req["response_format"] as? [String: Any] {
        let kind = rf["type"] as? String ?? ""
        if kind == "json_schema" {
            guard let js = rf["json_schema"] as? [String: Any], let schema = js["schema"] else {
                return (400, errorBody("response_format.json_schema.schema is required", type: "invalid_request_error", code: "missing_schema"))
            }
            schemaNode = schema
        } else if kind == "json_object" {
            return (400, errorBody("response_format `json_object` has no schema to constrain on; use `json_schema`", type: "invalid_request_error", code: "unsupported_response_format"))
        } else if kind != "text" {
            return (400, errorBody("unsupported response_format `\(kind)`", type: "invalid_request_error", code: "unsupported_response_format"))
        }
    }

    var options = GenerationOptions(sampling: .greedy)
    if let t = req["temperature"] as? Double, t > 0 { options = GenerationOptions(temperature: t) }
    if let maxTokens = req["max_tokens"] as? Int ?? req["max_completion_tokens"] as? Int {
        options = GenerationOptions(sampling: options.sampling, temperature: options.temperature, maximumResponseTokens: maxTokens)
    }

    do {
        let c = try await complete(instructions: instructions, prompt: prompt, schemaNode: schemaNode, options: options)
        return (200, J.o([
            ("id", .s("chatcmpl-\(UUID().uuidString.lowercased().prefix(24))")),
            ("object", .s("chat.completion")),
            ("created", .i(created)),
            ("model", .s("apple/foundation-model")),
            ("choices", .a([.o([
                ("index", .i(0)),
                ("message", .o([("role", .s("assistant")), ("content", .s(c.text))])),
                ("finish_reason", .s("stop")),
            ])])),
            ("usage", .o([
                ("prompt_tokens", .i(c.promptTokens)),
                ("completion_tokens", .i(c.completionTokens)),
                ("total_tokens", .i(c.promptTokens + c.completionTokens)),
            ])),
            // non-standard, for the PoC's own measurements; clients ignore it.
            ("x_metistry", .o([
                ("cost_usd", .n(0)),
                ("schema_mode", .s(c.schemaMode)),
                ("respond_ms", .n((c.respondMs * 10).rounded() / 10)),
                ("usage_ms", .n((c.usageMs * 10).rounded() / 10)),
            ])),
        ]).text)
    } catch let e as SchemaError {
        return (400, errorBody("schema not translatable: \(e.description)", type: "invalid_request_error", code: "unsupported_schema"))
    } catch {
        return (500, errorBody("\(error)", type: "server_error", code: "generation_failed"))
    }
}

// --------------------------------------------------------------- socket server

func readAll(_ fd: Int32) -> (String, String, String)? {
    var buf = [UInt8](), tmp = [UInt8](repeating: 0, count: 8192)
    var headerEnd = -1
    while headerEnd < 0 {
        let n = read(fd, &tmp, tmp.count)
        if n <= 0 { return nil }
        buf.append(contentsOf: tmp[0..<n])
        if buf.count >= 4 {
            for i in 0...(buf.count - 4) where buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10 {
                headerEnd = i
                break
            }
        }
    }
    let head = String(decoding: buf[0..<headerEnd], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let parts = (lines.first ?? "").split(separator: " ", maxSplits: 2).map(String.init)
    guard parts.count >= 2 else { return nil }
    var length = 0
    for l in lines.dropFirst() where l.lowercased().hasPrefix("content-length:") {
        length = Int(l.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) ?? 0
    }
    var body = Array(buf[(headerEnd + 4)...])
    while body.count < length {
        let n = read(fd, &tmp, tmp.count)
        if n <= 0 { break }
        body.append(contentsOf: tmp[0..<n])
    }
    return (parts[0], parts[1], String(decoding: body, as: UTF8.self))
}

func writeAll(_ fd: Int32, _ s: String) {
    var bytes = Array(s.utf8), off = 0
    while off < bytes.count {
        let n = bytes.withUnsafeBytes { write(fd, $0.baseAddress!.advanced(by: off), bytes.count - off) }
        if n <= 0 { break }
        off += n
    }
}

@main
struct Server {
    static func main() async {
        setvbuf(stdout, nil, _IOLBF, 0)
        let port = UInt16(CommandLine.arguments.dropFirst().first ?? "") ?? 7841

        switch model.availability {
        case .available: break
        case .unavailable(let why):
            FileHandle.standardError.write("Apple Foundation Models unavailable: \(why)\n".data(using: .utf8)!)
            exit(2)
        }

        let listener = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")  // loopback only, never 0.0.0.0
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(listener, 16) == 0 else {
            FileHandle.standardError.write("cannot listen on 127.0.0.1:\(port): \(String(cString: strerror(errno)))\n".data(using: .utf8)!)
            exit(1)
        }
        print("afm-v1 listening on http://127.0.0.1:\(port)  (model available)")

        // Serial: one generation at a time. Foundation Models is one shared
        // system daemon anyway, and a PoC measuring latency wants no queueing
        // noise. A shipped bridge would need a real decision here.
        while true {
            let conn = accept(listener, nil, nil)
            if conn < 0 { continue }
            if let (method, path, body) = readAll(conn) {
                let (status, out) = await handle(method: method, path: path, body: body)
                writeAll(conn, httpResponse(status, out))
            }
            close(conn)
        }
    }
}
