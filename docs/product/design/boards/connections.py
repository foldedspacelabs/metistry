"""Board: Settings ▸ Connections — anything outside Metistry, typed (2026-09-25).

C114, C115, C118. Replaces Resources (screen 9): a resource is a connection offered to
agents through Metistry's MCP proxy. Targets become Agent connections. Any type
can be offered — non-MCP types get tools Metistry generates.
"""
from lib import *
from lib_connect import *

CW,CH=2720,4160
def sw(T,sel,inner): return settingswindow(T,inner,sel=sel,full=True)

TYPEPAN=pan(L,"ONE NOUN, FIVE TYPES",
  f'<div style="display: flex; gap: 24px; align-items: flex-start;">{addconn(L,w=520)}'
  + '<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>A connection is anything outside Metistry</b> &mdash; a server, a service, an agent, a feed, a folder. "
         "<i>Resource</i>, <i>target</i> and <i>source</i> are retired as words (C114).")
  + nt(L,"<b>What a connection can do is set per tool, not by its type.</b> Devin&rsquo;s MCP server reads, changes "
         "things and starts sessions, so its tools are grouped <b>Reads &middot; Changes things &middot; Starts an agent</b>, "
         "each On &middot; Ask &middot; Off.",12)
  + nt(L,"<b>Any field can hold a reference.</b> Type <span style=\"font-family: "+MONO+";\">{{</span> to pick a secret or a variable.",12)
  + f'<div style="display: flex; gap: 14px; align-items: flex-start; margin-top: 14px;">'
  + f'<div style="width: 300px;">{rfield(L,"Bearer "+ref(L,"secret","de"),focus=True)}<div style="margin-top: 6px;">{refpicker(L)}</div></div>'
  + '</div></div></div>')


CUSTOM=pan(L,"KNOWN SERVICES ASK FOR NAMES; CUSTOM ONES ASK FOR THE REQUEST",
  nt(L,"<b>A known service</b> shows only the fields Metistry understands &mdash; Key, Organization, Repos &mdash; and "
       "still takes <b>extra headers and parameters</b>. <b>Anything else</b> is configured by how Metistry reaches it. "
       "Any value can hold a secret or a variable; names are plain text (C118).")
  + f'<div style="margin-top: 14px;">{reachtable(L)}</div>'
  + f'<div style="margin-top: 18px;">{addmcp(L,w=560)}</div>'
  + nt(L,"<b>A secret only goes where it is allowed.</b> A header or parameter that would send one to another host is "
         "flagged on the row and blocked in <b>What it sends</b> until you allow that host. Secrets belong in headers; "
         "one typed into a URL is flagged, because URLs end up in logs.",16))

PROXY=pan(L,"EVERY CONNECTION CAN BE OFFERED TO AGENTS — THROUGH METISTRY",
  proxydiagram(L,w=1180)
  + nt(L,"<b>The proxy speaks MCP to agents and each connection&rsquo;s own protocol behind it.</b> An API, a feed or a "
         "folder gets tools Metistry makes for it, so an agent uses all of them the same way &mdash; checked, "
         "with keys filled in, and logged. The agent never reaches the service or holds its key (C115).",16)
  + nt(L,"<b>Offer to agents</b> is one switch on the connection. Off, only Metistry uses it &mdash; Metis and its "
         "syncs. On, each agent still needs it granted in its own permissions.",12))

body=(heading("ROUND F · SCREEN 9, v2","Connections — anything outside Metistry, typed",
   "One list for every server, service, agent, feed and folder Metistry reaches, what each one may do, and whether "
   "agents can use it through Metistry.",L)
  + row(f'<div>{sub("SETTINGS ▸ CONNECTIONS",L["tt"])}{sw(L,"Connections",connlist(L,sel="Devin"))}</div>'
        + f'<div>{sub("ONE CONNECTION — MCP AND AN API",L["tt"])}{sw(L,"Connections",conndetail3(L))}</div>'
        + f'<div>{sub("A FEED, OFFERED TO AGENTS",L["tt"])}{sw(L,"Connections",feeddetail(L))}</div>',32,align="flex-start")
  + row(f'<div>{sub("CUSTOM MCP SERVER &mdash; BY URL",L["tt"])}{sw(L,"Connections",custom_http(L))}</div>'
        + f'<div style="display: flex; flex-direction: column; gap: 24px;">'
        + f'<div>{sub("CUSTOM MCP SERVER &mdash; BY COMMAND",L["tt"])}{sw(L,"Connections",custom_cmd(L))}</div>'
        + f'<div>{sub("AN A2A AGENT",L["tt"])}{sw(L,"Connections",custom_a2a(L))}</div></div>'
        + f'<div style="flex-grow: 1; min-width: 0;">{CUSTOM}</div>',32,align="flex-start")
  + row(TYPEPAN,18)
  + row(PROXY,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px; align-items: flex-start;">'
        + sw(D,"Connections",connlist(D,sel="Devin")) + sw(D,"Connections",custom_http(D)) + addmcp(D,w=560)
        + '</div></div>',18))
(PROJ/"Connections.dc.html").write_text(page("Connections",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Connections.dc.html ({CW}x{CH})")
