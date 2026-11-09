# Atomic Chat — a local-model chat client, and what Metistry's Chat takes from it (2026-09-28)

Research answering the owner's 2026-09-28 ask: a competitive UI/UX review of
[atomic.chat](https://atomic.chat/), an open-weight model chat app, for
Metistry's Chat (T6-2, screen 1) and the PWA's Chat (screen 18 §3).

Nothing here is built; this PR adds one document and no product code.

Sources: Atomic Chat's repository, **shallow-cloned and read locally** at
`e417ac1` (2026-09-21, tag `v2.0.44`, head of `main`); its claims cite paths in
*that* tree, marked `ac:`. Its `docs/decisions/` is an append-only ADR log (305
records, 2026-05-19 → 2026-09-21), and most "why" below is read from it. Stars,
forks, issues, releases and licence come from the GitHub API (fetched
2026-09-28). **The app was not installed or run**: every screen is described
from source and ADRs, not from use. Metistry claims cite `screen-01-chat.md`,
`docs/ops/mac-app.md` § Chat and `design-build-plan.md` at `origin/main` `eb5858e4`.

## 1. What it is, in five lines

1. A **Tauri + React desktop and mobile app** (macOS, Windows, Linux, iOS, Android) that downloads open-weight models from Hugging Face and chats with them locally; cloud keys (OpenAI, Anthropic, Mistral, Groq and others) sit beside local models, switchable per chat.
2. **Three engines behind one OpenAI-compatible server on `127.0.0.1:1337`**: its own llama.cpp fork (TurboQuant KV cache), upstream `ggml-org/llama.cpp`, and MLX-VLM on Apple Silicon, plus an Apple Foundation Models sidecar (`ac:AGENTS.md` §2–3). Other agents (OpenCode, Goose, Cline, Kilo Code…) are pointed at that server, and a Launch page installs and configures them.
3. **A hard fork of [Jan](https://github.com/janhq/jan)** by Menlo Research; much of the tree still carries `jan*` / `@janhq/*` names, and the ADR of 2026-05-19 sets the product identity.
4. **Licence: Apache-2.0** (`ac:LICENSE`, copyright Atomic Chat 2026 and Menlo Research 2025); the GitHub API reports `NOASSERTION` because the file carries a preamble before the licence text.
5. **Maturity**: repo created 2026-03-31, 1,640 ★ / 194 forks, 60 open issues (≈322 ever), 30 releases (v2.0.44 on 2026-09-21, a release every few days), 8,637 commits including Jan's history. Actively maintained by a small team, with visible same-week reversals in UI decisions (§4).

## 2. The interface, screen by screen

### 2.1 Shell and sidebar

- **A left sidebar with a Chat / Agent switch at the top**; each mode has its own history, search and bulk delete, and Projects and Integrations appear only under Chat (ADR 2026-07-21, `ac:web-app/src/components/left-sidebar/`). Threads can be renamed from a row menu (`ac:web-app/src/containers/ThreadList.tsx`); projects show their threads as a tree.
- **Routes** (`ac:web-app/src/routes/`): threads, projects, Hub (model catalogue), Cloud (providers), Connectors (MCP), Skills, Launch, Images, System Monitor, Logs, Local API Server, and 19 Settings pages.
- **Six global shortcuts**, one map (`ac:web-app/src/lib/shortcuts/const.ts:12-33`): ⌘B sidebar, ⌘N new chat, ⌘M new agent chat, ⌘P new project, ⌘, settings, ⌘K search. Settings ▸ Shortcuts lists them.

### 2.2 The thread

- **Scrolling** is the `use-stick-to-bottom` library with `initial="smooth"` and `resize="instant"` (`ac:web-app/src/components/ai-elements/conversation.tsx:10-20`): the view follows new content while the reader is at the end and stops once they scroll up. An icon-only ↓ button appears whenever the view is not at the end (lines 94-120); it does not say that anything arrived.
- **A reply** renders streamed markdown (Streamdown, with code, math, Mermaid and CJK plugins), then an action row: copy, regenerate, token speed and count; a user turn has copy, a pencil and delete (`ac:web-app/src/containers/MessageItem.tsx:473-571`).
- **Edit is inline** where the message sits, Enter saves and Escape cancels; saving a user message **deletes every later message** and re-runs the model (ADR 2026-08-21).
- **Reasoning** is its own block above the answer, held to a fixed six-line viewport while it streams so token growth cannot move the conversation; only its last 4,000 characters render live, as plain text (ADRs 2026-09-04, 2026-09-17).
- **Reasoning shown is a property of the message, not of the effort setting**: moving the effort slider once re-rendered old answers and snapped the reader to the bottom, so the render side stopped reading the setting (ADR 2026-09-16).
- **Token speed** (`ac:web-app/src/containers/TokenSpeedIndicator.tsx`) is live while streaming and persisted after; where the provider reports no decode timing, no speed is shown rather than estimated (ADR 2026-09-04).
- **A context gauge** sits top-right in the page header on a running thread (`HeaderContextSize.tsx`).

### 2.3 The composer

Left to right (`ac:web-app/src/containers/ChatInput.tsx`, 3,625 lines):
attachments, the approval-mode select (Agent threads), the plugins (connectors)
menu, the reasoning bulb, then one **model pill** beside the microphone and
Send. The pill names the model and, while thinking is on, its effort; its panel
opens on the model row with an effort slider, and a row leads to the searchable
list (ADR 2026-09-11). The header no longer carries a model picker.

- **Send with no model selected is resolved, not refused**: last used model, else a connected cloud provider, else the only local model, else the lightest local one by the parameter count in its name; the typed message is held with *Starting …* in the composer and sent when the model answers (ADR 2026-09-09). Only when nothing can be decided does a widget open, and Send stays clickable because pressing it is how the widget is reached (ADR 2026-09-07).
- **Stop** cancels the stream and any running tool call (`ChatInput.tsx:1424-1434`); stopping a *model* is recorded so the composer's auto-start does not undo it (ADR 2026-09-11).
- **The plugins menu** names each connector by a two-to-three-word tagline, shows *k of N tools* when some are off, and holds each connector's measured schema cost in its tooltip, flagged heavy above 10 % of the context window; the composer hints past 25 % (ADRs 2026-09-02, 2026-09-16).

### 2.4 Tool calls and approvals

- **One line per call** inside the reply, no *Called N tools* header: family icon, label, the call's main argument (query, path, hostname, or first text argument), and on the right how it ended — the error's first line, *Denied*, or result count (ADR 2026-09-15). Two days later the label became a localized human action ("Read notes.md") with the real tool id kept inside the disclosure (ADR 2026-09-17, `ac:web-app/src/lib/tools/activity-label.ts`).
- **Approval mode per thread**: *Ask for approval* (default) or *Full access*; Full access is marked by icon and words, not colour, and **confirmed every time** it is picked, with no *don't ask again* (ADRs 2026-09-15, 2026-09-16).
- **Per-call approval** docks above the composer's border, overlaying the transcript's bottom rather than pushing it (ADR 2026-09-17): *Approve once*, *Always allow this action*, *Deny*. "Always" stores a SHA-256 of tool name plus canonical arguments, globally, with no revocation UI yet (ADR 2026-07-23). **⌘↩ approves from anywhere**, including the composer; there is deliberately no Escape-to-deny (`ac:web-app/src/containers/AgentApprovalInline.tsx:55-68`).

### 2.5 Models: onboarding, Hub, load state

- **Onboarding recommends by hardware tier**, each row carrying a fit badge with a word — Good fit, Might fit, Won't fit — never colour alone (`ModelFitIndicator.tsx:10-20`), and warns before a download that will not fit in memory. It times out into the chat rather than trapping the user (ADRs 2026-08-07, 2026-09-16, 2026-09-17).
- **No model is preloaded at launch**; the send is the intent that pays for the load. The model dot reports engine state — running, starting, failed, not running — and a load reports its stage (installing engine, loading weights with how much is already in page cache, starting server) and can be cancelled (ADRs 2026-09-11, 2026-09-15).

### 2.6 Settings, connectors, network

- Settings is a routed page with a left list: General, Interface (font size Medium…Extra Large, accent colour), Assistant (per-assistant persona and sampling), Providers, Hardware, MCP Servers, Local API Server, Remote & LAN, HTTPS Proxy, Privacy, Shortcuts, Voice, Media and more.
- **Remote & LAN** exposes the local API server on the LAN or through a Cloudflare quick tunnel; **the API key stays optional** by product decision (ADR 2026-09-17-expose-…, item 7).
- **Privacy**: the site says "0 bytes of your data ever leaves your device"; the product-analytics store defaults to `true` (`ac:web-app/src/hooks/useAnalytic.ts:64`, PostHog, with Sentry gated on the same flag per ADR 2026-06-09) and can be switched off in Settings ▸ Privacy.

## 3. UI/UX ideas for Metistry's Chat

**Take.**

| Idea | Theirs | Why it beats ours today | Cost |
| --- | --- | --- | --- |
| **A Stop that works and holds** | cancels stream and tool call; a stopped model stays stopped | ours is drawn and off because no route cancels a turn (mac-app § Chat, C138); a long tool loop has no exit but waiting | M: a cancel route (a new closed-set action, invariant 10) plus the drain honouring it; Chat already draws Stop |
| **The wait names its stage** | *installing engine · loading weights (cached) · starting server*, each reported by the component doing it | our 60 s line can only say *nothing back for 62s*; with a stage on the wire it could say *starting the local model* or *waiting on the provider* — still reported, never inferred | M: a `stage` in `turn_progress` from the drain; client prints it |
| **Main argument on each strip line** | icon · name · query/path · outcome with the error's first line | our expanded line is glyph · tool · duration · outcome; the argument is one click deeper, so a surprising call needs opening to diagnose | S: `turn_progress` already carries arguments; take the first of query/path/url, redacted by `core` |
| **Reserved geometry for async states** | loading, cancel and done share one action slot; reasoning keeps a fixed viewport; approvals overlay, never push | our dots → strip → reply and *Not sent* → sent swap in-flow; at the end of the transcript a height change is a small P9 violation | S: fix the slot heights in `chat-view.swift` |
| **A setting never reflows the transcript** | ADR 2026-09-16: render reads the message, not the setting | our tier chip is a setting beside stored turns; nothing yet tests that pinning a tier leaves drawn turns untouched | S: one P9 test |
| **Measured layout tests** | `make test-layout`: headless measurement, `expectOneLine`, `expectSameWidth`, at Medium and Extra Large (`ac:docs/ui-layout-rules.md`) | T6-2's tests check scroll position and Reduce Motion, not geometry; §6.1's contrast faults show what unmeasured pairs cost | M: a measuring harness for SwiftUI views at default and largest text |

**Confirmations** (they arrived where we already are): model and effort in the
composer, not the header — which settles a drift in our own spec, where
screen-01 §3 item 1 still lists the control in the toolbar and §3c puts it in
the composer; state marked by icon and words, not colour (screen-01 §6.1); no
number shown the wire does not report (the token-speed ADR is our *never
inferred* rule).

**Refuse.**

1. **Edit that truncates.** Rewriting a sent turn and deleting what followed makes the transcript a draft; ours is a record (invariant 1). ↑ brings back the last turn as a *new* send, which stays.
2. **Delete per message and regenerate in place.** Same reason; a better answer is a new turn, and a rating (P8) says the old one was bad.
3. **A global ⌘↩ that approves.** It is our Send (screen-01 §6); one chord meaning two acts depending on what is on screen is a misfire. Approvals stay explicit acts on a card (A R D while a list has focus, C119).
4. **Per-thread Full access.** A switch beside the composer that turns off approval for everything bypasses the owner's per-tool policy (§5).
5. **Auto-follow while streaming, and an unlabeled ↓.** P9's pill announces and moves nothing; keep it.
6. **Friendly labels in place of tool names.** Their 48-hour reversal shows the trade; our strip is an audit surface, so the mono name stays primary and the human phrase goes to VoiceOver.
7. **Personas, emoji avatars, accent pickers.** The name comes from `identity.yaml`; colour is tokens.

## 4. Other lessons

- **Model handling.** *Resolve on send, hold the message, never preload* is the right shape for a local model; for Metistry it belongs to the router (invariant 4), which already picks — the lesson is to *say* in the waiting line when a turn is paying for a cold local load.
- **One OpenAI-compatible facade over several engines** is the shape compute.yaml already assumes (ruled 2026-09-11). Atomic Chat, LM Studio and Ollama each serve one on loopback, so any of them can back a `private` tier with no new code — a doctor `check()` and a preset are all it would take (Q3).
- **Performance.** Their measured trap: re-parsing a growing markdown stream costs 3 ms per delta at 2k characters and 549 ms at 80k, superlinear, until the app stops responding (ADR 2026-09-04). When prose streaming arrives after v1 (§2.20), the SwiftUI view needs the same rule from day one: render a bounded tail as plain text, parse once at the end, coalesce scroll to one frame. Their sidebar also paid one history fetch per row until fixed (ADR 2026-08-07) — our 30-message transcript and its per-turn `GET /api/runs/:id` joins deserve the same count.
- **Tool schemas cost context.** One-word *yo* became a 19,908-token request because every connector's tools rode along (ADR 2026-09-02). Metistry's lazy connection pair (T4-8b) already avoids that; showing each connection's measured cost in Settings ▸ Connections would make the saving visible.
- **Settings design.** They split, then reverted, a providers rework within a day (ADRs 2026-08-12, 2026-08-13), and replaced advanced model knobs with one context control (ADR 2026-07-27). Fewer, fixed panes (screen 15) hold up.
- **Onboarding.** Their own numbers: devices that got a model running on day one activated at 92.1 % against 24.7 % for those that did not (ADR 2026-09-07). Step 7 (choosing compute) is our equivalent moment; a fit word on a local model is cheap there.
- **Hardcoded names drift.** Their English locale still says *Atomic Bot* under a `jan` key (`ac:web-app/src/locales/en/common.json:96,281`) — three names for one product, the failure our naming rule exists to prevent.
- **The ADR log** is our C-numbers under another name, with supersede links; its value showed in this review, where every *why* had a record.

## 5. Product stance for Metistry

| Rule | Atomic Chat | Metistry: adopt · adapt · refuse |
| --- | --- | --- |
| **Closed menu (C119)** — every shortcut a menu item; the PWA adds none | six window-level shortcuts plus a ⌘↩ bound on `window` while an approval shows | **Adapt.** Anything taken (Stop) is a menu item with its key; nothing binds on the window. |
| **Needs You is the one interruption channel** | approvals dock over the composer; snackbars for loads and updates | **Adapt.** A request raised in Chat stays one row drawn twice — the prompt card in the turn and its Needs You card (mac-app § Chat). No snackbars, toasts or corner banners. |
| **No assistant name hardcoded** | custom assistants with names; a stale product name in strings | **Refuse** personas; the name arrives from the shell (chat-model.swift header). |
| **Allow · Ask First · Never** (C93 words: On · Ask · Off), default Ask | per thread: Ask / Full access; per call: once / always (exact args) / deny | **Refuse** the thread-wide bypass: policy is the owner's, per tool, in Settings. The exact-call *always* is Q1. |
| **Invariant 8** — authenticate as if internet-exposed | LAN and public tunnel with an optional key | **Refuse.** The console authenticates every request; remote access goes through an authenticated gateway, never an open tunnel. |
| **Tool strip joined exactly** | calls stored inside the message's parts, so joined by construction | **Adapt.** X-18 (`turn_id` on `GET /api/messages`) gives old replies their strips; their design is the evidence it is worth doing. |
| **P9** — the transcript never moves under the reader | follows while at the end; one ADR records a setting change snapping the reader away | **Keep ours**, and add the reserved-slot and setting tests (§3). |
| **Invariant 4** — routing bounded and audited | *lightest by the size in its name* chosen silently | **Refuse** an unrecorded heuristic; every choice stays a `runs` row. |
| **Second-instance wording** | n/a | Nothing here needs it; any public text on another machine's use says *second instance* and nothing more. |

**Plan sections and tickets it touches.** **T6-2** (Chat: Stop, the waiting
line, the strip, geometry tests); **X-18** (`turn_id`); **T7-x** — screen 18 §3's
Chat at 358pt inherits every rule here, and T7-7's live events carry any `stage`;
**T5-6** (Usage: *Where it went* already ranks chat by spend — token speed is
**not** a Usage fact and stays out); **T4-8b** (connection cost); screen-01
§3, §5.1 and §9.4; screen 15 (Compute, Connections); §2.20 (streaming).

## 6. Candidate tickets and open questions

**Tickets** (proposed; none is in the plan):

1. **CH-1 · Cancel a turn** · M — `POST /api/turns/:id/cancel`, one new closed-set console action, audited; the drain stops between calls; Chat's Stop goes live as a menu item (⌘., the macOS convention, if unbound); misuse test: cancelling a finished turn is a 409.
2. **CH-2 · The wait names its stage** · M — `turn_progress` gains `stage` (queued · loading model · calling provider · tool) written by the drain; the waiting and 60 s lines print it; deps T6-2.
3. **CH-3 · The strip line carries its argument** · S — expanded strip lines show the main argument (query, path, url, else first text argument, redacted) and a failure's first line; VoiceOver speaks a plain phrase.
4. **CH-4 · Chat geometry tests** · M — at default and largest text: column width constant across resize, one-line collapsed strip, dots / strip / *Not sent* share one slot, pinning a tier re-renders no stored turn.
5. **CH-5 · Connection context cost** · S — Settings ▸ Connections shows each connection's tool-schema tokens from `tools/list`, flagged above 10 % of the smallest tier's window.

**Open questions for the owner.**

1. **Should Ask offer *allow this exact call from now on*?** Atomic stores a hash of tool plus arguments and never asks again for that exact call. It is narrower than switching a tool to On, but it is a standing rule made from a prompt — kept in the instance and revocable in Connections, or refused?
2. **Is prose streaming still out of v1 for both Chat surfaces?** Their render-cost measurements say it is a real engineering cost; if it stays out, CH-2's stage line is the substitute for liveness.
3. **Should a local OpenAI-compatible app (Atomic Chat, LM Studio, Ollama) be a named compute.yaml preset for the `private` tier**, with a doctor `check()` — or stay a hand-written provider entry the owner adds?

## Sources

- Atomic Chat site: <https://atomic.chat/>.
- Repository, `main` at `e417ac1` (v2.0.44): <https://github.com/AtomicBot-ai/Atomic-Chat> — `README.md`, `AGENTS.md`, `LICENSE`, `docs/ui-layout-rules.md`, `docs/decisions/` (ADRs cited by date), `web-app/src/`.
- GitHub API, `repos/AtomicBot-ai/Atomic-Chat` (stars, forks, issues, releases, licence), fetched 2026-09-28.
- Upstream: Jan by Menlo Research, <https://github.com/janhq/jan>.
- Third-party overview: <https://www.promptquorum.com/power-local-llm/atomic-chat-review> (not relied on for any claim).
- Metistry: `docs/product/design/screen-01-chat.md`, `screen-15-settings.md`, `screen-17-usage.md`, `screen-18-pwa.md`, `DEVELOPER-HANDOFF.md` (C93, C119); `docs/ops/mac-app.md` § Chat; `apps/macos/sources/kit/chat-view.swift`, `chat-model.swift` (headers); `docs/product/design-build-plan.md` T5-6, T6-2, T7-x, X-18, §2.18, §2.20.
