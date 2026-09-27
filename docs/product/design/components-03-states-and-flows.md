# Components 03 — States and flows

New, 2026-09-25. Boards: `States-Screens`, `States-Settings`, `Flows`. Rulings
C135–C138. Closes review 01 §3.2 and §3.3 (R2.4–R2.6).

## 1. First paint (C135)

- Show what Metistry last had, at once. Past the screen's age limit, a **stale
  band** says when it is from (*Showing the board as of 9:14*).
- **Placeholder rows only on the very first load** of a screen.
- A wait over one second says what it waits for, with a count or progress when
  known. Never a bare spinner.

## 2. Per screen

| Screen | Empty | First load / waiting | Stale | Failed |
| --- | --- | --- | --- | --- |
| Board | *Nothing on the board* · Capture a Task | placeholder rows | band + last board | move reverts, *Try Again* |
| Card detail | moved elsewhere: *Done, by collator* · Open in Done | — | — | save fails, edit kept, *Try Again* |
| Projects | *No projects yet* · New Project | — | *Spend as of 40 minutes ago* · Sync Now | — |
| Artifacts | *No artifacts yet* | *Opening vendor-summary · v3 · 2.1 MB* | — | a version unreadable · Show v2 |
| Knowledge | no match: *Nothing matches "zebra"* | *Reading your vault · 312 of 1,240* | — | vault not found · Choose Folder |
| Run detail | transcript expired after 30 days; summary and cost remain | — | — | — |
| Usage | *Nothing spent this month* | — | — | — |
| Chat | *Ask Metis anything* | *Metis is reading 4 notes…* | — | *Not sent · Retry*, message kept |
| Compute | no models match; a silent provider named | download progress, size and time, Cancel; *Loading into memory…* | a provider's list *from yesterday* | *Not answering* · Retry; *Key rejected* · Replace Key; not enough disk or memory, said before Install |
| Scheduled | only the defaults · New Routine | a routine not run yet · first run time · Run Now | — | a sync failing 3 times stops and raises one request |
| Connections | — | — | — | Test failed with the status and cause · Replace Key |
| Services | — | Doctor *Checking 9 of 16* | — | all healthy says so |
| Instance | — | — | a linked instance *Not seen for 3 days* · Check Now · Remove | — |
| Updates | — | — | — | failed update rolled back, *nothing was lost* · View Log |

*Note (W2 housekeeping):* Projects' and Usage's spend comes from `GET /api/compute`; the ceiling it is read against is a **spending limit** (C130), and **Raise** opens Settings › Compute › Spending limits (§5).

## 3. Undo or confirm (C136)

Reversible → act at once, **Undo** for ten seconds: Decline All; Keep Mine /
Take the Fold's; moves. **Esc in the agent editor keeps a draft** (*Draft of
collator kept · Open*).

Irreversible → confirm, naming the cost: **Purge Now** (the unfolded sessions;
*Fold First*), **Sign Out Everywhere** (the devices), **Delete a secret in use**
(what stops).

## 4. Recording through a working day (C137)

| Moment | What it says |
| --- | --- |
| Before | the record sheet shows *About 150 MB an hour · 212 GB free* |
| No screen permission | *Metistry can't see your screen yet* · Open System Settings · Audio Only |
| Every 2 hours | *Still recording · 2 hours* · Stop Recording · Keep Going |
| Window closed | audio continues; the screen part stopped at a time |
| Mac slept | paused; resumed; the gap is marked in the transcript |
| Disk low | warning at 10 GB free; stops at 5 GB |
| 10 hours | stops; everything is saved and folding · Record Again |
| Crash | saved up to the crash; one report in Needs You · Record Again |

Developer budget: ~150 MB/hour (compressed audio; screen as changed frames);
transcript streamed; media deleted after the fold reads it; transcripts kept 30
days (C91).

## 5. No dead ends (C138)

**New Agent** → a local agent · connect an agent (A2A/ACP) · a tool that works
for you. **Run Now** with nothing to run is dimmed with its reason. **Raise**
opens Settings › Compute › Spending limits.
