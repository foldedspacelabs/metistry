"""Board: Settings — Instance, Services, Compute, Updates, Keyboard, Advanced (2026-09-25).

C123–C127. The panes the app already has as tabs, drawn for the 840 × 600
window (screen 15), with the owner's rulings applied.
"""
from lib import *
from lib_settings2 import *

CW,CH=2720,3450
def sw(T,sel,inner): return settingswindow(T,inner,sel=sel,full=True)
def cell(title,win): return f'<div>{sub(title,L["tt"])}{win}</div>'

NOTES=pan(L,"WHAT CHANGED",
  nt(L,"<b>Instance</b> is where the assistant is named (C123) &mdash; the name, mention and mark every surface uses. "
       "Linked instances list here too, with Link, Refresh and Remove.")
  + nt(L,"<b>Services</b> leads with <b>Doctor</b>: each problem carries the fix that resolves it. Every service shows "
        "its state, uptime, restarts and port, with Restart, Stop and Log (C124). The menu bar keeps its controls.",12)
  + nt(L,"<b>Compute</b> keys are secrets, <span style=\"font-family: "+MONO+";\">{{ secret.openrouter_key }}</span> (C125). "
        "Providers, who uses what, spending limits and local models, in that order.",12)
  + nt(L,"<b>Updates</b> updates and rolls back the runtime (C126); choosing releases or a git checkout is in "
        "<b>Advanced</b>. <b>Keyboard</b> is one switch (C127).",12))

body=(heading("ROUND F · SCREEN 15, PANES","Settings — Instance, Services, Compute, Updates, Keyboard, Advanced",
   "The panes the app already reads, drawn for the fixed window, each scrolling to its full length.",L)
  + row(cell("INSTANCE",sw(L,"Instance",instancepane(L)))
        + cell("SERVICES",sw(L,"Services",servicespane(L)))
        + cell("COMPUTE",sw(L,"Compute",computepane(L))),32,align="flex-start")
  + row(cell("UPDATES",sw(L,"Updates",updatespane(L)))
        + cell("KEYBOARD &mdash; OFF BY DEFAULT",sw(L,"Keyboard",keyboardpane(L,on=False)))
        + cell("ADVANCED",sw(L,"Advanced",advancedpane(L))),32,align="flex-start")
  + row(NOTES,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px; align-items: flex-start;">'
        + sw(D,"Services",servicespane(D)) + sw(D,"Compute",computepane(D)) + sw(D,"Keyboard",keyboardpane(D,on=True))
        + '</div></div>',18))
(PROJ/"Settings-Panes.dc.html").write_text(page("Settings Panes",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Settings-Panes.dc.html ({CW}x{CH})")
