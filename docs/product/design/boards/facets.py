"""Board: Facets, colour and the mark (round D, ported 2026-09-25).

The panels have lived in lib.py since round D (CHAN, ROWP, ORDERP, CAPP); the
assembly that placed them was never a module. This is it, so the board picks up
every later change to chips, badges and the facet order.
"""
from lib import *

CW,CH=2440,1660
body=(heading("ROUND D · FACETS, COLOUR AND THE MARK","Three channels, one order, four steps",
   "Hue names a kind of thing, weight says how much it matters, tint says something is wrong. Dates and estimates "
   "sit between plain text and a chip, carrying a glyph. And every task anywhere in the product lays its facets out "
   "in the same order.",L)
  + row(CHAN,18)
  + row(ROWP+f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0; display: flex; flex-direction: column; gap: 18px;">{ORDERP}{CAPP}</div>',18,align="flex-start")
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; width: 1180px;">{sub("DARK",D["tt"])}'
        f'<div style="display: flex; gap: 18px; align-items: flex-start;"><div style="flex: 1; min-width: 0;">{sample(D)}</div>'
        f'<div style="width: 460px; display: flex; flex-direction: column; gap: 12px;">'
        + agentprose(D,"The lease comparables came back 4% under his number, which is the thing you did not have on the 6th.",when="8:47 AM")
        + agentprose(D,"Two of the four tasks you carried into today were also on Monday&rsquo;s plan.",when="9:02 AM")
        + f'<div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">{btn(D,"Delegate","secondary",I["spark"],spark=True)}'
        + "".join(prio(D,n) for n in (1,2,3,4)) + '</div></div></div></div>',18))
(PROJ/"Facets.dc.html").write_text(page("Facets and colour",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Facets.dc.html ({CW}x{CH})")
