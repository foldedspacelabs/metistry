"""Board: Request — the request card, and the panel behind the bell.

Round C's component board, ported in round E. One correction carried in: the
panel header no longer reads "1 snoozed" (C21 — the query excludes snoozed rows,
so nothing can count them), so this board draws `panel2()` and `bellpanel()` is
gone from the library.
"""
from lib import *

CW,CH=1880,2410

CARD=pan(L,"THE CARD, PREVIEW EXPANDED",
  reqcard(L,glyph=I["key"],typ="ACCESS",
    title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
    agent="drey-dev",when="12m",prev=scope_preview(L,expanded=True),width=400)
  + nt(L,"<b>What Approve does</b> is on the card, not behind it: a decision whose consequence you have to go and "
        "look up is a decision you are guessing at. The fold shows the resulting list with the new prefix marked, "
        "so the answer to <i>how much does this widen</i> is a count you can see.",14))

STATES=pan(L,"FOUR ANSWERS, AND THE THREE STATES AFTER ONE",
  f'<div style="display: flex; flex-direction: column; gap: 14px;">'
  + "".join(f'<div>{sub(l,L["tt"])}{c}</div>' for l,c in [
      ("DECIDING — DISABLED, AND NOTHING SPINS",
       reqcard(L,glyph=I["book"],typ="NOTE",title="Keep the note on lease renewal",agent="metis",when="1h",
               prev=note_preview(L),state="deciding",width=400)),
      ("SETTLED — ONE LINE, UNDO WHERE REVERSIBLE",
       reqcard(L,glyph=I["key"],typ="ACCESS",title="",agent="drey-dev",when="12m",state="approved",width=400)),
      ("STALE — THE ROW MOVED, NOTHING WAS SENT",
       reqcard(L,glyph=I["key"],typ="ACCESS",
               title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
               agent="drey-dev",when="12m",state="stale",width=400))])
  + '</div>')

GLYPHS=pan(L,"WITH GLYPHS, AND WITHOUT — YOUR CALL",
  row(f'<div>{sub("WITH",L["tt"])}{card(actions(L,icons=True),L,pad=16)}</div>'
    + f'<div>{sub("WITHOUT",L["tt"])}{card(actions(L,icons=False),L,pad=16)}</div>',14)
  + nt(L,"A glyph on a destructive button is worth it; on <b>Approve</b> it is decoration, and four glyphs in a row "
        "read as a toolbar rather than an answer. Drawn both ways because it is a taste call and it is yours.",14))

REMOVED=pan(L,"TWO THINGS REMOVED, AND WHY",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==2 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="display: flex; flex-shrink: 0; color: {L["fail"]}; margin-top: 2px;">{ic(I["x"],14,2.2)}</span>'
          f'<div><div style="font-size: 12.5px; font-weight: 600; color: {L["tp"]};">{h}</div>'
          f'<div style="font-size: 12px; color: {L["ts"]}; line-height: 1.55; margin-top: 3px;">{b}</div></div></div>'
  for i,(h,b) in enumerate([
    ("Skip, as a fifth button",
     "It came off the card and lives as a batch verb, which is exactly where the wire puts it: "
     "<b>POST /api/proposals/batch</b> takes <b>later | skip | deny</b> and refuses everything else. Four answers "
     "on a card, three on a selection."),
    ("&ldquo;1 snoozed&rdquo; in the panel header",
     "<b>GET /api/proposals</b> without a cursor returns pending rows minus those snoozed into the future, so the "
     "panel has no way to count them. Round C asked for a number the wire does not serve. (C21)"),
    ("A batch bar on the panel",
     "The panel is where you answer four things; the list is where you answer forty. A selection model on a "
     "400px popover buys nothing and costs the card its calm."),])))

body=(heading("ROUND C · COMPONENTS, BACK-PATCHED","The request card, and the panel behind the bell",
   "The card is the product asking, so it carries its own consequence and its own four answers. Agent-written text "
   "in it is data and never looks like a control (P1); the ground is <b>agent-quiet</b> and the face is the serif "
   "stack. One correction since round C: the header can no longer claim a snoozed count.",L)
  + row(f'<div>{sub("THE PANEL, AT POPOVER WIDTH",L["tt"])}{panel3(L)}</div>'
        + f'<div style="display: flex; flex-direction: column; gap: 18px; flex-grow: 1; min-width: 0;">'
        + CARD + GLYPHS + '</div>',18,align="flex-start")
  + row(STATES+REMOVED,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + panel3(D) + reqcard(D,glyph=I["key"],typ="ACCESS",
            title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
            agent="drey-dev",when="12m",prev=scope_preview(D,expanded=True),width=400)
        + panel2(D,empty=True) + '</div></div>',18))
(PROJ/"Request.dc.html").write_text(page("Request",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Request.dc.html ({CW}x{CH})")
