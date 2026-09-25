"""Board: Routines v2 — everything Metistry does on a schedule (2026-09-25).

Owner: standup moves into the standard routine pattern, and every scheduled
thing is visible, editable and customisable. Two tabs — Routines (what Metis
and agents run) and Sources (what the collectors check). C111, C112.
"""
from lib import *
from lib_routines2 import *

CW,CH=2560,3400

def win(T,inner,sel="Routines"):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,sel)}{inner}</div></div>')

def split(T,a,b):
    return (f'<div style="flex-grow: 1; min-width: 0; display: flex; align-items: stretch;">{a}'
            f'<div style="width: 1px; background: {T["border"]};"></div>{b}</div>')

CHANGED=pan(L,"WHAT CHANGED",
  nt(L,"<b>Standup is a routine.</b> It runs before the brief, writes its own file, and the brief presents it. "
       "Tomorrow&rsquo;s Plan is the same (C111).")
  + nt(L,"<b>Nothing scheduled is hidden.</b> The routines Metistry ships with carry a <b>default</b> tag and a "
        "<b>Reset to Default</b>; everything else about them is editable. Collectors appear under <b>Sources</b> "
        "with their cadence and what they may raise (C112).",12)
  + nt(L,"<b>Run by</b> names Metis for the defaults. &ldquo;Built-in&rdquo; is gone.",12))

SUGG=pan(L,"METIS SUGGESTS — A REQUEST, NOT A PANEL",
  nt(L,"A suggestion about a routine is an <b>improvement</b> request in Needs You, in the standard pattern. "
       "Approve edits the routine; Revise answers in words.")
  + f'<div style="margin-top: 14px;">{suggest_card(L,w=560)}</div>')

body=(heading("ROUND F · SCREEN 8, v2","Routines — everything Metistry does on a schedule",
   "Standup joins the brief, the plan and the fold as an ordinary routine, and the collectors appear beside them "
   "as sources. Every one can be edited, paused or run now.",L)
  + row(win(L,split(L,routines_list(L),routine_detail(L,w=680))),18)
  + row(CHANGED+SUGG,18)
  + row(win(L,split(L,sources_list(L),source_detail(L,w=620))),18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden; display: flex;">'
        + split(D,routines_list(D),routine_detail(D,w=680)) + '</div></div>',18))
(PROJ/"Routines-v2.dc.html").write_text(page("Routines v2",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Routines-v2.dc.html ({CW}x{CH})")
