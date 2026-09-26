"""Board: Keyboard — the Mac's shortcuts, in the menu bar (2026-09-25).

C119, C120. No keyboard layer on the PWA. Every in-app shortcut is a menu item;
shortcuts that work in any app are off until the owner turns them on, and each is
checked with macOS when it is set. Start and Stop Recording are two shortcuts.
"""
from lib import *
from lib_access import *

CW,CH=2720,2210
def sw(T,inner): return settingswindow(T,inner,sel="Live Capture",full=True)

NOTES=pan(L,"WHAT CHANGED",
  nt(L,"<b>Mac only.</b> The PWA keeps the platform&rsquo;s own keys and adds none (C119).")
  + nt(L,"<b>Every shortcut is a menu item.</b> Go, Capture and Item hold them, so the menu bar is the reference and "
         "<b>Help › Keyboard Shortcuts</b> (⌘/) is the same list on one page.",12)
  + nt(L,"<b>Go is ⌘0–⌘7</b>, in sidebar order; ⌘0 is Needs You while it is shown. ⌘9 is retired with the panel. "
         "Chat&rsquo;s reset is <b>New Conversation</b>, ⇧⌘N, so ⌘R means one thing per screen: run or take.",12)
  + nt(L,"<b>In any app is off by default</b> (C120). Turning it on registers five shortcuts &mdash; Ask, Note, "
         "To-do, <b>Start Recording</b> and <b>Stop Recording</b>, now two &mdash; on ⌃⌥⌘, the least-claimed set. "
         "The bar&rsquo;s tooltip shows a shortcut only when it is on.",12))

CONF=pan(L,"A CONFLICT IS CAUGHT WHEN THE SHORTCUT IS SET",
  nt(L,"macOS refuses a shortcut another app holds, so <b>Metistry asks when you set one</b>, not later. "
       "<b>Taken</b> is failed ink: it will not work. <b>macOS uses this</b> is a warning: it would shadow a system "
       "action. Nothing is registered until every row is clear.")
  + nt(L,"<b>Focus is always visible.</b> With Full Keyboard Access on, the accent ring sits on the focused control "
        "&mdash; a row, a button, a segment of On &middot; Ask &middot; Off.",12)
  + f'<div style="display: flex; gap: 22px; align-items: center; margin-top: 14px;">'
  + focusring(L,btn(L,"Run Now","secondary",I["spark"],spark=True))
  + focusring(L,tristate(L,"ask"),r=8) + focusring(L,ref(L,"secret","github_read"),r=6) + '</div>')

body=(heading("ROUND F · KEYBOARD","Keyboard — the Mac&rsquo;s shortcuts live in its menus",
   "One set of shortcuts for the Mac app, each a menu item. Shortcuts that reach into other apps are off until "
   "you turn them on.",L)
  + row(menushow(L),18)
  + row(f'<div>{sub("HELP ▸ KEYBOARD SHORTCUTS &nbsp;⌘/",L["tt"])}{kbsheet(L,w=1040)}</div>'
        + f'<div style="flex-grow: 1; min-width: 0;">{NOTES}</div>',32,align="flex-start")
  + row(f'<div>{sub("SETTINGS ▸ LIVE CAPTURE &mdash; OFF (DEFAULT)",L["tt"])}{sw(L,hkpane(L,on=False))}</div>'
        + f'<div>{sub("ON &mdash; TWO CONFLICTS, ONE BEING RECORDED",L["tt"])}{sw(L,hkpane(L,on=True,conflicts=True))}</div>'
        + f'<div style="flex-grow: 1; min-width: 0;">{CONF}</div>',32,align="flex-start")
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px; align-items: flex-start;">'
        + f'<div style="width: 880px;">{menushow(D)}</div>' + sw(D,hkpane(D,on=True,conflicts=True)) + '</div></div>',18))
(PROJ/"Keyboard.dc.html").write_text(page("Keyboard",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Keyboard.dc.html ({CW}x{CH})")
