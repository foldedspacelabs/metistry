# `@foldedspacelabs/metistry-mcp-apple-fm`

Apple Foundation Models — the on-device model macOS keeps resident — behind
two surfaces on one loopback listener:

| | |
| --- | --- |
| `GET /v1/models`, `POST /v1/chat/completions` | an **OpenAI-compatible provider**, so any client that already speaks `/v1` can use the model with `response_format: json_schema` |
| `GET /check`, `POST /classify` | the Metistry bridge contract — a behavioural health probe and a batch classify route |

**Cost 0, and ~0 extra resident memory.** The weights belong to Apple
Intelligence and are in RAM for the operating system whether this runs or
not. The bridge's own footprint is about 23 MB.

Requires an Apple Silicon Mac, macOS 26+, and Apple Intelligence switched on.
No TCC grants at all.

## Standalone

```sh
export METISTRY_BRIDGE_TOKEN_APPLE_FM=$(openssl rand -base64 32)
npx @foldedspacelabs/metistry-mcp-apple-fm
```

```
apple-fm bridge on 127.0.0.1:7810 (helper: …/afm-helper.app/Contents/MacOS/afm-helper)
```

```sh
curl -sS http://127.0.0.1:7810/v1/models -H "authorization: Bearer $METISTRY_BRIDGE_TOKEN_APPLE_FM"
# {"object":"list","data":[{"id":"foundation-model","object":"model","created":…,"owned_by":"apple"}]}

curl -sS http://127.0.0.1:7810/v1/chat/completions \
  -H "authorization: Bearer $METISTRY_BRIDGE_TOKEN_APPLE_FM" \
  -H 'content-type: application/json' -d '{
  "model":"foundation-model",
  "messages":[{"role":"system","content":"You classify short personal-inbox capture items."},
              {"role":"user","content":"grocery: pick up milk and bread tomorrow before 6pm"}],
  "response_format":{"type":"json_schema","json_schema":{"name":"classification","strict":true,"schema":{
    "type":"object",
    "properties":{"category":{"type":"string","enum":["todo","event","idea","link","note"]},
                  "has_action":{"type":"boolean"},
                  "action":{"type":"string"}},
    "required":["category","has_action","action"],"additionalProperties":false}}}}'
```

```json
{"id":"chatcmpl-…","object":"chat.completion","created":…,"model":"foundation-model",
 "choices":[{"index":0,"message":{"role":"assistant",
   "content":"{\"action\": \"Go to grocery store and pick up milk and bread before 6pm tomorrow\", \"has_action\": true, \"category\": \"todo\"}"},
   "finish_reason":"stop"}],
 "usage":{"prompt_tokens":212,"completion_tokens":42,"total_tokens":254},
 "x_metistry":{"cost_usd":0,"schema_mode":"dynamic","respond_ms":739.5}}
```

| variable | | |
| --- | --- | --- |
| `METISTRY_BRIDGE_TOKEN_APPLE_FM` | **required** | the bearer every route takes |
| `METISTRY_AFM_PORT` | `7810` | |
| `METISTRY_AFM_HOST` | `127.0.0.1` | |
| `METISTRY_AFM_HELPER` | the bundled `afm-helper.app` | path to the Swift helper |

## Authentication is not optional

Every route takes the bearer, `/v1` included. The network is not a trust
boundary and loopback is network: an unauthenticated completion endpoint on
`127.0.0.1` is readable by anything else on the machine, and (without the
CORS answer below) by any web page you happen to visit. Missing, wrong or
malformed credentials all get the same uniform 401.

## Structured output

`response_format: { type: json_schema, … }` is the reason this surface
exists. The caller's schema is translated **per request** into Apple's
`DynamicGenerationSchema` and enforced at generation time — no schema is
compiled into the binary.

Supported: `object` (`properties`, `required`), `string` (with a string
`enum`), `integer`, `number`, `boolean`, `null` (macOS 26.4+), `array`
(`items`, `minItems`, `maxItems`), and `anyOf` — including `anyOf` over
object subschemas, i.e. a discriminated union assembled at request time.

Refused, with the field named, rather than silently degraded:

| | |
| --- | --- |
| `$ref`, `$defs`, `oneOf`, `allOf`, `not`, `patternProperties` | `400 unsupported_schema` |
| a schema or prompt that would not fit the window | `400 context_length_exceeded` |
| `stream: true` | `400 stream_unsupported` |
| `tools:` | `400 tools_unsupported` |
| `n` other than 1 | `400 n_unsupported` |
| an API this macOS version does not have | `503 not_available` |

Dropping a constraint quietly would make `strict: true` a lie.

## Three things to know before you build on it

**The context window is 4096 tokens and the schema is charged to it.** With
the schema in the prompt each described field costs roughly 32 tokens —
about 40 fields before latency alone rules it out. The bridge preflights with
the model's own tokenizer and refuses over budget with a `400` naming the
field, rather than letting the generation fail with a `500`.

**It is serial by design.** The Swift helper reads one request, awaits the
generation, and only then reads the next. Apple Foundation Models is one
shared system daemon; concurrent callers see latency, never an error.

**Parse the answer; never string-match it.** Apple's structured output does
not emit object keys in a stable order — twenty identical generations come
back as twenty different byte strings and one value. Anything that hashes,
regexes or compares raw output will see differences that are not there.

## `/classify` — the bridge contract

`POST /classify` takes up to 100 `{id, text}` items and returns a
`{category, has_action, action}` for each, with **per-item** failures.
Unlike `/v1`, it runs the deterministic redaction pass over the model's free
text before returning it, because it is not a provider surface and nothing
downstream needs the bytes verbatim. A `/v1` caller should run its own —
Metistry's `completeJson()` scrubs every string leaf of the parsed result.

`GET /check` returns the frozen `check()` shape after running a **real**
classification end to end. It probes behaviour, never a permission API.

## Building the helper

```sh
pnpm --filter @foldedspacelabs/metistry-mcp-apple-fm build:helper
```

Compiles `helper/afm-helper.swift` into a minimal app bundle and signs it —
Developer ID when one is installed (`METISTRY_SIGN_IDENTITY` pins which),
ad-hoc otherwise. The bundle shape buys this bridge nothing directly (no TCC
grants); it exists so both Swift helpers have one build shape to sign,
notarise and reason about.

## Where it came from

`docs/poc/poc19-apple-fm-v1/` is the proof that runtime-supplied schemas work
at all, and the reference implementation the translation here was lifted
from. `docs/ops/compute.md` is how a Metistry install wires it up as a
provider.
