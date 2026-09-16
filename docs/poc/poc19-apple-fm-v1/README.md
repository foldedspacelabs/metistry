# PoC-19 — Apple Foundation Models behind an OpenAI-compatible `/v1`

The PoC the owner asked for before compute PR 4
(`docs/plan-refresh-2026-09-13.md` §4, decision C8; research note
`docs/research/2026-09-11-local-models-openrouter-opencode.md`, "Apple
Foundation Models in the provider model").

| | |
|---|---|
| Status | **PASS** |
| Date | 2026-09-16 |
| Verdict | **Runtime schemas: YES — `DynamicGenerationSchema`.** Build option (b) as designed. |

---

## The assumption under test

> Option (b) grows the existing Swift bridge a `GET /v1/models` +
> `POST /v1/chat/completions` surface with `response_format: json_schema`,
> so `compute.yaml` can list Apple FM as `kind: openai-compatible`,
> `locality: on_machine`, cost 0. **Open question:** does Foundation Models
> accept a schema built at runtime from the caller's JSON, or only
> `@Generable` types compiled into the binary? If only compiled types, the
> surface shrinks to a fixed set of shapes and option (a) — a special
> `kind: apple-fm` over `/classify` — comes back into play.

## Method

1. Establish from the installed SDK (not a blog post) whether
   `DynamicGenerationSchema` exists and what it accepts.
2. Build a scratch Swift server — `afm-v1.swift`, single-file `swiftc`
   build like the shipped helper — serving loopback `127.0.0.1:7841`, that
   translates a caller-supplied JSON Schema into a `DynamicGenerationSchema`
   per request and calls `LanguageModelSession.respond(to:schema:)`.
3. 20 requests each of three shapes — plain text, a 3-field classification
   schema, a nested schema with two arrays — measuring p50/p95 and
   validating every structured response against the schema the caller sent
   (`bench.mjs`, zero dependencies; the JSON Schema check is hand-rolled
   over exactly the keywords the cases use).
4. The same three prompts through LM Studio's `google/gemma-4-e4b` on
   `:1234` for a like-for-like latency line.

**Isolation:** run in a worktree, on port 7841, as a plain process. The
Studio's production `apple-fm` bridge on `:7810` was never touched (one
unauthenticated probe, which correctly refused).

## Environment

```
$ sw_vers
ProductName:		macOS
ProductVersion:		26.4
BuildVersion:		25E246

$ xcrun swift --version
swift-driver version: 1.148.6 Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)
Target: arm64-apple-macosx26.0

$ xcodebuild -version
Xcode 26.6
Build version 17F113
```

---

## Result 1 — the API exists, and it is the right shape

`developer.apple.com/documentation/foundationmodels/dynamicgenerationschema`
renders through JavaScript; the JSON the page itself loads answers it
directly (`runs/apple-docs.txt`):

```
abstract:   The dynamic counterpart to the generation schema type that you use
            to construct schemas at runtime.
platforms:  iOS 26.0, iPadOS 26.0, Mac Catalyst 26.0, macOS 26.0, visionOS 26.0,
            watchOS 27.0
```

Confirmed against the SDK actually installed on this Mac —
`$(xcrun --show-sdk-path)/System/Library/Frameworks/FoundationModels.framework/
Versions/A/Modules/FoundationModels.swiftmodule/arm64e-apple-macos.swiftinterface`
(`runs/sdk-evidence.txt`):

```
$ grep -n 'DynamicGenerationSchema' "$SI"
1271:public struct DynamicGenerationSchema : Swift.Sendable {
1275:  public static var null: FoundationModels.DynamicGenerationSchema {
1278:  public init(name: Swift.String, description: Swift.String? = nil, properties: [FoundationModels.DynamicGenerationSchema.Property])
1282:  public init(name: Swift.String, description: Swift.String? = nil, representNilExplicitlyInGeneratedContent explicitNil: Swift.Bool, properties: [FoundationModels.DynamicGenerationSchema.Property])
1283:  public init(name: Swift.String, description: Swift.String? = nil, anyOf choices: [FoundationModels.DynamicGenerationSchema])
1285:  public init(arrayOf itemSchema: FoundationModels.DynamicGenerationSchema, minimumElements: Swift.Int? = nil, maximumElements: Swift.Int? = nil)
1292:    public init(name: Swift.String, description: Swift.String? = nil, schema: FoundationModels.DynamicGenerationSchema, isOptional: Swift.Bool = false)
1350:  public init(root: FoundationModels.DynamicGenerationSchema, dependencies: [FoundationModels.DynamicGenerationSchema]) throws
```

Three more initialisers sit in the declaration but carry no
`DynamicGenerationSchema` in their own text, so the grep above misses them
(`sed -n '1269,1294p'`, same file):

```
  public init(name: Swift.String, description: Swift.String? = nil, anyOf choices: [Swift.String])
  public init<Value>(type: Value.Type, guides: [FoundationModels.GenerationGuide<Value>] = []) where Value : FoundationModels.Generable
  public init(referenceTo name: Swift.String)
```

That last line is the whole answer: `GenerationSchema(root:dependencies:)`
converts a runtime-assembled tree into the `GenerationSchema` that
`session.respond(to:schema:includeSchemaInPrompt:)` already takes. **No
`@Generable` type is required anywhere on that path.** The compiled-shapes
fallback the task allowed for was not needed and was not written.

Also found, and used: `SystemLanguageModel.tokenCount(for:)` (macOS 26.4+,
overloads for prompt, instructions, tools, **schema** and transcript
entries). Apple exposes no per-response usage object, but this gives real
tokenizer counts for an honest `usage` block.

## Result 2 — the `/v1` surface works

```
$ curl -sS http://127.0.0.1:7841/v1/models
{"object":"list","data":[{"id":"apple/foundation-model","object":"model","created":1789566940,"owned_by":"apple"}]}

$ curl -sS http://127.0.0.1:7841/v1/chat/completions -H 'content-type: application/json' -d '{
  "model":"apple/foundation-model",
  "messages":[{"role":"system","content":"You classify short personal-inbox capture items."},
              {"role":"user","content":"grocery: pick up milk and bread tomorrow before 6pm"}],
  "response_format":{"type":"json_schema","json_schema":{"name":"classification","strict":true,"schema":{
    "type":"object",
    "properties":{"category":{"type":"string","enum":["todo","event","idea","link","note"]},
                  "has_action":{"type":"boolean"},
                  "action":{"type":"string"}},
    "required":["category","has_action","action"],"additionalProperties":false}}}}'

{"id":"chatcmpl-e0ab42ea-6a75-4cb4-9950-","object":"chat.completion","created":1789566940,
 "model":"apple/foundation-model",
 "choices":[{"index":0,"message":{"role":"assistant","content":
   "{\"category\": \"todo\", \"action\": \"go to grocery store and pick up milk and bread before 6pm tomorrow\", \"has_action\": true}"},
   "finish_reason":"stop"}],
 "usage":{"prompt_tokens":208,"completion_tokens":42,"total_tokens":250},
 "x_metistry":{"cost_usd":0,"schema_mode":"dynamic","respond_ms":1002.9,"usage_ms":48.4}}
```

`anyOf` over object subschemas works too — a discriminated union assembled
at request time, which is more than `/classify` could ever express:

```
$ curl ... '{"messages":[{"role":"user","content":"Remind me to call the dentist on Monday."}],
  "response_format":{"type":"json_schema","json_schema":{"name":"u","schema":{"anyOf":[
    {"type":"object","properties":{"kind":{"type":"string","enum":["task"]},"text":{"type":"string"}},"required":["kind","text"]},
    {"type":"object","properties":{"kind":{"type":"string","enum":["event"]},"day":{"type":"string"}},"required":["kind","day"]}]}}}}'

  "content":"{\"kind\": \"task\", \"text\": \"Call the dentist on Monday\"}"
```

Untranslatable schemas are refused with the OpenAI error envelope rather
than silently degraded (full log in `runs/edge-cases.txt`):

```
{"error":{"message":"schema not translatable: `$ref` is not supported at Response_a","type":"invalid_request_error","code":"unsupported_schema"}}  (HTTP 400)
{"error":{"message":"tool calling is out of scope for v1","type":"invalid_request_error","code":"tools_unsupported"}}  (HTTP 400)
{"error":{"message":"streaming is not implemented in this PoC","type":"invalid_request_error","code":"stream_unsupported"}}  (HTTP 400)
{"error":{"message":"no such endpoint: /v1/embeddings","type":"invalid_request_error","code":"not_found"}}  (HTTP 404)
```

## Result 3 — 60/60 requests, 40/40 schema-valid

`node bench.mjs` — 20 requests per case, end-to-end client latency
(HTTP + generation + usage accounting), raw rows in `runs/applefm.jsonl`:

```
applefm — http://127.0.0.1:7841/v1 — model apple/foundation-model
┌─────────┬──────────────┬─────────────────────────────────┬────┬─────────┬──────────────┬──────────────────┬────────┬────────┬────────┬────────┐
│ (index) │ case         │ what                            │ n  │ ok      │ schema_valid │ distinct_outputs │ p50_ms │ p95_ms │ min_ms │ max_ms │
├─────────┼──────────────┼─────────────────────────────────┼────┼─────────┼──────────────┼──────────────────┼────────┼────────┼────────┼────────┤
│ 0       │ 'a-text'     │ 'plain text, no schema'         │ 20 │ '20/20' │ 'n/a'        │ 1                │ 268.4  │ 308.8  │ 263    │ 336    │
│ 1       │ 'b-classify' │ '3-field classification schema' │ 20 │ '20/20' │ '20/20'      │ 2                │ 497.1  │ 515.9  │ 485.3  │ 537    │
│ 2       │ 'c-nested'   │ 'nested schema with two arrays' │ 20 │ '20/20' │ '20/20'      │ 20               │ 1464.3 │ 1626.2 │ 1410.6 │ 1754.9 │
└─────────┴──────────────┴─────────────────────────────────┴────┴─────────┴──────────────┴──────────────────┴────────┴────────┴────────┴────────┘
```

**Zero schema violations in 40 structured generations**, matching PoC-3's
result for compiled `@Generable` types. Cold start is a non-event: the
first call after `./afm-v1 7841` took 0.33 s (the model is a resident
system daemon — PoC-3's finding, still true).

`distinct_outputs` counts raw response strings, and it is the one surprise:

```
a-text       distinct raw strings= 1  distinct VALUES=1  mean respond_ms=236.4  mean usage_ms=38.6
b-classify   distinct raw strings= 2  distinct VALUES=1  mean respond_ms=445.5  mean usage_ms=51.8
c-nested     distinct raw strings=20  distinct VALUES=1  mean respond_ms=1420.8 mean usage_ms=56.8
```

Every one of the 20 nested responses is a **different byte string but the
same value** — `GeneratedContent.jsonString` does not emit object keys in a
stable order. Greedy sampling is still deterministic in the way that
matters (1 distinct value per case across 20 runs), but any consumer that
string-compares, hashes or regexes model output will see false differences.
**PR 4 must parse, never match.**

`usage_ms` is the cost of the three `tokenCount` round-trips: ~39–57 ms,
which is ~16% of a plain-text call and ~4% of a nested one. Cheap, but not
free — worth a flag if a caller does not want `usage`.

## Result 4 — the schema is charged to the 4096-token context

`runs/schema-width.txt` — one object, N required string fields:

```
  3 string fields     929 ms  ok    3 keys back   prompt_tokens= 161  completion_tokens=34
  5 string fields     719 ms  ok    5 keys back   prompt_tokens= 219  completion_tokens=53
 10 string fields    1372 ms  ok   10 keys back   prompt_tokens= 364  completion_tokens=110
 20 string fields    2526 ms  ok   20 keys back   prompt_tokens= 684  completion_tokens=190
 40 string fields    4831 ms  ok   40 keys back   prompt_tokens=1324  completion_tokens=415
 80 string fields   16865 ms  ok   80 keys back   prompt_tokens=2604  completion_tokens=1117
160 string fields     134 ms  HTTP 500  exceededContextWindowSize(... "Content contains 5342
                                        tokens, which exceeds the maximum allowed context
                                        size of 4096." ...)
```

PoC-3's 4096-token window is unchanged, and with `includeSchemaInPrompt`
the schema sits **inside** it — roughly 32 tokens per described field here.
The practical ceiling is ~40 fields before latency alone rules it out. The
good news is that this is checkable in advance: `tokenCount(for: schema)`
lets the bridge refuse an oversized schema with a `400` instead of failing
the generation with a `500`.

## Result 5 — like-for-like against the local GGUF

Same three prompts, same harness, LM Studio's `google/gemma-4-e4b` on
`:1234` (`runs/lmstudio-gemma4-e4b.jsonl`):

```
lmstudio-gemma4-e4b — http://127.0.0.1:1234/v1 — model google/gemma-4-e4b
┌─────────┬──────────────┬─────────────────────────────────┬────┬─────────┬──────────────┬──────────────────┬────────┬────────┬────────┬─────────┐
│ (index) │ case         │ what                            │ n  │ ok      │ schema_valid │ distinct_outputs │ p50_ms │ p95_ms │ min_ms │ max_ms  │
├─────────┼──────────────┼─────────────────────────────────┼────┼─────────┼──────────────┼──────────────────┼────────┼────────┼────────┼─────────┤
│ 0       │ 'a-text'     │ 'plain text, no schema'         │ 20 │ '20/20' │ 'n/a'        │ 1                │ 124.2  │ 150.2  │ 121.7  │ 13470.4 │
│ 1       │ 'b-classify' │ '3-field classification schema' │ 20 │ '20/20' │ '20/20'      │ 11               │ 348.4  │ 410.7  │ 292    │ 2162.1  │
│ 2       │ 'c-nested'   │ 'nested schema with two arrays' │ 20 │ '20/20' │ '20/20'      │ 20               │ 1509.5 │ 1688   │ 1435.9 │ 1853.8  │
└─────────┴──────────────┴─────────────────────────────────┴────┴─────────┴──────────────┴──────────────────┴────────┴────────┴────────┴─────────┘
```

| p50 | Apple FM | gemma-4-e4b |
|---|---|---|
| plain text | 268 ms | **124 ms** |
| 3-field schema | 497 ms | **348 ms** |
| nested + arrays | **1464 ms** | 1510 ms |

gemma-4-e4b is faster on short work and level on the nested case, but its
`max_ms` of 13.5 s on the first request is the model loading, and it is
non-deterministic at its default sampling (11 and 20 distinct values, not
just distinct key orders). The difference that actually decides routing is
residency (`runs/footprint.txt`):

```
### afm-v1 (this PoC) — the model lives in shared Apple Intelligence daemons already running
    22.7 MB  pid 11628  ./afm-v1

### LM Studio serving google/gemma-4-e4b on :1234 — the model backend process
   842.5 MB  pid 39539  /Users/mattcolf/.lmstudio/.internal/utils/node
(GGUF weights are mmapped, so RSS understates true residency.)
```

Apple FM costs **0 dollars and ~0 resident memory** — the weights are
already in RAM for the OS. That is the argument for it as the always-on
provider for reduction work, with a GGUF server as the bigger-context peer.

---

## Verdict for PR 4

**Build option (b) exactly as the research note designed it.** Runtime
schemas are supported; option (a)'s special `kind: apple-fm` stays
rejected, and the compiled-shapes subset is unnecessary.

Concretely, what this PoC says PR 4 should carry over:

1. **`DynamicGenerationSchema` + `GenerationSchema(root:dependencies:)`** is
   the translation path. The subset in `afm-v1.swift` (object, string,
   integer, number, boolean, null, array with `minItems`/`maxItems`, string
   `enum`, `anyOf`) covers everything `inbox-drain` needs.
2. **Refuse what you cannot translate.** `$ref`, `$defs`, `oneOf`, `allOf`,
   `not`, `patternProperties` get a `400` with `code:
   "unsupported_schema"`. Silently dropping a constraint would make the
   provider a liar about `strict: true`.
3. **Pre-flight the schema against the context window** with
   `tokenCount(for: schema)` and refuse over budget — a `400` beats a `500`
   from `exceededContextWindowSize`.
4. **Parse, never string-match.** Key order out of `GeneratedContent` is not
   stable between identical runs.
5. **Real `usage`, cost 0.** `tokenCount` gives honest token counts; the
   schema belongs in `prompt_tokens` because that is what fills the window.
6. **Fresh `LanguageModelSession` per request** — PoC-3's rule, reconfirmed;
   the window is per session.
7. `apple/foundation-model` as the single `/v1/models` id, so `compute.yaml`
   can pin `apple-fm/apple/foundation-model` by the existing
   `<provider>/<model-id>` rule.

## What this PoC did NOT verify

- **Concurrency.** The server is serial by design (one generation at a
  time) so the latency numbers carry no queueing noise. What Foundation
  Models does under parallel sessions is untested, and PR 4 needs a
  decision there.
- **Streaming.** `stream: true` is refused. `respond` has a
  `streamResponse` counterpart in the SDK; mapping it onto SSE is unproven.
- **Tool calling.** Out of scope for v1 by the research note; refused here.
- **Auth, manifest conformance, `check()`.** This is a bare loopback
  process, not a bridge — none of `core`'s wire contract is exercised.
- **Quality.** Latency and schema conformance only. PoC-3 measured
  extraction quality and PoC-15/16 measured Apple FM as a scorer; nothing
  here revisits either.
- **Multi-turn `messages`.** Every case sends one system + one user
  message. The role-labelled concatenation for longer histories is written
  but unmeasured.
- **A second machine.** One Mac, one macOS build (26.4). The
  `DynamicGenerationSchema` availability annotation says macOS 26.0, but
  `.null`, `tokenCount` and `representNilExplicitlyInGeneratedContent` are
  26.4-only — a 26.0–26.3 Mac would need the `#available` guards this PoC
  already carries, untested.

---

## Files

| file | what |
|---|---|
| `afm-v1.swift` | the server — JSON Schema → `DynamicGenerationSchema`, loopback HTTP, OpenAI shapes |
| `build.sh` | `swiftc -O -parse-as-library`, ad-hoc signed (the binary is gitignored) |
| `bench.mjs` | the harness — 3 cases × N, hand-rolled schema validation, p50/p95 |
| `runs/environment.txt` | `sw_vers`, Swift, Xcode, node |
| `runs/sdk-evidence.txt` | the `.swiftinterface` greps |
| `runs/apple-docs.txt` | Apple's own doc JSON |
| `runs/applefm.jsonl`, `runs/applefm-summary.json` | 60 Apple FM requests, one row each |
| `runs/lmstudio-gemma4-e4b.jsonl`, `-summary.json` | the same 60 against gemma-4-e4b |
| `runs/edge-cases.txt` | endpoints, unions, refusals |
| `runs/schema-width.txt` | the context-window ceiling |
| `runs/determinism.txt` | raw-string vs value distinctness |
| `runs/footprint.txt` | resident memory, both servers |

Reproduce:

```sh
cd docs/poc/poc19-apple-fm-v1
./build.sh
./afm-v1 7841 &
node bench.mjs
node bench.mjs --base-url http://127.0.0.1:1234/v1 --model google/gemma-4-e4b --label lmstudio-gemma4-e4b
```
