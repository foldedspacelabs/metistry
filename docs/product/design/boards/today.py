"""Board: Today — the day as a spine."""
from lib import *

CW,CH=2620,5060
body=(heading("ROUND D · SCREEN 5, v6","Today — one facet order, a shape for time",
   "Six corrections. One facet order obeyed everywhere a task is drawn, dates and estimates as glyphs rather than "
   "bare words, the sidebar actually showing Today first, a calendar change drawn as a <b>shape</b> instead of a "
   "diff, a rescheduling policy Metis acts inside, and four candidate voices for the assistant.",L)
  + row(f'{hub6(L)}<div style="display: flex; flex-direction: column; gap: 20px; flex-grow: 1; min-width: 0;">'
        f'{NAVP3}{ORDERP}</div>',20)
  + row(f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{CALP2}</div>'
        f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{POLICY}</div>',20)
  + row(SERIFP,20)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px;">' + sub("DARK",D["tt"])
        + hub6(D,True,1280) + '</div>',20))
(PROJ/"Today-Hub.dc.html").write_text(page("Today",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print("wrote Today-Hub.dc.html (v6)")
