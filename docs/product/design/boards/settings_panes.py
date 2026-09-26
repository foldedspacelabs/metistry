"""Board: Settings — Instance, Services, Compute, Updates, Keyboard, Advanced (2026-09-25).

C123–C127. The panes the app already has as tabs, drawn for the 840 × 600
window (screen 15), with the owner's rulings applied.
"""
from lib import *
from lib_settings2 import *

CW,CH=2720,4180
def sw(T,sel,inner): return settingswindow(T,inner,sel=sel,full=True)
def cell(title,win): return f'<div>{sub(title,L["tt"])}{win}</div>'

NOTES=pan(L,"WHAT CHANGED",
  nt(L,"<b>Instance</b> is where the assistant is named (C123) &mdash; the name, mention and mark every surface uses. "
       "Linked instances list here too, with Link, Refresh and Remove.")
  + nt(L,"<b>Services</b> leads with <b>Doctor</b>: each problem carries the fix that resolves it. Every service shows "
        "its state, uptime, restarts and port, with Restart, Stop and Log (C124). The menu bar keeps its controls.",12)
  + nt(L,"<b>Compute</b> sets what <b>Metis</b> uses, then holds the compute everything else can choose from, in two "
        "tabs. <b>Local</b>: Apple, LM Studio, Ollama, and a model browser that installs and loads. <b>Cloud</b>: each "
        "provider tagged <b>By token</b> or <b>Subscription</b>, keys as secrets, and the spending limits (C125, C128). "
        "An agent picks its model in its own definition.",12)
  + nt(L,"<b>Updates</b> updates and rolls back the runtime (C126); choosing releases or a git checkout is in "
        "<b>Advanced</b>. <b>Keyboard</b> is one switch (C127).",12))

body=(heading("ROUND F · SCREEN 15, PANES","Settings — Instance, Services, Compute, Updates, Keyboard, Advanced",
   "The panes the app already reads, drawn for the fixed window, each scrolling to its full length.",L)
  + row(cell("INSTANCE",sw(L,"Instance",instancepane(L)))
        + cell("SERVICES",sw(L,"Services",servicespane(L)))
        + cell("COMPUTE &mdash; LOCAL",sw(L,"Compute",computepane(L,"Local"))),32,align="flex-start")
  + row(cell("UPDATES",sw(L,"Updates",updatespane(L)))
        + cell("KEYBOARD &mdash; OFF BY DEFAULT",sw(L,"Keyboard",keyboardpane(L,on=False)))
        + cell("ADVANCED",sw(L,"Advanced",advancedpane(L))),32,align="flex-start")
  + row(cell("COMPUTE &mdash; CLOUD",sw(L,"Compute",computepane(L,"Cloud")))
        + f'<div style="display: flex; flex-direction: column; gap: 24px; width: 840px;">'
        + cell("IN AN AGENT&rsquo;S DEFINITION",agentcompute(L,w=560))
        + cell("KEEP AWAKE OFF &mdash; THE REST IS DISABLED",f'<div style="width: 560px;">{sunk(L,awake(L,on=False))}</div>')
        + '</div><div style="flex-grow: 1; min-width: 0;">'+NOTES+'</div>',32,align="flex-start")
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px; align-items: flex-start;">'
        + sw(D,"Services",servicespane(D)) + sw(D,"Compute",computepane(D,"Cloud")) + sw(D,"Keyboard",keyboardpane(D,on=True))
        + '</div></div>',18))
(PROJ/"Settings-Panes.dc.html").write_text(page("Settings Panes",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Settings-Panes.dc.html ({CW}x{CH})")
