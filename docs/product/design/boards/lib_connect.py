"""Connections, Secrets and Variables (2026-09-25; C114–C117).

One noun for anything outside Metistry — a Connection, typed. Any connection can
be offered to agents through Metistry's MCP proxy; non-MCP types get tools
Metistry generates. Credentials are Secrets, per instance, in the Keychain,
referenced as {{ secret.name }}; shared plain values are Variables,
{{ variable.name }}, usable anywhere including an agent's context.
"""
from lib import *
from lib_needs import rcard, rhead2, rask, rcontext, ranswers
I.setdefault("feed",'<path d="M5 5a14 14 0 0114 14"/><path d="M5 11a8 8 0 018 8"/><circle cx="6" cy="18" r="1.4"/>')
I.setdefault("api",'<path d="M8 4.5c-2 0-2.5 1-2.5 3v2c0 1.2-.8 2.5-2 2.5 1.2 0 2 1.3 2 2.5v2c0 2 .5 3 2.5 3M16 4.5c2 0 2.5 1 2.5 3v2c0 1.2.8 2.5 2 2.5-1.2 0-2 1.3-2 2.5v2c0 2-.5 3-2.5 3"/>')
I.setdefault("shield",'<path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6.3z"/>')
I.setdefault("brace",'<path d="M9 4.5H8a2 2 0 00-2 2v3a2.5 2.5 0 01-2 2.5 2.5 2.5 0 012 2.5v3a2 2 0 002 2h1M15 4.5h1a2 2 0 012 2v3a2.5 2.5 0 002 2.5 2.5 2.5 0 00-2 2.5v3a2 2 0 01-2 2h-1"/>')

# ---- types -------------------------------------------------------------------------------
TYPES={"mcp":("relay","MCP server"),"agent":("agents","Agent"),"api":("api","API"),
       "feed":("feed","Feed"),"files":("folder","Files")}
def tglyph(T,t,s=14,c=None): return f'<span style="display: flex; color: {c or T["ts"]};">{ic(I[TYPES[t][0]],s,1.9)}</span>'

# ---- a reference to a secret or a variable, as it reads in any field ------------------------
def ref(T,kind,name):
    g="key" if kind=="secret" else "brace"
    return (f'<span style="display: inline-flex; align-items: center; gap: 4px; padding: 0 7px 0 5px; border-radius: 6px; '
            f'border: 1px solid {T["bc"]}; background: {T["sunken"]}; font-family: {MONO}; font-size: 11px; line-height: 19px; '
            f'color: {T["tp"]}; white-space: nowrap;"><span style="display: flex; color: {T["ts"]};">{ic(I[g],11,2)}</span>'
            f'<span><span style="color: {T["ts"]};">{kind}.</span>{name}</span></span>')

def rfield(T,inner,*,focus=False):
    return (f'<div style="display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-height: 30px; box-sizing: border-box; '
            f'padding: 4px 9px; border-radius: 7px; background: {T["surface"]}; font-family: {MONO}; font-size: 11.5px; color: {T["tp"]}; '
            f'border: 1px solid {T["acc"] if focus else T["bc"]};'
            + (f' box-shadow: 0 0 0 3px {rgba(T["acc"],0.18)};' if focus else "") + f'">{inner}</div>')

def refpicker(T,*,w=300):
    """Typing {{ opens this: secrets and variables, filtered as you type."""
    def it(kind,name,sub_,on=False):
        return (f'<div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; '
                f'background: {T["accq"] if on else "transparent"};">{ref(T,kind,name)}'
                f'<span style="flex-grow: 1;"></span><span style="font-size: 11px; color: {T["ts"]};">{sub_}</span></div>')
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 10px; padding: 5px; box-shadow: 0 10px 28px rgba(26,24,21,0.18);">'
            f'<div style="padding: 5px 10px 3px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">SECRETS</div>'
            + it("secret","devin_key","sent to devin.ai",True) + it("secret","github_read","sent to github.com")
            + f'<div style="padding: 7px 10px 3px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">VARIABLES</div>'
            + it("variable","devin_org","org-7f3a&hellip;") + '</div>')

# ---- Settings ▸ Connections: the list -------------------------------------------------------
CONNS=[("GitHub","api","API &middot; MCP","2 agents &middot; 1 sync",True,"ok"),
       ("Devin","mcp","MCP &middot; API","1 agent &middot; 2 syncs &middot; Metis",True,"fail"),
       ("Jira","mcp","MCP &middot; work network","2 agents &middot; 1 routine",True,"ok"),
       ("Local Crew","agent","Agent &middot; ACP","Metis sends work",False,"ok"),
       ("AWS","api","API","1 sync",False,"ok"),
       ("Release Notes","feed","Feed &middot; RSS","1 sync &middot; 1 agent",True,"ok"),
       ("Team Drive","files","Files &middot; folder","1 agent",True,"ok"),
       ("Linear","mcp","MCP","Nobody yet",False,"ok")]
def connrow3(T,name,t,kind,used,offered,state,*,sel=False,last=False):
    dot=(f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["ok"]};"></span>' if state=="ok" else
         f'<span style="display: flex; color: {T["fail"]}; margin-left: -2px;">{ic(I["failed"],12,2.2)}</span>')
    prox=(f'<span title="Offered to agents through Metistry" style="display: flex; color: {T["acc"]};">{ic(I["shield"],13,2)}</span>'
          if offered else '<span></span>')
    return (f'<div style="display: grid; grid-template-columns: 9px 150px 130px minmax(0,1fr) 14px 13px; align-items: center; gap: 11px; '
            f'padding: 10px 16px; background: {T["surface"] if sel else "transparent"}; '
            f'box-shadow: {"inset 3px 0 0 "+T["acc"] if sel else "none"}; {bd_(T,last)}">{dot}'
            f'<span style="display: inline-flex; align-items: center; gap: 8px;">{tglyph(T,t)}'
            f'<span style="font-size: 13px; font-weight: {600 if sel else 500}; color: {T["tp"]};">{name}</span></span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{kind}</span>'
            f'<span style="font-size: 12px; color: {T["fail"] if state=="fail" else T["ts"]};">'
            f'{"Key expired &middot; "+used if state=="fail" else used}</span>{prox}'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.2)}</span></div>')

def connlist(T,*,sel=None):
    head=panehead(T,"Connections",btn(T,"Add Connection","secondary",I["plus"]))
    cols=(f'<div style="display: grid; grid-template-columns: 9px 150px 130px minmax(0,1fr) 14px 13px; gap: 11px; padding: 6px 16px; '
          f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>NAME</span><span>TYPE</span><span>USED BY</span><span></span><span></span></div>')
    rows="".join(connrow3(T,*c,sel=(c[0]==sel),last=(i==len(CONNS)-1)) for i,c in enumerate(CONNS))
    key=(f'<div style="display: flex; align-items: center; gap: 7px; padding: 10px 16px; font-size: 11.5px; color: {T["ts"]}; '
         f'border-top: 1px solid {T["border"]};"><span style="display: flex; color: {T["acc"]};">{ic(I["shield"],12,2)}</span>'
         f'Offered to agents through Metistry</div>')
    return f'<div style="background: {T["bg"]};">{head}{cols}{rows}{key}</div>'

# ---- one connection: Devin (MCP + API, and its MCP can start sessions) ---------------------
def toolrow3(T,name,desc,state,*,last=False):
    from lib import tristate
    return (f'<div style="display: grid; grid-template-columns: 150px minmax(0,1fr) 124px; align-items: center; gap: 12px; '
            f'padding: 7px 0; {bd_(T,last)}">{mono(name,T["tp"],11.5)}'
            f'<span style="font-size: 12px; color: {T["ts"]};">{desc}</span>{tristate(T,state)}</div>')

def toolgroup(T,label,rows,*,first=False):
    return ((f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; '
             f'margin: {0 if first else 12}px 0 2px;">{label}</div>')
            + "".join(toolrow3(T,*r,last=(i==len(rows)-1)) for i,r in enumerate(rows)))

def offerrow(T,on=True,*,note=None):
    return (f'<div style="display: flex; align-items: center; gap: 10px;">'
            f'<span style="display: flex; color: {T["acc"] if on else T["ts"]};">{ic(I["shield"],15,1.9)}</span>'
            f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Offer to agents through Metistry</span>'
            f'{toggle(T,on)}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin: 6px 0 0 25px;">'
            + (note or "Agents call it as MCP tools. Every call is checked against their permissions and logged in Activity; "
                       "the agent never reaches the service or its key.") + '</div>')

def conndetail3(T,*,w=None):
    wd=f"width: {w}px;" if w else ""
    head=(f'<div style="display: flex; align-items: center; gap: 11px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ts"]}; transform: rotate(180deg);">{ic(I["chevr"],14,2.2)}</span>'
          f'{tglyph(T,"mcp",17,T["tp"])}<div style="flex-grow: 1;"><div style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Devin</span>{known_chip(T)}</div>'
          f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 2px;">MCP server &middot; API</div></div>'
          f'{btn(T,"Test","secondary",I["check"])}</div>')
    how=sunk(T,
        f'<div style="display: grid; grid-template-columns: 96px minmax(0,1fr); gap: 9px 12px; align-items: center;">'
        f'<span style="font-size: 12px; color: {T["ts"]};">MCP</span>{rfield(T,"https://mcp.devin.ai/mcp")}'
        f'<span style="font-size: 12px; color: {T["ts"]};">API</span>{rfield(T,"https://api.devin.ai/v3")}'
        f'<span style="font-size: 12px; color: {T["ts"]};">Key</span>'
        f'<div>{rfield(T,"Bearer "+ref(T,"secret","devin_key"))}'
        f'<div style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: {T["fail"]}; margin-top: 5px;">'
        f'{ic(I["failed"],12,2.2)}Expired 2 days ago &middot; <span style="font-weight: 600; color: {T["acc"]};">Replace in Secrets</span></div></div>'
        f'<span style="font-size: 12px; color: {T["ts"]};">Organization</span>{rfield(T,ref(T,"variable","devin_org"))}</div>'
        + f'<div style="margin-top: 6px;">{devin_extra(T)}</div>')
    tools=sunk(T,
        toolgroup(T,"READS",[("list_sessions","Your sessions and their status","on"),
                             ("read_wiki","A repo&rsquo;s generated wiki","on")],first=True)
        + toolgroup(T,"CHANGES THINGS",[("send_message","Replies inside a running session","ask")])
        + toolgroup(T,"STARTS AN AGENT",[("create_session","Starts a Devin session &mdash; spends ACUs","ask")]))
    used=sunk(T,
        linkrow(T,"Devin Sessions &middot; sync","Every 5 minutes &middot; results come back as reports")
        + linkrow(T,"Devin Knowledge &middot; sync","Every hour &middot; knowledge and wikis into your inbox")
        + linkrow(T,"collator &middot; agent","read_wiki, list_sessions &middot; create_session, asking first")
        + linkrow(T,"Metis","Sends debugging and research work",last=True))
    return (f'<div style="{wd} background: {T["bg"]};">{head}<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"HOW METISTRY REACHES IT",how) + sunk(T,offerrow(T,True))
            + block(T,"TOOLS — BY WHAT THEY DO",tools) + block(T,"USED BY",used) + '</div></div>')

# ---- a non-MCP connection, offered through the proxy: a feed ------------------------------
def feeddetail(T,*,w=None):
    wd=f"width: {w}px;" if w else ""
    head=(f'<div style="display: flex; align-items: center; gap: 11px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ts"]}; transform: rotate(180deg);">{ic(I["chevr"],14,2.2)}</span>'
          f'{tglyph(T,"feed",17,T["tp"])}<div style="flex-grow: 1;"><div style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Release Notes</div>'
          f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 2px;">Feed &middot; RSS &middot; 3 sources</div></div>'
          f'{btn(T,"Test","secondary",I["check"])}</div>')
    how=sunk(T,
        f'<div style="display: grid; grid-template-columns: 96px minmax(0,1fr); gap: 9px 12px; align-items: center;">'
        f'<span style="font-size: 12px; color: {T["ts"]};">Feeds</span><div style="display: flex; flex-direction: column; gap: 6px;">'
        + rfield(T,"https://www.anthropic.com/news/rss.xml") + rfield(T,"https://github.blog/changelog/feed/")
        + rfield(T,"https://status.devin.ai/history.rss") + '</div>'
        f'<span style="font-size: 12px; color: {T["ts"]};">Key</span><span style="font-size: 12px; color: {T["ts"]};">None needed</span></div>')
    tools=sunk(T,
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-bottom: 6px;">Made by Metistry for this feed</div>'
        + toolgroup(T,"READS",[("list_items","Newest items, optionally since a date","on"),
                               ("get_item","One item in full","on"),
                               ("search_items","Items matching some words","on")],first=True))
    return (f'<div style="{wd} background: {T["bg"]};">{head}<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"HOW METISTRY REACHES IT",how) + sunk(T,offerrow(T,True)) + block(T,"TOOLS",tools) + '</div></div>')

# ---- Add Connection: pick a type -----------------------------------------------------------
def addconn(T,*,w=560):
    rows=[("mcp","MCP server","A server that offers tools","github.com/mcp, a local server"),
          ("agent","Agent","Somewhere Metistry sends work &mdash; A2A, ACP","Devin, a crew on this Mac"),
          ("api","API","An HTTP service with a key","AWS Cost Explorer"),
          ("feed","Feed","RSS, Atom or a calendar feed","a changelog, a team calendar"),
          ("files","Files","A folder, a file or a web page","a Drive folder, a spec on a site")]
    body="".join(
        f'<div style="display: grid; grid-template-columns: 22px 120px minmax(0,1fr); gap: 10px; align-items: center; '
        f'padding: 10px 12px; border-radius: 9px; border: 1px solid {T["acc"] if i==3 else T["border"]}; '
        f'background: {T["surface"]}; {"box-shadow: inset 3px 0 0 "+T["acc"]+";" if i==3 else ""}">'
        f'{tglyph(T,k,17,T["tp"])}<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{n}</span>'
        f'<div><div style="font-size: 12px; color: {T["tp"]};">{a}</div><div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 1px;">{b}</div></div></div>'
        for i,(k,n,a,b) in enumerate(rows))
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'padding: 16px; box-shadow: 0 16px 40px rgba(26,24,21,0.18);">'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-bottom: 12px;">Add a connection</div>'
            f'<div style="display: flex; flex-direction: column; gap: 7px;">{body}</div>'
            f'<div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px;">{btn(T,"Cancel","ghost")}{btn(T,"Continue","affirm")}</div></div>')

# ---- the proxy, drawn ----------------------------------------------------------------------
def proxydiagram(T,*,w=1100):
    def box(title,sub_,glyph,*,accent=False,wd=230):
        return (f'<div style="width: {wd}px; box-sizing: border-box; padding: 12px 14px; border-radius: 11px; background: {T["surface"]}; '
                f'border: 1px solid {T["acc"] if accent else T["bc"]};">'
                f'<div style="display: flex; align-items: center; gap: 8px;"><span style="display: flex; color: {T["acc"] if accent else T["ts"]};">{ic(I[glyph],16,1.9)}</span>'
                f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{title}</span></div>'
                f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 5px; line-height: 1.45;">{sub_}</div></div>')
    arrow=(lambda lab:f'<div style="flex-grow: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 70px;">'
           f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["ts"]};">{lab}</span>'
           f'<div style="width: 100%; height: 1.5px; background: {T["ts"]}; position: relative;">'
           f'<span style="position: absolute; right: -1px; top: -4px; width: 0; height: 0; border-left: 7px solid {T["ts"]}; '
           f'border-top: 4.5px solid transparent; border-bottom: 4.5px solid transparent;"></span></div></div>')
    steps=("1 &nbsp;Is this agent allowed? On &middot; Ask &middot; Off<br>2 &nbsp;Fill in secrets it was granted<br>"
           "3 &nbsp;Call the service<br>4 &nbsp;Log the call in Activity")
    targets=(f'<div style="display: flex; flex-direction: column; gap: 6px;">'
             + "".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; background: {T["surface"]}; '
                       f'border: 1px solid {T["border"]}; width: 190px; box-sizing: border-box;">{tglyph(T,k,14)}'
                       f'<span style="font-size: 12px; color: {T["tp"]};">{TYPES[k][1]}</span></div>' for k in TYPES) + '</div>')
    return (f'<div style="width: {w}px; display: flex; align-items: center;">'
            + box("An agent","collator, drey-dev, a Claude Code session","agents")
            + arrow("MCP")
            + box("Metistry&rsquo;s proxy",steps,"shield",accent=True,wd=290)
            + arrow("its own protocol") + targets + '</div>')

# ---- Settings ▸ Secrets ------------------------------------------------------------------
SECRETS=[("github_read","api.github.com","GitHub &middot; 2 agents","4 min ago",None),
         ("github_write","api.github.com","GitHub &middot; you only","Yesterday",None),
         ("devin_key","*.devin.ai","Devin &middot; 1 agent","2 days ago","fail"),
         ("jira_token","jira.internal","Jira","12 min ago",None),
         ("aws_key","ce.us-east-1.amazonaws.com","AWS","3 days ago",None),
         ("anthropic_key","api.anthropic.com","Compute","1 min ago",None)]
def secrow(T,name,hosts,used,lastu,state,*,sel=False,last=False):
    return (f'<div style="display: grid; grid-template-columns: 14px 128px minmax(0,1fr) 150px 13px; align-items: center; gap: 11px; '
            f'padding: 10px 16px; background: {T["surface"] if sel else "transparent"}; box-shadow: {"inset 3px 0 0 "+T["acc"] if sel else "none"}; {bd_(T,last)}">'
            + (f'<span style="display: flex; color: {T["fail"]};">{ic(I["failed"],12,2.2)}</span>' if state=="fail" else
               f'<span style="display: flex; color: {T["ts"]};">{ic(I["key"],12,2)}</span>')
            + f'{mono(name,T["tp"],12)}'
            f'<span style="font-size: 12px; color: {T["ts"]};">{used}<br><span style="font-family: {MONO}; font-size: 10.5px;">&rarr; {hosts}</span></span>'
            f'<span style="font-size: 12px; color: {T["fail"] if state=="fail" else T["ts"]};">{"Expired 2 days ago" if state=="fail" else "Used "+lastu}</span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.2)}</span></div>')

def secretspane(T,*,sel=None):
    head=panehead(T,"Secrets",btn(T,"Add Secret","secondary",I["plus"]))
    lede=(f'<div style="display: flex; align-items: center; gap: 7px; padding: 0 18px 10px; font-size: 12px; color: {T["ts"]};">'
          f'<span style="display: flex;">{ic(I["lock"],12,2)}</span>In the Keychain, for this instance. A value is never shown again.</div>')
    cols=(f'<div style="display: grid; grid-template-columns: 14px 128px minmax(0,1fr) 150px 13px; gap: 11px; padding: 6px 16px; '
          f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>NAME</span><span>USED BY &middot; SENT ONLY TO</span><span>LAST USED</span><span></span></div>')
    rows="".join(secrow(T,*s,sel=(s[0]==sel),last=(i==len(SECRETS)-1)) for i,s in enumerate(SECRETS))
    own=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 11px 16px; border-top: 1px solid {T["border"]};">'
         f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],12,2.2)}</span>'
         f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Metistry&rsquo;s own</span>'
         f'<span style="font-size: 12px; color: {T["ts"]};">5 &middot; database, bridges, the owner door &middot; rotate only</span></div>')
    return f'<div style="background: {T["bg"]};">{head}{lede}{cols}{rows}{own}</div>'

def secretdetail(T,*,w=None):
    wd=f"width: {w}px;" if w else ""
    head=(f'<div style="display: flex; align-items: center; gap: 11px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ts"]}; transform: rotate(180deg);">{ic(I["chevr"],14,2.2)}</span>'
          f'<span style="display: flex; color: {T["tp"]};">{ic(I["key"],17,1.9)}</span>'
          f'<div style="flex-grow: 1;">{mono("github_read",T["tp"],14)}'
          f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 3px;">Use it anywhere as {ref(T,"secret","github_read")}</div></div>'
          f'{btn(T,"Delete","dest",I["x"])}</div>')
    val=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;">'
        f'<span style="font-family: {MONO}; font-size: 13px; letter-spacing: 2px; color: {T["ts"]}; flex-grow: 1;">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>'
        f'{btn(T,"Replace","secondary",I["pencil"])}</div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">Set 26 days ago &middot; GitHub says it expires in 64 days</div>')
    hosts=sunk(T,
        f'<div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">'
        + "".join(f'<span style="padding: 2px 9px; border-radius: 6px; border: 1px solid {T["bc"]}; background: {T["surface"]}; '
                  f'font-family: {MONO}; font-size: 11.5px; color: {T["tp"]};">{h}</span>' for h in ("api.github.com","uploads.github.com"))
        + f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]}; margin-left: 4px;">Add</span></div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 8px;">Metistry refuses to send it anywhere else.</div>')
    def who(name,kind,how,state):
        from lib import tristate
        return (f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 124px; gap: 12px; align-items: center; padding: 8px 0; '
                f'border-bottom: 1px solid {T["border"]};"><div><div style="display: flex; align-items: center; gap: 7px;">'
                + (agentchip(T,name) if kind=="agent" else f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{name}</span>')
                + f'</div><div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 3px;">{how}</div></div>{tristate(T,state)}</div>')
    users=sunk(T,
        who("GitHub","conn","The connection&rsquo;s key &mdash; its sync and proxied calls","on")
        + who("collator","agent","Filled in by Metistry when it calls GitHub","on")
        + who("drey-dev","agent","Runs on this Mac &mdash; gets it as <span style=\"font-family: "+MONO+"; font-size: 11px;\">GITHUB_READ</span>","on")
        + who("vendor-research","agent","Not granted","off")
        + f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 9px;">A model never sees the value. A local run gets it as an environment variable, and the transcript shows the name, not the value.</div>')
    return (f'<div style="{wd} background: {T["bg"]};">{head}<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"VALUE",val) + block(T,"SENT ONLY TO",hosts) + block(T,"WHO MAY USE IT",users) + '</div></div>')

# ---- Settings ▸ Variables ----------------------------------------------------------------
VARS=[("standup_time","9:15 AM","Standup &middot; Morning Brief"),
      ("work_repos","metistry, metistry-instance, drey, fsl-site","GitHub sync &middot; 2 agents"),
      ("devin_org","org-7f3a92c1","Devin"),
      ("company","Folded Space Labs","3 agents&rsquo; instructions"),
      ("timezone","America/Detroit","Everywhere a time is shown")]
def variablespane(T):
    head=panehead(T,"Variables",btn(T,"Add Variable","secondary",I["plus"]))
    lede=(f'<div style="padding: 0 18px 10px; font-size: 12px; color: {T["ts"]};">Shared values, readable anywhere &mdash; '
          f'including an agent&rsquo;s instructions. Not for keys.</div>')
    cols=(f'<div style="display: grid; grid-template-columns: 124px minmax(0,1fr) 170px; gap: 12px; padding: 6px 16px; '
          f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};"><span>NAME</span><span>VALUE</span><span>USED IN</span></div>')
    rows="".join(f'<div style="display: grid; grid-template-columns: 124px minmax(0,1fr) 170px; gap: 12px; align-items: center; padding: 10px 16px; {bd_(T,i==len(VARS)-1)}">'
                 f'{mono(n,T["tp"],12)}<span style="font-size: 12.5px; color: {T["tp"]};">{v}</span>'
                 f'<span style="font-size: 12px; color: {T["ts"]};">{u}</span></div>' for i,(n,v,u) in enumerate(VARS))
    return f'<div style="background: {T["bg"]};">{head}{lede}{cols}{rows}</div>'

def looksecret(T,*,w=440):
    """A variable whose value looks like a key is caught at save."""
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 12px; padding: 14px;">'
            f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center;">'
            f'<span style="font-size: 12px; color: {T["ts"]};">Name</span>{rfield(T,"sentry_token")}'
            f'<span style="font-size: 12px; color: {T["ts"]};">Value</span>{rfield(T,"sntrys_eyJpYXQiOjE3M&hellip;",focus=True)}</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 11px; font-size: 12px; color: {T["tp"]};">'
            f'<span style="display: flex; color: {T["deg"]};">{ic(I["warn"],14,2)}</span>This looks like a key. Variables can be read by agents.</div>'
            f'<div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">{btn(T,"Save as Variable","ghost")}{btn(T,"Store as Secret","affirm",I["key"])}</div></div>')

def agentinstr(T,*,w=560):
    """A variable inside an agent's instructions; the preview shows what the agent reads."""
    return (f'<div style="width: {w}px; box-sizing: border-box;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; margin-bottom: 7px;">COLLATOR &middot; INSTRUCTIONS</div>'
            f'<div style="border: 1px solid {T["bc"]}; border-radius: 9px; background: {T["surface"]}; padding: 11px 13px; font-size: 12.5px; color: {T["tp"]}; line-height: 1.9;">'
            f'You keep the work at {ref(T,"variable","company")} moving. Watch {ref(T,"variable","work_repos")} and file what you learn. '
            f'Times are in {ref(T,"variable","timezone")}.</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 8px;">'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">Secrets can&rsquo;t go here &mdash; instructions are read by the model.</span>'
            f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Preview as the agent sees it</span></div></div>')

# ---- one request when a secret fails -------------------------------------------------------
def secretfail(T,*,w=460):
    deps=(f'<div style="margin-top: 10px; border-radius: 9px; background: {T["sunken"]}; padding: 8px 11px;">'
          + "".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">{ic(I[g],13,1.9)}'
                    f'<span style="font-size: 12px; color: {T["tp"]};">{a}</span><span style="font-size: 11.5px; color: {T["ts"]};">{b}</span></div>'
                    for g,a,b in (("relay","Devin","connection"),("repeat","Devin Sessions, Devin Knowledge","syncs &middot; stopped"),
                                  ("agents","collator","agent &middot; can&rsquo;t reach Devin")))
          + '</div>')
    ph='<span style="color: '+T["ts"]+';">Paste the new key</span>'
    field_='<div style="margin-top: 10px;">'+rfield(T,ph,focus=True)+'</div>'
    return rcard(T,rhead2(T,I["key"],"ACCESS",who="metis",when="2 days ago")
                 + rask(T,"Devin&rsquo;s key expired","devin_key &middot; used by 4 things")
                 + deps + field_ + ranswers(T,"Replace Key",pglyph="key",revise=None,decline=None,help_=False),w=w)

# ==== configuring a connection: known services vs custom (2026-09-25, C118) =================
I.setdefault("term",'<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M7.5 10l2.5 2-2.5 2M12.5 14.5h4"/>')
I.setdefault("globe",'<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.4 2.4 3.4 5.2 3.4 8.2s-1 5.8-3.4 8.2c-2.4-2.4-3.4-5.2-3.4-8.2s1-5.8 3.4-8.2z"/>')

def known_chip(T):
    return (f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; color: {T["ts"]}; '
            f'border: 1px solid {T["bc"]}; border-radius: 999px; padding: 0 7px; line-height: 17px;">{ic(I["check"],10,2.4)}Known service</span>')

def lbl(T,t): return f'<span style="font-size: 12px; color: {T["ts"]};">{t}</span>'

def kvedit(T,rows,*,cols=("NAME","VALUE"),add="Add",namew=150):
    """Name / value rows. Values take text, {{ secret.x }} and {{ variable.x }}; names are plain.
    A row may carry a check line under it (ok or warn)."""
    head=(f'<div style="display: grid; grid-template-columns: {namew}px minmax(0,1fr) 18px; gap: 8px; padding: 0 0 5px; '
          f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};"><span>{cols[0]}</span><span>{cols[1]}</span><span></span></div>')
    out=""
    for r in rows:
        n,v=r[0],r[1]; note=r[2] if len(r)>2 else None
        out+=(f'<div style="display: grid; grid-template-columns: {namew}px minmax(0,1fr) 18px; gap: 8px; align-items: center; margin-bottom: 6px;">'
              f'{rfield(T,n)}{rfield(T,v)}<span style="display: flex; color: {T["tt"]};">{ic(I["x"],12,2)}</span></div>')
        if note:
            kind,text=note
            col={"ok":T["ok"],"warn":T["deg"],"info":T["ts"]}[kind]
            g={"ok":I["check"],"warn":I["warn"],"info":I["lock"]}[kind]
            out+=(f'<div style="display: flex; align-items: center; gap: 6px; margin: -1px 0 8px {namew+8}px; font-size: 11.5px; color: {T["ts"]};">'
                  f'<span style="display: flex; color: {col};">{ic(g,12,2.1)}</span>{text}</div>')
    return (head+out+f'<div style="font-size: 12px; font-weight: 600; color: {T["acc"]}; display: inline-flex; align-items: center; gap: 5px;">'
            f'{ic(I["plus"],12,2.2)}{add}</div>')

def seg(T,items,sel):
    return (f'<span style="display: inline-flex; padding: 2px; border-radius: 8px; background: {T["sunken"]}; border: 1px solid {T["border"]};">'
            + "".join(f'<span style="padding: 4px 11px; border-radius: 6px; font-size: 12px; font-weight: {600 if i==sel else 500}; '
                      f'color: {T["tp"] if i==sel else T["ts"]}; background: {T["bg"] if i==sel else "transparent"}; '
                      f'box-shadow: {"0 1px 2px rgba(0,0,0,0.12)" if i==sel else "none"};">{i}</span>' for i in items) + '</span>')

def reqpreview(T,lines):
    return (f'<div style="border-radius: 9px; background: {T["sunken"]}; border: 1px solid {T["border"]}; padding: 10px 12px; '
            f'font-family: {MONO}; font-size: 11px; line-height: 1.75; color: {T["tp"]}; overflow: hidden;">{"<br>".join(lines)}</div>')

def masked(T,name):
    return (f'<span style="color: {T["ts"]};">&bull;&bull;&bull;&bull;&bull;&bull;</span>'
            f'<span style="color: {T["ts"]};"> ({name})</span>')

def chead(T,glyph,name,sub_,chip=""):
    return (f'<div style="display: flex; align-items: center; gap: 11px; padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["ts"]}; transform: rotate(180deg);">{ic(I["chevr"],14,2.2)}</span>'
            f'<span style="display: flex; color: {T["tp"]};">{ic(I[glyph],17,1.9)}</span>'
            f'<div style="flex-grow: 1;"><div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">{name}</span>{chip}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 2px;">{sub_}</div></div>'
            f'{btn(T,"Test","secondary",I["check"])}</div>')

def pane(T,head,blocks,*,w=None):
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} background: {T["bg"]};">{head}<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + "".join(blocks) + '</div></div>')

# -- a custom MCP server over HTTP --------------------------------------------------------
def custom_http(T,*,w=None):
    reach=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">{lbl(T,"Reached by")}{seg(T,["HTTP","Command"],"HTTP")}</div>'
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center;">'
        f'{lbl(T,"URL")}{rfield(T,"https://tools.internal/mcp")}</div>')
    query=sunk(T,kvedit(T,[("workspace",ref(T,"variable","team")),("region","us-east")],cols=("PARAMETER","VALUE"),add="Add Parameter"))
    auth=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px;">{seg(T,["None","Bearer","Basic","API Key","OAuth"],"Bearer")}</div>'
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center; margin-top: 10px;">'
        f'{lbl(T,"Token")}{rfield(T,ref(T,"secret","tools_token"))}</div>'
        f'<div style="display: flex; align-items: center; gap: 6px; margin: 6px 0 0 80px; font-size: 11.5px; color: {T["ts"]};">'
        f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],12,2.1)}</span>tools_token may go to tools.internal</div>')
    headers=sunk(T,kvedit(T,[
        ("X-Team",ref(T,"variable","team")),
        ("X-Client","metistry/1.4"),
        ("X-Audit-Key",ref(T,"secret","github_read"),("warn",'github_read may only go to api.github.com &middot; <span style="font-weight: 600; color: '+T["acc"]+';">Allow tools.internal</span>'))],
        cols=("HEADER","VALUE"),add="Add Header"))
    adv=(disclose(T,"Timeout, certificates, network",None,meta="30 s &middot; system trust &middot; direct"))
    prev=reqpreview(T,[f'<b>POST</b> https://tools.internal/mcp?workspace=platform&amp;region=us-east',
                       f'Authorization: Bearer {masked(T,"tools_token")}',
                       'X-Team: platform','X-Client: metistry/1.4',
                       f'X-Audit-Key: <span style="color: {T["deg"]};">blocked &mdash; not allowed to this host</span>'])
    return pane(T,chead(T,"relay","Internal Tools","MCP server &middot; custom"),
                [block(T,"HOW METISTRY REACHES IT",reach),block(T,"QUERY PARAMETERS",query),block(T,"AUTHENTICATION",auth),
                 block(T,"HEADERS",headers),adv,block(T,"WHAT IT SENDS",prev)],w=w)

# -- a custom MCP server run as a command ----------------------------------------------------
def custom_cmd(T,*,w=None):
    reach=sunk(T,
        f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">{lbl(T,"Reached by")}{seg(T,["HTTP","Command"],"Command")}</div>'
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center;">'
        f'{lbl(T,"Command")}{rfield(T,"github-mcp-server")}'
        f'{lbl(T,"Arguments")}{rfield(T,"stdio --read-only")}'
        f'{lbl(T,"Folder")}{rfield(T,ref(T,"variable","dev_root"))}'
        f'{lbl(T,"Runs")}<span>{seg(T,["On this Mac","In a container"],"In a container")}</span></div>')
    env=sunk(T,kvedit(T,[
        ("GITHUB_PERSONAL_ACCESS_TOKEN",ref(T,"secret","github_read"),("info","Given to this command only; never written to disk")),
        ("GITHUB_TOOLSETS","repos,issues,pull_requests")],cols=("VARIABLE","VALUE"),add="Add Variable",namew=210))
    return pane(T,chead(T,"relay","GitHub Tools","MCP server &middot; custom &middot; local command"),
                [block(T,"HOW METISTRY REACHES IT",reach),block(T,"ENVIRONMENT",env)],w=w)

# -- an A2A agent: the agent card is the URL ------------------------------------------------
def custom_a2a(T,*,w=None):
    reach=sunk(T,
        f'<div style="display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px 10px; align-items: center;">'
        f'{lbl(T,"Protocol")}<span>{seg(T,["A2A","ACP"],"A2A")}</span>'
        f'{lbl(T,"Agent card")}{rfield(T,"https://research.fsl.dev/.well-known/agent-card.json")}</div>'
        f'<div style="font-size: 11.5px; color: {T["ts"]}; margin: 8px 0 0 80px;">Found: <b style="color: {T["tp"]};">Research Desk</b> &middot; 3 skills &middot; streaming</div>')
    headers=sunk(T,kvedit(T,[("Authorization","Bearer "+ref(T,"secret","research_key"))],cols=("HEADER","VALUE"),add="Add Header"))
    return pane(T,chead(T,"agents","Research Desk","Agent &middot; A2A &middot; custom"),
                [block(T,"HOW METISTRY REACHES IT",reach),block(T,"HEADERS",headers)],w=w)

# -- the Add flow's second step: known services first, then custom -----------------------------
def addmcp(T,*,w=560):
    known=[("GitHub","api"),("Linear","relay"),("Sentry","relay"),("Jira","relay"),("Notion","relay"),("Google Drive","folder"),
           ("Devin","relay"),("Slack","chat")]
    grid="".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-radius: 9px; border: 1px solid {T["border"]}; '
                 f'background: {T["surface"]};"><span style="display: flex; color: {T["ts"]};">{ic(I[g],15,1.9)}</span>'
                 f'<span style="font-size: 12.5px; font-weight: 500; color: {T["tp"]};">{n}</span></div>' for n,g in known)
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'padding: 16px; box-shadow: 0 16px 40px rgba(26,24,21,0.18);">'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">'
            f'<span style="display: flex; color: {T["ts"]}; transform: rotate(180deg);">{ic(I["chevr"],13,2.2)}</span>'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Add an MCP server</span></div>'
            + rfield(T,'<span style="color: '+T["ts"]+';">Search known services</span>') +
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; margin: 12px 0 7px;">KNOWN &mdash; METISTRY ASKS ONLY FOR WHAT IT NEEDS</div>'
            f'<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">{grid}</div>'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; margin: 14px 0 7px;">CUSTOM</div>'
            f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">'
            + "".join(f'<div style="display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-radius: 9px; border: 1px solid {T["acc"] if i==0 else T["border"]}; '
                      f'background: {T["surface"]}; {"box-shadow: inset 3px 0 0 "+T["acc"]+";" if i==0 else ""}"><span style="display: flex; color: {T["tp"]};">{ic(I[g],16,1.9)}</span>'
                      f'<div><div style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{a}</div><div style="font-size: 11.5px; color: {T["ts"]};">{b}</div></div></div>'
                      for i,(g,a,b) in enumerate((("globe","By URL","Headers, parameters, auth"),("term","By command","Arguments, environment"))))
            + f'</div><div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px;">{btn(T,"Cancel","ghost")}{btn(T,"Continue","affirm")}</div></div>')

# -- what each way of reaching a connection asks for --------------------------------------------
def reachtable(T):
    rows=[("HTTP","MCP &middot; A2A &middot; API &middot; Feed &middot; a web page","URL &middot; query parameters &middot; authentication &middot; headers &middot; timeout, certificates, network"),
          ("Command","MCP &middot; ACP","command &middot; arguments &middot; folder &middot; environment &middot; runs on this Mac or in a container"),
          ("Path","Files","folder or file &middot; include and skip patterns &middot; watch for changes")]
    return ('<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
            + f'<tr style="color: {T["tt"]}; text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em;">'
              f'<th style="padding: 0 14px 8px 0;">REACHED BY</th><th style="padding: 0 14px 8px 0;">USED FOR</th><th style="padding: 0 0 8px;">ASKS FOR</th></tr>'
            + "".join(f'<tr style="border-top: 1px solid {T["border"]};"><td style="padding: 9px 14px 9px 0; font-weight: 600; color: {T["tp"]};">{a}</td>'
                      f'<td style="padding: 9px 14px 9px 0; color: {T["ts"]};">{b}</td><td style="padding: 9px 0; color: {T["tp"]};">{c}</td></tr>' for a,b,c in rows)
            + '</table>')

def devin_extra(T):
    """A known service keeps its named fields and still takes extra headers and parameters."""
    return disclose(T,"Extra headers and parameters",None,meta="none")
