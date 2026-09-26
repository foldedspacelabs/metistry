"""The PWA at phone width (390pt) and in a narrow window (600–899px) — screen 18.

Ruled 2026-09-24: a bottom tab bar — Today · Chat · Work · Knowledge · More —
with the bell (and +) in the header, so Needs You is still the only badge.
At ≥900px the PWA is the Mac layout: sidebar, three top-right controls.
"""
from lib import *
from lib_today import *

PW,PH=390,844          # an iPhone 15/16 viewport
CWD=358                # content width inside 16pt gutters
TABS=[("Today","cal"),("Chat","chat"),("Work","work"),("Knowledge","know"),("More","more")]
I.setdefault("more",'<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/>')
I.setdefault("back",'<path d="M14.5 5.5L8 12l6.5 6.5"/>')
I.setdefault("share",'<path d="M12 3.5v11M8 7l4-3.5L16 7"/><path d="M6 11v8.5h12V11"/>')
I.setdefault("wifioff",'<path d="M3.5 8.5a13 13 0 0117 0M6.5 12a8.5 8.5 0 0111 0M9.5 15.5a4 4 0 015 0"/><circle cx="12" cy="18.5" r="1" fill="currentColor" stroke="none"/><path d="M4 4l16 16"/>')
I.setdefault("search",'<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>')

def tabbar(T,sel="Today",w=PW,safe=True):
    cells="".join(
        f'<div style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding-top: 7px; '
        f'color: {T["acc"] if n==sel else T["ts"]};">{ic(I[g],23,1.8 if n!=sel else 2.1)}'
        f'<span style="font-size: 10px; font-weight: {600 if n==sel else 500};">{n}</span></div>' for n,g in TABS)
    return (f'<div style="position: absolute; left: 0; right: 0; bottom: 0; height: {83 if safe else 56}px; '
            f'background: {T["surface"]}; border-top: 0.5px solid {T["bc"]}; display: flex; '
            + (f'padding: 0 {max(0,(w-560)//2)}px;' if w>600 else '') + f'">{cells}</div>')

def hdrbtns(T,count=str(F["needs_you"])):
    return (f'<span style="display: inline-flex; align-items: center; gap: 18px;">'
            f'<span style="display: flex; color: {T["acc"]};" aria-label="Capture">{ic(I["plus"],22)}</span>'
            f'<span aria-label="Needs You">{bell(T,count,22)}</span></span>')

def hdr(T,title,*,large=True,sub=None,back=None,right=None,w=PW):
    r=right if right is not None else hdrbtns(T)
    bar=(f'<div style="height: 44px; display: flex; align-items: center; padding: 0 16px; gap: 10px;">'
         + (f'<span style="display: inline-flex; align-items: center; gap: 2px; color: {T["acc"]}; font-size: 16px;">'
            f'{ic(I["back"],20,2.2)}{back}</span>' if back else "")
         + ('' if large else f'<span style="flex-grow: 1; text-align: center; font-size: 16px; font-weight: 600; color: {T["tp"]};">{title}</span>')
         + (f'<span style="flex-grow: 1;"></span>' if large else '') + r + '</div>')
    big=(f'<div style="padding: 0 16px 8px;"><div style="font-size: 30px; font-weight: 700; letter-spacing: -0.01em; '
         f'color: {T["tp"]};">{title}</div>'
         + (f'<div style="font-size: 13px; color: {T["ts"]}; margin-top: 1px;">{sub}</div>' if sub else '') + '</div>') if large else ""
    return f'<div style="background: {T["bg"]};">{bar}{big}</div>'

def offband(T,*,since="9:04 AM"):
    return (f'<div style="margin: 0 16px 8px; display: flex; gap: 9px; align-items: flex-start; background: {T["sunken"]}; '
            f'border-radius: 10px; padding: 9px 12px;">'
            f'<span style="display: flex; color: {T["ts"]}; margin-top: 1px;">{ic(I["wifioff"],15,1.9)}</span>'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.45;"><b>Can&rsquo;t reach Metistry.</b> '
            f'<span style="color: {T["ts"]};">Showing {since}. Notes and ticks wait for the connection; decisions don&rsquo;t.</span></div></div>')

def phone(T,body,*,tab="Today",header=None,band="",overlay="",tabs=True,h=PH,label=None):
    lab=(f'<div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; margin-bottom: 8px;">{label}</div>'
         if label else "")
    return (f'<div style="width: {PW}px; flex-shrink: 0;">{lab}'
            f'<div style="position: relative; width: {PW}px; height: {h}px; border-radius: 44px; overflow: hidden; '
            f'background: {T["bg"]}; border: 1px solid {T["bc"]}; box-shadow: 0 10px 30px rgba(26,24,21,0.10);">'
            f'<div style="height: 47px; background: {T["bg"]};"></div>'
            + (header or "") + band
            + f'<div style="padding: 4px 16px {100 if tabs else 30}px;">{body}</div>'
            + (tabbar(T,tab) if tabs else "") + overlay + '</div></div>')

def scrim(T): return ('rgba(0,0,0,0.42)' if T is D else 'rgba(26,24,21,0.28)')

def sheet(T,title,inner,*,top=58,right="Done",left=None):
    """A page sheet: the page behind dims and steps back. Needs You, Capture and
    Usage all arrive this way on a phone (app-ux-plan §3.3)."""
    return (f'<div style="position: absolute; inset: 0; background: {scrim(T)};"></div>'
            f'<div style="position: absolute; left: 0; right: 0; top: {top}px; bottom: 0; background: {T["bg"]}; '
            f'border-radius: 14px 14px 0 0; overflow: hidden; box-shadow: 0 -4px 24px rgba(0,0,0,0.18);">'
            f'<div style="display: flex; justify-content: center; padding-top: 6px;"><span style="width: 36px; height: 5px; '
            f'border-radius: 3px; background: {T["bc"]};"></span></div>'
            f'<div style="display: flex; align-items: center; padding: 8px 16px 10px; gap: 10px;">'
            + (f'<span style="font-size: 16px; color: {T["acc"]};">{left}</span>' if left else '<span style="width: 40px;"></span>')
            + f'<span style="flex-grow: 1; text-align: center; font-size: 16px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 16px; font-weight: 600; color: {T["acc"]}; min-width: 40px; text-align: right;">{right}</span></div>'
            f'<div style="padding: 0 16px 40px;">{inner}</div></div>')

def group(T,rows,head=None,foot=None):
    return ((f'<div style="font-size: 12.5px; color: {T["ts"]}; padding: 0 4px 6px; text-transform: none;">{head}</div>' if head else "")
            + f'<div style="background: {T["surface"]}; border-radius: 12px; overflow: hidden; border: 0.5px solid {T["border"]};">'
            + "".join(rows) + '</div>'
            + (f'<div style="font-size: 12px; color: {T["ts"]}; padding: 6px 4px 0; line-height: 1.45;">{foot}</div>' if foot else "")
            + '<div style="height: 18px;"></div>')

def grow(T,label,*,glyph=None,detail=None,chev=True,last=False,sub=None,tone=None,right=None):
    return (f'<div style="display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 14px; '
            f'box-sizing: border-box;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            + (f'<span style="display: flex; color: {tone or T["acc"]};">{ic(I[glyph],19,1.9)}</span>' if glyph else "")
            + f'<div style="flex-grow: 1; min-width: 0;"><div style="font-size: 15px; color: {T["tp"]};">{label}</div>'
            + (f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 1px; line-height: 1.4;">{sub}</div>' if sub else "")
            + '</div>'
            + (f'<span style="font-size: 14px; color: {T["ts"]}; flex-shrink: 0;">{detail}</span>' if detail else "")
            + (right or "")
            + (f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],14,2.3)}</span>' if chev else "") + '</div>')

def secthead(T,t,right=None,mt=16):
    return (f'<div style="display: flex; align-items: baseline; margin: {mt}px 0 8px;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{t}</span>'
            f'<span style="flex-grow: 1;"></span>'
            + (f'<span style="font-size: 13px; font-weight: 600; color: {T["acc"]};">{right}</span>' if right else "") + '</div>')

# ---- Today, one column ------------------------------------------------------
def pnow(T,at):
    return (f'<div style="display: flex; align-items: center; gap: 8px; padding: 10px 0 6px;">'
            f'<span style="font-size: 12px; font-weight: 700; color: {T["acc"]};">{at}</span>'
            f'<span style="width: 6px; height: 6px; border-radius: 50%; background: {T["acc"]};"></span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["acc"]};"></span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["acc"]};">NOW</span></div>')

def ptime(T,t): return f'<div style="font-size: 12px; color: {T["ts"]}; font-variant-numeric: tabular-nums;">{t}</div>'

def pmeet(T,time,title,sub,note=None,preps=()):
    return (f'<div style="padding: 11px 0; border-bottom: 1px solid {T["border"]};">{ptime(T,time)}'
            f'<div style="display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 2px;">'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{sub}</span>'
            + (f'<span style="font-size: 12.5px; font-weight: 600; color: {T["acc"]};">{note}</span>' if note else "")
            + '</div>' + "".join(prep2(T,*p) for p in preps) + '</div>')

def pgap(T,time,label,fits,rows):
    return (f'<div style="padding: 10px 0 2px; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 8px;">{ptime(T,time)}'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 12px; color: {T["ts"]};">{fits}</span></div>{rows}</div>')

def ptravel(T,t):
    return (f'<div style="display: flex; align-items: center; gap: 7px; padding: 8px 0; border-bottom: 1px solid {T["border"]}; '
            f'font-size: 12.5px; color: {T["ts"]};"><span style="display: flex; color: {T["tt"]};">{ic(I["promote"],13,2)}</span>{t}</div>')

def pspine(T,*,at="9:04 AM",standup=False,nextup_on=True):
    g1=(taskrow(T,title="Call the dentist",p=3,d="18 Sep",dover=True,e="15m",states=[("5th Day","deg",I["clock"])],pad=0)
        + taskrow(T,title="Book the lease walkthrough",p=2,d="Today",e="10m",people=["Tom Reyes"],pad=0,last=True))
    return (pnow(T,at)
      + (pmeet(T,"9:15&ndash;9:30 AM","Standup","6 people","in Next Up &uarr;") if standup else "")
      + pmeet(T,F["one_on_one"],"1:1 with Jim Fallon","every other Tuesday","in Next Up &uarr;" if nextup_on else None)
      + pgap(T,"10:00 AM","35M FREE","both fit",g1)
      + ptravel(T,"25m travel &mdash; to the Ann Arbor office")
      + pmeet(T,F["design_review"],"Design review","4 people &middot; in person",
              preps=((I["board"],"in review, and what this is about",(("agent","Work #418",I["agents"]),)),))
      + ptravel(T,"25m travel &mdash; back"))

def ptodaypage(T,*,moment="first"):
    if moment=="first":
        return (daybar7(T,phone=True) + '<div style="height: 12px;"></div>' + brief(T,w=CWD,phone=True)
                + '<div style="height: 10px;"></div>' + nextup(T,kind="standup",mins=23,w=CWD,phone=True)
                + pspine(T,at="8:52 AM",standup=True,nextup_on=False))
    if moment=="next":
        return (brief(T,state="folded",w=CWD,phone=True) + '<div style="height: 10px;"></div>'
                + nextup(T,w=CWD,phone=True) + pspine(T))
    return (brief(T,state="folded",w=CWD,phone=True) + '<div style="height: 10px;"></div>' + closeday(T,w=CWD,phone=True))

def prightnow(T):
    agents=(agentrow(T,"drey-dev","migrating the settings pane &middot; 12m in","working")
            + agentrow(T,"taskuary",f'waiting on you: write access to <b>docs/</b> '
                       f'<span style="color: {T["acc"]}; font-weight: 600;">Answer</span>',"waiting")
            + agentrow(T,"claude-usage","cache report finished &middot; 4 findings","done",last=True))
    changes=(changerow(T,"<b>Design review</b> moved to 11:00 AM","20m ago")
             + changerow(T,"Jim replied about the SOW","41m ago",last=True))
    return (secthead(T,"AGENTS",mt=4) + agents + secthead(T,"SINCE YOU LAST LOOKED","8:52 AM") + changes)

# ---- narrow window ------------------------------------------------------------
def narrow(T,body,*,tab="Today",title="Today",sub=None,w=820,h=1100,side=None,overlay=""):
    """600–899px: the phone's shell with room — tab bar, header controls, and one
    column capped at the reading measure; a second column only where the Mac
    has one (Today's rail), from 760px."""
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 14px 24px 6px;">'
          f'<span style="font-size: 26px; font-weight: 700; color: {T["tp"]};">{title}</span>'
          + (f'<span style="font-size: 13px; color: {T["ts"]}; margin-top: 6px;">{sub}</span>' if sub else "")
          + f'<span style="flex-grow: 1;"></span>{hdrbtns(T)}'
          f'<span style="display: flex; color: {T["ts"]}; margin-left: 4px;" aria-label="Usage">{ic(I["gauge"],21)}</span></div>')
    cols=(f'<div style="display: flex; gap: 22px; padding: 8px 24px 90px; align-items: flex-start;">'
          f'<div style="flex-grow: 1; min-width: 0; max-width: 640px;">{body}</div>'
          + (f'<div style="width: 250px; flex-shrink: 0;">{side}</div>' if side else "") + '</div>')
    return (f'<div style="position: relative; width: {w}px; height: {h}px; border-radius: 16px; overflow: hidden; '
            f'background: {T["bg"]}; border: 1px solid {T["bc"]}; flex-shrink: 0; box-shadow: 0 10px 30px rgba(26,24,21,0.10);">'
            f'<div style="height: 28px; background: {T["sunken"]}; border-bottom: 1px solid {T["border"]}; display: flex; '
            f'align-items: center; gap: 6px; padding: 0 12px;">'
            + "".join(f'<span style="width: 10px; height: 10px; border-radius: 50%; background: {T["bc"]};"></span>' for _ in range(3))
            + f'<span style="flex-grow: 1; text-align: center; font-size: 11.5px; color: {T["ts"]};">Metistry</span></div>'
            + head + cols + tabbar(T,tab,w=w,safe=False) + overlay + '</div>')
