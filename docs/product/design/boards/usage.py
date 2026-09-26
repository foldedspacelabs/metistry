"""Board: Usage — the gauge's popover.

Screen 17, new 2026-09-23. Usage left the sidebar in round B (brand-kit.md): a
gauge beside the bell, top-right, no badge. This is the popover it opens.
"""
from lib import *

CW,CH=2200,1780

def anchored(T,state,label):
    return (f'<div>{sub(label,L["tt"])}'
            f'<div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px; width: 400px;">'
            f'{toolcrop(T,state=state)}{usagepop(T,state=state)}</div></div>')

POP=pan(L,"THE POPOVER — THIS MONTH AGAINST BUDGET, EACH DAY, WHERE IT WENT",
  row(anchored(L,"normal","WITHIN BUDGET") + anchored(L,"near","OVER 90%") + anchored(L,"over","BUDGET REACHED"),
      36,align="flex-start")
  + nt(L,"<b>The month against the budget leads</b>, then today and days left. Each day is a single-series bar chart "
        "and <b>where it went</b> ranks agents, routines and chat by spend &mdash; one hue off the sequential ramp, "
        "no legend, values in text ink. Cache rate, AWS and unpriced calls are one line each.",14)
  + nt(L,"<b>The gauge carries no badge</b> (P2). Past 90% its needle moves and it darkens; when a budget stops "
        "compute it takes the warning tint and the popover says so, with <b>Raise</b>.",12))

body=(heading("ROUND E · SCREEN 17, NEW","Usage — the gauge&rsquo;s popover",
   "What this is costing, against the spending limits, and where it went. Limits are set in Settings &#9656; Compute; this is where you "
   "read them.",L)
  + row(POP,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 36px;">'
        + anchored(D,"normal","") + anchored(D,"over","") + '</div></div>',18))
(PROJ/"Usage.dc.html").write_text(page("Usage",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Usage.dc.html ({CW}x{CH})")
