"""Today v7 — one morning, Next Up, close the day (2026-09-24).

Components for review 01's adopted opportunities 1–5 and 8, and rulings C97
(one Morning Brief, shown as Today) and C98 (tick a task where it is shown).
Every one takes a width so the PWA reuses it at 390pt (screen 18).
"""
from lib import *

BRIEF_TEXT=("Four things today, and one of them moved: the lease comparables came back <b>4% under</b> Jim&rsquo;s "
            "number, so the SOW is worth signing before your 9:30. <b>#418</b> is still blocked on the vendor terms. "
            "The settings brief has your 3:30 focus block.")
BRIEF_ONE="Four things today; the lease comparables are the one that moved."
STANDUP=[("Yesterday","Shipped the tokens pass; reviewed drey-dev&rsquo;s migration."),
         ("Today","The settings brief; signing the SOW."),
         ("Blockers","#418 waits on the vendor terms.")]

def eyebrow(T,t,col=None,mt=0):
    return (f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {col or T["tt"]}; '
            f'margin-top: {mt}px;">{t}</div>')

def standupsec(T,*,open_=True,phone=False):
    head=(f'<div style="display: flex; align-items: center; gap: 8px;">'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"] if open_ else I["chevr"],12,2.4)}</span>'
          f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Standup</span>'
          + ("" if phone else f'<span style="font-size: 12px; color: {T["ts"]};">9:15 AM &middot; ready to copy</span>')
          + f'<span style="flex-grow: 1;"></span>{btn(T,"Copy Standup","secondary",I["copy"])}</div>')
    if not open_: return head
    body="".join(f'<div style="display: flex; gap: 10px; margin-top: 6px;">'
                 f'<span style="width: 74px; flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: {T["ts"]}; padding-top: 2px;">{k}</span>'
                 f'<span style="font-family: {SERIF}; font-size: 13.5px; color: {T["tp"]}; line-height: 1.5;">{v}</span></div>'
                 for k,v in STANDUP)
    return (head + f'<div style="margin: 6px 0 0 20px;">{body}'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">Metistry doesn&rsquo;t post this. '
            f'Copy it and paste it yourself.</div></div>')

def brief(T,*,state="open",standup_open=False,w=None,phone=False):
    """C97: the one Morning Brief, and it is Today's first state. The plan is not
    repeated inside it — the plan IS the day below it, so the brief points there."""
    wd=f"width: {w}px; box-sizing: border-box;" if w else ""
    if state=="folded":
        return (f'<div style="{wd} display: flex; align-items: center; gap: 9px; background: {T["agq"]}; '
                f'border-radius: 10px; padding: 9px 13px;">'
                f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2)}</span>'
                f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]}; white-space: nowrap;">Morning Brief</span>'
                + ("" if phone else f'<span style="font-size: 12.5px; color: {T["ts"]}; min-width: 0; overflow: hidden; '
                   f'text-overflow: ellipsis; white-space: nowrap;">&mdash; {BRIEF_ONE}</span>')
                + f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; color: {T["ts"]};">6:02 AM</span>'
                f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],12,2.4)}</span></div>')
    if state in ("absent","failed"):
        g,c,t,b,a=((I["cal"],T["ts"],"No brief this morning.",
                    "<b>Me/profile.md</b> has no working days, so the brief wrote nothing rather than guess. "
                    "The day below is still complete.","Set Your Working Days") if state=="absent" else
                   (I["failed"],T["fail"],"The brief didn&rsquo;t run.",
                    "Last succeeded yesterday at 6:02 AM &middot; collator couldn&rsquo;t read <b>Areas/Finance</b>. "
                    "The day below is still complete.","Open the Run"))
        return (f'<div style="{wd} display: flex; gap: 11px; align-items: flex-start; background: {T["sunken"]}; '
                f'border-radius: 11px; padding: 12px 14px;">'
                f'<span style="display: flex; color: {c}; margin-top: 1px;">{ic(g,15,2)}</span>'
                f'<div style="flex-grow: 1; min-width: 0;"><div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{t}</div>'
                f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5; margin-top: 3px;">{b}</div>'
                f'<div style="margin-top: 9px;">{btn(T,a,"secondary")}</div></div></div>')
    head=(f'<div style="display: flex; align-items: center; gap: 7px;">'
          f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],14,1.9)}</span>'
          f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">MORNING BRIEF</span>'
          f'<span style="font-size: 11px; color: {T["ts"]};">{AN.title()} &middot; 6:02 AM</span>'
          f'<span style="flex-grow: 1;"></span>{thumbs(T)}'
          f'<span style="display: flex; color: {T["ts"]}; margin-left: 2px;">{ic(I["chevd"],13,2.3)}</span></div>')
    text=(f'<div style="font-family: {SERIF}; font-size: {15 if not phone else 15.5}px; line-height: 1.58; '
          f'color: {T["tp"]}; margin-top: 9px;">{BRIEF_TEXT}</div>')
    sec=(f'<div style="margin-top: 12px; padding-top: 11px; border-top: 1px solid {rgba(T["ag"],0.18)};">'
         + standupsec(T,open_=standup_open,phone=phone) + '</div>')
    foot=(f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 11px; flex-wrap: wrap;">'
          f'<span style="font-size: 12px; color: {T["ts"]};"><b style="color: {T["tp"]};">The plan is the day below</b> '
          f'&middot; 7 tasks, 2 carried</span><span style="flex-grow: 1;"></span>'
          + mono(F["brief_file"],T["ts"],10.5) + '</div>')
    return (f'<div style="{wd} background: {T["agq"]}; border-radius: 12px; padding: 13px 15px 12px;">'
            f'{head}{text}{sec}{foot}</div>')

def tickbox(T,state="open"):
    """C98: live. One click ticks; the receipt carries Undo."""
    return box(T,state=="done")

def taskrow(T,*,title,done=False,receipt=None,last=False,hover=False,pad=14,**kw):
    bits=facets(T,**kw)
    col=T["tt"] if done else T["tp"]
    deco="text-decoration: line-through;" if done else ""
    rec=""
    if receipt=="done":
        rec=(f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 11.5px; color: {T["ts"]};">'
             f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],12,2.3)}</span>Done &middot; written to '
             + mono(F["daily_note"],T["ts"],10.5)
             + f'<span style="font-weight: 600; color: {T["acc"]};">Undo</span></div>')
    if receipt=="queued":
        rec=(f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 11.5px; color: {T["ts"]};">'
             f'<span style="display: flex; color: {T["ts"]};">{ic(I["clock"],12,2.2)}</span>Waiting for the connection'
             f'<span style="font-weight: 600; color: {T["acc"]};">Undo</span></div>')
    if receipt=="stale":
        rec=(f'<div style="margin-top: 7px; background: {T["staleq"]}; border-radius: 8px; padding: 8px 10px; '
             f'font-size: 11.5px; color: {T["stale"]}; line-height: 1.5;">This line changed in your note since it was '
             f'shown. Nothing was written.<div style="font-family: {MONO}; font-size: 11px; color: {T["tp"]}; margin-top: 4px;">'
             f'- [ ] Call the dentist about the crown &#128197; 2026-09-18</div></div>')
    hov=(f'<span style="display: inline-flex; gap: 6px; flex-shrink: 0;">{btn(T,"Delegate","secondary",I["spark"])}</span>'
         if hover else "")
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 10px {pad}px; '
            f'background: {T["surface"] if hover else "transparent"}; border-radius: {8 if hover else 0}px;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="margin-top: 2px; display: flex;">{box(T,done)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 14px; color: {col}; {deco}">{title}</div>'
            + (f'<div style="display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 6px;">'
               + "".join(bits) + '</div>' if bits and not done else "")
            + rec + '</div>' + hov + '</div>')

def compactmeet(T,time,title,sub,note=None,w92=True):
    return (f'<div style="display: flex; gap: 10px; padding: 11px 0; border-bottom: 1px solid {T["border"]}; align-items: baseline;">'
            + (timecol(T,time) if w92 else "")
            + f'<div style="flex-grow: 1; min-width: 0; display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap;">'
            f'<span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{sub}</span>'
            + (f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">{note}</span>' if note else "")
            + '</div></div>')

def nextup(T,*,kind="meeting",mins=26,w=None,phone=False):
    """Review 01 §5.3: Today's best idea, promoted. Sticky under the header from
    thirty minutes before the next event. Retrieved facts first; one generated
    line, attributed; one prediction with its reason."""
    wd=f"width: {w}px; box-sizing: border-box;" if w else ""
    top=(f'<div style="display: flex; align-items: center; gap: 8px;">'
         f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["acc"]};">NEXT UP &middot; IN {mins} MIN</span>'
         f'<span style="flex-grow: 1;"></span>'
         f'<span style="font-size: 12px; color: {T["ts"]}; font-variant-numeric: tabular-nums;">'
         + ("9:15&ndash;9:30 AM" if kind=="standup" else F["one_on_one"]) + '</span></div>')
    if kind=="none":
        return (f'<div style="{wd} border: 1px solid {T["border"]}; border-radius: 12px; background: {T["surface"]}; '
                f'padding: 11px 14px; font-size: 12.5px; color: {T["ts"]};">Nothing else on your calendar today.</div>')
    if kind=="standup":
        body=(f'<div style="display: flex; align-items: baseline; gap: 9px; margin-top: 5px; flex-wrap: wrap;">'
              f'<span style="font-size: 16px; font-weight: 600; color: {T["tp"]};">Standup</span>'
              f'<span style="font-size: 12px; color: {T["ts"]};">6 people &middot; video</span></div>'
              f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 10px; flex-wrap: wrap;">'
              f'<span style="font-size: 12.5px; color: {T["ts"]};">Your draft is in the brief.</span>'
              f'<span style="flex-grow: 1;"></span>{btn(T,"Copy Standup","secondary",I["copy"])}'
              f'{btn(T,"Join","secondary",I["display"])}</div>')
    else:
        owe=taskrow(T,title="Sign the SOW",p=1,d="Today",e="15m",pad=0,last=True)
        last=taskrow(T,title="Send Jim the revised Q4 scope",p=2,e="30m",states=[("3rd Day","deg",I["clock"])],pad=0,last=True)
        gen=(f'<div style="background: {T["agq"]}; border-radius: 9px; padding: 9px 11px; margin-top: 10px;">'
             f'<div style="display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; '
             f'letter-spacing: 0.07em; color: {T["ag"]};">{ic(I["spark"],12,2)}{AN}'
             f'<span style="font-weight: 400; letter-spacing: 0; color: {T["ts"]};">written, not retrieved</span></div>'
             f'<div style="font-family: {SERIF}; font-size: 13.5px; color: {T["tp"]}; line-height: 1.5; margin-top: 4px;">'
             f'He has been waiting on the SOW since Tuesday; the comparables in last night&rsquo;s fold are the '
             f'answer he was missing.</div></div>')
        acts=(f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap;">'
              f'{btn(T,"Open Notes","secondary",I["note"])}{btn(T,"Record","secondary",I["rec"])}'
              + ('' if phone else '<span style="flex-grow: 1;"></span>')
              + f'<span style="display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
              f'{btn(T,"Draft the Agenda","secondary",I["spark"])}'
              f'<span style="font-size: 11.5px; color: {T["ts"]};">3 open items with Jim</span></span></div>')
        body=(f'<div style="display: flex; align-items: baseline; gap: 9px; margin-top: 5px; flex-wrap: wrap;">'
              f'<span style="font-size: 16px; font-weight: 600; color: {T["tp"]};">1:1 with Jim Fallon</span>'
              f'<span style="font-size: 12px; color: {T["ts"]};">every other Tuesday &middot; video</span></div>'
              + eyebrow(T,"YOU OWE HIM",mt=11) + owe
              + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap;">'
              + eyebrow(T,"LAST TIME") + ent(T,"note","6 September",I["note"])
              + f'<span style="font-size: 12px; color: {T["ts"]};">3 action items &middot; 2 done</span></div>'
              + last + gen + acts)
    return (f'<div style="{wd} border: 1px solid {T["bc"]}; border-radius: 12px; background: {T["elevated"]}; '
            f'padding: 12px 15px 13px; box-shadow: 0 6px 18px rgba(26,24,21,0.08);">{top}{body}</div>')

def fold7(T,label):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0;">{timecol(T,"")}'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],13,2.3)}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{label}</span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["border"]};"></span></div>')

def gap7(T,span,label,fits,rows):
    return (f'<div style="padding: 10px 0; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px;">{timecol(T,span)}'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["border"]};"></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{fits}</span></div>'
            f'<div style="margin-left: 88px;">{rows}</div></div>')

def calhelp7(T):
    """Folded to one line with its prediction: one Metis voice open at a time."""
    return (f'<div style="margin: 8px 0 2px 102px; display: flex; align-items: center; gap: 9px; flex-wrap: wrap; '
            f'background: {T["agq"]}; border-radius: 10px; padding: 8px 12px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2)}</span>'
            f'<span style="font-size: 12.5px; color: {T["tp"]};">Move the lease call to 1:45 and your focus block '
            f'starts at 2:15 &mdash; 2h 45m for the brief, not 90m.</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Move the Lease Call&hellip;","secondary",I["spark"])}'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],12,2.4)}</span></div>')

def spine7(T,*,at="9:04 AM",past="Earlier today &mdash; <b>Standup</b> &middot; 3 items moved at your request &middot; 2 carried forward",
           nextup_on=True,standup=False):
    g1=(taskrow(T,title="Call the dentist",p=3,d="18 Sep",dover=True,e="15m",states=[("5th Day","deg",I["clock"])])
        + taskrow(T,title="Book the lease walkthrough",p=2,d="Today",e="10m",people=["Tom Reyes"],last=True))
    g2=(taskrow(T,title="Read drey-dev&rsquo;s migration notes",p=3,e="30m",links=[("agent","Work #418",I["agents"])])
        + taskrow(T,title="Renew the parking permit",p=3,d="Today",e="10m",last=True))
    g3=taskrow(T,title="Write the design brief for the settings pane",p=1,d="Wed",e="90m",
               links=[("project","Settings Pane",I["board"])],last=True)
    out=((fold7(T,past) if past else "") + nowbar(T,at)
      + (compactmeet(T,"9:15&ndash;9:30 AM","Standup","6 people &middot; video","in Next Up &uarr;") if standup else "")
      + compactmeet(T,F["one_on_one"],"1:1 with Jim Fallon","every other Tuesday",
                    "in Next Up &uarr;" if nextup_on else None)
      + gap7(T,"10:00 AM","35M FREE","both fit &middot; 10m to spare",g1)
      + travel(T,"25m","to the Ann Arbor office")
      + f'<div style="display: flex; gap: 10px; padding: 12px 0; border-bottom: 1px solid {T["border"]};">'
        f'{timecol(T,F["design_review"])}<div style="flex-grow: 1; min-width: 0;">'
        f'<div style="display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap;">'
        f'<span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Design review</span>'
        f'<span style="font-size: 12px; color: {T["ts"]};">4 people &middot; in person</span></div>'
        + prep2(T,I["board"],"in review, and what this is about",(("agent","Work #418",I["agents"]),))
        + prep2(T,I["clock"],"its brief is in the focus block at 3:30 PM") + '</div></div>'
      + travel(T,"25m","back")
      + gap7(T,"12:10 PM","50M FREE","both fit &middot; 10m to spare",g2)
      + compactmeet(T,"1:00&ndash;1:45 PM","Vendor review","3 people &middot; video &middot; you owe Kessler nothing yet")
      + compactmeet(T,"3:00&ndash;3:30 PM","Lease call with Tom Reyes","2 people &middot; video")
      + calhelp7(T)
      + f'<div style="display: flex; gap: 10px; padding: 12px 0; border-bottom: 1px solid {T["border"]};">'
        f'{timecol(T,"3:30&ndash;5:00 PM")}<div style="flex-grow: 1; min-width: 0;">'
        f'<div style="display: flex; align-items: center; gap: 9px;">'
        f'<span style="display: flex; color: {T["acc"]};">{ic(I["clock"],14,1.9)}</span>'
        f'<span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Focus &mdash; the settings brief</span>'
        f'{ent(T,"plain","90m")}</div><div style="margin-top: 4px;">{g3}</div></div></div>'
      + f'<div style="display: flex; gap: 10px; padding: 11px 0; align-items: center;">{timecol(T,"5:30 PM")}'
        f'<span style="display: flex; color: {T["ts"]};">{ic(I["check"],13,2.2)}</span>'
        f'<span style="font-size: 12.5px; color: {T["ts"]};">Your day ends &middot; <b style="color: {T["tp"]};">Close the Day</b> '
        f'opens here at 5:00</span></div>')
    return out

def rail7(T,w=286,at="9:04 AM"):
    agents=(agentrow(T,"drey-dev","migrating the settings pane &middot; 12m in","working")
            + agentrow(T,"taskuary",f'waiting on you: write access to <b>docs/</b> '
                       f'<span style="color: {T["acc"]}; font-weight: 600;">Answer</span>',"waiting")
            + agentrow(T,"claude-usage","cache report finished &middot; 4 findings","done",last=True))
    changes=(changerow(T,"<b>Design review</b> moved to 11:00 AM","20m ago")
             + changerow(T,"Jim replied about the SOW","41m ago")
             + changerow(T,"<b>Work #418</b> went to review","1h ago",last=True))
    return (f'<div style="width: {w}px; flex-shrink: 0; border-left: 1px solid {T["border"]}; padding: 16px 16px 16px 18px; '
            f'background: {T["bg"]};">'
            + railsec(T,"NEEDS YOU",
                f'<div style="display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: {T["ts"]};">'
                f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"],15)}</span>'
                f'<span><b style="color: {T["tp"]};">{F["needs_you"]} waiting</b> &mdash; one is about today</span></div>',"Open")
            + railsec(T,"AGENTS",agents)
            + railsec(T,"SINCE YOU LAST LOOKED",changes,at) + '</div>')

def closeday(T,*,closed=False,w=None,phone=False):
    """Review 01 §5.5. The end of the day has a screen. What it stores is app
    state (B4's reading, still the owner's to rule); nothing edits a note, and
    tomorrow's plan reads it at 7 PM."""
    wd=f"width: {w}px; box-sizing: border-box;" if w else ""
    if closed:
        return (f'<div style="{wd} border: 1px solid {T["border"]}; border-radius: 10px; background: {T["surface"]}; '
                f'padding: 10px 13px; font-size: 12.5px; color: {T["ts"]};">'
                f'<div style="display: flex; align-items: center; gap: 9px;">'
                f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],14,2.2)}</span>'
                f'<span><b style="color: {T["tp"]};">Day closed at 5:14 PM</b> &middot; 6 done &middot; 2 to tomorrow &middot; 1 this week</span>'
                f'<span style="flex-grow: 1;"></span><span style="font-weight: 600; color: {T["acc"]};">Reopen</span></div>'
                f'<div style="display: flex; gap: 12px; flex-wrap: wrap; margin: 6px 0 0 23px; font-size: 11.5px;">'
                + mono(F["close_file"],T["ts"],10.5)
                + f'<span>&middot; 3 tasks rescheduled in their notes</span>'
                f'<span>&middot; tomorrow&rsquo;s plan written</span></div></div>')
    choice=lambda sel:segchoice(T,[(I["chevr"],"Tomorrow"),(I["cal"],"This Week"),(I["later"],"Someday")],sel)
    def openrow(title,bits,sel,last=False):
        return (f'<div style="display: flex; gap: 11px; align-items: {"flex-start" if phone else "center"}; padding: 9px 0; '
                f'flex-wrap: {"wrap" if phone else "nowrap"};'
                + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
                f'<span style="display: flex; margin-top: 2px;">{box(T)}</span>'
                f'<div style="flex-grow: 1; min-width: 0;"><div style="font-size: 13.5px; color: {T["tp"]};">{title}</div>'
                f'<div style="display: flex; gap: 7px; flex-wrap: wrap; margin-top: 5px;">{"".join(bits)}</div></div>'
                f'<span style="flex-shrink: 0; {"margin-left: 27px;" if phone else ""}">{choice(sel)}</span></div>')
    done=(f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: {T["ts"]};">'
          + "".join(f'<span style="display: inline-flex; align-items: center; gap: 5px;"><span style="display: flex; color: {T["ok"]};">'
                    f'{ic(I["check"],12,2.4)}</span>{t}</span>'
                    for t in ("Sign the SOW","Call the dentist","Write the design brief"))
          + f'<span style="color: {T["acc"]}; font-weight: 600;">+3 more</span></div>')
    opens=(openrow("Read drey-dev&rsquo;s migration notes",[prio(T,3),est(T,"30m")],"Tomorrow")
           + openrow("Renew the parking permit",[prio(T,3),due(T,"Today",True),est(T,"10m")],"Tomorrow")
           + openrow("Send Jim the revised Q4 scope",[prio(T,2),ent(T,"person","Jim Fallon",I["person"]),
                     st(T,"4th Day","deg",I["clock"])],"This Week",last=True))
    owed=("".join(f'<div style="display: flex; align-items: baseline; gap: 8px; padding: 5px 0; font-size: 12.5px; color: {T["ts"]};">'
                  f'{ent(T,"person",p,I["person"])}<span>{what}</span></div>'
                  for p,what in (("Jim Fallon","the revised Q4 scope &middot; 4th day"),
                                 ("Sam Kessler","the revised volume numbers &middot; due Thu, from the Vendor review"))))
    tmr=(f'<div style="display: flex; gap: 3px; margin-top: 6px;">'
         + "".join(f'<div style="width: {wv}%; height: 18px; border-radius: 4px; background: '
                   f'{seghex(T,0,T is D) if k=="m" else T["sunken"]};"></div>'
                   for k,wv in (("m",8),("g",14),("m",12),("g",30),("m",10),("g",26)))
         + f'</div><div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 5px;">3 meetings &middot; 4h 40m free &middot; '
           f'2 tasks already due</div>')
    return (f'<div style="{wd} border: 1px solid {T["bc"]}; border-radius: 13px; background: {T["elevated"]}; '
            f'padding: 14px 16px 15px; box-shadow: 0 6px 18px rgba(26,24,21,0.08);">'
            f'<div style="display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Close the Day</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">5:08 PM &middot; your day ends at 5:30</span></div>'
            + eyebrow(T,"DONE &middot; 6",mt=13) + f'<div style="margin-top: 6px;">{done}</div>'
            + eyebrow(T,"STILL OPEN &middot; 3",mt=14) + opens
            + eyebrow(T,"OWED TO PEOPLE &middot; 2",mt=12) + owed
            + eyebrow(T,"TOMORROW &middot; WEDNESDAY 23 SEPTEMBER",mt=12) + tmr
            + eyebrow(T,"A LINE FOR TOMORROW",mt=13)
            + f'<div style="margin-top: 6px; border: 1px solid {T["bc"]}; border-radius: 9px; background: {T["surface"]}; '
              f'padding: 8px 11px; font-size: 13px; color: {T["tp"]}; line-height: 1.45;">Kessler first &mdash; the volume '
              f'numbers decide the renewal.</div>'
            + f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap;">'
              f'{btn(T,"Close the Day","affirm",I["check"])}'
              f'<span style="font-size: 12px; color: {T["ts"]}; line-height: 1.45;">Saves the day to '
              + mono(F["close_file"],T["ts"],10.5)
              + f', reschedules 3 tasks in their notes, and writes tomorrow&rsquo;s plan.</span></div></div>')

def todaywin7(T,*,at,top,spine,w=1280,dark=False,rail_at="yesterday"):
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{toolbar(T)}<div style="display: flex;">{sidebar8(T)}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex;">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="padding: 14px 18px 13px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">'
            f'<span style="font-size: 20px; font-weight: 650; color: {T["tp"]};">Today</span>'
            f'<span style="font-size: 13px; color: {T["ts"]};">{F["day"]}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">as of 2 min ago</span>{seg(T)}</div>'
            f'{daybar7(T,dark)}</div>'
            f'<div style="padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 12px; max-width: 760px;">'
            f'{top}<div>{spine}</div>{askbar(T)}</div></div>{rail7(T,at=rail_at)}</div></div></div>')

SEGS7=[("Meetings",162,0),("Travel",50,1),("Focus Blocked",90,2),("Tasks That Fit",65,3),("Doesn’t Fit",0,"deg")]
def daybar7(T,dark=False,phone=False):
    tot=sum(v for _,v,_ in SEGS7)
    bars="".join(f'<div style="width: {v/tot*100:.1f}%; background: {seghex(T,k,dark)};"></div>' for _,v,k in SEGS7 if v)
    legend="".join(f'<span style="display: inline-flex; align-items: center; gap: 5px;">'
                   f'<span style="width: 8px; height: 8px; border-radius: 2px; background: {seghex(T,k,dark) if v else "transparent"}; '
                   f'box-sizing: border-box; border: {"0" if v else "1.5px solid "+T["tt"]};"></span>'
                   f'<span style="color: {T["ts"]};">{n}</span><span style="color: {T["tt"]};">{v}m</span></span>'
                   for n,v,k in SEGS7)
    return (f'<div><div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; flex-wrap: wrap;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">THE DAY</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">5h 2m committed of 9h &middot; everything planned fits</span></div>'
            f'<div style="display: flex; gap: 2px; height: 8px; border-radius: 999px; overflow: hidden; '
            f'background: {T["sunken"]};">{bars}</div>'
            + ("" if phone else f'<div style="display: flex; gap: 14px; margin-top: 8px; font-size: 11px; flex-wrap: wrap;">{legend}</div>')
            + '</div>')
