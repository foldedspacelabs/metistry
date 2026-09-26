"""Needs You v5 — the bell opens a full view (2026-09-25).

Ruled: Needs You takes the main area as list + detail, reached by the bell and
not by a sidebar row. The bell shows pressed while it is open, the sidebar shows
no selection, and the view's title bar leads back to where you were. Questions
step one at a time.
"""
from lib import *
from lib_needs import *
I.setdefault("back",'<path d="M14.5 5.5L8 12l6.5 6.5"/>')

def bellpressed(T,count="10"):
    return (f'<span style="position: relative; display: inline-flex; padding: 4px; border-radius: 7px; '
            f'background: {T["acc"]}; color: {T["onacc"]};" aria-pressed="true" aria-label="Needs You, open">'
            f'{ic(I["bell"],18,2)}<span style="position: absolute; top: -6px; right: -8px; background: {T["surface"]}; '
            f'color: {T["acc"]}; border: 1.5px solid {T["acc"]}; font-size: 9px; font-weight: 700; border-radius: 999px; '
            f'padding: 0 4px; line-height: 13px;">{count}</span></span>')

def toolbar2(T,pressed=True,count="10"):
    return (f'<div style="display: flex; align-items: center; gap: 12px; padding: 9px 16px; '
            f'border-bottom: 1px solid {T["border"]}; background: {T["surface"]};">'
            f'<span style="color: {T["acc"]}; display: flex;"><svg viewBox="0 0 64 64" width="17" height="17" aria-hidden="true">'
            f'<path d="M12 12 H52 V52 H38 L12 26 Z" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="miter"/></svg></span>'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Metistry</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="display: flex; color: {T["acc"]};">{ic(I["plus"],18)}</span>'
            + f'<span style="display: flex; color: {T["ts"]};">{ic(I["gauge"],18)}</span></div>')

# ---------- the list -------------------------------------------------------------------
REQS=[("today","ask","QUESTION","Three choices before I split the settings pane",("agent","drey-dev"),"8m"),
      ("today","cal","INVITATION","Lease walkthrough &middot; Thu 3:00 PM",("src","calendar"),"35m"),
      ("today","pr","PULL REQUEST","Split the settings pane into one file per pane",("agent","drey-dev"),"14m"),
      ("today","reply","PULL REQUEST","drey-dev answered your comment",("agent","drey-dev"),"6m"),
      ("today","mail","MESSAGE","Re: revised volume numbers",("src","mail"),"2h"),
      ("today","mic","MEETING","Vendor review &middot; 3 to-dos",("agent","metis"),"1h"),
      ("earlier","ask","QUESTION","FSL ops reached its $0.50 budget",("agent","metis"),"yesterday"),
      ("earlier","linear","TASK","Migrate the backup job off the old host",("src","linear"),"yesterday"),
      ("earlier","key","ACCESS","Read Areas/Finance",("agent","drey-dev"),"2d"),
      ("earlier","failed","REPORT","Inbox Triage didn&rsquo;t run",("agent","inbox-triage"),"2d")]

def nyrow(T,g,typ,title,who,when,*,sel=False):
    whoh=agentchip(T,who[1]) if who[0]=="agent" else srcbadge(T,who[1])
    return (f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px 10px 12px; '
            f'border-left: 3px solid {T["acc"] if sel else "transparent"}; background: {T["accq"] if sel else "transparent"}; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["ts"]}; margin-top: 2px;">{ic(I[g],15,1.9)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 6px;">'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 11px; color: {T["ts"]};">{when}</span></div>'
            f'<div style="font-size: 13.5px; font-weight: {600 if sel else 500}; color: {T["tp"]}; margin-top: 2px; line-height: 1.35;">{title}</div>'
            f'<div style="margin-top: 5px;">{whoh}</div></div></div>')

def nylist(T,sel,w=340):
    out=""
    for grp in ("today","earlier"):
        rows=[r for r in REQS if r[0]==grp]
        out+=(f'<div style="padding: 10px 14px 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
              f'background: {T["sunken"]};">{"TODAY" if grp=="today" else "EARLIER"} &middot; {len(rows)}</div>')
        out+="".join(nyrow(T,*r[1:],sel=(r[3]==sel)) for r in rows)
    return f'<div style="width: {w}px; flex-shrink: 0; border-right: 1px solid {T["border"]}; background: {T["surface"]};">{out}</div>'

def nyhead(T,back="Today",n=10):
    chips="".join(f'<span style="padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; '
                  f'background: {T["accq"] if s else "transparent"}; color: {T["acc"] if s else T["ts"]}; '
                  f'border: 1px solid {"transparent" if s else T["bc"]};">{t} <span style="color: {T["ts"]};">{c}</span></span>'
                  for t,c,s in (("All",n,True),("Questions",2,False),("Pull Requests",2,False),("Invitations",1,False),
                                ("Messages",1,False),("Meetings",1,False),("More",3,False)))
    frm=(f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 8px; border: 1px solid {T["bc"]}; '
         f'font-size: 12px; color: {T["tp"]};">From: Everyone {ic(I["chevd"],11,2.2)}</span>')
    return (f'<div style="padding: 12px 18px 12px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 12px;">'
            f'<span style="font-size: 20px; font-weight: 650; color: {T["tp"]};">Needs You</span>'
            f'<span style="font-size: 13px; color: {T["ts"]};">{n} waiting</span><span style="flex-grow: 1;"></span></div>'
            f'<div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 11px;">{chips}'
            f'<span style="flex-grow: 1;"></span>{frm}</div></div>')

def keys(T):
    k=lambda a,b:(f'<span style="display: inline-flex; align-items: center; gap: 5px;"><span style="font-family: {MONO}; font-size: 10.5px; '
                  f'padding: 1px 6px; border-radius: 5px; border: 1px solid {T["bc"]}; color: {T["tp"]};">{a}</span>{b}</span>')
    return (f'<div style="display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 24px; border-top: 1px solid {T["border"]}; '
            f'font-size: 11.5px; color: {T["ts"]}; background: {T["surface"]};">'
            + k("↑ ↓","move") + k("↵","primary") + k("R","Revise") + k("L","Later") + k("⌘↵","send") + k("⌘0","Needs You") + '</div>')

def nywin(T,sel,detail,*,w=1440,h=None,back="Today"):
    hh=f"height: {h}px;" if h else ""
    return (f'<div style="width: {w}px; {hh} border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; background: {T["bg"]}; '
            f'flex-shrink: 0; display: flex; flex-direction: column;">{toolbar2(T)}'
            f'<div style="display: flex; flex-grow: 1; min-height: 0;">{sidebar8(T,sel="Needs You")}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column;">{nyhead(T,back)}'
            f'<div style="display: flex; flex-grow: 1; min-height: 0;">{nylist(T,sel)}'
            f'<div style="flex-grow: 1; min-width: 0; padding: 22px 28px 26px;">{detail}</div></div>{keys(T)}</div></div></div>')

# ---------- detail: a question, one at a time ---------------------------------------------
QS=[("Where should the Connections table live?",False,["Its own file, SettingsConnections.swift","Inside SettingsPanes.swift"],None),
    ("Which panes ship in this PR?",True,["Instance","Services","Compute","Account"],"Pick any"),
    ("Keep the old settings-view.swift shim for one release?",False,["Yes, for one release","No, remove it now"],None)]
ANS=[(0,),(0,1,3),None]
OTHER3="Keep it, marked deprecated in its header"

def steps(T,cur,total=3,done=()):
    segs="".join(f'<span style="flex: 1; height: 4px; border-radius: 2px; background: '
                 f'{T["acc"] if (i in done or i<cur) else (T["tp"] if i==cur else T["border"])};"></span>' for i in range(total+1))
    return (f'<div style="display: flex; align-items: center; gap: 12px;">'
            f'<div style="display: flex; gap: 4px; width: 200px;">{segs}</div>'
            f'<span style="font-size: 12px; color: {T["ts"]};">'
            + (f"Question {cur+1} of {total}" if cur<total else "Your answers") + '</span></div>')

def qhead(T):
    return (rhead(T,I["ask"],"QUESTION","drey-dev","8m",extra=f'<span style="font-size: 11px; color: {T["ts"]};">3 questions</span>')
            + f'<div style="font-size: 22px; font-weight: 650; color: {T["tp"]}; margin-top: 10px; line-height: 1.3;">Three choices before I split the settings pane</div>'
            + f'<div style="max-width: 640px;">{rcontext(T,QCTX,QREFS)}</div>')

def bigopt(T,label,*,multi=False,on=False,other=None,kbd=None):
    mark=(f'<span style="width: 18px; height: 18px; flex-shrink: 0; border-radius: {5 if multi else 999}px; box-sizing: border-box; '
          f'display: inline-flex; align-items: center; justify-content: center; border: {"0" if on else "1.5px solid "+T["bc"]}; '
          f'background: {T["acc"] if on else "transparent"}; color: {T["onacc"]};">'
          + (ic(I["check"],12,3) if (on and multi) else (f'<span style="width: 6px; height: 6px; border-radius: 50%; background: {T["onacc"]};"></span>' if on else ""))
          + '</span>')
    txt=(f'<span style="font-size: 15px; color: {T["tp"]}; flex-grow: 1;">{label}</span>' if other is None else
         f'<span style="flex-grow: 1; font-size: 15px; color: {T["tp"]}; border-bottom: 1.5px solid {T["acc"]}; padding-bottom: 3px;">{other}</span>')
    return (f'<div style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; '
            f'border: 1px solid {T["acc"] if on else T["border"]}; background: {T["accq"] if on else T["surface"]}; margin-top: 8px;">'
            f'{mark}{txt}' + (f'<span style="font-family: {MONO}; font-size: 11px; color: {T["ts"]};">{kbd}</span>' if kbd else "") + '</div>')

def qstep(T,cur,*,sel=(),other=None):
    p,multi,opts,hint=QS[cur]
    body=(f'<div style="max-width: 640px; margin-top: 22px; padding: 20px 22px; border: 1px solid {T["border"]}; border-radius: 14px; background: {T["surface"]};">'
          f'{steps(T,cur)}'
          f'<div style="font-size: 18px; font-weight: 600; color: {T["tp"]}; margin-top: 16px;">{p}</div>'
          + (f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 3px;">{hint}</div>' if hint else "")
          + "".join(bigopt(T,o,multi=multi,on=(i in sel),kbd=str(i+1)) for i,o in enumerate(opts))
          + bigopt(T,"Something else&hellip;",multi=multi,on=other is not None,other=other,kbd=str(len(opts)+1))
          + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 18px;">'
          + (btn(T,"Back","secondary") if cur>0 else "")
          + f'<span style="flex-grow: 1;"></span>'
          + btn(T,"Next" if cur<2 else "Review Answers","affirm" if (sel or other) else "disabled",I["chevr"])
          + '</div></div>')
    foot=(f'<div style="max-width: 640px; display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12.5px; color: {T["ts"]};">'
          f'<span>Not the right questions?</span>{btn(T,"Revise","secondary",I["pencil"])}{btn(T,"Decline","ghost",I["x"])}'
          f'<span style="flex-grow: 1;"></span>{btn(T,"","ghost",I["later"],icon_only=True,title="Later")}</div>')
    return qhead(T)+body+foot

def qsummary(T,*,sent=False):
    rows=[("1","Where should the Connections table live?","Its own file, SettingsConnections.swift",0),
          ("2","Which panes ship in this PR?","Instance, Services, Account",1),
          ("3","Keep the old settings-view.swift shim for one release?",f'<i>{OTHER3}</i>',2)]
    lst="".join(f'<div style="display: flex; gap: 12px; padding: 11px 0; border-top: 1px solid {T["border"]}; align-items: baseline;">'
                f'<span style="font-size: 12px; font-weight: 700; color: {T["acc"]}; width: 14px;">{n}</span>'
                f'<div style="flex-grow: 1;"><div style="font-size: 13px; color: {T["ts"]};">{q}</div>'
                f'<div style="font-size: 15px; color: {T["tp"]}; margin-top: 2px;">{a}</div></div>'
                + ("" if sent else f'<span style="font-size: 12.5px; font-weight: 600; color: {T["acc"]};">Edit</span>') + '</div>'
                for n,q,a,_ in rows)
    act=(rreceipt(T,"Sent to drey-dev &middot; 9:12 AM &middot; not read yet","Change") if sent else
         f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 16px;">{btn(T,"Back","secondary")}'
         f'<span style="flex-grow: 1;"></span><span style="font-size: 12px; color: {T["ts"]};">&#8984;&#8629;</span>'
         f'{btn(T,"Send Answers","affirm",I["send"])}</div>')
    body=(f'<div style="max-width: 640px; margin-top: 22px; padding: 20px 22px; border: 1px solid {T["border"]}; border-radius: 14px; background: {T["surface"]};">'
          + (steps(T,3) if not sent else "") + f'<div style="margin-top: 12px;">{lst}</div>{act}</div>')
    return qhead(T)+body

# ---------- detail: other types at reading width --------------------------------------------
def widen(card): return f'<div style="max-width: 680px;">{card}</div>'

def prdetail(T):
    ftree="".join(f'<div style="display: flex; gap: 8px; padding: 5px 12px 5px 10px; font-family: {MONO}; font-size: 11px; '
                  f'border-left: 2px solid {T["acc"] if s else "transparent"}; font-weight: {600 if s else 400}; color: {T["tp"]};">'
                  f'<span style="flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{p}</span>'
                  f'<span style="color: {T["ok"]};">+{a}</span><span style="color: {T["fail"]};">&minus;{d}</span></div>'
                  for p,a,d,s in (("SettingsConnections.swift",142,0,True),("SettingsPanes.swift",51,7,False),("settings-view.swift",4,31,False),
                                  ("SettingsInstance.swift",9,0,False),("SettingsCompute.swift",6,0,False),("Package.swift",2,0,False)))
    return (rhead(T,I["pr"],"PULL REQUEST","drey-dev","14m",extra=mono("metistry#431",T["ts"],11))
          + f'<div style="font-size: 22px; font-weight: 650; color: {T["tp"]}; margin-top: 10px;">Split the settings pane into one file per pane</div>'
          + prmeta(T,"metistry","drey/settings-split &rarr; main","+214 &minus;38 &middot; 6 files") + checksline(T)
          + f'<div style="max-width: 640px;">{rcontext(T,PRCTX)}</div>'
          + f'<div style="display: flex; gap: 14px; margin-top: 14px; align-items: flex-start;">'
            f'<div style="width: 220px; flex-shrink: 0; border: 1px solid {T["border"]}; border-radius: 10px; padding: 6px 0; background: {T["surface"]};">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; padding: 4px 12px 6px;">FILES &middot; 6</div>{ftree}</div>'
            f'<div style="flex-grow: 1; min-width: 0;">{diffview(T)}</div></div>'
          + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
            f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Request Changes","secondary",I["pencil"])}{btn(T,"Comment","secondary",I["chat"])}'
            f'<span style="font-size: 12px; color: {T["ts"]};">1 draft comment goes with your review &middot; posts as @mattcolf</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Open on GitHub &rarr;</span></div>')

def emptydetail(T):
    return (f'<div style="max-width: 520px; margin: 80px auto 0; text-align: center;">'
            f'<div style="display: inline-flex; color: {T["tt"]};">{ic(I["bell"],28,1.6)}</div>'
            f'<div style="font-size: 18px; font-weight: 600; color: {T["tp"]}; margin-top: 10px;">Nothing needs you.</div>'
            f'<div style="font-size: 13.5px; color: {T["ts"]}; margin-top: 6px; line-height: 1.5;">When Metis, an agent or a sync '
            f'you connected asks for something, it lands here &mdash; and only then does the bell show a number.</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 10px;">This row leaves the sidebar when you go elsewhere.</div></div>')
