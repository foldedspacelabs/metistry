"""Board: Routines — the scheduled compute, and what runs it.

Screen 8, refined 2026-09-22 from owner feedback: ordered by what runs next
rather than grouped by cadence, a renamable name, the agent as a link, a
graphical summary, and the terminology settled — Knowledge, Schedule,
Recurrence, Outputs, History. "Silent" is gone.
"""
from lib import *

CW,CH=2560,3060

def win(T,inner):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Routines")}{inner}</div></div>')

GRIDP=pan(L,"THE WEEK, SO THE SHAPE OF IT IS VISIBLE",
  schedgrid(L)
  + nt(L,"Occurrences are not magnitudes, so this is not a chart with a value axis — it is a tick per run on a "
        "week-by-hour grid, which is the form that answers <i>how are these laid out</i>. What it shows at a "
        "glance is the thing a list cannot: <b>everything the owner configured runs in the same hour</b>.",14)
  + nt(L,"<b>One hue, two weights.</b> Filled is run by your agent, outlined is built-in. It was going to be two "
        "colours until the palette validator measured them: in dark mode the agent ink and the neutral separate at "
        "<b>14.3 &Delta;E</b>, under the hard floor of 15 — indistinguishable even with full colour vision. Weight "
        "carries it instead, which is the same channel the presence dots and the permission pips already use.",12)
  + nt(L,"Per-agent hues were the other option and were rejected on the system rather than the measurement: hue "
        "carries <i>what kind of thing</i>, never <i>which one</i>. Identity comes from the row below, which is "
        "also this picture&rsquo;s table view.",12))

ORDER=pan(L,"ORDERED BY WHAT RUNS NEXT — SO A ROUTINE APPEARS ONCE PER OCCURRENCE",
  nt(L,"Grouped by cadence, the list was an unordered set of configuration. Ordered by <b>when it next runs</b>, "
       "with day bands, it becomes a schedule — and a routine that runs daily simply appears under each day.")
  + nt(L,"<b>That repetition is what removed two columns.</b> The row <i>is</i> an occurrence, so it needs no "
        "&ldquo;next run&rdquo; column and no &ldquo;how it went&rdquo; column: the time is the occurrence, and "
        "history belongs to the routine, not to the list. Four columns and a state glyph, down from five columns.",12)
  + nt(L,"<b>Recurrence</b> is the rule, said in words — <i>Every day at 6:02 AM</i>, <i>Every Tuesday at 9:00 "
        "AM</i> — beside the loop glyph. The cron string is mechanism and lives in the routine&rsquo;s Schedule "
        "section, not on a list the owner reads every morning.",12))

TERMS=pan(L,"TERMINOLOGY — FOUR SECTIONS, AND NO INVENTED WORDS",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;">WAS</th><th style="padding: 0 12px 8px 0;">NOW</th>'
    f'<th style="padding: 0 0 8px 0;">WHY</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tt"]}; text-decoration: line-through;">{a}</td>'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600;">{b}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{c}</td></tr>'
    for a,b,c in [
      ("Reach for this run","Knowledge","It is permission to read knowledge. Call it what it is, and use the "
       "Knowledge glyph the nav already uses"),
      ("When it acts","Schedule","There was already a word for this"),
      ("Ticks","Recurrence","A second term for one idea. The cron expression is mechanism, shown once, in Schedule"),
      ("Silent","&mdash;","<b>Gone.</b> &ldquo;Silent&rdquo; described the runner&rsquo;s internals. The owner "
       "does not care, and a run that did nothing already says <i>wrote an empty table &mdash; nothing had "
       "changed</i>, which is the same fact in words that mean something")])
  + '</table>'
  + nt(L,"Attribute names are Title Case throughout; values stay verbatim. The first pass had <b>acts</b>, "
        "<b>ticks</b>, <b>inherited</b> and <b>granted for this</b> in lower case, which read as code leaking "
        "through the interface.",14))

HISTP=pan(L,"HISTORY IS WHERE A ROUTINE GETS DEBUGGED",
  nt(L,"A result and an output tell you <i>that</i> it went wrong. Expanding a run shows <b>the prompt that was "
       "sent</b> — the definition and the task, composed the way the agent received them — and <b>what it wrote "
       "back</b>. That is the whole of what you need to work out why a routine is producing the wrong thing, and "
       "to fix it in the layer that caused it.")
  + nt(L,"The prompt is <i>your</i> text, so it is set in the interface face. The output is the agent&rsquo;s, so "
        "it takes the serif and the verdict controls, like agent prose everywhere else.",12)
  + nt(L,"<b>Metis suggests</b> is not a new mechanism. Metistry already emits <b>improvement</b> proposals — "
        "<b>reply-review</b> does it for reply quality, with a deterministic suggested edit that nothing applies "
        "until the owner allows it in triage. A routine suggestion is that same proposal kind pointed at a "
        "routine, so it arrives in Needs You like every other request and this panel is only where you read it in "
        "context.",12))

body=(heading("ROUND E · SCREEN 8, REFINED","Routines — the scheduled compute, and what runs it",
   "An agent is a capability; a routine is an assignment. The list is ordered by what runs next, so it reads as a "
   "schedule rather than as configuration, and the week grid above it shows the shape a list cannot — that "
   "everything the owner configured runs inside the same hour.",L)
  + row(win(L,routinelist2(L)),18)
  + row(GRIDP+ORDER,18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div style="width: 700px; flex-shrink: 0;">{sub("ONE ROUTINE",L["tt"])}'
        + f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{routinedetail2(L)}</div></div>'
        + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px;">'
        + TERMS + HISTP + '</div></div>',18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {D["bc"]}; border-radius: 12px; '
          f'overflow: hidden;">{routinelist2(D)}</div>'
        + f'<div style="width: 560px; flex-shrink: 0;">{schedgrid(D)}</div>'
        + '</div></div>',18))
(PROJ/"Routines.dc.html").write_text(page("Routines",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Routines.dc.html ({CW}x{CH})")
