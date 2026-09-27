# Components 02 — Keyboard and VoiceOver

New, 2026-09-25. Boards: `Keyboard`, `VoiceOver`. Rulings C119–C122. This file is
the one map; each screen spec's keyboard section defers to it.

## 1. The Mac's shortcuts (C119)

No keyboard layer on the PWA. On the Mac, every shortcut is a menu item.

| Menu | Items |
| --- | --- |
| Go | Needs You ⌘0 (while shown) · Today ⌘1 · Chat ⌘2 · Activity ⌘3 · Work ⌘4 · Knowledge ⌘5 · Agents ⌘6 · Scheduled ⌘7 · Back ⌘[ · Forward ⌘] · Command Palette ⌘K · Filter ⌘F |
| Capture | New Capture ⌘N · Ask Metis · Note · To-do · Start Recording · Stop Recording (the any-app five, §2) · Hide Capture Bar · Shortcuts in Any App… |
| Item | follows the selection: Open ↩ · Open in Obsidian ⌘O · Approve A · Revise R · Decline D · Later L · Complete Space · Move… M · Hand to an Agent… ⇧⌘P · Run Now ⌘R · Pause ⌥⌘P — items that don't apply are dimmed |
| View | Today / All ⌥⌘T · Show Sidebar ⌃⌘S |
| Help | Keyboard Shortcuts ⌘/ |

**Per screen**

| Screen | Keys |
| --- | --- |
| Any list | ↑ ↓ move · ↩ open · Space select · ⌘A select all · M move to… |
| Needs You | A R D approve, revise, decline · L later · 1–9 pick an answer · ⌘↩ send answers |
| Today | Space complete · ⌘Z undo · ⌥⌘T Today / All · ⇧⌘P hand to an agent · ⌘C copy standup |
| Chat | ⌘↩ send · ↑ edit last message · ⇧⌘N new conversation (was ⌘R) |
| Activity | ⌘R take pending rows |
| Scheduled | ⌘R Run Now / Sync Now · ⌥⌘P Pause |
| Agents | ⌘S save definition · ⌘⌫ revoke, confirmed |
| Board | ← → between columns · M move |
| Knowledge, Projects, Artifacts, Run detail | the list keys and ⌘O |
| Settings, Connections, Secrets, Variables, Usage | the list keys; Tab through fields |

Retired: ⌘9 (the panel, C109). Single-letter keys act only while a list has
focus, never in a text field.

## 2. Shortcuts in any app (C120)

Settings › **Keyboard** › **Shortcuts in any app**, **off by default** (C127 moved it from Live Capture).

| Action | Suggested |
| --- | --- |
| Ask Metis | ⌃⌥⌘A |
| Note | ⌃⌥⌘N |
| To-do | ⌃⌥⌘T |
| Start Recording | ⌃⌥⌘R |
| Stop Recording | ⌃⌥⌘S |

Each row is a recorder: *Record Shortcut* · *Press a shortcut…* · the keys with ×.
Checked with macOS when set:

- **Taken** — another app holds it; failed ink, *Another app already uses this.
  Pick another.*
- **System** — macOS uses it; warning, *macOS uses this to …*
- Nothing is registered until every row is clear. Off means nothing is
  registered at all.

The bar's tooltip shows a shortcut only when it is on. Stop Recording is
dimmed in the Capture menu while nothing is recording.

## 3. What VoiceOver says (C121)

Rules:

- A glyph-only control speaks its name, and its shortcut when one is set.
- A mark that carries meaning (failed, stale, ok, paused) speaks it in words as
  part of its row's label — never alone, never colour only.
- A chart speaks one sentence and offers its table in the rotor.
- The one badge announces a change once, and not while the owner is on it.
- Landmarks: sidebar, list, detail; the capture bar is its own window. Each
  section of a detail is a heading.
- References speak their kind: *Secret, github_read*; a variable speaks its
  value.

| Element | Says | Is a |
| --- | --- | --- |
| Capture bar | Metistry capture bar | group |
| Ask · Note · To-do | Ask Metis · Note, Control-Option-Command-N · To-do | button |
| Record · Stop | Start recording. Screen and microphone · Stop recording | button |
| Recording | Recording, 4 minutes. Screen and microphone | status, once |
| Needs You row | Needs You, 10 waiting | button, selected |
| Question | Question 1 of 3. Where should the Connections table live? | heading |
| An answer | Its own file, SettingsConnections.swift. 1 of 3 | radio button |
| Send Answers | Send answers, dimmed. 1 question unanswered | button |
| Usage gauge | Usage, $1.84 today, 37% of the day's budget | button |
| A task | Send Jim the revised Q4 scope. Priority 2, 30 minutes, third day | checkbox |
| Ticked | Sign the SOW, done. Written to today's note. Undo available | checkbox, checked |
| The week | This week: 39 runs, all by 7 AM or after 6 PM. Show as table | image + table |
| A routine | 6:00 AM, Standup, default, run by Metis, working days at 6 AM. Succeeded | row |
| On · Ask · Off | create_session. Ask, 2 of 3 | radio group |
| Offer switch | Offer to agents through Metistry, on | switch |

*Note (W2 housekeeping):* the Usage gauge speaks C130's word — *37% of the day's spending limit*, not *budget* — and the per-tool row speaks the ruled **Allow · Ask First · Never**, not *On · Ask · Off*.

## 4. Motion, text and focus (C122)

- **Reduce Motion:** stepped questions cross-fade; the Needs You row appears
  without sliding; the recording mark stops breathing and holds its tint.
- **Larger text:** checked at the largest size macOS offers. Panes grow longer,
  never wider (screen 15).
- **Focus:** with Full Keyboard Access, the accent ring (3px, accent at 50%) on
  the focused row, button, segment or chip.
