"""Needs You v4 — one request pattern for everything an agent needs from the owner (2026-09-25).

Every request is the same five parts: HEADER · THE ASK · CONTEXT · BODY · ANSWERS.
A type chooses one body block from a closed set and names its primary verb; it
never draws its own card. New types are a row in RTYPES, not a new component.
"""
from lib import *
from lib_today import taskrow, eyebrow

I.setdefault("pr",'<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="18" r="2.2"/>'
                  '<path d="M7 8.2v7.6M17 15.8V10a3 3 0 00-3-3h-3.5M12.5 5l-2 2 2 2"/>')
I.setdefault("code",'<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>')
I.setdefault("reply",'<path d="M10 7L5 12l5 5"/><path d="M5 12h9a5 5 0 015 5v1"/>')

W=376   # a card inside the 400px panel

# ---------- the five parts ------------------------------------------------------
def rhead(T,glyph,typ,who,when,*,trust="internal",extra="",person=False):
    whoh=(ent(T,"person",who,I["person"]) if person else agentchip(T,who))
    return (f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(glyph,14,1.9)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
            f'{extra}<span style="flex-grow: 1;"></span>{whoh}{trustmark(T,trust)}'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>')

def rask(T,text,sub=None):
    return (f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-top: 9px; line-height: 1.35;">{text}</div>'
            + (f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 3px;">{sub}</div>' if sub else ""))

def refchip(T,t,g="note"):
    return (f'<span style="display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px; '
            f'background: {T["sunken"]}; font-family: {MONO}; font-size: 10.5px; color: {T["tp"]};">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I[g],10,2)}</span>{t}</span>')

def rcontext(T,prose,refs=(),*,more=None):
    """Context: the agent's words on the wash (P1, C69), then the retrieved
    things they rest on, as chips you can open. Generated and retrieved never mix."""
    return (f'<div style="margin-top: 10px; background: {T["agq"]}; border-radius: 9px; padding: 9px 11px;">'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.52;">{prose}</div>'
            + (f'<div style="display: flex; gap: 5px; flex-wrap: wrap; margin-top: 8px;">{"".join(refchip(T,*r) for r in refs)}</div>' if refs else "")
            + '</div>'
            + (disclose(T,"More context",more) if more else ""))

def ranswers(T,primary,*,pglyph="check",revise="Revise",decline="Decline",extra=(),disabled=False,note=None,help_=True,rglyph="pencil"):
    k=lambda x:"disabled" if disabled else x
    return ((f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 10px;">{note}</div>' if note else "")
            + f'<div style="display: flex; align-items: center; gap: 7px; row-gap: 8px; flex-wrap: wrap; margin-top: {6 if note else 12}px;">'
            + btn(T,primary,k("affirm"),I[pglyph] if pglyph else None)
            + (btn(T,revise,"secondary",I[rglyph] if rglyph else None) if revise else "")
            + (btn(T,decline,"secondary",I["x"]) if decline else "")
            + "".join(extra)
            + f'<span style="flex-grow: 1;"></span>'
            + btn(T,"","ghost",I["later"],icon_only=True,title="Later") + (helplink(T) if help_ else "") + '</div>')

def rcard(T,inner,*,w=W,tone=None):
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["surface"]}; border: 1px solid {tone or T["border"]}; '
            f'border-radius: 12px; padding: 13px 14px 12px;">{inner}</div>')

def rreceipt(T,text,undo="Change",*,ok=True):
    return (f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 11px; padding-top: 10px; '
            f'border-top: 1px solid {T["border"]}; font-size: 12px; color: {T["ts"]};">'
            f'<span style="display: flex; color: {T["ok"] if ok else T["ts"]};">{ic(I["check"],13,2.3)}</span>'
            f'<span style="flex-grow: 1;">{text}</span>'
            + (f'<span style="font-weight: 600; color: {T["acc"]};">{undo}</span>' if undo else "") + '</div>')

def rrevise(T,who,text,*,label="Revise"):
    return (f'<div style="margin-top: 11px; border: 1px solid {T["acc"]}; border-radius: 10px; padding: 9px 11px; background: {T["surface"]};">'
            f'<div style="font-size: 11px; font-weight: 600; color: {T["ts"]};">Tell {who} what to change</div>'
            f'<div style="font-size: 13px; color: {T["tp"]}; line-height: 1.5; margin-top: 4px;">{text}</div></div>'
            f'<div style="display: flex; gap: 7px; margin-top: 9px;">{btn(T,"Send Revision","affirm",I["send"])}{btn(T,"Cancel","secondary")}</div>')

# ---------- body blocks (the closed set) ----------------------------------------
def optrow(T,label,*,multi=False,on=False,other=None,last=False):
    mark=(f'<span style="width: 15px; height: 15px; flex-shrink: 0; border-radius: {4 if multi else 999}px; box-sizing: border-box; '
          f'display: inline-flex; align-items: center; justify-content: center; '
          f'border: {"0" if on else "1.5px solid "+T["bc"]}; background: {T["acc"] if on else "transparent"}; color: {T["onacc"]};">'
          + (ic(I["check"],10,3.2) if (on and multi) else (f'<span style="width: 5px; height: 5px; border-radius: 50%; background: {T["onacc"]};"></span>' if on else ""))
          + '</span>')
    body=(f'<span style="font-size: 13px; color: {T["tp"] if on or other else T["ts"] if label.startswith("Something") else T["tp"]};">{label}</span>'
          if other is None else
          f'<span style="flex-grow: 1; border-bottom: 1px solid {T["acc"]}; font-size: 13px; color: {T["tp"]}; padding-bottom: 2px;">{other}</span>')
    return (f'<div style="display: flex; gap: 9px; align-items: center; padding: 7px 9px; border-radius: 8px; '
            f'background: {T["accq"] if on else "transparent"};">{mark}{body}</div>')

def question(T,n,prompt,opts,*,multi=False,sel=(),other=None,hint=None,last=False):
    rows="".join(optrow(T,o,multi=multi,on=(i in sel)) for i,o in enumerate(opts))
    rows+=optrow(T,"Something else&hellip;",multi=multi,on=other is not None,other=other)
    return (f'<div style="padding: 10px 0 8px;{"" if last else " border-bottom: 1px solid "+T["border"]+";"}">'
            f'<div style="display: flex; gap: 8px; align-items: baseline;">'
            f'<span style="font-size: 11px; font-weight: 700; color: {T["acc"] if (sel or other) else T["tt"]}; width: 14px;">{n}</span>'
            f'<span style="font-size: 13.5px; font-weight: 600; color: {T["tp"]}; line-height: 1.4;">{prompt}</span></div>'
            + (f'<div style="font-size: 11.5px; color: {T["ts"]}; margin: 2px 0 0 22px;">{hint}</div>' if hint else "")
            + f'<div style="margin: 5px 0 0 13px;">{rows}</div></div>')

def filesblock(T,files,*,more=0):
    rows="".join(f'<div style="display: flex; align-items: baseline; gap: 8px; padding: 4px 0;">'
                 f'<span style="flex-grow: 1; min-width: 0; font-family: {MONO}; font-size: 11px; color: {T["tp"]}; '
                 f'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{p}</span>'
                 f'<span style="font-family: {MONO}; font-size: 11px; color: {T["ok"]};">+{a}</span>'
                 f'<span style="font-family: {MONO}; font-size: 11px; color: {T["fail"]};">&minus;{d}</span></div>' for p,a,d in files)
    # measured: `ok` on sunken is 4.47:1 light, so the counts sit on the card's own surface (5.27:1)
    return (f'<div style="margin-top: 10px; border: 1px solid {T["border"]}; border-radius: 9px; padding: 7px 10px;">{rows}'
            + (f'<div style="font-size: 11.5px; color: {T["acc"]}; font-weight: 600; padding-top: 3px;">+{more} more files</div>' if more else "")
            + '</div>')

def checksline(T,*,failing=None,n=12):
    if failing:
        return (f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: {T["tp"]};">'
                f'<span style="display: flex; color: {T["fail"]};">{ic(I["failed"],13,2.1)}</span><b>1 check failing</b>'
                f'<span style="color: {T["ts"]};">&middot; {failing} &middot; {n-1} passed</span></div>')
    return (f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: {T["ts"]};">'
            f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],13,2.3)}</span>{n} checks passed</div>')

def prmeta(T,repo,branch,stat):
    return (f'<div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 5px; font-size: 12px; color: {T["ts"]};">'
            + mono(branch,T["ts"],11) + f'<span>&middot;</span><span>{stat}</span></div>')

def thread(T,lines,snippet=None):
    code=""
    if snippet:
        code=(f'<div style="background: {T["sunken"]}; border-radius: 8px; padding: 6px 0; font-family: {MONO}; font-size: 10.5px; '
              f'line-height: 1.65; margin-top: 10px; overflow: hidden;">'
              + "".join(f'<div style="display: flex; gap: 9px; padding: 0 9px; white-space: nowrap; '
                        f'background: {T["accq"] if hl else "transparent"};"><span style="color: {T["tt"]}; width: 22px; text-align: right;">{n}</span>'
                        f'<span style="color: {T["tp"]};">{c}</span></div>' for n,c,hl in snippet) + '</div>')
    msgs="".join(
        (f'<div style="margin-top: 9px;"><div style="display: flex; gap: 6px; align-items: baseline;">'
         + (f'<span style="font-size: 11.5px; font-weight: 700; color: {T["tp"]};">you</span>' if who=="you" else
            agentchip(T,who) if not who[0].isupper() else ent(T,"person",who,I["person"]))
         + f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>'
         + (f'<div style="font-size: 13px; color: {T["tp"]}; line-height: 1.5; margin-top: 3px;">{t}</div>' if who=="you" or who[0].isupper() else
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.5; margin-top: 4px; '
            f'background: {T["agq"]}; border-radius: 8px; padding: 6px 9px;">{t}</div>')
         + '</div>') for who,when,t in lines)
    return code + msgs

def composer1(T,ph,*,typed=None):
    return (f'<div style="margin-top: 10px; border: 1px solid {T["acc"] if typed else T["bc"]}; border-radius: 9px; padding: 8px 10px; '
            f'font-size: 13px; color: {T["tp"] if typed else T["tt"]}; background: {T["surface"]};">{typed or ph}</div>')

# ---------- the types ---------------------------------------------------------------
QCTX=("The settings pane is 2,400 lines in one file. I can split it three ways, and each changes how the tokens "
      "migration lands in <b>#418</b>. I&rsquo;ve drafted the first file both ways; nothing is committed.")
QREFS=[("Work #418","board"),("settings-view.swift","code"),("C62 fixed window","note")]
def qcard(T,*,state="open",w=W):
    sel1,sel2,oth3=(((0,),(0,1,3),"Keep it, marked deprecated in its header") if state in ("partial","sent") else ((),(),None))
    if state=="partial": oth3=None
    head=rhead(T,I["ask"],"QUESTION","drey-dev","8m",extra=f'<span style="font-size: 11px; color: {T["ts"]};">3 questions</span>')
    body=(rask(T,"Three choices before I split the settings pane") + rcontext(T,QCTX,QREFS))
    qs=(question(T,1,"Where should the Resources table live?",["Its own file, SettingsResources.swift","Inside SettingsPanes.swift"],sel=sel1)
        + question(T,2,"Which panes ship in this PR?",["Instance","Services","Compute","Account"],multi=True,sel=sel2,hint="Pick any")
        + question(T,3,"Keep the old settings-view.swift shim for one release?",["Yes, for one release","No, remove it now"],other=oth3,last=True))
    if state=="revise":
        return rcard(T,head+body+f'<div style="margin-top: 10px; font-size: 12px; color: {T["ts"]};">3 questions &middot; not answered</div>'
                     + rrevise(T,"drey-dev","Don&rsquo;t split yet. Migrate the tokens in place first, then split in a second PR."),w=w)
    if state=="sent":
        return rcard(T,head+rask(T,"Three choices before I split the settings pane")
                     + f'<div style="margin-top: 8px; font-size: 12.5px; color: {T["tp"]}; line-height: 1.6;">'
                       f'1 &middot; Its own file<br>2 &middot; Instance, Services, Account<br>3 &middot; <i>Keep it, marked deprecated in its header</i></div>'
                     + rreceipt(T,"Sent to drey-dev &middot; 9:12 AM &middot; not read yet","Change"),w=w)
    ans=ranswers(T,"Send Answers",pglyph="send",disabled=(state!="ready"),
                 note=("2 of 3 answered" if state=="partial" else None if state=="ready" else "0 of 3"))
    if state=="ready":
        qs=(question(T,1,"Where should the Resources table live?",["Its own file, SettingsResources.swift","Inside SettingsPanes.swift"],sel=(0,))
            + question(T,2,"Which panes ship in this PR?",["Instance","Services","Compute","Account"],multi=True,sel=(0,1,3),hint="Pick any")
            + question(T,3,"Keep the old settings-view.swift shim for one release?",["Yes, for one release","No, remove it now"],
                       other="Keep it, marked deprecated in its header",last=True))
    return rcard(T,head+body+f'<div style="margin-top: 4px;">{qs}</div>'+ans,w=w)

PRCTX=("The split is mechanical except <b>SettingsResources.swift</b>, where the grant table moved with its selection "
       "state. That&rsquo;s the file to read.")
PRFILES=[("apps/macos/…/SettingsResources.swift",142,0),("apps/macos/…/settings-view.swift",4,31),("apps/macos/…/SettingsPanes.swift",51,7)]
def prcard(T,*,state="review",w=W,source="agent"):
    person=source=="github"
    who="Priya Shah" if person else "drey-dev"
    head=(rhead2(T,I["pr"],"PULL REQUEST",src="github",person=who,when="14m",extra=mono("metistry#431",T["ts"],11)) if person else
          rhead(T,I["pr"],"PULL REQUEST",who,"14m",extra=mono("metistry#431",T["ts"],11)))
    ask=rask(T,"Split the settings pane into one file per pane")
    meta=prmeta(T,"metistry","drey/settings-split &rarr; main","+214 &minus;38 &middot; 6 files")
    ctx=(rcontext(T,PRCTX) if not person else
         f'<div style="margin-top: 9px; font-size: 12.5px; color: {T["tp"]};"><b>Priya Shah</b> requested your review.</div>' + mirrorline(T,"github"))
    files=filesblock(T,PRFILES,more=3)
    checks=checksline(T,failing=("lint &middot; SettingsPanes.swift:88" if state=="failing" else None))
    open_gh=f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Review Changes &rarr;</span>'
    if state=="nocred":
        return rcard(T,head+ask+meta+files+checks
            + f'<div style="margin-top: 10px; display: flex; gap: 9px; background: {T["sunken"]}; border-radius: 9px; padding: 9px 11px;">'
              f'<span style="display: flex; color: {T["ts"]};">{ic(I["relay"],14,1.9)}</span>'
              f'<div style="font-size: 12px; color: {T["tp"]}; line-height: 1.5;"><b>Metistry can read this PR but can&rsquo;t post to GitHub.</b> '
              f'<span style="color: {T["ts"]};">Its token is read-only. Connect a write token to review here.</span></div></div>'
            + f'<div style="display: flex; gap: 7px; margin-top: 11px;">{btn(T,"Connect GitHub","secondary",I["relay"])}'
              f'{btn(T,"Open on GitHub","secondary",I["share"] if "share" in I else None)}</div>',w=w)
    if state=="stale":
        return rcard(T,head+ask+meta
            + f'<div style="display: flex; gap: 9px; background: {T["staleq"]}; border-radius: 9px; padding: 9px 11px; margin-top: 10px;">'
              f'<span style="display: flex; color: {T["stale"]};">{ic(I["clock"],14,2)}</span>'
              f'<span style="font-size: 12px; color: {T["stale"]}; line-height: 1.5;">2 commits were pushed while this was open, so '
              f'nothing was sent. What you&rsquo;re looking at now is the new head.</span></div>'
            + files + checks + ranswers(T,"Approve",revise="Request Changes",decline=None,extra=(btn(T,"Comment","secondary",I["chat"]),)),w=w,tone=T["stale"])
    if state=="approving":
        return rcard(T,head+ask+meta+checks
            + composer1(T,"Add a comment (optional)",typed="The grant table move reads well. Ship it.")
            + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap;">'
              f'{btn(T,"Approve on GitHub","affirm",I["check"])}{btn(T,"Cancel","secondary")}'
              f'<span style="font-size: 11.5px; color: {T["ts"]};">Posts a review as @mattcolf</span></div>',w=w)
    if state=="changes":
        return rcard(T,head+ask+meta+checks
            + composer1(T,"What needs to change",typed="Keep settings-view.swift as a shim for one release &mdash; the Mac app&rsquo;s "
                        "preview target still imports it.")
            + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap;">'
              f'{btn(T,"Request Changes","affirm",I["pencil"])}{btn(T,"Cancel","secondary")}'
              f'<span style="font-size: 11.5px; color: {T["ts"]};">drey-dev picks this up from the PR</span></div>',w=w)
    if state=="approved":
        return rcard(T,head+ask+rreceipt(T,"Approved on GitHub as @mattcolf &middot; 9:20 AM","Open on GitHub"),w=w)
    return rcard(T,head+ask+meta+ctx+files+checks
        + ranswers(T,"Approve",revise="Request Changes",decline=None,extra=(btn(T,"Comment","secondary",I["chat"]),))
        + f'<div style="margin-top: 9px;">{open_gh}</div>',w=w)

def threadcard(T,*,w=W,state="open"):
    head=rhead(T,I["reply"],"PULL REQUEST","drey-dev","6m",extra=mono("metistry#431",T["ts"],11))
    ask=rask(T,"drey-dev answered your comment","SettingsResources.swift &middot; line 42")
    snip=[(41,"struct ResourcesPane: View {",False),(42,"  @Binding var selection: Grant.ID?",True),(43,"  let grants: [Grant]",False)]
    th=thread(T,[("you","yesterday","Why does the selection binding move here?"),
                 ("drey-dev","6m","The table needs it to scroll the new grant into view. The alternative threads it through two views.")],snip)
    if state=="replied":
        return rcard(T,head+ask+th+rreceipt(T,"Replied and resolved on GitHub &middot; 9:24 AM","Open on GitHub"),w=w)
    return rcard(T,head+ask+th+composer1(T,"Reply&hellip;")
        + f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 10px; flex-wrap: wrap;">'
          f'{btn(T,"Reply","affirm",I["reply"])}{btn(T,"Resolve Conversation","secondary",I["check"])}'
          f'<span style="flex-grow: 1;"></span>{btn(T,"","ghost",I["later"],icon_only=True,title="Later")}</div>',w=w)

# ---- C96 events as instances of the pattern ----
def budgetq(T,w=W):
    head=rhead(T,I["ask"],"QUESTION","metis","2m")
    return rcard(T,head+rask(T,"FSL ops reached its $0.50 budget at 2:40 PM")
        + rcontext(T,"Two routines were mid-run: the vendor reconciliation stopped at invoice 0804. Nothing else in FSL "
                     "ops runs until tomorrow unless you allow more.",[("FSL ops","board"),("Usage","gauge")])
        + question(T,1,"What should happen now?",["Allow $0.50 more today","Leave it stopped until tomorrow"],sel=(0,),last=True)
        + ranswers(T,"Send Answer",pglyph="send",decline=None),w=w)

def failreport(T,w=W):
    head=rhead(T,I["failed"],"REPORT","inbox-triage","22m")
    return rcard(T,head+rask(T,"Inbox Triage didn&rsquo;t run","Last succeeded yesterday at 9:00 AM &middot; failed today at 9:00 AM")
        + f'<div style="margin-top: 9px; background: {T["sunken"]}; border-radius: 8px; padding: 7px 10px; font-family: {MONO}; '
          f'font-size: 11px; color: {T["tp"]}; line-height: 1.5;">apple-mail: mailbox &ldquo;Vendors&rdquo; not found</div>'
        + ranswers(T,"Try Again",pglyph="repeat" if "repeat" in I else None,revise=None,decline="Dismiss",
                   extra=(btn(T,"Open the Run","secondary"),)),w=w)

def credaccess(T,w=W):
    head=rhead(T,I["key"],"ACCESS","metis","3h")
    return rcard(T,head+rask(T,"Reconnect Sentry","Last worked 2 days ago &middot; token expired")
        + f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 7px;">collator and 1 routine use it; both are waiting.</div>'
        + ranswers(T,"Reconnect",pglyph="relay",revise=None,decline="Dismiss"),w=w)

def conflictreview(T,w=W):
    head=rhead(T,I["review"],"REVIEW","metis","1h")
    col=lambda k,v:(f'<div style="flex: 1; min-width: 0; background: {T["sunken"]}; border-radius: 8px; padding: 7px 9px;">'
                    f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">{k}</div>'
                    f'<div style="font-size: 12px; color: {T["tp"]}; margin-top: 3px; line-height: 1.45;">{v}</div></div>')
    return rcard(T,head+rask(T,"Two writers met in sleep.md","You edited it while the fold was writing")
        + f'<div style="display: flex; gap: 7px; margin-top: 9px;">{col("YOURS &middot; 10:14 PM","Bed by 11 on weeknights.")}'
          f'{col("THE FOLD&rsquo;S &middot; 10:15 PM","Bed by 11; the Oura data says 11:40 on average.")}</div>'
        + ranswers(T,"Keep Mine",pglyph="check",revise="Take the Fold&rsquo;s",decline=None,
                   extra=(btn(T,"Merge in Obsidian","ghost"),)),w=w)

# ---- the meeting card, made at Stop ----
def mtodo(T,text,chips,*,last=False):
    return (f'<div style="display: flex; gap: 9px; align-items: flex-start; padding: 7px 0;{"" if last else " border-bottom: 1px solid "+T["border"]+";"}">'
            f'<span style="display: flex; color: {T["ag"]}; margin-top: 2px;">{ic(I["todo"],13,1.9)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;"><div style="font-size: 13px; color: {T["tp"]};">{text}</div>'
            f'<div style="display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px;">{"".join(chips)}'
            f'<span style="font-size: 11px; color: {T["ts"]};">proposed</span></div></div>'
            f'<span style="display: inline-flex; gap: 2px;">'
            + "".join(f'<span style="display: flex; padding: 3px; color: {T["ts"]};">{ic(I[g],14,2)}</span>' for g in ("check","pencil","x"))
            + '</span></div>')

def meetingstop(T,w=W):
    head=rhead(T,I["mic"],"MEETING","metis","just now",extra=f'<span style="font-size: 11px; color: {T["ts"]};">from Stop</span>')
    todos=(mtodo(T,"Send Kessler the revised volume numbers",[due(T,"Thu"),ent(T,"person","Sam Kessler",I["person"])])
           + mtodo(T,"Check whether net-45 applies to the Q4 order",[due(T,"Fri"),ent(T,"person","you",I["person"])])
           + mtodo(T,"Ask Orlin for their updated terms",[due(T,"Mon"),ent(T,"person","Dana Ruiz",I["person"])],last=True))
    fu=(f'<div style="margin-top: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
        f'{btn(T,"Draft Follow-up","secondary",I["spark"])}'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">to Kessler &middot; drafted, never sent</span></div>')
    return rcard(T,head+rask(T,"Vendor review","Notes and 3 to-dos &middot; 42 min &middot; 1:00&ndash;1:42 PM")
        + rcontext(T,"Kessler confirmed net-45 and dropped the volume tier. The March renewal is no longer the cheapest "
                     "option; Orlin may undercut it.")
        + f'<div style="margin-top: 8px;">{eyebrow(T,"TO-DOS &middot; 3")}{todos}</div>' + fu
        + ranswers(T,"Accept All",revise="Revise",decline="Decline All",help_=False),w=w)

# ---- the panel -------------------------------------------------------------------
def chipsrow(T,items,sel):
    return (f'<div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 11px;">'
            + "".join(f'<span style="padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; '
                      f'background: {T["accq"] if t==sel else "transparent"}; color: {T["acc"] if t==sel else T["ts"]}; '
                      f'border: 1px solid {"transparent" if t==sel else T["bc"]};">{t} <span style="color: {T["ts"]};">{n}</span></span>'
                      for t,n in items) + '</div>')

def panel4(T,w=400):
    head=(f'<div style="padding: 14px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">6 waiting</span></div>'
          + chipsrow(T,[("All",6),("Questions",2),("Pull Requests",2),("Meetings",1),("Access",1)],"All") + '</div>')
    body=(f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
          + grouplabel(T,"QUESTIONS","2") + qcard(T,state="partial") + budgetq(T)
          + grouplabel(T,"PULL REQUESTS","2") + prcard(T) + threadcard(T)
          + grouplabel(T,"MEETINGS","1") + meetingstop(T) + '</div>')
    foot=(f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]};">'
          f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Open Needs You &rarr;</span></div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; flex-shrink: 0;">{head}{body}{foot}</div>')

# ---- the full window: a PR at reading width ---------------------------------------
HUNK=[(" ",38,"struct ResourcesPane: View {"),("-",39,"  var grants: [Grant]"),("+",39,"  let grants: [Grant]"),
      ("+",40,"  @Binding var selection: Grant.ID?"),(" ",41,""),(" ",42,"  var body: some View {"),
      ("-",43,"    List(grants) { grant in"),("+",43,"    Table(grants, selection: $selection) {"),
      (" ",44,"      TableColumn(\"Tool\", value: \\.name)"),(" ",45,"      TableColumn(\"May\") { GrantControl($0) }")]
def diffview(T):
    rows=""
    for k,n,c in HUNK:
        bg={"+":T["okq"],"-":T["failq"]," ":"transparent"}[k]; ink={"+":T["ok"],"-":T["fail"]," ":T["tt"]}[k]
        rows+=(f'<div style="display: flex; gap: 12px; padding: 0 14px; background: {bg}; white-space: pre;">'
               f'<span style="color: {T["ts"] if k.strip() else T["tt"]}; width: 26px; text-align: right;">{n}</span>'
               f'<span style="color: {ink}; width: 8px;">{k.strip()}</span><span style="color: {T["tp"]};">{c}</span></div>')
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 10px; overflow: hidden; background: {T["surface"]};">'
            f'<div style="display: flex; align-items: center; gap: 9px; padding: 8px 14px; background: {T["sunken"]}; border-bottom: 1px solid {T["border"]};">'
            + mono("apps/macos/sources/kit/SettingsResources.swift",T["tp"],11.5)
            + f'<span style="flex-grow: 1;"></span><span style="font-family: {MONO}; font-size: 11px; color: {T["ok"]};">+142</span></div>'
            f'<div style="font-family: {MONO}; font-size: 11.5px; line-height: 1.75; padding: 6px 0;">{rows}</div>'
            f'<div style="margin: 0 14px 12px 60px; border: 1px solid {T["bc"]}; border-radius: 9px; padding: 9px 11px; background: {T["bg"]};">'
            f'<div style="font-size: 11px; font-weight: 600; color: {T["ts"]};">Your comment on line 40 &middot; draft</div>'
            f'<div style="font-size: 13px; color: {T["tp"]}; margin-top: 3px;">Does the preview target still build without the binding?</div>'
            f'<div style="display: flex; gap: 7px; margin-top: 8px;">{btn(T,"Add to Review","secondary")}{btn(T,"Cancel","ghost")}</div></div></div>')

def prwindow(T,w=1320):
    lst="".join(f'<div style="display: flex; gap: 9px; padding: 10px 14px; border-bottom: 1px solid {T["border"]}; '
                f'background: {T["accq"] if s else "transparent"};"><span style="display: flex; color: {T["ts"]}; margin-top: 2px;">{ic(I[g],14,1.9)}</span>'
                f'<div style="min-width: 0;"><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{t}</div>'
                f'<div style="font-size: 13px; color: {T["tp"]}; margin-top: 2px; line-height: 1.35;">{x}</div></div></div>'
                for g,t,x,s in (("ask","QUESTION","Three choices before I split the settings pane",False),
                                ("ask","QUESTION","FSL ops reached its $0.50 budget",False),
                                ("pr","PULL REQUEST","Split the settings pane into one file per pane",True),
                                ("reply","PULL REQUEST","drey-dev answered your comment",False),
                                ("mic","MEETING","Vendor review",False),("key","ACCESS","Read Areas/Finance",False)))
    # selection by an accent rule and weight, not a fill: `ok` on accq is 4.12:1 light (measured)
    ftree="".join(f'<div style="display: flex; gap: 8px; padding: 5px 12px 5px 10px; font-family: {MONO}; font-size: 11px; '
                  f'border-left: 2px solid {T["acc"] if s else "transparent"}; font-weight: {600 if s else 400}; color: {T["tp"]};"><span style="flex-grow: 1; overflow: hidden; '
                  f'text-overflow: ellipsis; white-space: nowrap;">{p}</span><span style="color: {T["ok"]};">+{a}</span>'
                  f'<span style="color: {T["fail"]};">&minus;{d}</span></div>'
                  for p,a,d,s in (("SettingsResources.swift",142,0,True),("SettingsPanes.swift",51,7,False),("settings-view.swift",4,31,False),
                                  ("SettingsInstance.swift",9,0,False),("SettingsCompute.swift",6,0,False),("Package.swift",2,0,False)))
    main=(f'<div style="flex-grow: 1; min-width: 0; padding: 18px 22px;">'
          f'<div style="display: flex; align-items: center; gap: 9px;">{mono("metistry#431",T["ts"],12)}'
          f'{agentchip(T,"drey-dev")}<span style="font-size: 12px; color: {T["ts"]};">&middot; review requested 14m ago</span>'
          f'<span style="flex-grow: 1;"></span><span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Open on GitHub &rarr;</span></div>'
          f'<div style="font-size: 20px; font-weight: 650; color: {T["tp"]}; margin-top: 6px;">Split the settings pane into one file per pane</div>'
          + prmeta(T,"metistry","drey/settings-split &rarr; main","+214 &minus;38 &middot; 6 files") + checksline(T)
          + f'<div style="max-width: 640px;">{rcontext(T,PRCTX)}</div>'
          + f'<div style="display: flex; gap: 14px; margin-top: 14px; align-items: flex-start;">'
            f'<div style="width: 250px; flex-shrink: 0; border: 1px solid {T["border"]}; border-radius: 10px; padding: 6px 0; background: {T["surface"]};">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; padding: 4px 12px 6px;">FILES &middot; 6</div>{ftree}</div>'
            f'<div style="flex-grow: 1; min-width: 0;">{diffview(T)}</div></div>'
          + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid {T["border"]};">'
            f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Request Changes","secondary",I["pencil"])}{btn(T,"Comment","secondary",I["chat"])}'
            f'<span style="font-size: 12px; color: {T["ts"]};">1 draft comment goes with your review &middot; posts as @mattcolf</span></div></div>')
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; background: {T["bg"]}; flex-shrink: 0;">'
            f'{toolbar(T)}<div style="display: flex;">'
            f'<div style="width: 300px; flex-shrink: 0; border-right: 1px solid {T["border"]}; background: {T["surface"]};">'
            f'<div style="padding: 12px 14px; font-size: 15px; font-weight: 600; color: {T["tp"]}; border-bottom: 1px solid {T["border"]};">'
            f'Needs You <span style="font-size: 12px; font-weight: 400; color: {T["ts"]};">6</span></div>{lst}</div>{main}</div></div>')

# ============ FROM EVERYWHERE — Metis, agents, and collectors (2026-09-25) ============
I.setdefault("mail",'<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>')
I.setdefault("gh",'<circle cx="12" cy="12" r="8.2"/><path d="M9.5 18.5v-2.2c0-1 .3-1.6.9-2-2.6-.3-4-1.3-4-3.7 0-.9.3-1.7.9-2.3-.1-.6-.1-1.4.2-2.1 0 0 .8-.2 2.4.9a8 8 0 014.2 0c1.6-1.1 2.4-.9 2.4-.9.3.7.3 1.5.2 2.1.6.6.9 1.4.9 2.3 0 2.4-1.4 3.4-4 3.7.6.4.9 1 .9 2v2.2"/>')
I.setdefault("linear",'<circle cx="12" cy="12" r="8.2"/><path d="M6 13.5l4.5 4.5M5.2 10.3l8.5 8.5M6.8 7.3l9.9 9.9M9.8 5.4l8.8 8.8"/>')
SRC={"github":("gh","GitHub"),"calendar":("cal","Calendar"),"mail":("mail","Mail"),"linear":("linear","Linear")}

def srcbadge(T,src):
    g,n=SRC[src]
    return (f'<span style="display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; '
            f'border: 1px solid {T["bc"]}; font-size: 10.5px; font-weight: 600; color: {T["ts"]};">{ic(I[g],10,2)}{n}</span>')

def rhead2(T,glyph,typ,*,src=None,who=None,person=None,when,extra=""):
    """Who asked: Metis, an agent, or a source a collector reads — then the person there, if any."""
    ids=""
    if src: ids+=srcbadge(T,src)
    if person: ids+=ent(T,"person",person,I["person"])
    if who: ids+=agentchip(T,who)
    return (f'<div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(glyph,14,1.9)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
            f'{extra}<span style="flex-grow: 1;"></span>{ids}'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>')

def mirrorline(T,src):
    n=SRC[src][1]
    return (f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 9px; font-size: 11.5px; color: {T["ts"]};">'
            f'{ic(I["repeat"],12,2)}Mirrors {n} &mdash; answering there clears it here</div>')

def invitecard(T,*,w=W,state="open"):
    head=rhead2(T,I["cal"],"INVITATION",src="calendar",person="Tom Reyes",when="35m")
    ask=rask(T,"Lease walkthrough","Thu 24 Sep &middot; 3:00&ndash;4:00 PM &middot; 214 Main St")
    if state=="cleared":
        return rcard(T,head+ask+rreceipt(T,"Accepted in Calendar &middot; 10:02 AM &middot; cleared here",None),w=w)
    body=(f'<div style="margin-top: 9px; background: {T["sunken"]}; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: {T["tp"]}; line-height: 1.55;">'
          f'<div>2 people &middot; you and Tom Reyes</div>'
          f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 3px; color: {T["deg"]};">{ic(I["clock"],12,2.2)}'
          f'<span>Overlaps your 3:30 focus block by 30 min</span></div>'
          f'<div style="color: {T["ts"]}; margin-top: 3px;">25 min travel each way</div></div>')
    return rcard(T,head+ask+body+mirrorline(T,"calendar")
        + ranswers(T,"Accept",revise="Maybe",decline="Decline",help_=False,rglyph=None),w=w)

def mailcard(T,*,w=W):
    head=rhead2(T,I["mail"],"MESSAGE",src="mail",person="Sam Kessler",when="2h",extra=f'{agentchip(T,"metis")}')
    ask=rask(T,"Re: revised volume numbers","Kessler asked for them by Thursday")
    ctx=rcontext(T,"He asked a direct question and it has sat two hours. You owe him the numbers anyway &mdash; "
                   "<b>Send Kessler the revised volume numbers</b> is due Thursday.",[("Vendor review","note"),("due Thu","check")])
    ex=(f'<div style="margin-top: 9px; border-left: 2px solid {T["bc"]}; padding: 1px 0 1px 10px; font-size: 12.5px; color: {T["tp"]}; line-height: 1.5;">'
        f'&ldquo;Can you send the revised volume numbers before Thursday&rsquo;s call? We need them to hold the net-45 terms.&rdquo;</div>')
    note=(f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">Metis thinks this needs you &mdash; Mail didn&rsquo;t say so.</div>')
    return rcard(T,head+ask+ex+ctx+note
        + ranswers(T,"Draft Reply",pglyph="spark",revise=None,decline="Not Mine",
                   extra=(btn(T,"Open in Mail","secondary"),),help_=False),w=w)

def issuecard(T,*,w=W):
    head=rhead2(T,I["linear"],"TASK",src="linear",person="Priya Shah",when="1h",extra=mono("OPS-212",T["ts"],11))
    ask=rask(T,"Migrate the backup job off the old host","Assigned to you &middot; due Mon &middot; P2")
    ex=(f'<div style="margin-top: 9px; background: {T["sunken"]}; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: {T["tp"]}; line-height: 1.5;">'
        f'The old host is decommissioned on the 30th. The job needs the new bucket and a fresh key.</div>')
    return rcard(T,head+ask+ex+mirrorline(T,"linear")
        + ranswers(T,"Add to Today",pglyph="plus",revise=None,decline=None,
                   extra=(btn(T,"Delegate","secondary",I["spark"]),btn(T,"Open in Linear","ghost")),help_=False),w=w)

def ghcleared(T,*,w=W):
    head=rhead2(T,I["pr"],"PULL REQUEST",src="github",person="Priya Shah",when="2h",extra=mono("drey#88",T["ts"],11))
    return rcard(T,head+rask(T,"Add the export button to reports")
        + rreceipt(T,"You approved it on GitHub &middot; 10:14 AM &middot; cleared here",None),w=w)

def fromfilter(T):
    items=[("Everyone",10,True),("Metis",3,False),("Agents",3,False),("GitHub",2,False),("Calendar",1,False),("Mail",1,False),("Linear",1,False)]
    return (f'<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px;">'
            f'<span style="font-size: 11px; color: {T["ts"]}; margin-right: 2px;">From</span>'
            + "".join(f'<span style="padding: 2px 8px; border-radius: 999px; font-size: 11px; background: {T["accq"] if s else "transparent"}; '
                      f'color: {T["acc"] if s else T["ts"]}; border: 1px solid {"transparent" if s else T["bc"]};">{t} '
                      f'<span style="color: {T["ts"]};">{n}</span></span>' for t,n,s in items) + '</div>')

def panel5(T,w=400):
    head=(f'<div style="padding: 14px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">10 waiting</span></div>'
          + chipsrow(T,[("All",10),("Questions",2),("Pull Requests",3),("Invitations",1),("Tasks",1),("Messages",1),("Meetings",1),("Access",1)],"All")
          + fromfilter(T) + '</div>')
    body=(f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
          + grouplabel(T,"TODAY","3") + invitecard(T) + mailcard(T) + prcard(T,source="github")
          + grouplabel(T,"EARLIER","7") + f'<div style="font-size: 12px; color: {T["ts"]}; padding: 2px 4px;">Questions, the other pull requests, '
            f'a task, the meeting and an access request &hellip;</div></div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; flex-shrink: 0;">{head}{body}</div>')
