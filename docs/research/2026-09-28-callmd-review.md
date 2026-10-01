# call.md — a live "needs → tools → surface" loop during calls, and what Metistry takes from it (2026-09-28)

Research answering the owner's 2026-09-28 ask: during a call,
[`video-db/call.md`](https://github.com/video-db/call.md) notices that the
conversation needs something, calls an MCP server or its own knowledge, and
shows the result in near real time — a feature Metistry could replicate. Other
parts may be interesting; many will not apply.

Nothing here is built; this PR adds one document and no product code.

Sources: call.md's repository, **shallow-cloned and read locally** at
`ba53ebe` (2026-08-19, the head of `main`); its claims cite `path:line` in
*that* tree, marked `callmd:`. Stars, forks, issues and licence come from the
GitHub API and `gh` (fetched 2026-09-28). Metistry claims cite
`design-build-plan.md` sections at `origin/main` `cbe4c079`. **No latency was
measured**: running call.md needs a VideoDB account key, so every timing
below is read from the code's constants, and says so.

## 1. What it is, in five lines

1. An **Electron desktop app** (TypeScript, React, SQLite) by the VideoDB team that records a call, transcribes *you* (mic) and *them* (system audio) as two channels, and runs two LLM loops over the transcript while it records.
2. The **live loops**: "Live Assist" (things to say, questions to ask) and "MCP Findings" (tool results); after the call, a three-part summary and optional webhooks to n8n/Zapier.
3. **Cloud-dependent by construction**: capture, transcription (AssemblyAI via VideoDB by default) and every LLM call go through VideoDB's API on the user's VideoDB key; "local-first" in the README means *storage*.
4. **Licence: MIT is declared** (`package.json` `"license": "MIT"`, README badge) but there is **no `LICENSE` file**, and the GitHub API reports the licence as `null`.
5. **Maturity**: created 2026-02-25, 94 commits, last push 2026-08-19, 1,488 ★ / 167 forks, 4 issues ever (1 open: #34, silent Windows audio), no GitHub releases (installs by `curl | bash` from `artifacts.videodb.io`), `package.json` v1.0.4; nine unit-test files, **none covering the live loop**. Best read as a vendor showcase for the VideoDB API, maintained in bursts.

## 2. The real-time loop, precisely

### 2.1 Two generations, and which one runs

**v1 (2026-02-26, `41e0a94`) was per-segment and keyword-gated.** Every final
transcript segment went through `MCPAgentService.shouldTrigger`
(`callmd:src/main/services/mcp/mcp-agent.service.ts:425-444`) — a substring
match against ~45 default keywords ("docs", "customer", "book", "check",
"price", …, lines 233-261) plus user-added ones — and a match started the
agent loop (`run`, lines 270-419). A regex `IntentDetectorService`
(`callmd:src/main/services/mcp/intent-detector.service.ts`) sat beside it.

**v2 (2026-03-26, `7546c5c` "remove trigger based mcp calls") replaced it with
a timer and lets the model decide.** The commit deletes the only callers from
`sales-copilot.service.ts`; `mcp-agent.service.ts`, `intent-detector.service.ts`
and the `mcp:set-trigger-keywords` IPC handler (`callmd:src/main/ipc/mcp.ts:362-385`)
remain, reachable only by code that no longer calls them. **The loop that runs
today is `callmd:src/main/services/mcp-inference.service.ts`**, and the rest of
this section describes it.

### 2.2 The loop, stage by stage

| Stage | What happens | Where |
| --- | --- | --- |
| **Capture** | VideoDB's capture binary records mic, system audio and screen and streams them to VideoDB; one WebSocket per channel returns transcript events | `callmd:src/main/ipc/capture.ts:76-111`; engine default `assemblyai`, `rtstream-transcript.service.ts:21` |
| **Relay** | Transcript events go main → renderer; the renderer forwards **final** segments back to main over IPC (`live-assist:add-transcript`), and only while the transcript panel is `enabled` | `callmd:src/renderer/hooks/useGlobalRecorderEvents.ts:109-138`; `src/main/ipc/live-assist.ts:76-85` |
| **Buffer** | Each segment is stamped with *arrival* time and kept 60 s | `mcp-inference.service.ts:126-138` |
| **Trigger** | `setInterval` every **20 s**; no immediate run, no event trigger | lines 19, 86-102 |
| **Detection** | No classifier. The last 20 s of transcript (`[You]` / `[Them]`) goes to one chat completion with **every tool of every connected server** attached, `tool_choice: auto`; the system prompt asks for "active" and "passive" requests and says "Silence is your default. An empty response is correct." | lines 22-61, 250-305; `llm.service.ts:335` |
| **Tool selection** | The model picks. Tool names are rewritten to ≤32-char aliases (`s<server6>_<i>_<tool20>`) and mapped back | lines 143-173, 199-204 |
| **Execution** | Sequential `callTool` over the MCP SDK (stdio or HTTP); results are JSON-stringified back to the model; loop until a text answer or **3 tool calls** | lines 194-233, 304-344; `mcp-client.service.ts:313-360` |
| **Presentation** | A non-empty answer becomes one markdown card, `serverName: 'MCP Agent'`, sent to the main window. The Live Assist panel renders **only the latest** card, and only while ≥1 server is connected. The always-on-top floating widget shows say/ask cards, **not** findings | lines 347-373; `LiveAssistPanel.tsx:225-227, 396-428`; `ipc/widget.ts:155-179` |
| **Memory** | The last 10 messages of *non-empty* exchanges are replayed next tick; the prompt asks the model not to repeat fetches | lines 347-355 |

Live Assist (`live-assist.service.ts`) is the same shape — a 20 s timer, the
last 20 s of transcript, one JSON completion of 0-3 `say_this` / `ask_this`
items — with no tools.

### 2.3 Latency — read from the code, not measured

Utterance → final segment (the README: "Wait 5-10 seconds for first
transcripts") → up to **20 s** for the next tick → one completion to choose
tools → the tool → a second completion to write the card → IPC render. With a
tool involved that is two model round trips on VideoDB's `ultra` model at
`temperature 0.7`, `max_tokens 4096` (`llm.service.ts:99-103`). A realistic
floor is ~10 s and a typical case 20-40 s: **"near real time" means "within
the next half-minute"**, which is enough for a lookup the conversation will
still want and too slow for a reply to a direct question.

### 2.4 Failure handling

- LLM failure: logged, the run ends, nothing is shown (lines 307-310).
- Tool failure: `Error: <message>` goes back to the model as the tool result (lines 331-333); an unknown alias returns `Unknown tool`.
- **No timeouts** on the completion or on `callTool`, and **no in-flight guard** on the interval: a run longer than 20 s overlaps the next, and the two share `toolNameMap`, which each run clears at its start (line 154).
- `previousQueries` is written (line 219) and never read; deduplication rests on the prompt alone.
- Hitting the 3-call cap exits the `while` before the summarising completion, so a model that asks for three tools at once gets **results fetched and nothing shown** (lines 304, 323, 338).

## 3. Lessons learned

**What works.**

1. **Silence as the default, written into the output contract.** "An empty response is correct" plus "lead with the data" is the right posture for anything that speaks during a call; the v1 → v2 change shows keyword triggers produced noise and missed paraphrase.
2. **Two channels, labelled at the source.** You-vs-them is available because the audio arrives separately — no diarisation guesswork — and every prompt uses it.
3. **One small surface for findings.** A card with the data, not a chat; the owner glances, and the latest replaces the last.
4. **Settle the post-call artefacts early.** Overview, key points, action items: the same three shapes Metistry's meeting proposal group already carries.

**What is brittle.**

1. **A fixed 20 s window cuts utterances in half.** A question spanning a tick boundary is seen in two pieces, and the first half survives only if the previous tick *produced output* (history keeps non-empty exchanges only).
2. **Timer, not event.** The tick fires whether or not anything happened and waits up to 20 s when something did; there is no cheap gate before the expensive call, so every tick with speech pays for a tool-laden completion.
3. **The model sees every tool.** Tool count grows with each server; schemas are flattened (`convertInputSchema` keeps only `properties` and `required`, lines 178-189), losing nested constraints.
4. **Concurrency and caps are unguarded** (§2.4). **Arrival time, not speech time**, stamps segments, so a transcription stall shifts the window.
5. **The live loop depends on a renderer view being mounted and enabled** — the relay goes through a React hook.
6. **Vestigial code and settings.** Trigger keywords are still persisted and loaded (`ipc/mcp.ts:53-64`) and do nothing; `MCPResultsOverlay` (pin, dismiss, two visible) is exported and not mounted.

**What they got wrong.**

1. **Any tool, automatically, from anyone's speech.** Write tools are offered exactly like reads, with no confirmation, and the `[Them]` channel — a party the owner does not control — is as able to cause a call as the owner is. That is a prompt-injection path from the far side of a call into the owner's CRM. The only controls are prompt sentences ("Every tool call must tie to something said").
2. **Sensitivity is a prompt.** "Flag it as not safe to share aloud" is the whole data-handling policy, and the floating widget is always-on-top and visible on every workspace, so if the owner shares a screen, whatever it shows is shared.
3. **"Local-first" with a cloud pipeline.** Audio, transcript, screen frames and every tool result go to VideoDB's API; the README says so in its Security section, but the feature list leads with "Local-First".
4. **No consent or disclosure mechanism** for the other participants — `consent` appears only in the Google OAuth flow.

## 4. Product stance for Metistry

The loop is worth having. Metistry already owns most of its parts — on-device
transcription as it records (T8-2a, §2.15), a private tier for turns in a
capture session (T8-6), a free on-device classifier (the `mcp-apple-fm`
bridge; PoC-19 measured 497 ms for a three-field classification), a lazy
connection pair limited to reads (T4-8b), knowledge search and named queries.
What it lacks is the glue, and the glue must not be call.md's.

| Invariant / rule | call.md | Metistry: adopt · adapt · refuse |
| --- | --- | --- |
| **Enforce at the tool** (2, and the principle over all) | every tool offered, `tool_choice: auto`, prompt rules | **Refuse.** The live turn's surface is fixed in code: `knowledge_search`, `knowledge_grep`, named queries, and `connections_call` on tools whose group is `reads` and mode `on` — the T4-8b P1 set, which is already reads-only. Changes never run live; one surfaces as an `action` request and waits. |
| **Untrusted input** (8) | `[Them]` can trigger calls | **Adapt.** App audio is untrusted content, like mail. Only the owner's own channel (mic, *your side only*) or an explicit jot may *initiate* a lookup; app audio may inform one. Misuse test ships with it. |
| **One read path** (3) | n/a (SQLite in-process) | **Adopt as is.** Knowledge lookups go through `knowledge_search`/`knowledge_grep` and named queries (e.g. `calendar_event`, the meeting-note door's), never SQL. |
| **No shell, no raw git** (9) | app spawns any stdio `command` the user types | **Refuse.** Connections launch under the supervisor behind the egress allowlist (T4-8a); the live turn gets the lazy pair, nothing else. |
| **Closed console mutating surface** (10) | pin/dismiss plus webhooks | **Adapt.** Findings are read-only; hiding one is client view state, not an action. Anything the owner does with a finding goes through a door that exists: Note, To-do (the bar's own), or Approve on a later request. No new action. |
| **Swift TCC bridges** (6) | vendor binary, audio to the cloud | **Adopt Metistry's own.** `mcp-live-capture` already transcribes on the Mac as it records; the loop needs a *read* of the running session's text, never a way to start one (§2.15: no `exposes` entry starts a recording). |
| **Needs You is the one interruption channel** | a card appears unbidden | **Adapt.** A finding is not a request and is never pushed, notified or animated: it waits in the bar's Ask tail (screen 11 §4) as a static line and count, the way jots are counted. The animation list is closed (screen 11 §3.1), so nothing may pulse. Only a *proposed change* becomes a Needs You item, after or during the call. |
| **Routing bounded by rules** (4) | one cloud model, hard-coded | **Adopt.** Turns in a capture session run on `private` (T8-6); the gate runs on Apple FM at cost 0; each choice is a `runs` row. |
| **Git is the record** (1) | findings in SQLite | **Adapt.** Findings are derived and die with the session unless the owner keeps them; kept ones are cited, with connection, tool and arguments, in the draft `Journal/Meetings/<date>-<topic>.md` of the meeting proposal group (T8-7). Each call is already a `runs` row `connection_call` (T4-8b). |
| **Wording** | "sales copilot" framing | Meeting capture of this kind is most likely on the **second instance**; public text says so and nothing more. |

**Plan sections and tickets it touches.**

- **T2-11** (calendar fields, meeting note) — the event gives the live loop its context (title, attendees, series); owner-only notes must stay out of it (T2-11's own test: *notes never reach an agent*).
- **The meeting-note door** (`POST /api/meetings/:event_id/note`, §2.11) — where kept findings land when a note exists before the call.
- **#253 / T8-2a, T8-2b, T8-5, T8-6, T8-7** (the capture bar and held audio/screen) — the transcript source, the surface, the tier and the after-call group. Screen frames stay out of v1 of the loop: call.md dropped the visual-analysis card from its widget (`6c6f023`, 2026-03-31), though screen descriptions still feed Live Assist.
- **Apple FM bridge** (`packages/mcp-apple-fm`, PoC-19) — the need gate.
- **T4-8a/b, T4-9** (connections) — the live tool set is the P1 set; an `ask`-mode tool is never offered live, because Ask needs the owner's hand.
- **Routines** (§2.5) — not the live loop (a live session is not scheduled), but call.md's pre-meeting setup maps onto Next Up at T–30 (T6-1b) and the Morning Brief: a *prep* slot filled from the same lookups before the call starts.
- **§4 Q18** (SpeechTranscriber) and **§2.20** (SSE: a `finding` event carries an id, never a body).

## 5. Candidate tickets and open questions

**Tickets** (proposed; none is in the plan):

1. **LC-1 · Live transcript read** · M — `mcp-live-capture` gains read-only `session_transcript_since {session_id, after_seq}` (text, channel, speech time), assistant actor only, joins `CREW_NEVER_TOOLS`; deps T8-2a.
2. **LC-2 · The need gate** · M — each final owner-channel segment (plus 30 s of context) goes to Apple FM for `{need, kind: knowledge|connection|none, query}`; fixtures from owner-labelled real sessions only (C11); deps T8-6, `mcp-apple-fm`.
3. **LC-3 · The live lookup turn** · M — on a positive gate, one private-tier turn limited to knowledge search and P1 reads; one in flight (drop, never queue), 2 calls, 8 s deadline, dedupe by (tool, args) per session, a `runs` row each; deps T4-8b, LC-2.
4. **LC-4 · Findings in the bar** · S — static cards in the Ask tail with the source line, a count on the rail, no motion, no push; deps T8-5.
5. **LC-5 · Keep a finding** · S — kept findings are cited with provenance in the meeting proposal group's draft note; the rest expire with the session; deps T8-7.
6. **LC-6 · Misuse tests** · S — an app-audio utterance ("delete the Acme deal") causes no call; no `changes` or `ask` tool is ever in the live list; the turn is refused off the private tier.

**Open questions for the owner.**

1. **Does a live lookup leave the Mac?** While recording, the bar says *staying on this Mac*. A `connections_call` to a remote MCP server sends a query derived from the private transcript off-machine. Allow it (reads, `on`, with the query shown), restrict live lookups to local knowledge and local connections, or make it a per-connection switch?
2. **Who may initiate a lookup?** The proposal above lets only the owner's channel initiate. Is that right, or should the other side's questions ("what did we agree last quarter?") also trigger — with the finding shown to the owner only?
3. **Where do findings live, and do they survive?** The Ask tail during the call and a cited section of the meeting note after — or a separate *Found during the call* list, kept 30 days with the transcript (C91)? And, given screen sharing: should the findings panel exclude itself from capture, which the Glass review treated as a trust smell when used to hide the app?

## Sources

- call.md repository, `main` at `ba53ebe`: <https://github.com/video-db/call.md> (README, `src/`, `tasks/todo.md`, commit history).
- The v1 → v2 change: <https://github.com/video-db/call.md/commit/7546c5c>.
- Issues: <https://github.com/video-db/call.md/issues> (#25, #27, #29, #34).
- VideoDB's page for it: <https://docs.videodb.io/examples-and-tutorials/ai-copilots/call-md>.
- GitHub API, `repos/video-db/call.md` (stars, forks, licence `null`, dates), fetched 2026-09-28.
- Metistry: `docs/product/design-build-plan.md` §2.5, §2.6, §2.11, §2.12, §2.15, §2.20, T2-11, T4-8a/b, T6-1b, T8-*; `docs/product/design/screen-11-capture-bar.md`; `docs/research/2026-09-21-live-capture-bar.md`; `docs/research/2026-09-21-intent-classification-tier.md`; PoC-19 in `docs/product/PRODUCT.md`.
