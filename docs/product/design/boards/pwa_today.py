"""Board: PWA — Today at 390pt and in a narrow window (screen 18, 2026-09-24)."""
from lib_pwa import *

CW,CH=2660,2250
H=lambda T,**k: hdr(T,"Today",sub=F["day"]+" &middot; as of 2 min ago",**k)

p1=phone(L,ptodaypage(L,moment="first"),header=H(L),label="8:52 AM &middot; FIRST OPEN")
p2=phone(L,ptodaypage(L,moment="next"),header=H(L),label="9:04 AM &middot; NEXT UP")
p3=phone(L,pspine(L)[0:0] + pmeet(L,"1:00&ndash;1:45 PM","Vendor review","3 people &middot; video")
         + pmeet(L,"3:00&ndash;3:30 PM","Lease call with Tom Reyes","2 people")
         + f'<div style="margin: 8px 0; display: flex; gap: 9px; align-items: flex-start; background: {L["agq"]}; '
           f'border-radius: 10px; padding: 9px 12px;"><span style="display: flex; color: {L["ag"]}; margin-top: 2px;">'
           f'{ic(I["spark"],13,2)}</span><div style="font-size: 13px; color: {L["tp"]}; line-height: 1.45;">Move the lease '
           f'call to 1:45 and the focus block starts at 2:15.<div style="margin-top: 8px;">'
           f'{btn(L,"Move the Lease Call&hellip;","secondary",I["spark"])}</div></div></div>'
         + pmeet(L,"3:30&ndash;5:00 PM","Focus &mdash; the settings brief","90m")
         + taskrow(L,title="Write the design brief for the settings pane",p=1,d="Wed",e="90m",pad=0,last=True)
         + '<div style="height: 8px;"></div>' + prightnow(L),
         header=hdr(L,"Today",large=False),label="9:04 AM &middot; SCROLLED &mdash; THE RAIL COMES LAST")
p4=phone(L,ptodaypage(L,moment="close"),header=H(L),label="5:08 PM &middot; CLOSE THE DAY")
p5=phone(L,brief(L,state="folded",w=CWD,phone=True) + pspine(L)[:0]
         + pnow(L,"9:04 AM")
         + taskrow(L,title="Call the dentist",done=True,receipt="queued",pad=0)
         + taskrow(L,title="Book the lease walkthrough",p=2,d="Today",e="10m",people=["Tom Reyes"],pad=0,last=True),
         header=H(L),band=offband(L),label="OFFLINE &middot; TICKS WAIT, DECISIONS DON&rsquo;T")

NOTES=pan(L,"TODAY ON A PHONE &mdash; ONE COLUMN, SAME ORDER",
  nt(L,"<b>The spine is the page.</b> The time column becomes a line above each item; the Mac&rsquo;s rail becomes "
       "the last two sections, because a phone reads one thing at a time and the rail answers the question you ask "
       "second.")
  + nt(L,"<b>The brief, Next Up and Close the Day are the Mac&rsquo;s components at 358pt</b> &mdash; one code path, "
         "no phone-only copy. Their choices wrap under the row instead of beside it.",12)
  + nt(L,"<b>No Needs You line on the page:</b> the bell in the header is it.",12)
  + nt(L,"<b>Offline, the page shows what it last had and says when.</b> A tick queues with its line and "
         "replays with the 409 check, so it can never overwrite an edit; a decision is not offered at all.",12))

N=narrow(L,brief(L,state="folded") + '<div style="height: 10px;"></div>' + nextup(L)
         + '<div style="height: 6px;"></div>' + pspine(L),
         title="Today",sub=F["day"],side=prightnow(L),h=1180)

body=(heading("PWA &middot; SCREEN 18","Today on a phone, and in a narrow window",
        "390pt with a tab bar and the bell in the header; 600&ndash;899px keeps that shell with room. At 900px and "
        "up the PWA is the Mac layout.",L)
  + row(p1+p2+p3+p4+p5,24)
  + row(N + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px;">{NOTES}'
        + phone(D,ptodaypage(D,moment="next"),header=H(D),label="DARK") + '</div>',24))
(PROJ/"PWA-Today.dc.html").write_text(page("PWA — Today",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote PWA-Today.dc.html ({CW}x{CH})")
