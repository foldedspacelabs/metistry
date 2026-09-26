"""Board: PWA — Needs You, Chat and Capture at 390pt (screen 18)."""
from lib_pwa import *

CW,CH=2660,1930

def action(T,*,disabled=False):
    k=(lambda x:"disabled") if disabled else (lambda x:x)
    return (f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; padding: 13px 14px;">'
            f'{reqhead(T,I["work"],"ACTION","drey-dev","40m")}'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-top: 8px;">Comment on #418</div>'
            f'<div style="background: {T["agq"]}; border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-family: {SERIF}; '
            f'font-size: 13.5px; color: {T["tp"]}; line-height: 1.5;">Invoices 0612 and 0804 are at net-45; the comparison '
            f'uses net-45 for those two only.</div>'
            f'<div style="display: flex; gap: 7px; margin-top: 11px;">{btn(T,"Approve",k("affirm"),I["check"])}'
            f'{btn(T,"Revise",k("secondary"),I["pencil"])}{btn(T,"Decline",k("secondary"),I["x"])}</div></div>')

def gl_(T,t,n): return f'<div style="margin: 12px 0 7px;">{grouplabel(T,t,n)}</div>'

chips=(f'<div style="display: flex; gap: 6px; margin: 2px 0 4px; overflow: hidden;">'
       + "".join(f'<span style="padding: 5px 12px; border-radius: 999px; font-size: 13px; white-space: nowrap; '
                 f'background: {L["accq"] if s else "transparent"}; color: {L["acc"] if s else L["ts"]}; '
                 f'border: 1px solid {"transparent" if s else L["bc"]};">{t}</span>'
                 for t,s in (("All 4",True),("Meetings",False),("Access",False),("Actions",False),("Notes",False))) + '</div>')
queue=(chips + gl_(L,"MEETINGS","1") + meetingcard(L,expanded=False,width=CWD)
       + gl_(L,"ACCESS","1") + accesscard2(L,width=CWD) + gl_(L,"ACTIONS","1") + action(L))
N1=phone(L,"",header=hdr(L,"Today",sub=F["day"]),overlay=sheet(L,"Needs You",queue),label="THE BELL &mdash; A SHEET")

def lrow(T,g,typ,title,agent,when,*,swipe=None,last=False):
    row_=(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 11px 14px; background: {T["surface"]};">'
          f'<span style="display: flex; color: {T["ts"]}; margin-top: 2px;">{ic(I[g],17,1.9)}</span>'
          f'<div style="flex-grow: 1; min-width: 0;"><div style="display: flex; gap: 8px; align-items: center;">'
          f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
          f'<span style="flex-grow: 1;"></span>{agentchip(T,agent)}<span style="font-size: 12px; color: {T["tt"]};">{when}</span></div>'
          f'<div style="font-size: 15px; color: {T["tp"]}; margin-top: 3px;">{title}</div></div></div>')
    if not swipe:
        return f'<div style="{"" if last else "border-bottom: 0.5px solid "+T["border"]+";"}">{row_}</div>'
    if swipe=="approve":
        act=(f'<div style="width: 96px; flex-shrink: 0; background: {T["acc"]}; color: {T["onacc"]}; display: flex; '
             f'flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 13px; font-weight: 600;">'
             f'{ic(I["check"],18,2.2)}Approve</div>')
        return (f'<div style="display: flex; overflow: hidden; border-bottom: 0.5px solid {T["border"]};">{act}'
                f'<div style="width: {CWD}px; flex-shrink: 0;">{row_}</div></div>')
    act=(f'<div style="width: 96px; flex-shrink: 0; background: {T["sunken"]}; color: {T["tp"]}; display: flex; '
         f'flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 13px; font-weight: 600; '
         f'border-left: 0.5px solid {T["bc"]};">{ic(I["x"],18,2.2)}Decline</div>')
    return (f'<div style="display: flex; overflow: hidden; justify-content: flex-end; border-bottom: 0.5px solid {T["border"]};">'
            f'<div style="width: {CWD}px; flex-shrink: 0;">{row_}</div>{act}</div>')

lst=(f'<div style="border-radius: 12px; overflow: hidden; border: 0.5px solid {L["border"]};">'
     + lrow(L,"key","ACCESS","Read Areas/Finance","drey-dev","12m",swipe="approve")
     + lrow(L,"work","ACTION","Comment on #418","drey-dev","40m",swipe="decline")
     + lrow(L,"book","NOTE","Keep the note on lease renewal","metis","1h")
     + lrow(L,"key","ACCESS","Write to the release notes folder","taskuary","41m",last=True) + '</div>'
     + nt(L,"Swipe right to <b>Approve</b>, left to <b>Decline</b>. Decline is not red: red is for <i>failed</i>, and a "
            "decline can be answered again (C92). Access cards with a <b>Before and after</b> open instead of swiping.",12))
N2=phone(L,"",header=hdr(L,"Today",sub=F["day"]),overlay=sheet(L,"Needs You",lst,left="Select"),label="COMPACT &mdash; SWIPE TO ANSWER")

N3=phone(L,"",header=hdr(L,"Today",sub=F["day"]),overlay=sheet(L,"Vendor review",meetingcard(L,width=CWD),left="&lsaquo; 4",right="",top=58),
         label="A MEETING &mdash; PUSHED FROM THE SHEET")

offq=(f'<div style="display: flex; gap: 9px; align-items: center; background: {L["sunken"]}; border-radius: 10px; padding: 9px 12px; '
      f'margin-bottom: 10px;"><span style="display: flex; color: {L["ts"]};">{ic(I["wifioff"],15,1.9)}</span>'
      f'<span style="font-size: 13px; color: {L["tp"]};"><b>Decisions need the connection.</b> '
      f'<span style="color: {L["ts"]};">Showing 9:04 AM.</span></span></div>'
      + gl_(L,"ACTIONS","1") + action(L,disabled=True)
      + f'<div style="height: 16px;"></div><div style="text-align: center; padding: 26px 10px; border-radius: 12px; '
        f'border: 1px dashed {L["bc"]};"><div style="font-size: 15px; font-weight: 600; color: {L["tp"]};">Nothing needs you.</div>'
        f'<div style="font-size: 13px; color: {L["ts"]}; margin-top: 4px; line-height: 1.45;">The empty sheet, for comparison: '
        f'when an agent asks, it lands here &mdash; and only then does the bell show a number.</div></div>')
N4=phone(L,"",header=hdr(L,"Today",sub=F["day"]),band=offband(L),overlay=sheet(L,"Needs You",offq,top=150),
         label="OFFLINE, AND EMPTY")

M=CWD
chat=(userturn(L,"Is the SOW safe to sign before the 9:30?",when="9:02 AM",w=M)
      + '<div style="height: 14px;"></div>'
      + replyturn(L,"Yes. The comparables came back <b>4% under</b> his number, which covers the one clause you "
                    "flagged on the 6th. Nothing else in it changed since the draft.",when="9:02 AM",w=M-18,hang=False)
      + f'<div style="margin: 8px 0 0 18px;">{toolstrip(L,collapsed=True)}</div>'
      + '<div style="height: 14px;"></div>' + userturn(L,"Draft the agenda for Jim.",when="9:03 AM",w=M)
      + f'<div style="margin: 12px 0 0; padding-left: 16px; border-left: 2px solid {L["ag"]};">{waitdots(L)}</div>')
comp=(f'<div style="position: absolute; left: 12px; right: 12px; bottom: 92px; background: {L["surface"]}; '
      f'border: 1px solid {L["bc"]}; border-radius: 22px; padding: 9px 9px 9px 14px; display: flex; align-items: center; gap: 9px;">'
      f'<span style="display: flex; color: {L["acc"]};">{ic(I["plus"],20)}</span>'
      f'<span style="flex-grow: 1; font-size: 15px; color: {L["tt"]};">Ask anything&hellip;</span>'
      f'{btn(L,"Stop","secondary",I["x"])}</div>')
C1=phone(L,chat,tab="Chat",header=hdr(L,"Chat",large=False),overlay=comp,label="CHAT &mdash; THE SAME COLUMN, AT 358")

refused=(userturn(L,"Draft the agenda for Jim.",when="9:05 AM",w=M)
         + f'<div style="display: flex; gap: 8px; align-items: center; margin-top: 7px; font-size: 12.5px; color: {L["ts"]};">'
           f'<span style="display: flex; color: {L["ts"]};">{ic(I["wifioff"],13,1.9)}</span>Not sent &mdash; you&rsquo;re offline.'
           f'<span style="font-weight: 600; color: {L["acc"]};">Try Again</span></div>')
C2=phone(L,refused,tab="Chat",header=hdr(L,"Chat",large=False),band=offband(L,since="9:05 AM"),label="CHAT OFFLINE &mdash; REFUSED, NOT QUEUED")

cap=(composer(L,state="typing",w=CWD-34) + '<div style="height: 12px;"></div>'
     + nt(L,"<b>+ opens the same capture everywhere</b> &mdash; header, share sheet, a notification&rsquo;s reply. "
            "Offline it waits and says so.",0))
K1=phone(L,"",header=hdr(L,"Today",sub=F["day"]),overlay=sheet(L,"Capture",cap,left="Cancel",right="",top=300),label="CAPTURE &mdash; +")

NOTE=pan(L,"NEEDS YOU AND CHAT ON A PHONE",
  nt(L,"<b>The bell opens a sheet</b>, the Mac panel&rsquo;s cards at 358pt: the same answers, the same disclosures, "
       "the same order (C92). <b>Select</b> gives the compact list for working down a queue.")
  + nt(L,"<b>Chat keeps its measure rule:</b> the column is the phone, the reply keeps its 2px rule inside the width, "
         "and the composer floats above the tab bar. A send offline is refused, never queued &mdash; an answer "
         "that arrives an hour late is not the conversation you were having.",12))

body=(heading("PWA &middot; SCREEN 18","Needs You, Chat and Capture on a phone",
        "The bell&rsquo;s panel becomes a sheet; swipe answers the compact list; Chat is the same column at 358pt.",L)
  + row(N1+N2+N3+N4+f'<div style="flex-grow: 1; min-width: 0;">{NOTE}</div>',24)
  + row(C1+C2+K1+phone(D,"",header=hdr(D,"Today",sub=F["day"]),
                       overlay=sheet(D,"Needs You",gl_(D,"ACCESS","1")+accesscard2(D,width=CWD)+gl_(D,"ACTIONS","1")+action(D)),
                       label="DARK"),24))
(PROJ/"PWA-NeedsYou.dc.html").write_text(page("PWA — Needs You and Chat",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote PWA-NeedsYou.dc.html ({CW}x{CH})")
