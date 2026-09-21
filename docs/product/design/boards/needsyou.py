"""Board: Needs You — the bell, the panel, the list, and the access request.

Round E back-patch: regenerated onto the facet system, and the `access_request` card
kind is drawn for the first time (C40, C41, C42).
"""
from lib import *

CW,CH=2240,3560

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

ACCESS=pan(L,"THE ACCESS REQUEST — FOUR STATES OF ONE CARD",
  f'<div style="display: flex; gap: 16px; align-items: flex-start;">'
  + "".join(f'<div style="width: 420px; flex-shrink: 0;">{sub(lbl,L["tt"])}{c}</div>'
     for lbl,c in [
       ("ASKED",        accesscard(L,state="pending",width=420)),
       ("ASKED AGAIN",  accesscard(L,state="escalated",width=420)),
       ("REVISING",     accesscard(L,state="revising",width=420)),
       ("REFUSED — AND STILL WAITING", accesscard(L,state="refused",width=420,agent="taskuary",trust="external",when="41m")),
     ])
  + '</div>'
  + nt(L,"<b>The reason is the agent's words</b>, so it sits in the prose treatment and never in a control. "
        "<b>What it holds now</b> is the scope triple verbatim — the same sentence the Agents panel and "
        "<b>metistry agents list</b> show, composed once and never here (P3 §3.4).",16)
  + nt(L,"<b>Approve is not purely additive</b>, and the card says so. An area grant sets the tier to "
        "<b>folders</b>, so an agent that was browsing every title in the vault stops doing that and sees titles "
        "only inside its own folders. The grant model has one tier, so &ldquo;browse everything plus read one "
        "area&rdquo; is not expressible — the trade <i>is</i> the decision, and hiding it would make Approve a "
        "surprise. (C41)",12)
  + nt(L,"<b>Asked again is neutral, not tinted.</b> Tint carries <i>something is wrong</i> and nothing here is: "
        "a second ask is provenance. It names when you declined, links what you answered, and says the ladder "
        "ends — the tool refuses a third ask rather than letting a mechanism be worked indefinitely. (C42)",12)
  + nt(L,"<b>Revise can only grant less.</b> The asked prefix is a ceiling and every option is at or below it. "
        "Granting more than was asked is not a revision of this request, it is a different decision, and it is "
        "not on this control. (C40)",12))

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

FOUNDP=pan(L,"WHAT THIS ROUND FOUND",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==4 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 34px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("C40","<b>accept_with_changes</b> validates only that the revised area is a <i>valid grant shape</i>, not "
           "that it sits under the asked one, so the wire would accept a widening. The control above cannot "
           "express one; the endpoint should refuse one."),
    ("C41","<b>widenedGrants</b> sets tier <b>folders</b> unconditionally. For an agent at <b>titles</b> that is "
           "a loss as well as a gain, and nothing in the payload flags it — the card has to work it out from "
           "<b>current_scope</b>."),
    ("C42","the escalation ladder's third rung is enforced at the tool, so an agent that has been declined twice "
           "is refused without the owner ever seeing a row. That belongs on Agents, the way a successful "
           "collector pass does."),
    ("C21","the panel header cannot say &ldquo;1 snoozed&rdquo; — the query excludes snoozed rows, so the panel "
           "has no way to count them. Dropped to <b>4 waiting</b>."),
    ("—","one pending ask per <b>(agent, area)</b>, enforced by a partial unique index, so a retrying agent "
         "cannot fill the queue with the same sentence. Nothing needed to be designed for it, which is the point."),])))

body=(heading("ROUND E · SCREEN 3, BACK-PATCHED","Needs You — and an agent asking for a folder",
   "Not a screen: a popover on Mac, a sheet on iOS, and one real list behind both for when the queue is long. "
   "This round adds the <b>access_request</b> card — the one request kind where answering changes what another "
   "principal can see, so it is the one that has to be honest about what Approve costs.",L)
  + row(BELLP,18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div>{sub("THE PANEL (MAC) — 400PX, GROUPED, OLDEST FIRST",L["tt"])}{panel2(L)}</div>'
        + f'<div>{sub("EMPTY — NO CHIPS, NO FOOTER, NO COUNT",L["tt"])}{panel2(L,empty=True)}</div>'
        + f'<div>{sub("iOS — A SHEET, SO THE THUMB LANDS ON THE FIRST CARD",L["tt"])}{sheet(L)}</div>'
        + '</div>',18)
  + row(ACCESS,18)
  + row(LISTP,18)
  + row(FOUNDP,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + panel2(D) + accesscard(D,state="pending",width=420) + accesscard(D,state="revising",width=420)
        + '</div></div>',18))
(PROJ/"NeedsYou.dc.html").write_text(page("Needs You",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote NeedsYou.dc.html ({CW}x{CH})")
