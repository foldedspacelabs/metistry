"""Board: The Obsidian plugin (round D, ported 2026-09-25).

MIRROR, PLUGFIX and CHIPEDP have lived in lib.py since round D; this module is
the assembly they were missing.
"""
from lib import *

CW,CH=2320,1340
body=(heading("ROUND D · THE OBSIDIAN PLUGIN","A hint that never moves your text",
   "The chips are one object rendered in two apps. The plugin&rsquo;s harder job is staying out of the way: the "
   "attribute hint is an overlay in the line&rsquo;s right margin, so nothing below it ever shifts &mdash; and once the "
   "metadata is there, every chip is a control you can click and change.",L)
  + row(MIRROR,18) + row(PLUGFIX+CHIPEDP,18,align="flex-start")
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px;">{sub("DARK",D["tt"])}'
        f'<div style="display: flex; gap: 18px; align-items: flex-start;">{editor(D,OB_D)}{picker(D)}{chipedit(D)}</div></div>',18))
(PROJ/"Plugin.dc.html").write_text(page("The Obsidian plugin",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Plugin.dc.html ({CW}x{CH})")
