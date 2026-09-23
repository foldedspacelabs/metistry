"""Board: Resources — the connections Metistry holds, and lends.

Screen 9, new 2026-09-22. Metistry holds credentials for servers a remote agent
cannot reach and mediates access to them. This screen is where a connection is
DEFINED; granting one to an agent or a routine happens in their permissions
table, like everything else.
"""
from lib import *

CW,CH=2440,2160

def win(T,inner):
    """Settings ▸ Resources (ruled 2026-09-22). Its own WINDOW, not a pane in the
    main one — the first draft styled the section list like the sidebar and it read
    as a nav row that had supposedly been removed."""
    return settingswindow(T,inner,full=True)

def conndetail(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; '
          f'border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],15,2.2)}</span>'
          f'<div style="flex-grow: 1; min-width: 0;">'
          f'<div style="display: flex; align-items: center; gap: 9px;">'
          f'<span style="display: flex; color: {T["ag"]};">{ic(I["plug"],15,1.8)}</span>'
          f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Jira</span></div>'
          f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 3px;">MCP &middot; your work network &middot; '
          f'reachable only from this machine</div></div>'
          f'{btn(T,"Disconnect","dest",I["x"])}</div>')
    conn=sunk(T,
        kv(T,"Endpoint","https://jira.internal/mcp",mono_=True)
        + kv(T,"Credential","Held by Metistry &mdash; never handed to an agent")
        + kv(T,"Reachable From","This machine only &mdash; no agent can reach it directly")
        + kv(T,"Last Checked","4 minutes ago &middot; 14 tools discovered",last=True))
    tools=toolblock(T)
    lent=sunk(T,
        linkrow(T,"collator","Read issues in 3 projects &middot; comment, asking first")
        + linkrow(T,"drey-dev","Read issues in 1 project")
        + linkrow(T,"Morning Digest","Read issues in 3 projects &mdash; during the run only",last=True))
    return (f'<div style="{wd} background: {T["bg"]};">{head}'
            f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + block(T,"THE CONNECTION",conn)
            + block(T,"TOOLS — ON, ASK OR OFF",tools)
            + block(T,"LENT TO",lent)
            + '</div></div>')

WHY=pan(L,"WHY THIS IS A SCREEN AND NOT A SETTING",
  nt(L,"Metistry can reach servers a remote agent cannot — a work network, something behind a VPN, something "
       "IP-allowlisted. So it holds the credential and <b>mediates</b>: an agent asks Metistry, Metistry asks the "
       "server. The agent never sees the token.")
  + nt(L,"That makes a connection a <b>resource</b> in exactly the sense Knowledge already is: one thing, defined "
        "once, lent to several agents, routines and projects on different terms. Defining it belongs in one place; "
        "granting it belongs in the permissions table of whatever is being granted. Those are two different "
        "questions and the last two rounds have shown what happens when one screen tries to answer both.",12)
  + nt(L,"<b>The credential never moves.</b> That is the sentence the whole screen exists to make true, and it is "
        "the reason a proxied row in a permissions table is not the same as a grant: revoking here cuts every "
        "agent off at once, and revoking there cuts one.",12))

CONTRACT=pan(L,"THE BRIDGE CONTRACT ALREADY WROTE THE RULES",
  nt(L,"<b>CLAUDE.md</b> requires every bridge to do <b>lazy tool discovery</b>, "
       "<b>preview-then-confirm on destructive tools</b>, and <b>secret redaction by default</b>. A proxied MCP "
       "server conforming to that contract inherits the behaviour this screen would otherwise have to invent — "
       "which is the argument for treating a proxied server as a bridge rather than as a new species.")
  + nt(L,"So the tool list is not decoration. <b>Lazy discovery</b> means the list is what the server said it has, "
        "the last time it was asked — a fact with a timestamp, not a configuration. And "
        "<b>preview-then-confirm is what <i>Ask</i> means</b>: it is not a second marker beside the control, it is "
        "the middle state of it.",12)
  + nt(L,"<b>The owner&rsquo;s choice is the whole control</b> (ruled 2026-09-22). An earlier draft marked "
        "destructive tools <i>Previews first</i> alongside the setting, which said two things at once and quietly "
        "overrode a deliberate <b>On</b>. If you choose On, it is on. What a tool does is carried by its "
        "description, which is where that belongs — the table informs the choice rather than second-guessing it.",12)
  + nt(L,"<b>Per tool, not per server.</b> Nobody who clicks <i>grant Jira</i> means <i>including delete_issue</i>. "
        "A server-level switch is the shape that produces that mistake, so there isn't one.",12))

APPROVE=pan(L,"WHAT &ldquo;ASK&rdquo; ACTUALLY LOOKS LIKE — AND THE PROBLEM IN IT",
  nt(L,"<b>The channel already exists.</b> An <i>Ask</i> tool call is a request in <b>Needs You</b>, answered with "
       "the four answers every request takes, and delivered by web push when you are away — "
       "<b>NOTIFICATION_TITLE</b> already maps <b>alert</b> to &ldquo;Needs You&rdquo; and <b>web-push</b> is "
       "already a dependency. No dialogue: a dialogue assumes someone is sitting there, which is exactly the case "
       "that does not hold.")
  + f'<div style="background: {L["degq"]}; border-radius: 10px; padding: 13px 15px; margin-top: 14px;">'
    f'<div style="display: flex; align-items: center; gap: 8px;">'
    f'<span style="display: flex; color: {L["deg"]};">{ic(I["warn"],14,2)}</span>'
    f'<span style="font-size: 12.5px; font-weight: 600; color: {L["tp"]};">A synchronous approval inside an '
    f'unattended run is a contradiction</span></div>'
    f'<div style="font-size: 12px; color: {L["tp"]}; line-height: 1.55; margin-top: 6px;">Morning Digest runs at '
    f'6:02 AM and wants to comment on PROJ-412. You are asleep. Blocking means the routine is half-done for three '
    f'hours; failing means it produced nothing because of a step that was never urgent.</div></div>'
  + nt(L,"<b>The answer that matches everything else in the product: the run finishes without it, and says so.</b> "
        "The output carries the line <i>I would have commented on PROJ-412 — that needs your approval</i>, and the "
        "request lands in Needs You. Nothing blocks, nothing is half-applied, and the fact is reported rather than "
        "silently dropped. It is the same discipline as <b>later</b> not blocking, and as a failed action leaving "
        "its row pending.",14)
  + nt(L,"<b>A default, not a guardrail.</b> An earlier draft said a destructive tool should not be grantable as "
        "<b>On</b> to an unattended routine at all. That was the design overriding a deliberate choice, which is "
        "the wrong instinct here: a tool that writes where other people can see it <b>defaults</b> to Ask, and the "
        "owner may set it to On. A default is enforcement enough — the same reason <b>dispatch</b> defaults to Ask "
        "in the wire rather than being forbidden.",12)
  + nt(L,"So the three states mean slightly different things by context, and that is worth stating rather than "
        "papering over: on an agent you are talking to, <b>Ask</b> pauses. On a routine at 6 AM, <b>Ask</b> "
        "defers.",12))

FOUND=pan(L,"WHAT THIS NEEDS, AND THE ONE THING IT CHANGES ELSEWHERE",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 30px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("D9","a registry of proxied servers — endpoint, credential reference, discovered tools with a discovery "
          "timestamp, and which principals hold which tools. None of it exists."),
    ("D11","a per-tool grant, held beside the agent&rsquo;s other permissions rather than in a second place, so the "
           "matrix can render it as one more row."),
    ("D12","a proxy audit line. Every call an agent makes through Metistry is Metistry acting with the "
           "owner&rsquo;s credential, which is exactly the thing <b>runs</b> exists to record."),
    ("C50","<b>the nav is nine rows.</b> Today &middot; Chat &middot; Activity &middot; Work &#9656; &middot; "
           "Knowledge &#9656; &middot; Routines &middot; Resources &middot; Agents. Worth saying plainly: the "
           "seven-row rule has now been broken twice, and the argument each time was the same one C30 used. If "
           "there is a tenth, the rule is not a rule and the sidebar needs a different idea.")])))

body=(heading("ROUND E · SCREEN 9, NEW","Resources — the connections Metistry holds, and lends",
   "Metistry can reach servers your agents cannot, so it holds the credential and mediates. A connection is "
   "defined here, once; it is granted to an agent or a routine in their own permissions table. <b>The credential "
   "never moves.</b>",L)
  + row(win(L,resourcelist(L)),18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div style="width: 700px; flex-shrink: 0;">{sub("ONE CONNECTION",L["tt"])}'
        + f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{conndetail(L)}</div></div>'
        + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px;">'
        + WHY + CONTRACT + '</div></div>',18)
  + row(APPROVE+FOUND,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden;">{resourcelist(D)}</div></div>',18))
(PROJ/"Resources.dc.html").write_text(page("Resources",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Resources.dc.html ({CW}x{CH})")
