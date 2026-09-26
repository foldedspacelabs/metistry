"""Board: PWA — Knowledge and everything under More, at 390pt (screen 18)."""
from lib_pwa import *

CW,CH=2660,1930

search=(f'<div style="display: flex; align-items: center; gap: 8px; background: {L["sunken"]}; border-radius: 10px; '
        f'padding: 8px 11px; margin-bottom: 12px; color: {L["ts"]}; font-size: 15px;">{ic(I["search"],16,2)}Search knowledge</div>')
eye=group(L,[grow(L,"Draft &middot; vendors.md",glyph="pencil",sub="Metis rewrote the vendor summary from three captures",tone=L["ts"]),
             grow(L,"Conflict &middot; sleep.md",glyph="warn",sub="You edited it while the fold was writing",tone=L["deg"]),
             grow(L,"Suggestion &middot; Areas/Health/",glyph="spark",sub="Four notes that may be one area",tone=L["ag"],last=True)],
          head="NEEDS YOUR EYE &middot; 4")
ars=group(L,[grow(L,"Areas/Fsl",sub="Drey, the business setup, and the vendor thread you are in now"),
             grow(L,"Areas/Health",sub="Sleep, labs, and the protein blend"),
             grow(L,"Areas/Ops",sub="The lease, the studio, and the things with dates on them",last=True)],head="AREAS")
K1=phone(L,search+folddigest(L,w=CWD-36)+'<div style="height: 14px;"></div>'+eye+ars,tab="Knowledge",
         header=hdr(L,"Knowledge"),label="KNOWLEDGE &mdash; THE FOLD FIRST")

def frow(T,g,actor,subject,detail,when,*,tone=None,last=False):
    return (f'<div style="display: flex; gap: 10px; padding: 10px 0;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            f'<span style="display: flex; color: {tone or T["ts"]}; margin-top: 2px;">{ic(I[g],16,1.9)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;"><div style="display: flex; gap: 7px; align-items: baseline;">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{subject}</span><span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 12px; color: {T["tt"]};">{when}</span></div>'
            f'<div style="font-size: 13px; color: {T["ts"]}; margin-top: 2px; line-height: 1.4;">{mono(actor,T["ag"],11.5)} &middot; {detail}</div></div></div>')
act=(f'<div style="display: flex; gap: 6px; margin-bottom: 8px;">'
     + "".join(f'<span style="padding: 5px 11px; border-radius: 999px; font-size: 13px; background: {L["accq"] if s else "transparent"}; '
               f'color: {L["acc"] if s else L["ts"]}; border: 1px solid {"transparent" if s else L["bc"]};">{n}</span>'
               for n,s in (("Everything",True),("Agents",False),("Scheduled",False),("Captures",False))) + '</div>'
     + frow(L,"repeat","collator","Morning Brief","ran its routine &middot; wrote the brief","2h")
     + frow(L,"board","drey-dev","Claimed #412","Rebuild the cache report","3h")
     + frow(L,"failed","collector","aws-costs","last succeeded 2 days ago &middot; token expired","3h",tone=L["fail"])
     + frow(L,"note","you","Captured a note","&ldquo;Ask the landlord whether the March renewal&hellip;&rdquo;","4h")
     + frow(L,"check","claude-usage","Closed #409","cache report &middot; 4 findings","5h",last=True))
A1=phone(L,act,tab="More",header=hdr(L,"Activity",large=False,back="More"),label="MORE &#9656; ACTIVITY")

def agrow(T,name,what,state,*,remote=False,last=False,detail=None):
    return (f'<div style="display: flex; align-items: center; gap: 11px; min-height: 52px; padding: 8px 14px; box-sizing: border-box;'
            f'{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">{presdot(T,state)}'
            f'<div style="flex-grow: 1; min-width: 0;"><div>{agentchip(T,name,remote)}</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 3px;">{what}</div></div>'
            + (f'<span style="font-size: 13px; color: {T["ts"]};">{detail}</span>' if detail else "")
            + f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],14,2.3)}</span></div>')
ags=(group(L,[agrow(L,"collator","daily at 6:02 AM &middot; Morning Brief","working",detail="6m"),
              agrow(L,"drey-dev","migrating the settings pane","working",detail="12m"),
              agrow(L,"vendor-research","when Metis delegates","idle",last=True)],head="YOURS")
     + group(L,[agrow(L,"taskuary","waiting on you: write access to docs/","queued",remote=True,detail="41m"),
                agrow(L,"devin","idle since Monday","idle",remote=True,last=True)],head="CONNECTED")
     + f'<div style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.45; padding: 0 4px;">New agents are defined on the Mac.</div>')
G1=phone(L,ags,tab="More",header=hdr(L,"Agents",large=False,back="More"),label="MORE &#9656; AGENTS")

def perm(T,res,read,write,*,last=False):
    cell=lambda k,v:(f'<div style="display: flex; gap: 8px; font-size: 13px; margin-top: 3px;"><span style="width: 44px; color: {T["ts"]};">{k}</span>'
                     f'<span style="color: {T["tp"]};">{v}</span></div>')
    return (f'<div style="padding: 10px 14px;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]};">{res}</div>{cell("Read",read)}{cell("Write",write)}</div>')
det=(f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 14px;">{presdot(L,"working")}'
     f'<span style="font-family: {MONO}; font-size: 20px; font-weight: 600; color: {L["ag"]};">drey-dev</span></div>'
     + group(L,[perm(L,"Knowledge","Areas/Projects &middot; Areas/Ops","&mdash;"),
                perm(L,"Work","every project",f'status, comment {askmark(L)}'),
                perm(L,"Jira",f'issues &middot; {ic(I["relay"],11,2)} through Metistry',f'comment {askmark(L)}',last=True)],
             head="WHAT IT MAY DO",foot=f'{askmark(L)} Ask &mdash; comes to you first. Anything not listed is not granted.')
     + group(L,[grow(L,"Edit Permissions",chev=True,last=True)]))
G2=phone(L,det,tab="More",header=hdr(L,"",large=False,back="Agents"),label="AN AGENT &mdash; THE ONE TABLE, AS A LIST")

def occ(T,at,name,who,recur,*,state=None,last=False):
    mark=(f'<span style="display: flex; color: {T["fail"]};">{ic(I["failed"],15,2)}</span>' if state=="fail" else
          f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],14,2.3)}</span>' if state=="ok" else
          '<span style="width: 15px;"></span>')
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 10px 14px;{"" if last else " border-bottom: 0.5px solid "+T["border"]+";"}">'
            f'<span style="width: 66px; flex-shrink: 0; font-size: 13px; color: {T["ts"]}; font-variant-numeric: tabular-nums; padding-top: 1px;">{at}</span>'
            f'<div style="flex-grow: 1; min-width: 0;"><div style="font-size: 15px; color: {T["tp"]};">{name}</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 2px;">{mono(who,T["ag"],11.5)} &middot; {recur}</div></div>{mark}</div>')
rts=(group(L,[occ(L,"6:00 AM","Standup","metis","Working days",state="ok"),
              occ(L,"6:02 AM","Morning Brief","metis","Every day",state="ok"),
              occ(L,"7:00 AM","Vendor Sweep","vendor-research","Every day",state="fail"),
              occ(L,"7:00 PM","Tomorrow&rsquo;s Plan","metis","Working evenings"),
              occ(L,"10:00 PM","Knowledge Fold","metis","Every night",last=True)],head="TODAY")
     + group(L,[occ(L,"Sun 6 PM","Weekly Review","metis","Every week",last=True)],head="LATER THIS WEEK"))
R1=phone(L,rts,tab="More",header=hdr(L,"Scheduled",large=False,back="More"),label="MORE &#9656; SCHEDULED")

U1=phone(L,"",tab="More",header=hdr(L,"More"),overlay=sheet(L,"Usage",usagepop(L,w=CWD),top=120),label="USAGE &mdash; A SHEET")

sets=(group(L,[grow(L,"Instance",glyph="folder",detail="Studio"),grow(L,"Services",glyph="server"),
               grow(L,"Compute",glyph="cpu",detail="$60 a month"),grow(L,"Updates",glyph="update",last=True)])
      + group(L,[grow(L,"Account",glyph="person"),grow(L,"Connections",glyph="plug",detail="8"),
                 grow(L,"Sessions",glyph="repeat",detail="30 days",last=True)],head="ACCESS",
              foot="Secrets, Variables, Live Capture and Keyboard are set on the Mac: keys stay off this browser, and the others are the Mac&rsquo;s own."))
S1=phone(L,sets,tab="More",header=hdr(L,"Settings",large=False,back="More"),label="MORE &#9656; SETTINGS")

def budrow(T,name,val,sub=None,*,last=False,over=False):
    return grow(T,name,sub=sub,chev=False,last=last,
                right=(f'<span style="font-size: 15px; font-weight: 600; color: {T["deg"] if over else T["tp"]}; '
                       f'padding: 5px 10px; border-radius: 8px; background: {T["sunken"]};">{val}</span>'))
comp=(group(L,[budrow(L,"Every month","$60",sub="$41.20 so far &middot; stops compute at the limit",last=True)],head="THE INSTANCE")
      + group(L,[budrow(L,"Drey","$5 a day"),budrow(L,"Metistry","$4 a day"),
                 budrow(L,"FSL ops","$0.50 a day",sub="reached at 2:40 PM &middot; in Review",over=True),
                 budrow(L,"Home","$1 a day",last=True)],head="EACH PROJECT, EACH DAY",
              foot="A project that reaches its day&rsquo;s budget is put in Review and tells you in Needs You (C96). "
                   "The month&rsquo;s budget stops compute for everything.")
      + group(L,[grow(L,"Models and Providers",sub="Anthropic &middot; claude-sonnet for chat",last=True)]))
S2=phone(L,comp,tab="More",header=hdr(L,"Compute",large=False,back="Settings"),label="COMPUTE &mdash; WHERE RAISE LANDS")

NOTE=pan(L,"KNOWLEDGE AND MORE",
  nt(L,"<b>Knowledge opens on the fold</b>, then what needs your eye, then areas &mdash; the Mac&rsquo;s order, as rows.")
  + nt(L,"<b>More is the Mac&rsquo;s sidebar below Knowledge</b>, pushed one level: Activity, Agents, Routines; Usage "
         "arrives as a sheet; Settings is a grouped list. <b>Compute is drawn here first</b> &mdash; it is where "
         "both Raise buttons land (R2.6), and the Mac pane follows it.",12)
  + nt(L,"Agents are read and granted from the phone; <b>defining</b> one stays on the Mac.",12))

body=(heading("PWA &middot; SCREEN 18","Knowledge and everything under More",
        "The fold first; Activity, Agents, Routines, Usage and Settings one push away; Compute&rsquo;s budgets drawn for the first time.",L)
  + row(K1+A1+G1+G2+R1,24)
  + row(U1+S1+S2+f'<div style="flex-grow: 1; min-width: 0;">{NOTE}</div>',24))
(PROJ/"PWA-More.dc.html").write_text(page("PWA — Knowledge and More",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote PWA-More.dc.html ({CW}x{CH})")
