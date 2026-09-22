"""Board: Routines — the scheduled compute, and what runs it.

New 2026-09-21, top-level in the nav (C50). The owner's brief is one sentence:
one place to see all the scheduled compute Metistry runs each day, and how.
"""
from lib import *

CW,CH=2440,2820

def win(T,inner):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Routines")}{inner}</div></div>')

SPLIT=pan(L,"AN AGENT IS A CAPABILITY. A ROUTINE IS AN ASSIGNMENT.",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;"></th><th style="padding: 0 12px 8px 0;">LIVES ON</th>'
    f'<th style="padding: 0 0 8px 0;">SAYS</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600; white-space: nowrap;">{a}</td>'
    f'<td style="padding: 9px 12px 9px 0;">{b}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{c}</td></tr>'
    for a,b,c in [
      ("the definition",mono("agents/&lt;area&gt;/&lt;id&gt;.md",L["ts"],11.5),
       "<b>how it behaves</b> — read-only here, edited on Agents"),
      ("the task prompt","the routine","<b>what to do this occasion</b> — appended to the definition"),
      ("base reach","the agent","what it can touch all the time"),
      ("granted reach","the routine","what it can touch <i>during this task only</i>")])
  + '</table>'
  + nt(L,"An agent that is good at collating gets, on one routine, the knowledge to summarise and a place to write "
        "it — and holds neither the rest of the time.",14))

TICK=pan(L,"THE SCHEDULE A ROUTINE KEEPS IS NOT WHEN IT ACTS",
  f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 13px 15px;">'
  f'<div style="font-family: {SERIF}; font-size: 13.5px; color: {L["tp"]}; line-height: 1.6;">&ldquo;Hourly because '
  f'the runner has no time of day; it plans once an evening, after the day end Me/profile.md states, on the eve of '
  f'a working day, <b>and is silent otherwise</b>.&rdquo;</div>'
  f'<div style="font-size: 11.5px; color: {L["ts"]}; margin-top: 7px;">plan-tomorrow&rsquo;s own manifest</div></div>'
  + nt(L,"<b>plan-tomorrow</b> is <b>@hourly</b> and acts once an evening. <b>knowledge-fold</b> is hourly and "
        "folds once a night. The tick is a mechanism, not a description of what the system does — so a row reading "
        "<b>@hourly</b> is technically true and useless.",14)
  + nt(L,"<b>The row says when it acts</b>, in words; the tick is mechanism, shown in detail. A routine that "
        "ticked twelve times and did nothing has not run twelve times, and the list must not suggest it did — the "
        "same discipline as Activity giving a too-early tick no row at all.",12))

SPECIES=pan(L,"TWO SPECIES IN ONE LIST, AND THE HONEST DIFFERENCE",
  nt(L,"Five routines ship today and <b>all five are deliberately model-free</b> — code with a schedule. What the "
       "owner is describing is a user-defined agent, a prompt and a grant; the closest shipped thing is "
       "<b>knowledge-fold</b>, which assembles a brief and <i>enqueues one assistant turn</i>. That is this shape "
       "already, with Metis as the agent and a hardcoded brief.")
  + nt(L,"They belong in one list, because <i>what is Metistry running for me</i> does not care whether the output "
        "was computed or generated. The difference is a fact in the row: a routine either <b>names the agent that "
        "runs it</b>, or reads <b>built-in</b>. That teaches the distinction for free and gives the deep links one "
        "rule.",12)
  + nt(L,"<b>&ldquo;Nothing to do&rdquo; is a first-class outcome</b>, not a blank. Four of the five ship "
        "explicitly silent when there is nothing to act on, and a screen that renders that as an empty cell reads "
        "as a fault.",12))

FOUND=pan(L,"WHAT THIS SCREEN NEEDS FROM THE WIRE",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==5 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 30px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("D8","a routine <b>task prompt</b>, additive over the agent&rsquo;s definition — with D2&rsquo;s per-run grant "
          "and D3&rsquo;s <b>agent</b> field. These three are one feature, and they are most of this screen."),
    ("D7","a routine outcome beyond <b>ok</b> — <b>acted</b> versus <b>silent</b>. Without it the list cannot tell "
          "a working routine from a sleeping one, and four of five ship deliberately silent."),
    ("D5","a machine-readable <b>acts:</b> on the manifest — the human sentence and the silence conditions — so "
          "three surfaces stop parsing an English description."),
    ("D6","<b>next_run_at</b>, computed where the runner already computes due-ness."),
    ("C3","a per-routine budget. Recurring compute is where money leaks, and a routine is the only object in the "
          "product that can honestly be said to have a monthly cost."),
    ("—","a routine is the natural home for the spend cap the Agents roster could not justify — which is why "
         "spend came off that row and lives here instead.")])))

body=(heading("ROUND E · SCREEN 8, NEW","Routines — the scheduled compute, and what runs it",
   "Top-level in the nav, for C30&rsquo;s own reason: a routine is not a kind of agent, it is an assignment "
   "<i>of</i> one, and <i>what is Metistry running for me every day</i> is a daily question a child row would "
   "bury. Two renders: the schedule, and one routine.",L)
  + row(win(L,routineroster(L)),18)
  + row(SPLIT+TICK,18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div style="width: 680px; flex-shrink: 0;">{sub("ONE ROUTINE",L["tt"])}'
        + f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{routinedetail(L)}</div></div>'
        + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px;">'
        + SPECIES + FOUND + '</div></div>',18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {D["bc"]}; border-radius: 12px; '
          f'overflow: hidden;">{routineroster(D)}</div>'
        + f'<div style="width: 620px; flex-shrink: 0; border: 1px solid {D["bc"]}; border-radius: 12px; '
          f'overflow: hidden;">{routinedetail(D)}</div>'
        + '</div></div>',18))
(PROJ/"Routines.dc.html").write_text(page("Routines",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Routines.dc.html ({CW}x{CH})")
