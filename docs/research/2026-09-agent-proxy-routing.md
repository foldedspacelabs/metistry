# AI-agent proxies and routing layers — Quotio, CLIProxyAPI, LiteLLM (2026-09-07)

Owner question: could a proxy/routing layer like Quotio let Metistry
"support many more AI agents and companies without developing the
connection ourselves"? Short answer: the question hides two different
seams, one is already solved, the other the plan already reserves — and
one new option is worth recording, with a terms-of-service caveat.

## What these tools are

| Tool | What it is | Client-facing | Upstream | License / size |
| --- | --- | --- | --- | --- |
| **Quotio** | Native Swift macOS menu-bar app (macOS 14+). Manages many AI *accounts*, tracks quotas, runs a local proxy, and **auto-configures Claude Code, Codex CLI, Amp, OpenCode, Factory Droid** to point at it. Failover Round Robin / Fill First. | the bundled proxy | Claude, OpenAI, Gemini, Qwen, Vertex, Copilot, … via OAuth or keys | MIT, ~4.8k★ |
| **CLIProxyAPI** (what Quotio bundles) | Go proxy. Serves **OpenAI-, Anthropic Messages-, Gemini- and Grok-compatible endpoints**; pools **subscription OAuth accounts** (Claude Code, Codex, Gemini, Grok Build) plus API keys and OpenAI-compatible upstreams (OpenRouter); round-robin across accounts; YAML config; binary or Docker. Built-in usage stats removed in v6.10 (separate companion projects). | OpenAI / Anthropic / Gemini / Grok | OAuth-pooled subscriptions + keys | MIT, ~51k★ |
| **LiteLLM** | Python gateway. OpenAI-compatible plus native `/v1/messages` pass-through, 100+ providers, **virtual keys, per-key budgets, rate limits, fallbacks, cost tracking**; YAML; Docker/Helm/Terraform. | OpenAI-compatible (+ native) | 100+ APIs | MIT core + commercial enterprise tier, ~58k★ |

Neither Quotio nor CLIProxyAPI documents any terms-of-service position on
routing *subscription* OAuth tokens (Claude Code, ChatGPT) through a
third-party proxy. That is the material risk, not the engineering.

## The two seams, separated

**Seam 1 — agents connecting *to* Metistry (inbound).** This is what
"support many more AI agents" actually needs, and it is done: every
agent, from any vendor, reaches Metistry through **one MCP endpoint**
(`POST /mcp`, per-agent bearer, 18 tools — §4.11, §4.19, PRs #51/#57/#58).
There is no per-agent connector to write; MCP is the connector. Claude
Code, Codex, Cursor, OpenCode, Amp, Droid, Pi and the rest all mount MCP
servers. What Quotio adds here is **onboarding ergonomics**: it writes
the proxy address into each tool's config so the user never edits JSON.
Artifact Server does the same (`artifactserver connect <client>`). That
is worth copying as **`metistry connect <client>`** in the CLI — one
command that mints an agent token via the management API (passkey
session), writes the MCP entry into the chosen client's config file with
a compare-and-swap journal (never clobber a foreign entry), and verifies
with a real `tools/list`. Small, and it is the whole "many agents" story.

**Seam 2 — Metistry calling *model providers* (outbound).** Plan §4.18 A
already says provider choice is instance config: "a gateway (LiteLLM-
style, Bedrock, Vertex) puts non-Anthropic models behind the same
interface." Two things sharpen now:

- **The gateway is transport, never routing.** Invariant 4 (the router is
  deterministic) is untouched by a gateway *as long as* failover and
  model selection stay declarative config (`deployment.yaml`
  `gateway:` block: base URL, key ref, model aliases per tier) and no
  gateway-side "smart routing" decides which model answers. Quotio's
  Round Robin / Fill First across *accounts of the same model* is fine;
  anything that swaps model *tiers* on its own is not.
- **Subscription pooling is a ToS question, not a feature.** CLIProxyAPI's
  distinctive ability — presenting pooled Claude Code / Codex OAuth
  sessions as an API — is exactly the arrangement §4.18 A already flags
  as economically volatile (Anthropic paused metered SDK credits on
  2026-06-15; "may return with advance notice"). Metistry's engine already
  runs on the subscription token *as Claude Code*, which is the sanctioned
  path. Putting a third-party proxy in front of that token buys nothing
  the engine lacks and adds a policy risk the project cannot underwrite
  for its users. **Not adopted; not recommended in docs.**

**Where a gateway genuinely earns its place: the hosted tier.** The
FSL-hosted plan ("we host it for you with usage limits", ux-direction
2026-09-01) needs exactly what LiteLLM-class gateways sell: virtual keys
per instance, per-key budgets and rate limits, cost attribution,
fallback across provider keys FSL holds. That is a hosting-tier
component, self-hosted by FSL, behind the same `gateway:` block — the
open-source install never needs it. Note the license split (MIT core,
commercial enterprise features such as SSO) when that decision is made.

## Quotio specifically

Not a fit as a dependency or a bundled component: it is a consumer
desktop UI for account juggling, macOS-only, with proprietary config
injection and no protocol to standardize on. Two ideas are worth
lifting: the `connect` command (above) and a **provider-quota view** —
when a user *has* configured a gateway, a `gateway-usage` collector can
read its usage endpoint into `metrics` next to `claude-usage` and
`aws-costs` so the dashboard shows subscription headroom, not just
API-equivalent cost. Both are collectors/CLI verbs, not architecture.

## Decisions recorded (plan §4.18 E)

1. Agents connect via MCP only; no per-agent adapters, ever. `metistry
   connect <client>` is the onboarding sugar (CLI, Phase 5).
2. Outbound provider access goes through an optional, declarative
   `gateway:` block; the gateway may pool accounts of one model, never
   choose tiers. Supported-by-configuration, validated only for the
   Claude-primary path (§4.18's v1 rule stands).
3. Third-party proxies that re-present subscription OAuth sessions are
   not adopted and not documented as a supported path.
4. A gateway with virtual keys and budgets is the hosted tier's metering
   layer — an FSL deployment concern, revisited with that tier.
