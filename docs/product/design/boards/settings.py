"""Board: Settings — the window itself.

Screen 15, new 2026-09-22. Owner's rulings: a sidebar, grouped; Connections is
renamed Account; and the window is NOT resizable — it is a fixed size chosen for
its content, with panes that scroll vertically (closing C62).
"""
from lib import *
from lib_connect import connlist

CW,CH=2600,3080

def w(T,sel,inner,**kw): return settingswindow(T,inner,sel=sel,**kw)

GROUPS=pan(L,"ONE WINDOW, 840 × 600, GROUPED — THE REAL SECTIONS, AND THREE NEW ONES",
  row(f'<div>{sub("ACCESS ▸ CONNECTIONS",L["tt"])}{w(L,"Connections",connlist(L))}</div>'
    + f'<div>{sub("ACCESS ▸ ACCOUNT (WAS CONNECTIONS)",L["tt"])}{w(L,"Account",accountpane(L))}</div>',
      32,align="flex-start")
  + nt(L,"<b>A sidebar, grouped, at a fixed size</b> (ruled 2026-09-22). Instance &middot; Services &middot; "
        "Compute &middot; Updates; <b>Access</b> &mdash; Account, Connections, Secrets, Variables; <b>Capture</b> &mdash; Live "
        "Capture, Sessions; Advanced. Ten sections would not fit as tabs across the top.",14)
  + nt(L,"<b>840 × 600 is set by the widest pane.</b> The Connections list fits 640 with its <i>used by</i> column wrapping. Measured, not guessed.",12))

CAPTURE=pan(L,"CAPTURE ▸ LIVE CAPTURE AND SESSIONS",
  row(f'<div>{sub("LIVE CAPTURE",L["tt"])}{w(L,"Live Capture",panehead(L,"Live Capture")+capturesettings(L,bare=True))}</div>'
    + f'<div>{sub("SESSIONS",L["tt"])}{w(L,"Sessions",panehead(L,"Sessions")+archivesettings(L,bare=True))}</div>',
      32,align="flex-start"))

BIGTEXT=pan(L,"LARGER TEXT — THE PANE GETS LONGER, NEVER WIDER",
  row(f'<div>{sub("CONNECTIONS AT 135% TEXT, SCROLLED",L["tt"])}'
      + w(L,"Connections",f'<div style="zoom: 1.35;">{connlist(L)}</div>',scrolled=0.35) + '</div>'
      + f'<div style="flex-grow: 1; min-width: 0; padding-top: 22px;">'
      + nt(L,"<b>This is how a fixed window stays accessible</b> (C62, closed). Every pane scrolls vertically, so "
            "larger text lengthens it and nothing is clipped. Columns that cannot shrink wrap their text instead of "
            "pushing the pane sideways.",14)
      + '</div>',32,align="flex-start"))

body=(heading("ROUND E · SCREEN 15, NEW","Settings — one fixed window, grouped, sized to its content",
   "A sidebar with the real sections in four groups, three of them new, at a fixed 840 × 600 set by the widest pane. "
   "Panes scroll, so larger text never needs a bigger window.",L)
  + row(GROUPS,18)
  + row(CAPTURE,18)
  + row(BIGTEXT,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px;">'
        + w(D,"Connections",connlist(D)) + w(D,"Live Capture",panehead(D,"Live Capture")+capturesettings(D,bare=True))
        + '</div></div>',18))
(PROJ/"Settings.dc.html").write_text(page("Settings",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Settings.dc.html ({CW}x{CH})")
