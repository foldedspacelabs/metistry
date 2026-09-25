"""Board: Needs You v5 — the bell opens a full view; questions step one at a time (2026-09-25)."""
from lib_needs5 import *
import lib_pwa as P

CW,CH=2600,4560

SELQ="Three choices before I split the settings pane"
SELPR="Split the settings pane into one file per pane"
A=nywin(L,SELQ,qstep(L,1,sel=(0,1,3)),h=1000)
NOTES=pan(L,"THE BELL OPENS A VIEW, NOT A PANEL",
  nt(L,"<b>The bell is a toggle.</b> Pressed, it fills with the accent and the main area becomes Needs You: the list on "
       "the left, the selected request at reading width. The sidebar shows no selection &mdash; you are not in a section.")
  + nt(L,"<b>The title bar leads back.</b> <i>&lsaquo; Today</i> names where you came from and returns you there, scrolled "
         "where you left it. Esc or the bell again does the same. Answering the last request offers the same way back.",12)
  + nt(L,"<b>Every way in lands here</b> &mdash; the bell, Today&rsquo;s <i>4 waiting</i>, a notification &mdash; with the "
         "request that brought you selected.",12)
  + nt(L,"<b>One line per request</b>, grouped Today and Earlier, filtered by type and by <b>From</b>. The detail pane has "
         "the room the 400px panel never had: a diff, a meeting&rsquo;s notes, three questions. The panel is retired on the "
         "Mac; the phone keeps its sheet.",12)
  + nt(L,"<b>Keyboard-first</b>: &uarr;&darr; move, &crarr; the primary, R Revise, L Later, Esc back.",12))

def crop(inner,title,w=820):
    return (f'<div style="flex-shrink: 0;">{sub(title,L["tt"])}<div style="width: {w}px; box-sizing: border-box; border: 1px solid {L["border"]}; '
            f'border-radius: 12px; background: {L["bg"]}; padding: 22px 28px 24px;">{inner}</div></div>')
STEPS=pan(L,"A QUESTION, ONE AT A TIME &mdash; ANSWER, SLIDE ON, SEND AT THE END",
  f'<div style="display: flex; gap: 20px; flex-wrap: wrap;">'
  + crop(qstep(L,0,sel=(0,)),"1 &mdash; PICK ONE; THE NUMBER KEYS CHOOSE")
  + crop(qstep(L,2,other=OTHER3),"3 &mdash; ANSWERED IN YOUR OWN WORDS")
  + crop(qsummary(L),"YOUR ANSWERS &mdash; EDIT ANY, THEN SEND")
  + crop(qsummary(L,sent=True),"SENT &mdash; CHANGE UNTIL IT&rsquo;S READ") + '</div>'
  + nt(L,"<b>One question fills the card.</b> Choosing and pressing Next slides it away and brings the next; the bar shows "
         "where you are. The last step lists every answer with <b>Edit</b> beside it, and <b>Send Answers</b> (&#8984;&#8629;) "
         "sends them together &mdash; the agent gets one reply, not three.",14)
  + nt(L,"<b>Revise and Decline sit under every step</b>, so <i>these are the wrong questions</i> is never more than a "
         "click away. A single-question request skips the summary: choosing sends.",12))

B=nywin(L,SELPR,prdetail(L),h=1000)
PH=pan(L,"ON A PHONE &mdash; THE SAME STEPS IN THE SHEET",
  f'<div style="display: flex; gap: 20px;">'
  + P.phone(L,"",header=P.hdr(L,"Today",sub=F["day"]),overlay=P.sheet(L,"Needs You",
      f'<div style="transform: scale(1); ">{steps(L,1)}</div>'
      f'<div style="font-size: 17px; font-weight: 600; color: {L["tp"]}; margin-top: 14px;">{QS[1][0]}</div>'
      f'<div style="font-size: 12.5px; color: {L["ts"]}; margin-top: 2px;">Pick any</div>'
      + "".join(bigopt(L,o,multi=True,on=(i in (0,1,3))) for i,o in enumerate(QS[1][2]))
      + bigopt(L,"Something else&hellip;",multi=True)
      + f'<div style="display: flex; gap: 8px; margin-top: 16px;">{btn(L,"Back","secondary")}<span style="flex-grow: 1;"></span>'
        f'{btn(L,"Next","affirm",I["chevr"])}</div>'
      + f'<div style="font-size: 12.5px; color: {L["acc"]}; margin-top: 14px; font-weight: 600;">Revise instead</div>',left="&lsaquo; 10"),
      label="QUESTION 2 OF 3")
  + P.phone(L,"",header=P.hdr(L,"Today",sub=F["day"]),overlay=P.sheet(L,"Needs You",qsummary(L).split('<div style="max-width: 640px; margin-top: 22px;')[1].join(['<div style="margin-top: 4px;','']) if False else
      f'{steps(L,3)}' + "".join(f'<div style="padding: 11px 0; border-top: 1px solid {L["border"]}; margin-top: 8px;">'
                                f'<div style="font-size: 12.5px; color: {L["ts"]};">{q}</div><div style="font-size: 15px; color: {L["tp"]}; margin-top: 2px;">{a}</div></div>'
                                for q,a in ((QS[0][0],"Its own file"),(QS[1][0],"Instance, Services, Account"),(QS[2][0],f"<i>{OTHER3}</i>")))
      + f'<div style="margin-top: 14px;">{btn(L,"Send Answers","affirm",I["send"])}</div>',left="&lsaquo; 10"),label="YOUR ANSWERS")
  + '</div>')

TOG=pan(L,"THE TOGGLE",
  f'<div style="display: flex; flex-direction: column; gap: 12px; width: 520px;">'
  f'{sub("CLOSED &mdash; A COUNT",L["tt"])}<div style="border: 1px solid {L["border"]}; border-radius: 10px; overflow: hidden;">{toolbar2(L,pressed=False)}</div>'
  f'{sub("OPEN &mdash; PRESSED, THE COUNT RIDES ALONG",L["tt"])}<div style="border: 1px solid {L["border"]}; border-radius: 10px; overflow: hidden;">{toolbar2(L)}</div>'
  f'{sub("DARK",L["tt"])}<div style="border: 1px solid {D["border"]}; border-radius: 10px; overflow: hidden;">{toolbar2(D)}</div></div>'
  + nt(L,"Nothing new in the sidebar, so the eight rows stand (C57). The pressed bell is the one place that says "
         "&ldquo;you are in Needs You.&rdquo;",12))

body=(heading("NEEDS YOU &middot; v5","The bell opens a view &mdash; and questions come one at a time",
        "The 400px panel ran out of room. Needs You now takes the main area as a list and a detail pane, reached from "
        "the bell and left by the way you came.",L)
  + row(A + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px;">{NOTES}{TOG}</div>',20,"flex-start")
  + row(STEPS,20)
  + row(B + f'<div style="flex-grow: 1; min-width: 0;">{PH}</div>',20,"flex-start")
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px;">' + sub("DARK",D["tt"])
        + nywin(D,SELQ,qstep(D,1,sel=(0,1,3)),h=1000) + '</div>',20))
(PROJ/"NeedsYou-v5.dc.html").write_text(page("Needs You v5",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote NeedsYou-v5.dc.html ({CW}x{CH})")
