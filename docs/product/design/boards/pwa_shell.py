"""Board: PWA — the shell: tabs, More, install, enrolment, notifications, offline (screen 18)."""
from lib_pwa import *

CW,CH=2660,1710

def keyed(T,size=44):
    return (f'<svg viewBox="0 0 64 64" width="{size}" height="{size}" aria-hidden="true" style="color: {T["acc"]};">'
            f'<path d="M12 12 H52 V52 H38 L12 26 Z" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="miter"/></svg>')

more=(group(L,[grow(L,"Metistry on Studio",glyph="cpu",sub="Connected &middot; v0.11.0",chev=True,last=True)])
      + group(L,[grow(L,"Activity",glyph="activity"),grow(L,"Agents",glyph="agents",detail="1 waiting"),
                 grow(L,"Routines",glyph="repeat",last=True)])
      + group(L,[grow(L,"Usage",glyph="gauge",detail="$41.20 of $60"),grow(L,"Settings",glyph="gear",last=True)]))
S1=phone(L,more,tab="More",header=hdr(L,"More"),label="MORE")

steps="".join(f'<div style="display: flex; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid {L["border"]};">'
              f'<span style="width: 26px; height: 26px; border-radius: 50%; background: {L["accq"]}; color: {L["acc"]}; '
              f'display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;">{i}</span>'
              f'<span style="font-size: 15px; color: {L["tp"]};">{t}</span><span style="flex-grow: 1;"></span>'
              + (f'<span style="display: flex; color: {L["acc"]};">{ic(I[g],20,1.9)}</span>' if g else "") + '</div>'
              for i,t,g in ((1,"Tap Share in Safari","share"),(2,"Choose Add to Home Screen","plus"),(3,"Open Metistry from there",None)))
install=(f'<div style="text-align: center; padding: 18px 8px 6px;">{keyed(L,52)}'
         f'<div style="font-size: 20px; font-weight: 700; color: {L["tp"]}; margin-top: 12px;">Add Metistry to your Home Screen</div>'
         f'<div style="font-size: 14px; color: {L["ts"]}; line-height: 1.45; margin-top: 6px;">It opens full screen, and it is the only '
         f'way an iPhone lets Metistry send you a notification.</div></div>{steps}'
         f'<div style="margin-top: 16px;">{btn(L,"Not Now","secondary")}</div>')
S2=phone(L,"",tab="Today",header=hdr(L,"Today",sub=F["day"]),overlay=sheet(L,"",install,right="",top=250),
         label="INSTALL &middot; IPHONE, SAFARI")

enrol=(f'<div style="text-align: center; padding: 70px 18px 0;">{keyed(L,64)}'
       f'<div style="font-size: 26px; font-weight: 700; color: {L["tp"]}; margin-top: 18px;">Enrol this device</div>'
       f'<div style="font-size: 15px; color: {L["ts"]}; line-height: 1.5; margin-top: 10px;">This one-time link came from '
       f'<b style="color: {L["tp"]};">Studio</b>. Enrolling makes a passkey on this phone; the link then stops working.</div>'
       f'<div style="margin-top: 26px; display: flex; justify-content: center;">'
       f'<button style="font: inherit; font-size: 16px; font-weight: 600; padding: 13px 22px; border-radius: 12px; border: 0; '
       f'background: {L["acc"]}; color: {L["onacc"]}; width: 100%;">Enrol with a Passkey</button></div>'
       f'<div style="font-size: 13px; color: {L["ts"]}; margin-top: 16px;">Name this device <b style="color: {L["tp"]};">Matt&rsquo;s iPhone</b> &middot; Change</div></div>')
S3=phone(L,enrol,tabs=False,label="FIRST OPEN &middot; A ONE-TIME LINK")

ask=(f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; background: {L["elevated"]}; padding: 13px 14px;">'
     f'<div style="display: flex; gap: 10px; align-items: flex-start;"><span style="display: flex; color: {L["acc"]};">{ic(I["bell"],19)}</span>'
     f'<div><div style="font-size: 15px; font-weight: 600; color: {L["tp"]};">Get a notification when something needs you?</div>'
     f'<div style="font-size: 13px; color: {L["ts"]}; margin-top: 3px; line-height: 1.45;">Only for Needs You &mdash; never for activity.</div>'
     f'<div style="display: flex; gap: 8px; margin-top: 11px;">{btn(L,"Turn On","affirm")}{btn(L,"Not Now","secondary")}</div></div></div></div>')
note=(f'<div style="border-radius: 18px; background: {rgba(L["surface"],0.96)}; border: 0.5px solid {L["bc"]}; padding: 11px 13px; '
      f'box-shadow: 0 6px 20px rgba(0,0,0,0.14);"><div style="display: flex; align-items: center; gap: 8px;">'
      f'<span style="width: 20px; height: 20px; border-radius: 5px; background: {L["acc"]}; display: inline-flex; align-items: center; '
      f'justify-content: center;"><svg viewBox="0 0 64 64" width="13" height="13"><path d="M12 12 H52 V52 H38 L12 26 Z" fill="none" '
      f'stroke="{L["onacc"]}" stroke-width="11"/></svg></span><span style="font-size: 12px; font-weight: 600; color: {L["ts"]};">METISTRY</span>'
      f'<span style="flex-grow: 1;"></span><span style="font-size: 12px; color: {L["ts"]};">now</span></div>'
      f'<div style="font-size: 14.5px; font-weight: 600; color: {L["tp"]}; margin-top: 5px;">Needs You &middot; Access</div>'
      f'<div style="font-size: 14px; color: {L["tp"]};">drey-dev wants to read Areas/Finance</div></div>')
S4=phone(L,ask + '<div style="height: 18px;"></div>' + secthead(L,"WHAT ARRIVES",mt=0) + note
         + nt(L,"Tapping opens that card in Needs You. It never says more than the card&rsquo;s title, and never a secret.",10),
         header=hdr(L,"Today",sub=F["day"]),label="NOTIFICATIONS &middot; ASKED IN CONTEXT")

VERBS=[("Reading","the last view, with its time: <i>Showing 9:04 AM</i>"),
       ("Capture &mdash; +, share, a note","<b>waits</b>, and sends with its idempotency key; the receipt says <i>Waiting</i>"),
       ("Tick a task","<b>waits</b> with the line it saw, and replays through the 409 check"),
       ("Answer a request","<b>not offered</b> &mdash; the buttons stay, in the disabled ink, under <i>Decisions need the connection</i>"),
       ("Send in Chat","<b>refused</b> with the reason; the draft stays in the composer with Try Again"),
       ("Move a card, Run Now, a mode or a grant","<b>not offered</b>")]
OFF=pan(L,"OFFLINE &mdash; ONE RULE PER VERB",
  f'<table style="width: 100%; border-collapse: collapse; font-size: 13px;">'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};"><td style="padding: 9px 14px 9px 0; color: {L["tp"]}; '
            f'font-weight: 600; white-space: nowrap; vertical-align: top;">{a}</td>'
            f'<td style="padding: 9px 0; color: {L["ts"]}; line-height: 1.5;">{b}</td></tr>' for a,b in VERBS) + '</table>'
  + nt(L,"Anything that has a consequence for someone else, or cannot be taken back, needs the server&rsquo;s answer "
         "before it happens. A note to yourself does not.",14))

NAVP=pan(L,"THE SHELL",
  nt(L,"<b>Five tabs, the bell and + in the header.</b> Today &middot; Chat &middot; Work &middot; Knowledge &middot; More "
       "(ruled 2026-09-24). Activity, Agents, Routines, Usage and Settings sit under More, in the Mac&rsquo;s order. "
       "No tab carries a badge; the bell is still the only one (P2).")
  + nt(L,"<b>Work&rsquo;s children are a segmented control</b> at the top of the tab &mdash; Board &middot; Projects &middot; "
         "Artifacts. Knowledge is its fold, then its areas.",12)
  + nt(L,"<b>Large titles collapse on scroll.</b> 44pt rows, 16pt gutters, the tokens&rsquo; type scale; the browser&rsquo;s "
         "text size is respected.",12)
  + nt(L,"<b>600&ndash;899px keeps the tab bar</b> and gains the usage gauge in the header; sheets become centred "
         "dialogs. <b>At 900px the sidebar returns.</b>",12))

nmore=narrow(L,group(L,[grow(L,"Activity",glyph="activity"),grow(L,"Agents",glyph="agents",detail="1 waiting"),
                        grow(L,"Routines",glyph="repeat",last=True)])
               + group(L,[grow(L,"Usage",glyph="gauge",detail="$41.20 of $60"),grow(L,"Settings",glyph="gear",last=True)]),
             tab="More",title="More",h=640)

body=(heading("PWA &middot; SCREEN 18","The shell &mdash; tabs, More, install, enrolment, notifications, offline",
        "Everything the phone has that the Mac does not, and the one rule that decides what works without a connection.",L)
  + row(S1+S2+S3+S4+f'<div style="flex-grow: 1; min-width: 0;">{NAVP}</div>',24)
  + row(nmore + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px;">{OFF}</div>',24))
(PROJ/"PWA-Shell.dc.html").write_text(page("PWA — Shell",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote PWA-Shell.dc.html ({CW}x{CH})")
