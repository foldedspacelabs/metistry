"""Board: Needs You — the bell, the panel, the list, the meeting, and access.

Round E. Second pass 2026-09-22: the access card cut to what it asks and three
answers, with the rest behind disclosures; seven request types (action added,
C80); a meeting arrives as one grouped card (C81).
"""
from lib import *

CW,CH=2240,4420

BELLP=pan(L,"THE BELL — THE ONLY BADGE IN THE PRODUCT",
  f'<div style="display: flex; flex-direction: column; gap: 16px;">'
  + bellcase(L,None,"Nothing waiting — no badge",
      "No zero, no dimmed dot. A count of nothing is not information, and a badge that is always there stops "
      "meaning anything.")
  + bellcase(L,"4","1&ndash;99 — the number","<b>accent</b> on <b>on-accent</b>, never a state colour. These are "
      "decisions, not failures: a full queue is normal and the badge must not read as an alarm.")
  + bellcase(L,"99+","Past 99 — a mood, not a count",
      "The number has stopped being a count. The list is where you deal with it.")
  + '</div>'
  + nt(L,"No counts on sidebar rows, none on Activity, none on Work. Every other number is something you go and "
        "look at; this one is the product asking (P2).",14))

ACCESS=pan(L,"ACCESS — WHAT IT ASKS, THREE ANSWERS, THE REST ON REQUEST",
  f'<div style="display: flex; gap: 16px; align-items: flex-start;">'
  + "".join(f'<div style="width: 380px; flex-shrink: 0;">{sub(lbl,L["tt"])}{c}</div>'
    for lbl,c in [
       ("ASKED",        accesscard2(L)),
       ("OPENED",       accesscard2(L,open_=("why","ba"))),
       ("ASKED AGAIN",  accesscard2(L,state="escalated")),
       ("REVISING",     accesscard2(L,state="revising")),
       ("CAN&rsquo;T BE GRANTED", accesscard2(L,state="refused",agent="taskuary",trust="external",when="41m"))])
  + '</div>'
  + nt(L,"<b>Cut to what it asks and three answers</b> (ruled 2026-09-22). The reason, the before-and-after and "
        "any earlier decline are disclosures you open when you want them. The rules live behind <b>?</b>, on a "
        "help page, not on the card.",14)
  + nt(L,"Revise still grants only at or below what was asked (C40).",12))

LISTP=pan(L,"WHAT THE WIRE WILL DO TO MANY ROWS AT ONCE",
  f'<div style="display: flex; flex-direction: column; gap: 16px;">'
  + fulllist(L,"select",w=780) + fulllist(L,"result",w=780) + '</div>'
  + nt(L,"Three verbs on a selection and <b>never Approve</b>: <b>later | skip | deny</b> is the endpoint's own "
        "list quoted back, because Approve, Revise and Approve-as-work each do something per kind. Every row "
        "still carries its own four answers.",16)
  + nt(L,"<b>Partial success is the normal outcome</b>, not an error — the batch is all-or-nothing per row so "
        "that one item answered on a phone thirty seconds ago cannot refuse the other two. The applied rows "
        "carry a receipt, the unapplied one keeps its selection so Retry acts on exactly it, and the colour "
        "sits on the <b>glyph</b> while the words stay <b>text-primary</b>.",12)
  + nt(L,"&ldquo;Select all on this page&rdquo;, said in those words, because <b>MAX_LIST</b> is 100 and the "
        "queue can be longer. An honest label beats a hidden cap.",12))

MEETING=pan(L,"A MEETING — ONE CARD, EACH PART ITS OWN ANSWER",
  row(f'<div>{sub("OPEN",L["tt"])}{meetingcard(L,width=520)}</div>'
    + f'<div>{sub("AFTER ACCEPT ALL",L["tt"])}{meetingcard(L,result=True,width=520)}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>Accept All sends one approval per item</b>, in order, each with its own receipt &mdash; not a "
          "batch, which the endpoint refuses for Approve. Every part keeps its own consequence, and one already "
          "answered on your phone shows the way any partial result does (C81).",14)
    + nt(L,"<b>Your own jots are not asked about.</b> They are your words, saved when you typed them, and go "
          "into the notes as yours.",12)
    + nt(L,"<b>Revise</b> on the card and on the notes, so a mistake is fixed before anything is accepted. "
          "Any to-do can be accepted, revised or declined on its own.",12) + '</div>',18,align="flex-start"))

FOUNDP=pan(L,"WHAT THIS PASS FOUND",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==1 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 34px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("C80","<b>pending_requests</b> maps <b>action</b> to <i>note</i>. An agent asking to do something is not a "
           "note; <b>action</b> becomes the seventh word the owner reads."),
    ("C81","proposals have no group, so a meeting&rsquo;s notes and to-dos arrive as unrelated rows. A group id "
           "per session fixes it, and is where C77&rsquo;s anchors get promoted."),])))

body=(heading("ROUND E · SCREEN 3, BACK-PATCHED","Needs You — and an agent asking for a folder",
   "A popover on Mac, a sheet on iOS, and one list behind both. Seven request types; a meeting arrives as one "
   "card; an access request is what it asks and three answers.",L)
  + row(BELLP,18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div>{sub("THE PANEL (MAC) — 400PX, GROUPED, OLDEST FIRST",L["tt"])}{panel3(L)}</div>'
        + f'<div>{sub("EMPTY — NO CHIPS, NO FOOTER, NO COUNT",L["tt"])}{panel2(L,empty=True)}</div>'
        + f'<div>{sub("iOS — A SHEET, SO THE THUMB LANDS ON THE FIRST CARD",L["tt"])}{sheet(L)}</div>'
        + '</div>',18)
  + row(ACCESS,18)
  + row(MEETING,18)
  + row(LISTP,18)
  + row(FOUNDP,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + panel3(D) + meetingcard(D,width=520) + accesscard2(D,open_=("ba",),width=380)
        + '</div></div>',18))
(PROJ/"NeedsYou.dc.html").write_text(page("Needs You",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote NeedsYou.dc.html ({CW}x{CH})")
