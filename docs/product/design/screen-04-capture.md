# Screen 4 — Capture

Round D, fourth. **Not a screen**: a floating "+" and the composer it opens.
Board: `Capture`.

§3.8 is emphatic and right — *there is no Capture tab and no Capture screen
anywhere*. A place you navigate to contradicts a five-second promise.

## 1. Where the "+" lives

One affordance, one position per platform.

| Platform | The control | Opens as |
| --- | --- | --- |
| macOS | the toolbar **+** and the sidebar footer **+** — the same control twice, in the two places a pointer already rests — plus `⌘N` and the global hotkey | a popover, or a panel for the hotkey |
| iOS | one floating **+** bottom-right, over the content, clear of the tab bar and the home indicator | a medium-detent sheet |
| PWA | the header **+** | the same composer inline |

The share extension, the drop target, the Shortcut and the menu-bar item are
**additional doors to this control**, not alternatives to it.

## 2. Anatomy

A multiline field (autogrowing from three lines, placeholder `note…`
lowercase — it is a prompt, not a label), an attachment row, `⌘↩`, and one
primary **Capture** button. Below: the receipt.

**No title field.** A capture is a thought, not a document. Nothing validates,
nothing suggests, nothing completes — the model is not in this loop.

**The attachment is a named chip** with its size and a remove, never a raw file
input. What you attached has to be legible before you send it.

## 3. The promise, and how it is kept honestly

**The popover does not wait for 201.** Press `⌘↩` and the field clears, the
receipt reads *capturing… you can close this*, and closing the popover cancels
nothing. That is what makes the promise five seconds rather than however long
the instance takes.

**But clearing the field is not a claim that it worked.** P5 says state is
reported, never inferred, and an optimistic clear infers success. So the text
does not vanish — it moves into the pending receipt and lives there until the
server answers. On failure it comes **back into the field**, with the reason
and a Retry. Nothing is ever typed twice.

**Offline is a state, not an error** — a `degraded` chip carrying §3.8's own
words: "queued — will send when the instance is reachable". What makes that
safe is on the wire, not in the design system: §6 fault 2.

## 4. States

| State | Rendering |
| --- | --- |
| empty | placeholder `note…` |
| typing | autogrown; no affordance appears that was not there before |
| attaching | the file chip, name and size, removable |
| sending | field cleared, receipt pending, **popover closable** |
| captured | `captured → inbox #418 · Inbox/2026-09-20-note.md` — the id and the path, because those are what came back |
| queued-offline | the `degraded` chip, holding its idempotency key |
| failed | the reason in the server's words, the text back in the field, the attachment still attached, Retry reusing the same key |

## 5. Keyboard

`⌘N` (and the global hotkey) opens it · `⌘↩` captures · `⌘⇧A` attaches ·
`esc` closes **keeping the draft** — a capture composer that discards on escape
is a capture composer you stop trusting. The draft survives until it is sent.

## 6. What this round found

1. **§3.8 specifies a receipt the endpoint cannot produce.** It reads
   "captured → inbox #418 · classified `note` on-device". `POST /capture`
   returns **201 `{id, path, sha256}`** and nothing else — classification
   happens later, in the `*/5` drain. And §3.8's own **Never** forbids waiting
   for it. The two halves of one paragraph contradict each other. Drawn as the
   id and the vault path, which is what came back; the classification arrives
   on Activity as its own row, which is what ADOPT 1 built the timeline for.
   (C23)
2. **The thing that makes "never drops" safe is not in the design system.**
   `POST /capture` honours `Idempotency-Key`, scoped to the credential class,
   and a replay returns **the original response** — same id — with
   `idempotency-replayed: true`. That is exactly what lets an offline queue
   retry without "never drops" quietly becoming "sometimes captures twice". So
   the composer **mints a key when you press Capture and keeps it across every
   retry**, and a replay renders as the same success with the same id, because
   from your side it is the same capture. Nothing in §3.8 mentions any of it.
   (C24)
3. **Your own captures are indistinguishable from any HTTP caller.**
   `POST /capture` hardcodes `source: "http"`, and the vocabulary — `imessage |
   share | http | obsidian | cli` — has no value for *the app itself*. A note
   typed in this popover appears on Activity as `http · new`, beside anything
   else that spoke HTTP. Either the vocabulary gains a value the apps send, or
   Activity stops showing it. I would add the value. (C25)
4. **`inbox.status` has five values and two are ever seen.** `new | classified
   | accepted | rejected | archived`. The last three have no rendering anywhere
   and no screen that owns them — they belong to a triage surface that does not
   exist yet. Recorded before Knowledge is drawn, because that is where it will
   surface.
5. **"The last capture's receipt" does not survive a fast hand.** Two `⌘↩`s in
   three seconds means two in flight, and one line cannot report both. The
   rule: the line shows the **oldest unresolved** capture and a second pending
   one appends a count — *capturing… (2)* — collapsing back to a single receipt
   as they land. A failure always wins the line, because it is the only one
   that needs you.

## 7. Data sources

| Piece | Source |
| --- | --- |
| the capture | `POST /capture` — JSON `{note, filename, content_base64}` or raw bytes with `x-metistry-filename` |
| the receipt | the 201 body: `id`, `path`, `sha256` |
| retry safety | `Idempotency-Key` on the request; `idempotency-replayed` on the response |
| offline queue | client-side, holding the request and its key |
| what the classifier decided | **not here** — Activity, later, as a `capture` row whose detail carries `status` |
| a text-only capture's filename | the server's `note-<ts>.md` default |

## 8. Open items

- A source value for the apps themselves (fault 3) is a one-word vocabulary
  change with a migration behind it; worth doing before Knowledge.
- Whether the offline queue is visible anywhere other than the receipt line. My
  answer is Settings → Status, not a badge — an unsent capture is not a
  decision waiting on you, and P2 keeps the only badge for those.
- The drop target on the macOS window is specified in §3.8 and not drawn here;
  it has no states of its own beyond the attaching state, but it does need a
  drawn hover.
