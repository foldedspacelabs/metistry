"""Settings panes: Instance, Services, Compute, Updates, Keyboard, Advanced (2026-09-25).

C123–C127. Built from what the app already reads (settings-view.swift,
compute-view.swift, updater.swift) and the owner's rulings: the assistant's name
is set here; services get their controls and Doctor; provider keys are Secrets;
the runtime updates and rolls back here; linked instances list under Instance;
one Keyboard pane holds the any-app switch.
"""
from lib import *
from lib_connect import ref, rfield, seg, lbl
from lib_access import combo, recorder

SANS_="-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"
def plain(t): return '<span style="font-family: '+SANS_+'; font-size: 12.5px;">'+t+'</span>'
def ph(T,t): return '<span style="color: '+T["ts"]+'; font-family: '+SANS_+'; font-size: 12.5px;">'+t+'</span>'
def ibtn(T,g,title):
    return (f'<span title="{title}" style="display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 24px; '
            f'border-radius: 6px; border: 1px solid {T["bc"]}; background: {T["surface"]}; color: {T["ts"]};">{ic(I[g],12,2)}</span>')
def body(T,*blocks): return '<div style="padding: 2px 18px 18px; display: flex; flex-direction: column; gap: 16px;">'+"".join(blocks)+'</div>'
def dot(T,c): return f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {c}; flex-shrink: 0;"></span>'
def note(T,t,g=None,c=None):
    return (f'<div style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">'
            + (f'<span style="display: flex; color: {c or T["ts"]};">{ic(I[g],12,2.1)}</span>' if g else "") + f'{t}</div>')

# ---- Instance -------------------------------------------------------------------------------
def instancepane(T):
    who=sunk(T,
        f'<div style="display: grid; grid-template-columns: 90px minmax(0,1fr); gap: 9px 12px; align-items: center;">'
        f'{lbl(T,"Name")}{rfield(T,plain("Metis"),focus=True)}'
        f'{lbl(T,"Mention")}{rfield(T,"@metis")}'
        f'{lbl(T,"Mark")}<span style="display: flex; align-items: center; gap: 10px;">{mark(T,size=22)}'
        f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Change</span></span>'
        f'{lbl(T,"Instance ID")}<span style="display: flex; align-items: center; gap: 8px;">{mono("inst_7f3a92c1e0b4",T["ts"],11.5)}{ibtn(T,"copy","Copy")}</span></div>'
        + note(T,"Everywhere the assistant is named uses this. Saving writes identity.yaml and shows in Activity.","lock"))
    here=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><span style="display: flex; color: {T["ts"]};">{ic(I["folder"],15,1.9)}</span>'
        f'<span style="flex-grow: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">'
        f'{mono("~/Development/metistry-home",T["tp"],12)}</span>{btn(T,"Choose…","secondary")}{btn(T,"Open in Finder","ghost")}</div>'
        + note(T,"Runs as <b>default</b> &middot; ports 7400&ndash;7407"))
    rec=sunk(T,"".join(
        f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 0; {bd_(T,i==2)}">'
        f'<span style="display: flex; color: {T["ok"] if cur else T["tt"]}; width: 14px;">{ic(I["check"] if cur else I["folder"],13,2)}</span>'
        f'<span style="flex-grow: 1;">{mono(pth,T["tp"],11.5)}</span><span style="font-size: 11.5px; color: {T["ts"]};">{w}</span>'
        f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"] if not cur else T["tt"]};">{"In use" if cur else "Forget"}</span></div>'
        for i,(pth,w,cur) in enumerate((("~/Development/metistry-home","now",True),("~/Development/metistry-test","2 days ago",False),
                                         ("~/cos-test","3 weeks ago",False)))))
    peers=sunk(T,"".join(
        f'<div style="display: grid; grid-template-columns: 10px minmax(0,1fr) 150px 26px; gap: 10px; align-items: center; padding: 8px 0; {bd_(T,i==1)}">'
        f'{dot(T,T["ok"] if ok else T["stale"])}<div>{mono(o,T["tp"],11.5)}<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{c}</div></div>'
        f'<span style="font-size: 11.5px; color: {T["stale"] if not ok else T["ts"]};">{s}</span>{ibtn(T,"x","Remove")}</div>'
        for i,(o,c,s,ok) in enumerate((("https://work.metistry.fsl.dev","Knowledge &middot; sends work","Seen 2 min ago",True),
                                        ("https://studio.local:7401","Knowledge","Last seen 3 days ago",False))))
        + f'<div style="display: flex; gap: 8px; margin-top: 10px;">{btn(T,"Link an Instance…","secondary",I["plus"])}{btn(T,"Refresh","ghost",I["repeat"])}</div>')
    return panehead(T,"Instance")+body(T,block(T,"THE ASSISTANT",who),block(T,"THIS INSTANCE",here),
                                       block(T,"RECENT",rec),block(T,"LINKED INSTANCES",peers))

# ---- Services ------------------------------------------------------------------------------
SVCS=[("db","running","Up 3 d 4 h","0","7400"),
      ("console","running","Up 3 d 4 h","0","7401"),
      ("reconciler","running","Up 3 d 4 h","1","7402"),
      ("assistant","crash","Exited 1 &middot; 5 restarts in 2 min","5","7403"),
      ("eventkit","backoff","Restarting in 8 s &middot; 3rd try","3","7404"),
      ("apple-fm","running","Up 3 d 4 h","0","7405"),
      ("watchdog","running","Inside the supervisor","0","&mdash;")]
def svcrow(T,name,st,line,rs,port,*,last=False):
    mk={"running":dot(T,T["ok"]),"crash":f'<span style="display: flex; color: {T["fail"]};">{ic(I["failed"],12,2.2)}</span>',
        "backoff":f'<span style="display: flex; color: {T["deg"]};">{ic(I["clock"],12,2.2)}</span>',"stopped":dot(T,T["tt"])}[st]
    word={"running":"Running","crash":"Crash-looping","backoff":"Backing off","stopped":"Stopped"}[st]
    col={"crash":T["fail"]}.get(st,T["ts"])
    return (f'<div style="display: grid; grid-template-columns: 14px 100px minmax(0,1fr) 44px 84px; gap: 10px; align-items: center; padding: 8px 0; {bd_(T,last)}">'
            f'{mk}{mono(name,T["tp"],12)}<div><span style="font-size: 12px; font-weight: 600; color: {col};">{word}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};"> &middot; {line}</span></div>'
            f'<span style="font-size: 11.5px; color: {T["ts"]}; font-variant-numeric: tabular-nums;">{port}</span>'
            f'<span style="display: flex; gap: 4px; justify-content: flex-end;">{ibtn(T,"repeat","Restart")}{ibtn(T,"stop","Stop")}{ibtn(T,"note","Log")}</span></div>')

def doctor(T,*,w=None):
    probs=[("failed",T["fail"],"assistant can&rsquo;t start: it needs <b>db</b>, which was restarting","Restart assistant"),
           ("warn",T["deg"],"eventkit needs Calendar access","Open System Settings")]
    return sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">2 problems</span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">Checked 1 min ago</span>{btn(T,"Run Doctor","secondary",I["wrench"])}</div>'
        + "".join(f'<div style="display: flex; align-items: center; gap: 9px; padding: 9px 0 0; margin-top: 9px; border-top: 1px solid {T["border"]};">'
                  f'<span style="display: flex; color: {c};">{ic(I[g],13,2.1)}</span><span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{t}</span>'
                  f'{btn(T,a,"secondary")}</div>' for g,c,t,a in probs)
        + f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 9px;">14 checks passed</div>')

def servicespane(T):
    head=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><div style="flex-grow: 1;">'
        f'<div style="font-size: 12.5px; color: {T["tp"]};">Supervised by <b>launchd</b></div>'
        f'<div style="margin-top: 2px;">{mono("com.foldedspacelabs.metistry",T["ts"],11)}</div></div>'
        f'{btn(T,"Restart All","secondary",I["repeat"])}{btn(T,"Stop All","ghost",I["stop"])}</div>'
        f'<div style="margin-top: 10px; border-top: 1px solid {T["border"]};">'
        + "".join(svcrow(T,*s,last=(i==len(SVCS)-1)) for i,s in enumerate(SVCS)) + '</div>')
    life=sunk(T,
        setrow(T,label="Start at Login",note="Opens Metistry when you log in",control=toggle(T,True))
        + setrow(T,label="Run in the Background",note="Services keep running when the app is closed",control=toggle(T,True))
        + awake(T,on=True,tipfor="lid"))
    return panehead(T,"Services")+body(T,block(T,"DOCTOR",doctor(T)),block(T,"SERVICES",head),block(T,"WHEN IT RUNS",life))

def warnmark(T,tip=None):
    g=f'<span style="display: flex; color: {T["deg"]};">{ic(I["warn"],13,2.1)}</span>'
    if not tip: return f'<span style="position: relative; display: inline-flex;">{g}</span>'
    return (f'<span style="position: relative; display: inline-flex;">{g}'
            f'<span style="position: absolute; left: 20px; top: -8px; width: 250px; z-index: 2; padding: 7px 10px; border-radius: 8px; '
            f'background: {T["elevated"]}; border: 1px solid {T["bc"]}; box-shadow: 0 8px 22px rgba(26,24,21,0.2); font-size: 11.5px; '
            f'line-height: 1.45; color: {T["tp"]};">{tip}</span></span>')

def awake(T,*,on=True,tipfor=None):
    subs=[("Allow sleep on battery","battery","Off, Metistry keeps a laptop awake on battery. Scheduled work can run it flat."),
          ("Allow sleep when the lid is closed","lid","Off, a closed laptop keeps running. In a bag it can overheat.")]
    rows="".join(
        f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0 9px 22px; border-top: 1px solid {T["border"]}; opacity: {1 if on else 0.42};">'
        f'<span style="font-size: 12.5px; color: {T["tp"]};">{lab}</span>{warnmark(T,tip if (on and tipfor==k) else None)}'
        f'<span style="flex-grow: 1;"></span>{toggle(T,True)}</div>' for lab,k,tip in subs)
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid {T["border"]};">'
            f'<div style="flex-grow: 1;"><div style="font-size: 12.5px; color: {T["tp"]};">Keep this Mac Awake</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">So scheduled work runs overnight</div></div>{toggle(T,on)}</div>' + rows)

# ---- Compute -------------------------------------------------------------------------------
def tag(T,t,*,strong=False):
    return (f'<span style="font-size: 10.5px; font-weight: 600; color: {T["tp"] if strong else T["ts"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 999px; padding: 0 7px; line-height: 17px; white-space: nowrap;">{t}</span>')
def pick(T,t,w):
    return (f'<span style="display: inline-flex; align-items: center; justify-content: space-between; width: {w}px; box-sizing: border-box; padding: 4px 9px; '
            f'border: 1px solid {T["bc"]}; border-radius: 7px; background: {T["surface"]}; font-size: 12.5px; color: {T["tp"]};">{t}'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"],11,2.2)}</span></span>')
def tabbar(T,items,sel):
    return (f'<div style="display: flex; gap: 20px; border-bottom: 1px solid {T["border"]};">'
            + "".join(f'<span style="padding: 7px 0 8px; font-size: 13px; font-weight: {600 if n==sel else 500}; color: {T["tp"] if n==sel else T["ts"]}; '
                      f'box-shadow: {"inset 0 -2px 0 "+T["acc"] if n==sel else "none"};">{n} <span style="font-weight: 400; color: {T["ts"]};">{c}</span></span>' for n,c in items)
            + '</div>')
def prov(T,name,tags,line,*,acts=True,last=False,extra=""):
    return (f'<div style="padding: 10px 0; {bd_(T,last)}"><div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</span>{"".join(tags)}<span style="flex-grow: 1;"></span>'
            + (f'{btn(T,"Test","ghost",I["check"])}{ibtn(T,"x","Remove")}' if acts else "") + '</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 4px;">{line}</div>{extra}</div>')

def metisblock(T):
    return sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><span style="display: flex; color: {T["ag"]};">{ic(I["cpu"],16,1.9)}</span>'
        f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Metis uses</span></div>'
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center; margin-top: 11px;">'
        f'{lbl(T,"Model")}<span style="display: flex; align-items: center; gap: 8px;">{pick(T,"Claude Sonnet",190)}'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">via Claude</span>{tag(T,"Subscription")}</span>'
        f'{lbl(T,"Effort")}<span>{seg(T,["Low","Medium","High"],"Medium")}</span>'
        f'{lbl(T,"If it fails")}<span style="display: flex; align-items: center; gap: 8px;">{pick(T,"Qwen3 Coder 30B",190)}'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">on this Mac</span>{tag(T,"Local")}</span></div>'
        + note(T,"Agents and routines choose their own model in their definitions, from Your Models below."))

PROVS=[("Apple Foundation Models",["Local","Free"],"Built into macOS &middot; ready",None,True,False),
       ("LM Studio",["Local","Free"],"localhost:1234 &middot; running",None,True,True),
       ("Ollama",["Local","Free"],"Not running &middot; <b>Start Ollama</b>",None,True,True),
       ("Claude",["Cloud","Subscription"],"Max plan &middot; this window 42% used, resets in 3 h","signed",True,True),
       ("OpenRouter",["Cloud","By token","ZDR claimed"],"300+ models","openrouter_key",True,True),
       ("Groq",["Cloud","By token","No ZDR claim"],"","groq_key",True,True),
       ("Together AI",["Cloud","By token"],"","missing",False,True)]
def provrow2(T,name,tags,line,cred,on,rm,*,last=False):
    if cred=="signed": c=f'<span style="font-size: 11.5px; color: {T["ts"]};">Signed in &middot; <b style="color: {T["acc"]};">Sign Out</b></span>'
    elif cred=="missing": c=(f'<span style="font-size: 11.5px; color: {T["fail"]};">{ic(I["failed"],11,2.2)} Key not set</span>'
                             f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};"> &middot; Choose a secret</span>')
    elif cred: c=f'<span style="display: inline-flex; align-items: center; gap: 6px;"><span style="font-size: 11.5px; color: {T["ts"]};">Key</span>{ref(T,"secret",cred)}</span>'
    else: c=""
    sub_=" &middot; ".join(x for x in (line,) if x)
    return (f'<div style="display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 10px 0; {bd_(T,last)} opacity: {1 if on else 0.6};">'
            f'{toggle(T,on)}<div><div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap;">'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</span>{"".join(tag(T,t) for t in tags)}</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px;">'
            + (f'<span style="font-size: 11.5px; color: {T["ts"]};">{sub_}</span>' if sub_ else "") + (" " if sub_ and c else "") + c + '</div></div>'
            f'<span style="display: flex; gap: 5px;">{btn(T,"Test","ghost",I["check"])}{ibtn(T,"x","Remove") if rm else ""}</span></div>')

def providers2(T):
    return sunk(T,"".join(provrow2(T,*p_,last=(i==len(PROVS)-1)) for i,p_ in enumerate(PROVS))
        + f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 10px;">{btn(T,"Add Provider…","secondary",I["plus"])}'
          f'<span style="font-size: 11.5px; color: {T["ts"]};">Switched-off providers aren&rsquo;t searched or offered.</span></div>')

def meter(T,label,used,total,frac,col):
    return (f'<div style="display: grid; grid-template-columns: 56px minmax(0,1fr) 96px; gap: 10px; align-items: center;">'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{label}</span>'
            f'<div style="height: 6px; border-radius: 3px; background: {T["border"]}; overflow: hidden;"><div style="width: {int(frac*100)}%; height: 100%; background: {col};"></div></div>'
            f'<span style="font-size: 11.5px; color: {T["ts"]}; text-align: right; font-variant-numeric: tabular-nums;">{used} of {total}</span></div>')

def chipsrow(T,items,on=()):
    return ('<div style="display: flex; gap: 6px; flex-wrap: wrap;">'
            + "".join(f'<span style="font-size: 11.5px; padding: 2px 9px; border-radius: 999px; border: 1px solid {T["acc"] if i in on else T["bc"]}; '
                      f'color: {T["acc"] if i in on else T["ts"]}; background: {T["accq"] if i in on else "transparent"}; font-weight: {600 if i in on else 500};">{i}</span>' for i in items)
            + '</div>')

def yrow(T,name,maker,route,tags,right,act,*,last=False,loaded=False):
    st=(f'<span style="display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: {T["tp"]};">'
        f'<span style="width: 7px; height: 7px; border-radius: 50%; background: {T["ok"]};"></span>Loaded</span>' if loaded else "")
    return (f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 150px 84px; gap: 10px; align-items: center; padding: 8px 0; {bd_(T,last)}">'
            f'<div><div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap;"><span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{maker}</span></div>'
            f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap;"><span style="font-size: 11.5px; color: {T["ts"]};">{route}</span>{"".join(tag(T,t) for t in tags)}</div></div>'
            f'<div style="text-align: right;">{st}<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{right}</div></div>'
            f'<span style="display: flex; justify-content: flex-end;">{act}</span></div>')

def yourmodels(T):
    head=(meter(T,"Memory","19 GB","64 GB",0.30,T["ag"]) + '<div style="height: 6px;"></div>' + meter(T,"Disk","61 GB","1 TB",0.12,T["ts"]))
    search=(f'<div style="display: flex; gap: 8px; align-items: center; margin-top: 12px;"><div style="flex-grow: 1;">'
            f'{rfield(T,ph(T,"Search 6 providers for models — llama, qwen, sonnet…"))}</div></div>')
    grp=lambda t:f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; margin: 14px 0 2px;">{t}</div>'
    local=(yrow(T,"Qwen3 Coder 30B","Alibaba","LM Studio &middot; Q4_K_M",["Local","Free"],"19 GB",btn(T,"Unload","ghost"),loaded=True)
           + yrow(T,"Llama 3.2 3B","Meta","LM Studio &middot; Q8",["Local","Free"],"3 GB",btn(T,"Load","secondary"))
           + yrow(T,"Foundation Model","Apple","Built in",["Local","Free"],"&mdash;","",loaded=True,last=True))
    cloud=(yrow(T,"Claude Sonnet","Anthropic","via Claude",["Cloud","Subscription"],"Included in Max",ibtn(T,"x","Remove"))
           + yrow(T,"Claude Opus","Anthropic","via Claude",["Cloud","Subscription"],"Included in Max",ibtn(T,"x","Remove"))
           + yrow(T,"Llama 3.1 8B","Meta","via Groq",["Cloud","By token"],"$0.05 / $0.08 per M",ibtn(T,"x","Remove"),last=True))
    return sunk(T,head+search+grp("ON THIS MAC &middot; 3")+local+grp("FROM THE CLOUD &middot; 3")+cloud)

def offer(T,prov,tags,detail,price,act,*,best=None,last=False):
    return (f'<div style="display: grid; grid-template-columns: 110px minmax(0,1fr) 120px 76px; gap: 8px; align-items: center; padding: 7px 0 7px 12px; {bd_(T,last)}">'
            f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{prov}</span>'
            f'<div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">{"".join(tag(T,t) for t in tags)}'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{detail}</span></div>'
            f'<div style="text-align: right;"><div style="font-size: 12px; color: {T["tp"]}; font-variant-numeric: tabular-nums;">{price}</div>'
            + (f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; color: {T["ok"]};">{best}</div>' if best else "")
            + f'</div><span style="display: flex; justify-content: flex-end;">{act}</span></div>')

def modelsearch(T):
    head=(meter(T,"Memory","19 GB","64 GB",0.30,T["ag"]) + '<div style="height: 6px;"></div>' + meter(T,"Disk","61 GB","1 TB",0.12,T["ts"]))
    search=(f'<div style="margin-top: 12px;">{rfield(T,plain("llama 3.3"),focus=True)}</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 9px;">{chipsrow(T,["Local","Cloud","Free","By token","Subscription","Fits this Mac","Tools"],on=("Tools",))}'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; color: {T["ts"]}; white-space: nowrap;">Sort: Best match &#9662;</span></div>')
    m1=(f'<div style="margin-top: 14px; border: 1px solid {T["border"]}; border-radius: 10px; background: {T["bg"]}; padding: 10px 12px;">'
        f'<div style="display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;"><span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Llama 3.3 70B Instruct</span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">Meta &middot; 128K context &middot; tools &middot; 5 places</span></div>'
        f'<div style="margin-top: 6px;">'
        + offer(T,"OpenRouter",["Cloud","By token"],"ZDR claimed","$0.13 / $0.40",btn(T,"Add","secondary",I["plus"]),best="CHEAPEST")
        + offer(T,"Groq",["Cloud","By token"],"no ZDR claim","$0.59 / $0.79",btn(T,"Add","secondary",I["plus"]))
        + offer(T,"Ollama",["Local","Free"],"Q4_K_M &middot; 43 GB &middot; needs 48 GB",f'<span style="color: {T["ts"]};">Tight fit</span>',btn(T,"Install","secondary",I["update"]))
        + offer(T,"LM Studio",["Local","Free"],"Q3_K_L &middot; 37 GB &middot; needs 41 GB","Fits",btn(T,"Install","secondary",I["update"]))
        + offer(T,"LM Studio",["Local","Free"],"Q8_0 &middot; 75 GB",f'<span style="color: {T["fail"]};">Too large</span>',btn(T,"Install","disabled",I["update"]),last=True)
        + '</div><div style="font-size: 11px; color: {c}; margin-top: 6px;">Prices per million tokens, in / out.</div></div>'.replace("{c}",T["ts"]))
    m2=(f'<div style="margin-top: 10px; border: 1px solid {T["border"]}; border-radius: 10px; background: {T["bg"]}; padding: 10px 12px;">'
        f'<div style="display: flex; align-items: baseline; gap: 8px;"><span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Llama 3.3 Nemotron Super 49B</span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">NVIDIA, from Llama 3.3 &middot; 2 places</span><span style="flex-grow: 1;"></span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">Local or cloud &middot; from $0.10 per M</span><span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.2)}</span></div></div>')
    return sunk(T,head+search+m1+m2)

def computepane(T,mode="default"):
    models=yourmodels(T) if mode=="default" else modelsearch(T)
    return (panehead(T,"Compute")+body(T,block(T,"METIS",metisblock(T)),block(T,"PROVIDERS",providers2(T)),
            block(T,"YOUR MODELS" if mode=="default" else "YOUR MODELS &mdash; SEARCHING",models),block(T,"SPENDING LIMITS",limits2(T))))

def limits2(T):
    hdr=(f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 64px 64px 214px; gap: 8px; padding-bottom: 5px; font-size: 10.5px; '
         f'font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};"><span></span><span>DAY</span><span>MONTH</span><span>THEN</span></div>')
    return sunk(T,hdr + limitrow(T,"This instance","$5.00","$80","Stop") + limitrow(T,"OpenRouter","$4.00","$60","Critical only")
        + limitrow(T,"Groq","&mdash;","$10","Stop",last=True)
        + f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 9px; border-top: 1px solid {T["border"]};">'
          f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">Claude &middot; subscription</span>'
          f'<span style="font-size: 11.5px; color: {T["ts"]};">The plan&rsquo;s window is its limit</span></div>'
        + f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">Today $1.84 of $5.00 &middot; local models cost nothing &middot; Stop pauses routines and asks in Needs You.</div>')

def agentcompute(T,*,w=560):
    """In an agent's definition: a model, then where it runs."""
    return (f'<div style="width: {w}px; box-sizing: border-box; border: 1px solid {T["bc"]}; border-radius: 12px; background: {T["bg"]}; padding: 14px 16px;">'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">{agentchip(T,"collator")}'
            f'<span style="font-size: 12px; color: {T["ts"]};">definition</span></div>'
            + block(T,"COMPUTE",sunk(T,
                f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center;">'
                f'{lbl(T,"Model")}<span>{pick(T,"Llama 3.3 70B Instruct",250)}</span>'
                f'{lbl(T,"Runs on")}<span style="display: flex; align-items: center; gap: 8px;">{pick(T,"OpenRouter",150)}{tag(T,"Cloud")}{tag(T,"By token")}'
                f'<span style="font-size: 11.5px; color: {T["ts"]};">$0.13 / $0.40</span></span>'
                f'{lbl(T,"Effort")}<span>{seg(T,["Low","Medium","High"],"Medium")}</span></div>'
                + note(T,"Models come from Your Models. <b>Same as Metis</b> follows Metis&rsquo;s choice.")))
            + '</div>')

def limitrow(T,who,day,month,act,*,last=False):
    f_=lambda v:f'<span style="display: inline-block; width: 64px; box-sizing: border-box; padding: 3px 7px; border: 1px solid {T["bc"]}; border-radius: 6px; background: {T["surface"]}; font-size: 12px; color: {T["tp"]}; text-align: right; font-variant-numeric: tabular-nums;">{v}</span>'
    return (f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 64px 64px 214px; gap: 8px; align-items: center; padding: 6px 0; {bd_(T,last)}">'
            f'<span style="font-size: 12.5px; color: {T["tp"]};">{who}</span>{f_(day)}{f_(month)}{seg(T,["Allow","Stop","Critical only"],act)}</div>')

# ---- Updates -------------------------------------------------------------------------------
def updatespane(T):
    app=sunk(T,kv(T,"Version","1.4.2 &middot; Stable")
        + f'<div style="display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],13,2.2)}</span><span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">Up to date &middot; checked 2 hours ago</span>'
          f'{btn(T,"Check Now","secondary")}</div>'
        + setrow(T,label="Check for updates automatically",control=toggle(T,True),last=True))
    rt=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><div style="flex-grow: 1;">'
        f'<div style="font-size: 12.5px; color: {T["tp"]};">Running <b>2026.09.24</b></div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">Signed release &middot; installed yesterday &middot; checksums verified</div></div></div>'
        f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 10px 12px; border-radius: 9px; background: {T["surface"]}; border: 1px solid {T["border"]};">'
        f'<span style="display: flex; color: {T["acc"]};">{ic(I["update"],15,2)}</span><span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;"><b>2026.09.25</b> is available</span>'
        f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">What&rsquo;s New</span>{btn(T,"Update Runtime","affirm")}</div>'
        f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 10px;"><span style="font-size: 12px; color: {T["ts"]}; flex-grow: 1;">'
        f'Previous: 2026.09.20 &middot; kept so you can go back</span>{btn(T,"Roll Back","ghost",I["undo"])}</div>'
        + note(T,"Services restart once; Needs You and your notes are untouched."))
    return panehead(T,"Updates")+body(T,block(T,"THIS APP",app),block(T,"METISTRY RUNTIME",rt))

# ---- Keyboard ------------------------------------------------------------------------------
def keyboardpane(T,*,on=False):
    rows="".join(
        f'<div style="display: flex; align-items: center; gap: 12px; padding: 8px 0; {bd_(T,i==4)} opacity: {1 if on else 0.45};">'
        f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{a}</span>{recorder(T,k)}</div>'
        for i,(a,k) in enumerate((("Ask Metis",["⌃","⌥","⌘","A"]),("Note",["⌃","⌥","⌘","N"]),("To-do",["⌃","⌥","⌘","T"]),
                                   ("Start Recording",["⌃","⌥","⌘","R"]),("Stop Recording",["⌃","⌥","⌘","S"]))))
    main=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;"><div style="flex-grow: 1;">'
        f'<div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Shortcuts in any app</div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">'
        + ("Ask, Note, To-do and recording, while another app is in front." if on else "Off. Metistry registers nothing outside its own windows.")
        + f'</div></div>{toggle(T,on)}</div><div style="margin-top: 10px; border-top: 1px solid {T["border"]};">{rows}</div>'
        + note(T,"Click a shortcut to change it. Each is checked with macOS when set."))
    inapp=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 11px 13px; border-radius: 10px; border: 1px solid {T["border"]};">'
           f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">Shortcuts inside Metistry are always on, in its menus.</span>'
           f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Show All</span>{combo(T,["⌘","/"])}</div>')
    return panehead(T,"Keyboard")+body(T,main,inapp)

# ---- Advanced ------------------------------------------------------------------------------
def advancedpane(T):
    rt=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px; padding-bottom: 9px; border-bottom: 1px solid {T["border"]};">'
        f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">Runtime from</span>{seg(T,["Releases","Git checkout"],"Releases")}</div>'
        + kv(T,"Command","metistry &middot; 2026.09.24",mono_=False)
        + kv(T,"Product folder","~/Library/Application Support/Metistry/product",mono_=True,last=True))
    dev=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 8px;"><div style="flex-grow: 1;">{rfield(T,ph(T,"No override"))}</div>'
        f'{btn(T,"Choose…","secondary")}{btn(T,"Clear","ghost")}</div>'
        + note(T,"Runs the product from a local checkout instead. For developing Metistry."))
    ver=sunk(T,kv(T,"App","1.4.2") + kv(T,"Runtime","2026.09.24") + kv(T,"Bundled runtime","2026.09.20")
             + kv(T,"Instance pin","2026.09.24 &middot; 41 migrations applied",last=True))
    diag=sunk(T,
        setrow(T,label="Logs",note="One file per service, for this instance",control=btn(T,"Open in Finder","secondary"))
        + setrow(T,label="Passkeys",note="Ask macOS whether this Mac can use one",control=btn(T,"Check","secondary"),last=True))
    return panehead(T,"Advanced")+body(T,block(T,"RUNTIME",rt),block(T,"DEVELOPER OVERRIDE",dev),block(T,"VERSIONS",ver),block(T,"DIAGNOSTICS",diag))
