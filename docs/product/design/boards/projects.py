"""Board: Work ▸ Projects.

Screen 13, new 2026-09-22. Projects appear on first use (migration 0011), so
there is no New Project. The state that matters most is review mode, and why.
Owner's ruling (D13): a project holds permissions, and every member agent
inherits them by default.
"""
from lib import *

CW,CH=2600,3320

LIST=pan(L,"THE LIST — WHICH PROJECTS ARE ON THEIR OWN, AND WHICH ARE WAITING ON YOU",
  row(workwin(L,projlist(L)),18)
  + nt(L,"<b>Mode is the first thing read after the name.</b> Autonomous is a quiet outline. Review you chose is a "
        "heavier outline &mdash; the weight channel, because it matters more, not because anything is wrong. "
        "Review forced by the budget takes the <b>warning tint</b>, because that one is a fault (C83).",14)
  + nt(L,"No New Project: a project exists the first time a task, agent or artifact names it.",12))

DETAIL=pan(L,"A PROJECT — WHAT&rsquo;S IN FLIGHT, WHO&rsquo;S ON IT, WHAT THEY CAN REACH",
  row(workwin(L,projdetail(L)),18)
  + nt(L,"<b>Permissions belong to the project, and every agent in it gets them</b> (ruled 2026-09-22, D13). "
        "Each member shows only what it has <i>beyond</i> the project &mdash; <b>+ Areas/Finance</b> &mdash; or "
        "<i>project access only</i>. The same table as Agents, so there is one way to read access everywhere.",14)
  + nt(L,"On an agent&rsquo;s own page, access that comes from a project carries the project&rsquo;s name as its "
        "provenance, so you can always tell inherited from granted.",12))

TRIPPED=pan(L,"OVER BUDGET — THE PROJECT PUT ITSELF IN REVIEW",
  row(workwin(L,projdetail(L,why="budget")),18)
  + nt(L,"The header says when, why, and what changed for you, in one sentence, with <b>Raise Budget</b> beside it. "
        "The footnote keeps the record: <i>review since 2:40 PM (over budget)</i>.",14))

CONFIRM=pan(L,"THE CONFIRMATIONS — BOTH DIRECTIONS, AND ADDING AN AGENT",
  row(f'<div>{sub("BACK TO AUTONOMOUS",L["tt"])}{modeconfirm(L,to="autonomous")}</div>'
    + f'<div>{sub("INTO REVIEW",L["tt"])}{modeconfirm(L,to="review")}</div>'
    + f'<div>{sub("ADDING AN AGENT",L["tt"])}{addagent(L)}</div>',18,align="flex-start")
  + nt(L,"Each says the consequence in one sentence. Adding an agent names exactly what it inherits, because "
        "joining a project <i>is</i> a grant &mdash; the one thing inheritance could otherwise hide.",14))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 18px;">{i+1}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,v in enumerate([
    "<b>Project grants</b> (D13): grants held by a project and inherited by every member, with the project as the "
    "grant&rsquo;s provenance wherever it is shown.",
    "<b>Why a project is in review</b> &mdash; owner or budget, and when. §3.12 already draws the footnote; the "
    "rollup needs to return the reason.",
    "<b>Rename the area rollup</b> (C82): <b>projects_overview</b> groups by Knowledge area, so the dashboard panel "
    "and the morning brief&rsquo;s section become <i>Areas</i>.",
    "<b>projects_rollup</b> already returns everything else on the list."])))

body=(heading("ROUND E · SCREEN 13, NEW","Work ▸ Projects — mode first, then work, then access",
   "Projects appear on first use. The list answers which ones are running on their own and which are waiting on "
   "you; a project answers what is in flight, who is on it, and what they can reach &mdash; which, since today, "
   "the project itself grants.",L)
  + row(LIST,18)
  + row(DETAIL,18)
  + row(TRIPPED,18)
  + row(CONFIRM+ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + workwin(D,projdetail(D)) + '</div>',18))
(PROJ/"Projects.dc.html").write_text(page("Projects",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Projects.dc.html ({CW}x{CH})")
