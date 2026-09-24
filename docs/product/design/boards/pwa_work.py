"""Board: PWA — Work at 390pt and 820px: Board, card detail, Projects, an artifact, a room (screen 18)."""
from lib_pwa import *

CW,CH=2660,1930

def segw(T,sel):
    return (f'<div style="display: flex; padding: 2px; border-radius: 9px; background: {T["sunken"]}; margin: 0 0 10px;">'
            + "".join(f'<span style="flex: 1; text-align: center; padding: 6px 0; border-radius: 7px; font-size: 13px; '
                      f'font-weight: {600 if n==sel else 500}; color: {T["tp"] if n==sel else T["ts"]}; '
                      f'background: {T["bg"] if n==sel else "transparent"}; '
                      f'box-shadow: {"0 1px 2px rgba(0,0,0,0.12)" if n==sel else "none"};">{n}</span>'
                      for n in ("Board","Projects","Artifacts")) + '</div>')

def colchips(T,sel):
    return (f'<div style="display: flex; gap: 6px; overflow: hidden; margin-bottom: 10px;">'
            + "".join(f'<span style="padding: 5px 11px; border-radius: 999px; font-size: 13px; white-space: nowrap; '
                      f'font-weight: {600 if n==sel else 500}; background: {T["accq"] if n==sel else "transparent"}; '
                      f'color: {T["acc"] if n==sel else T["ts"]}; border: 1px solid {"transparent" if n==sel else T["bc"]};">'
                      f'{n} <span style="color: {T["ts"]}; font-weight: 400;">{c}</span></span>'
                      for n,c in (("Backlog",12),("Assigned",5),("In Progress",4),("Blocked",2),("Done",40))) + '</div>')

def pcard(T,title,chips,*,thread=0,glyph="board"):
    return (f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 11px; padding: 11px 12px; margin-bottom: 8px;">'
            f'<div style="display: flex; gap: 8px; align-items: flex-start;">'
            f'<span style="display: flex; color: {T["tt"]}; margin-top: 2px;">{ic(I[glyph],15,1.9)}</span>'
            f'<span style="flex-grow: 1; font-size: 15px; color: {T["tp"]}; line-height: 1.35;">{title}</span>'
            + (f'<span style="display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: {T["ts"]};">'
               f'{ic(I["chat"],13,1.9)}{thread}</span>' if thread else "")
            + f'</div><div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; margin-left: 23px;">{"".join(chips)}</div></div>')

board=(segw(L,"Board") + colchips(L,"In Progress")
       + pcard(L,"Book the follow-up",[gl(L,I["clock"],"4m left"),ent(L,"agent","drey-dev",I["agents"])],thread=3)
       + pcard(L,"Rebuild the cache report",[gl(L,I["clock"],"lease lapsed 12m ago",L["deg"]),st(L,"Lease Lapsed")])
       + pcard(L,"Migrate the settings pane to tokens",[gl(L,I["clock"],"38m left"),ent(L,"project","Settings Pane",I["board"])])
       + pcard(L,"Audit the egress allowlist",[gl(L,I["clock"],"1h 10m left"),ent(L,"agent","taskuary",I["agents"])])
       + nt(L,"<b>One column at a time.</b> The chips are the columns, with counts; the filter row and Has Thread sit "
              "behind the header&rsquo;s filter button. Drag becomes <b>Move to&hellip;</b> on the card.",6))
W1=phone(L,board,tab="Work",header=hdr(L,"Work"),label="WORK &#9656; BOARD")

dtl=(f'<div style="display: flex; gap: 8px; align-items: flex-start;"><span style="display: flex; color: {L["ag"]}; margin-top: 3px;">'
     f'{ic(I["board"],17,1.9)}</span><div style="font-size: 21px; font-weight: 700; color: {L["tp"]}; line-height: 1.25;">'
     f'Rebuild the cache report</div></div>'
     f'<div style="display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 12px;">'
     + st(L,"Lease Lapsed") + ent(L,"agent","drey-dev",I["agents"]) + ent(L,"project","Ops",I["board"]) + '</div>'
     + f'<div style="font-size: 14.5px; color: {L["tp"]}; line-height: 1.5;">Regenerate the weekly cache report with the new '
       f'buckets, and flag anything over 20% miss.</div>'
     + secthead(L,"THREAD","Open Room") + roommsg(L,"drey-dev","Stopped at the 2 AM bucket &mdash; the source file is missing.","2:31 PM")
     + secthead(L,"HISTORY")
     + f'<div style="font-size: 13px; color: {L["ts"]}; line-height: 1.9;">2:02 PM &middot; <b style="color: {L["tp"]};">drey-dev</b> claimed it<br>'
       f'2:40 PM &middot; lease lapsed, claim still held</div>')
bar=(f'<div style="position: absolute; left: 0; right: 0; bottom: 83px; padding: 10px 16px; background: {L["bg"]}; '
     f'border-top: 0.5px solid {L["border"]}; display: flex; gap: 8px;">{btn(L,"Move to&hellip;","secondary",I["chevr"])}'
     f'{btn(L,"Release","secondary")}<span style="flex-grow: 1;"></span></div>')
W2=phone(L,dtl,tab="Work",header=hdr(L,"",large=False,back="Board"),overlay=bar,label="A CARD &mdash; PUSHED, EVERY TAP (C84)")

def mrow(T,t,sub=None,*,on=True,last=False):
    return (f'<div style="padding: 12px 16px;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            f'<div style="font-size: 16px; color: {T["acc"] if on else T["tt"]}; text-align: center;">{t}</div>'
            + (f'<div style="font-size: 12px; color: {T["ts"]}; text-align: center; margin-top: 2px;">{sub}</div>' if sub else "") + '</div>')
menu=(f'<div style="position: absolute; inset: 0; background: {scrim(L)};"></div>'
      f'<div style="position: absolute; left: 10px; right: 10px; bottom: 96px;">'
      f'<div style="background: {L["elevated"]}; border-radius: 14px; overflow: hidden;">'
      f'<div style="padding: 11px 16px; text-align: center; font-size: 13px; color: {L["ts"]}; border-bottom: 0.5px solid {L["border"]};">'
      f'Move &ldquo;Rebuild the cache report&rdquo; to</div>'
      + mrow(L,"Backlog","releases drey-dev&rsquo;s claim") + mrow(L,"Assigned to&hellip;","pick an agent")
      + mrow(L,"Done","closes it")
      + mrow(L,"In Progress",on=False,sub="only an agent claims a card",last=True) + '</div>'
      f'<div style="background: {L["elevated"]}; border-radius: 14px; margin-top: 8px; padding: 13px; text-align: center; '
      f'font-size: 16px; font-weight: 600; color: {L["acc"]};">Cancel</div></div>')
W3=phone(L,dtl,tab="Work",header=hdr(L,"",large=False,back="Board"),overlay=menu,label="MOVE TO&hellip; &mdash; ONLY LEGAL MOVES")

def prow(T,p,last=False):
    return (f'<div style="padding: 12px 14px;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            f'<div style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 16px; font-weight: 600; color: {T["tp"]};">{p["title"]}</span>'
            f'{modechip(T,p["mode"],p["why"])}<span style="flex-grow: 1;"></span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],14,2.3)}</span></div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin: 4px 0 7px;">{p["open"]} open &middot; {p["blocked"]} blocked &middot; {len(p["members"])} agents</div>'
            f'{spendbar(T,p["spent"],p["budget"],over=p["why"]=="budget")}</div>')
projs=(segw(L,"Projects") + f'<div style="background: {L["surface"]}; border-radius: 12px; border: 0.5px solid {L["border"]}; overflow: hidden;">'
       + "".join(prow(L,p,last=i==len(PROJECTS)-1) for i,p in enumerate(PROJECTS)) + '</div>')
W4=phone(L,projs,tab="Work",header=hdr(L,"Work"),label="WORK &#9656; PROJECTS")

def pdoc(T):
    out=""
    for k,t in DOC:
        if k=="h":
            out+=f'<div style="font-size: 21px; font-weight: 700; color: {T["tp"]}; margin-bottom: 10px;">{t}</div>'; continue
        hl=k in ("hl","hl2")
        n=2 if k=="hl" else 1
        out+=(f'<p style="margin: 0 0 10px; font-size: 15px; color: {T["tp"]}; line-height: 1.6;'
              + (f' background: {T["accq"]}; border-radius: 3px;' if hl else '') + f'">{t}'
              + (f' <span style="display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; border-radius: 999px; '
                 f'background: {T["surface"]}; border: 1px solid {T["bc"]}; font-size: 12px; font-weight: 600; color: {T["acc"]}; '
                 f'vertical-align: 1px;">{ic(I["chat"],12,2)}{n}</span>' if hl else '') + '</p>')
    return out
th=(f'<div style="display: flex; flex-direction: column; gap: 12px;">'
    + roommsg(L,"collator","Two invoices since June are at net-45 &mdash; should the summary say which?","11:02 AM")
    + roommsg(L,"you","Yes, name them.","11:20 AM") + '</div>'
    f'<div style="margin-top: 14px; border: 1px solid {L["bc"]}; border-radius: 18px; padding: 9px 14px; font-size: 15px; color: {L["tt"]};">Reply&hellip;</div>')
art=(f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">{mono("v3",L["tp"],12)}'
     f'<span style="font-size: 12.5px; color: {L["ts"]};">collator &middot; 2h</span><span style="flex-grow: 1;"></span>'
     f'<span style="font-size: 13px; font-weight: 600; color: {L["acc"]};">Versions</span></div>' + pdoc(L))
W5=phone(L,art,tab="Work",header=hdr(L,"",large=False,back="Artifacts"),
         overlay=sheet(L,"Line 3 &middot; 2 comments",th,top=470,right="Resolve"),label="AN ARTIFACT &mdash; THREADS INLINE")

room=(f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 9px 12px; font-size: 13px; color: {L["tp"]}; margin-bottom: 12px;">'
      f'<b>Came to you.</b> Ten agent turns went by without you.</div>'
      f'<div style="display: flex; flex-direction: column; gap: 12px;">'
      + roommsg(L,"collator","Invoices 0612 and 0804 are at net-45. The rest are on the old terms.","2:02 PM")
      + roommsg(L,"drey-dev","Then the renewal comparison should use net-45 for those two only.","2:05 PM")
      + f'<div style="font-size: 12.5px; color: {L["tt"]}; text-align: center;">7 more agent turns</div>'
      + roommsg(L,"drey-dev","Still waiting on whether the tier is gone for Q4 too.","2:31 PM") + '</div>')
rcomp=(f'<div style="position: absolute; left: 12px; right: 12px; bottom: 92px;">'
       f'<div style="display: flex; align-items: center; gap: 7px; margin: 0 4px 7px;">{tailmeter(L,10)}'
       f'<span style="font-size: 12px; color: {L["ts"]};">10 of 10 &middot; yours resets it</span></div>'
       f'<div style="background: {L["surface"]}; border: 1px solid {L["bc"]}; border-radius: 22px; padding: 10px 14px; '
       f'font-size: 15px; color: {L["tt"]};">Add to the Room&hellip;</div></div>')
W6=phone(L,room,tab="Work",header=hdr(L,"#418",large=False,back="Card",right=f'<span style="font-size: 16px; color: {L["acc"]};">Resolve</span>'),
         overlay=rcomp,label="A TASK&rsquo;S ROOM")

def ncol(T,name,n,cards):
    return (f'<div style="width: 250px; flex-shrink: 0; background: {T["sunken"]}; border-radius: 12px; padding: 10px 9px;">'
            f'<div style="font-size: 12px; font-weight: 700; letter-spacing: 0.05em; color: {T["tp"]}; padding: 0 3px 8px;">'
            f'{name} <span style="font-weight: 400; color: {T["ts"]};">{n}</span></div>{cards}</div>')
nb=(segw(L,"Board")
    + f'<div style="display: flex; gap: 10px; overflow: hidden; margin-right: -60px;">'
    + ncol(L,"Assigned",5,pcard(L,"Review the migration plan",[ent(L,"agent","drey-dev",I["agents"])],thread=2,glyph="review")
             + pcard(L,"Reconcile the September invoices",[ent(L,"agent","taskuary",I["agents"]),st(L,"Overdue")]))
    + ncol(L,"In Progress",4,pcard(L,"Book the follow-up",[gl(L,I["clock"],"4m left")],thread=3)
             + pcard(L,"Rebuild the cache report",[st(L,"Lease Lapsed")]))
    + ncol(L,"Blocked",2,pcard(L,"Publish the tokens package",[st(L,"Waiting on #417 to merge")],thread=1)
             + pcard(L,"Sign off the vendor SOW",[st(L,"Waiting on You")])) + '</div>')
NB=narrow(L,nb,tab="Work",title="Work",h=720)

NOTE=pan(L,"WORK ON A PHONE",
  nt(L,"<b>Board is one column at a time</b>, picked by its chips; at 600px and up the columns scroll sideways, "
       "snapping to each. <b>Move to&hellip;</b> replaces the drag and lists only moves the service would accept.")
  + nt(L,"<b>Every tap opens the card</b> (C84), pushed full-screen; the room is a push from there. An artifact&rsquo;s "
         "threads become counts on their lines, opening a sheet &mdash; the margin does not fit, and a phone does not need it to.",12)
  + nt(L,"Projects: the mode chip and the spend bar carry the row, as on the Mac.",12))

body=(heading("PWA &middot; SCREEN 18","Work on a phone &mdash; Board, a card, Projects, an artifact, a room",
        "Board picks one column at a time; drag becomes Move to&hellip;; threads become counts on their lines.",L)
  + row(W1+W2+W3+W4+f'<div style="flex-grow: 1; min-width: 0;">{NOTE}</div>',24)
  + row(W5+W6+NB,24))
(PROJ/"PWA-Work.dc.html").write_text(page("PWA — Work",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote PWA-Work.dc.html ({CW}x{CH})")
