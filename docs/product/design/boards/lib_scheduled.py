"""Scheduled (was Routines v2) — everything Metistry does on a schedule, visible and editable (2026-09-25).

Ruled: standup is a routine in the standard pattern, and the owner can see, edit
and customise every scheduled thing — the routines Metistry ships with included,
and the syncs that read connections. Nothing scheduled is hidden as "built-in".
"""
from lib import *
from lib_needs import srcbadge, SRC, rhead2
I.setdefault("pause",'<path d="M9 6v12M15 6v12"/>')
I.setdefault("reset",'<path d="M5 12a7 7 0 107-7H8"/><path d="M10.5 2.5L8 5l2.5 2.5"/>')

def default_tag(T):
    return (f'<span style="font-size: 10.5px; color: {T["ts"]}; border: 1px solid {T["bc"]}; border-radius: 999px; '
            f'padding: 0 7px; line-height: 16px;">default</span>')

def occ2(T,*,at,name,runner,recur,state=None,default=False,feeds=None,last=False,sel=False):
    mark={"fail":f'<span style="display: flex; color: {T["fail"]};">{ic(I["failed"],13,2.2)}</span>',
          "ok":f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],13,2.3)}</span>',
          "paused":f'<span style="display: flex; color: {T["tt"]};">{ic(I["pause"],13,2.2)}</span>'}.get(state,"<span></span>")
    feed=(f'<span style="font-size: 11.5px; color: {T["ts"]};">&rarr; {feeds}</span>' if feeds else "")
    return (f'<div style="display: grid; grid-template-columns: 15px 74px minmax(0,1fr) 130px 230px; align-items: center; '
            f'gap: 13px; padding: 10px 16px; background: {T["surface"] if sel else "transparent"}; box-shadow: {"inset 3px 0 0 "+T["acc"] if sel else "none"}; {bd_(T,last)}">{mark}'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; font-variant-numeric: tabular-nums;">{at}</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
            f'<span style="font-size: 13px; font-weight: {600 if sel else 500}; color: {T["tp"]};">{name}</span>'
            + (default_tag(T) if default else "") + feed + '</span>'
            f'<span>{agentchip(T,runner)}</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 6px;"><span style="display: flex; color: {T["tt"]};">'
            f'{ic(I["repeat"],13,1.9)}</span><span style="font-size: 12px; color: {T["ts"]};">{recur}</span></span></div>')

def tabs(T,sel):
    return (f'<div style="display: inline-flex; padding: 2px; border-radius: 9px; background: {T["sunken"]};">'
            + "".join(f'<span style="padding: 5px 16px; border-radius: 7px; font-size: 12.5px; font-weight: {600 if n==sel else 500}; '
                      f'color: {T["tp"] if n==sel else T["ts"]}; background: {T["bg"] if n==sel else "transparent"}; '
                      f'box-shadow: {"0 1px 2px rgba(0,0,0,0.12)" if n==sel else "none"};">{n} '
                      f'<span style="color: {T["ts"]}; font-weight: 400;">{c}</span></span>' for n,c in (("Routines",10),("Syncs",5)))
            + '</div>')

def rhead_list(T,sel):
    return (f'<div style="display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Scheduled</span>{tabs(T,sel)}'
            f'<span style="flex-grow: 1;"></span>{btn(T,"New Routine" if sel=="Routines" else "New Sync","secondary",I["plus"])}</div>')

def routines_list(T,*,sel="Standup",w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    cols=(f'<div style="display: grid; grid-template-columns: 15px 74px minmax(0,1fr) 130px 230px; gap: 13px; '
          f'padding: 6px 16px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>WHEN</span><span>ROUTINE</span><span>RUN BY</span><span>RECURRENCE</span></div>')
    allday=(dayband(T,"THROUGHOUT THE DAY")
        + occ2(T,at="&middot;",name="Inbox Sort",runner="metis",recur="Every 5 minutes",state="ok",default=True,feeds="Needs You")
        + occ2(T,at="&middot;",name="Usage Rollup",runner="metis",recur="Every hour",state="ok",default=True,feeds="Usage",last=True))
    today=(dayband(T,"TODAY &middot; TUESDAY")
        + occ2(T,at="6:00 AM",name="Standup",runner="metis",recur="Working days at 6:00 AM",state="ok",default=True,
               feeds="Morning Brief",sel=(sel=="Standup"))
        + occ2(T,at="6:02 AM",name="Morning Brief",runner="metis",recur="Every day at 6:02 AM",state="ok",default=True,
               feeds="Today &middot; your note")
        + occ2(T,at="7:00 AM",name="Vendor Sweep",runner="vendor-research",recur="Every day at 7:00 AM",state="fail")
        + occ2(T,at="7:00 PM",name="Tomorrow&rsquo;s Plan",runner="metis",recur="Working evenings, or when you close the day",
               default=True,feeds="Morning Brief")
        + occ2(T,at="10:00 PM",name="Knowledge Fold",runner="metis",recur="Every night at 10:00 PM",default=True)
        + occ2(T,at="11:00 PM",name="Reply Review",runner="metis",recur="Every night at 11:00 PM",default=True,last=True))
    later=(dayband(T,"SUNDAY")
        + occ2(T,at="6:00 PM",name="Weekly Review",runner="metis",recur="Sundays at 6:00 PM",default=True,last=True))
    off=(dayband(T,"PAUSED")
        + occ2(T,at="&mdash;",name="Inbox Triage",runner="inbox-triage",recur="Paused 4 days ago by you",state="paused",last=True))
    return (f'<div style="{wd} background: {T["bg"]};">{rhead_list(T,"Routines")}'
            f'<div style="padding: 0 16px 12px;">{timeline(T)}</div>{cols}{allday}{today}{later}{off}</div>')

# ---- syncs: scheduled reads from one connection (C113) ------------------------------------
from lib_connect import tglyph, ref
SYNCS=[("GitHub","GitHub","api","Pull requests and issues in your repos","Every 15 minutes","4 min ago","ok","Raises: reviews requested of you &middot; replies to you"),
       ("Devin Sessions","Devin","mcp","Results of work Metis sent","Every 5 minutes","2 days ago &middot; key expired","fail",None),
       ("Devin Knowledge","Devin","mcp","Knowledge notes and repo wikis","Every hour","2 days ago &middot; key expired","fail",None),
       ("AWS Costs","AWS","api","Spend per service","Every 6 hours","3 days ago","stale",None),
       ("Release Notes","Release Notes","feed","New items from 3 feeds","Every hour","22 min ago","ok","Raises: nothing &middot; items go to your inbox")]
def connchip(T,name,t):
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px 1px 6px; border-radius: 999px; '
            f'border: 1px solid {T["bc"]}; font-size: 11.5px; color: {T["tp"]};">{tglyph(T,t,12)}{name}</span>')
def syncrow(T,name,conn,t,what,every,last_,state,raises,*,sel=False,last=False):
    st={"ok":(I["check"],T["ok"]),"fail":(I["failed"],T["fail"]),"stale":(I["clock"],T["stale"])}[state]
    lastc=T["fail"] if state=="fail" else (T["stale"] if state=="stale" else T["ts"])
    return (f'<div style="display: grid; grid-template-columns: 15px 150px 150px minmax(0,1fr) 130px 190px; align-items: start; gap: 13px; '
            f'padding: 11px 16px; background: {T["surface"] if sel else "transparent"}; box-shadow: {"inset 3px 0 0 "+T["acc"] if sel else "none"}; {bd_(T,last)}">'
            f'<span style="display: flex; color: {st[1]}; margin-top: 2px;">{ic(st[0],13,2.2)}</span>'
            f'<span style="font-size: 13px; font-weight: {600 if sel else 500}; color: {T["tp"]};">{name}</span>'
            f'<span>{connchip(T,conn,t)}</span>'
            f'<div><div style="font-size: 12.5px; color: {T["tp"]};">{what}</div>'
            + (f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 3px;">{raises}</div>' if raises else "")
            + f'</div><span style="font-size: 12px; color: {T["ts"]};">{every}</span>'
            f'<span style="font-size: 12px; color: {lastc};">{last_}</span></div>')

def syncs_list(T,*,sel="GitHub",w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    cols=(f'<div style="display: grid; grid-template-columns: 15px 150px 150px minmax(0,1fr) 130px 190px; gap: 13px; '
          f'padding: 6px 16px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>SYNC</span><span>CONNECTION</span><span>BRINGS IN</span><span>EVERY</span><span>LAST</span></div>')
    rows="".join(syncrow(T,*s_,sel=(s_[0]==sel),last=(i==len(SYNCS)-1)) for i,s_ in enumerate(SYNCS))
    note=(f'<div style="padding: 10px 16px; font-size: 12px; color: {T["ts"]}; border-top: 1px solid {T["border"]};">'
          f'A sync reads and never writes back. Keys belong to the connection.</div>')
    return f'<div style="{wd} background: {T["bg"]};">{rhead_list(T,"Syncs")}{cols}{rows}{note}</div>'

# ---- one routine: Standup, in the standard pattern -----------------------------------------
def daytoggle(T,days_on):
    return (f'<span style="display: inline-flex; gap: 4px;">'
            + "".join(f'<span style="width: 30px; height: 26px; display: inline-flex; align-items: center; justify-content: center; '
                      f'border-radius: 7px; font-size: 11.5px; font-weight: 600; background: {T["acc"] if on else "transparent"}; '
                      f'color: {T["onacc"] if on else T["ts"]}; border: 1px solid {T["acc"] if on else T["bc"]};">{d}</span>'
                      for d,on in zip(("M","T","W","T","F","S","S"),days_on)) + '</span>')

def field(T,v,*,w=110,mono_=False):
    return (f'<span style="display: inline-flex; align-items: center; gap: 6px; width: {w}px; box-sizing: border-box; padding: 5px 9px; '
            f'border: 1px solid {T["bc"]}; border-radius: 7px; background: {T["surface"]}; font-size: 12.5px; color: {T["tp"]};'
            + (f' font-family: {MONO}; font-size: 11.5px;' if mono_ else "") + f'">{v}</span>')

def schedule_edit(T):
    return sunk(T,
        f'<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">'
        f'<span style="font-size: 12px; color: {T["ts"]}; width: 70px;">Days</span>{daytoggle(T,(1,1,1,1,1,0,0))}'
        f'<span style="font-size: 12px; color: {T["ts"]};">your working days</span></div>'
        f'<div style="display: flex; align-items: center; gap: 12px; margin-top: 10px;">'
        f'<span style="font-size: 12px; color: {T["ts"]}; width: 70px;">At</span>{field(T,"6:00 AM",w=96)}'
        f'<span style="font-size: 12px; color: {T["ts"]};">before the Morning Brief, for your 9:15 AM standup</span></div>'
        f'<div style="display: flex; align-items: center; gap: 12px; margin-top: 10px;">'
        f'<span style="font-size: 12px; color: {T["ts"]}; width: 70px;">Skip</span>'
        f'<span style="font-size: 12.5px; color: {T["tp"]};">Days with no standup on your calendar</span>{toggle(T,True)}</div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 10px;">Next: tomorrow, 6:00 AM &middot; then Thursday, Friday</div>')

def task_edit(T):
    return (f'<div style="display: flex; flex-direction: column; gap: 10px;">'
            f'<div style="display: flex; align-items: center; gap: 9px;"><span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">WHAT IT&rsquo;S ASKED TO DO</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Edit</span></div>'
            f'<div style="border: 1px solid {T["border"]}; border-radius: 9px; background: {T["surface"]}; padding: 11px 13px; font-size: 12.5px; '
            f'color: {T["tp"]}; line-height: 1.6;">Draft today&rsquo;s standup from yesterday&rsquo;s plan, what I closed, and what is '
            f'blocked. Three lines &mdash; <b>Yesterday</b>, <b>Today</b>, <b>Blockers</b> &mdash; plain, no adjectives. Name a '
            f'blocker&rsquo;s owner.</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: {T["ts"]};">'
            f'<span>Shape from</span>{mono("Templates/Standup.md",T["tp"],11.5)}'
            f'<span>&middot; voice from</span>{mono("Me/Working Style.md",T["tp"],11.5)}'
            f'<span style="flex-grow: 1;"></span><span style="color: {T["acc"]}; font-weight: 600;">Open in Obsidian</span></div></div>')

def reads_writes(T):
    return sunk(T,
        kv(T,"Reads",f'Tomorrow&rsquo;s Plan &middot; what you closed yesterday &middot; blocked work')
        + kv(T,"Writes","Journal/Standup/&lt;date&gt;.md",mono_=True)
        + kv(T,"Feeds","the Morning Brief&rsquo;s <b>Standup</b> section, with Copy")
        + kv(T,"Never","posts anywhere &mdash; you copy it",last=True))

def shist(T):
    rows=[(True,"Monday, 6:00 AM","3 lines","0.4&cent;"),
          (None,"Friday","Skipped &mdash; no standup on your calendar","&mdash;"),(True,"Thursday, 6:00 AM","3 lines &middot; 2 blockers","0.5&cent;")]
    return runsteps(T)+'<div style="height: 8px;"></div>'+sunk(T,"".join(
        f'<div style="display: grid; grid-template-columns: 16px 140px minmax(0,1fr) 44px; gap: 11px; align-items: center; padding: 7px 0; {bd_(T,i==len(rows)-1)}">'
        f'<span style="display: flex; color: {T["ok"] if ok else T["tt"]};">{ic(I["check"] if ok else I["pause"],13,2.2)}</span>'
        f'<span style="font-size: 12px; color: {T["ts"]};">{a}</span><span style="font-size: 12px; color: {T["tp"]};">{b}</span>'
        f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right;">{c}</span></div>' for i,(ok,a,b,c) in enumerate(rows)))

def routine_detail(T,*,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="flex-grow: 1; min-width: 0;"><div style="display: flex; align-items: center; gap: 8px;">{renamefield(T,"Standup")}{default_tag(T)}</div>'
          f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 5px; padding-left: 10px;">'
          f'<span style="font-size: 12px; color: {T["ts"]};">Run by</span>{agentchip(T,"metis")}'
          f'<span style="font-size: 12px; color: {T["ts"]};">&middot; change</span></div></div>'
          f'{btn(T,"Run Now","secondary",I["spark"],spark=True)}{btn(T,"Pause","secondary",I["pause"])}</div>')
    foot=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid {T["border"]};">'
          f'<span style="font-size: 12px; color: {T["ts"]};">Shipped with Metistry; everything above is yours to change.</span>'
          f'<span style="flex-grow: 1;"></span>{btn(T,"Reset to Default","ghost",I["reset"])}</div>')
    return (f'<div style="{wd} background: {T["bg"]};">{head}'
            f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"SCHEDULE",schedule_edit(T)) + task_edit(T)
            + block(T,"READS AND WRITES",reads_writes(T)) + block(T,"HISTORY",shist(T)) + '</div>' + foot + '</div>')

def sync_detail(T,*,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="flex-grow: 1;">{renamefield(T,"GitHub")}'
          f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 5px; padding-left: 10px;">'
          f'<span style="font-size: 12px; color: {T["ts"]};">Reads from</span>{connchip(T,"GitHub","api")}'
          f'<span style="font-size: 12px; color: {T["ts"]};">with</span>{ref(T,"secret","github_read")}</div></div>'
          f'{btn(T,"Sync Now","secondary",I["repeat"])}{btn(T,"Pause","secondary",I["pause"])}</div>')
    cadence=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 12px;"><span style="font-size: 12px; color: {T["ts"]}; width: 70px;">Every</span>'
        + segchoice(T,[(I["clock"],"5 min"),(I["clock"],"15 min"),(I["clock"],"Hour"),(I["clock"],"6 hours")],"15 min") + '</div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 9px;">Last synced 4 min ago &middot; 12 open PRs, 3 waiting on you</div>')
    what=sunk(T,
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 12px; align-items: center;">'
        f'<span style="font-size: 12px; color: {T["ts"]};">Repos</span><span>{ref(T,"variable","work_repos")}'
        f'<span style="font-size: 11.5px; color: {T["ts"]}; margin-left: 8px;">metistry, metistry-instance, drey, fsl-site</span></span>'
        f'<span style="font-size: 12px; color: {T["ts"]};">Brings in</span><span style="font-size: 12.5px; color: {T["tp"]};">Open pull requests and issues, their checks and comments</span></div>')
    rules=sunk(T,"".join(
        f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 0; {bd_(T,i==2)}">'
        f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{t}</span>{toggle(T,on)}</div>'
        for i,(t,on) in enumerate((("A review is requested of you",True),("Someone replies to your comment",True),("You are mentioned",False)))))
    return (f'<div style="{wd} background: {T["bg"]};">{head}<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"EVERY",cadence) + block(T,"WHAT IT READS",what) + block(T,"WHAT REACHES NEEDS YOU",rules) + '</div></div>')

# ---- a run, opened: the steps it took ------------------------------------------------------
from lib_needs import rask, rcontext, ranswers, rcard, refchip
def runsteps(T):
    steps=[("read","Read Tomorrow&rsquo;s Plan","Journal/Plan/2026-09-22.md","0.4 s"),
           ("read","Read what you closed Monday","7 tasks","0.1 s"),
           ("read","Read blocked work","2 tasks &middot; 1 PR","0.2 s"),
           ("spark","Drafted three lines","Opus &middot; 1,840 tokens","6.1 s"),
           ("write","Wrote","Journal/Standup/2026-09-22.md","0.1 s")]
    g={"read":I["book"] if "book" in I else I["note"],"spark":I["spark"],"write":I["pencil"]}
    rows="".join(
        f'<div style="display: grid; grid-template-columns: 16px minmax(0,1fr) 46px; gap: 10px; align-items: center; padding: 6px 0;">'
        f'<span style="display: flex; color: {T["ts"]};">{ic(g[k],13,1.9)}</span>'
        f'<span style="font-size: 12px; color: {T["tp"]};">{a} <span style="font-family: {MONO}; font-size: 11px; color: {T["ts"]};">{b}</span></span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]}; text-align: right; font-variant-numeric: tabular-nums;">{c}</span></div>'
        for k,a,b,c in steps)
    out=(f'<div style="margin-top: 8px; border-radius: 8px; background: {T["surface"]}; border: 1px solid {T["border"]}; padding: 9px 11px; '
         f'font-family: {SERIF}; font-size: 12.5px; color: {T["tp"]}; line-height: 1.55;">'
         f'<b>Yesterday</b> &mdash; shipped the Needs You list; reviewed PR 263.<br>'
         f'<b>Today</b> &mdash; routines editor; vendor review at 1.<br>'
         f'<b>Blockers</b> &mdash; Devin token expired (me).</div>')
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 10px; padding: 10px 12px; background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 9px;"><span style="display: flex; color: {T["ok"]};">{ic(I["check"],13,2.2)}</span>'
            f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Today, 6:00 AM</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">&middot; 5 steps &middot; 6.9 s &middot; 0.4&cent;</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Open file</span></div>'
            f'<div style="margin-top: 6px; padding-left: 2px;">{rows}</div>{out}</div>')

def suggest_card(T,*,w=560):
    ba=(f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">'
        + "".join(f'<div style="border-radius: 8px; background: {T["sunken"]}; padding: 8px 10px;">'
                  f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{h}</div>'
                  f'<div style="font-size: 12px; color: {T["tp"]}; margin-top: 4px; line-height: 1.45;">{t}</div></div>'
                  for h,t in (("NOW","Working days at 6:00 AM"),("SUGGESTED","Working days at <b>8:30 AM</b>")))
        + '</div>')
    return rcard(T,rhead2(T,I["spark"],"IMPROVEMENT",who="metis",when="Sunday")
        + rask(T,"Draft standup at 8:30 instead of 6:00?","Standup &middot; routine")
        + rcontext(T,"You open the draft around 9:05 most days. At 6:00 it misses PRs merged overnight in other time zones &mdash; three last week.",
                   [("Journal/Standup","note")])
        + ba + ranswers(T,"Approve",help_=False),w=w)
