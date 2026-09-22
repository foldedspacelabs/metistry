"""Board: Agents — what Metis delegates to, and what connects in.

Rewritten 2026-09-21. The first attempt organised itself around `agents.grants`
and `agents.autonomy` and produced a permissions matrix with a disclosure
triangle; the owner rejected it. Metis is off the roster entirely: it is
unscoped because it IS the user (C52).
"""
from lib import *

CW,CH=2440,3720

def win(T,inner,*,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; '
            f'background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Agents")}{inner}</div></div>')

WHAT=pan(L,"WHAT IS ON THIS SCREEN, AND WHY PERMISSIONS LIVE HERE",
  f'<div style="background: {L["accq"]}; border-radius: 10px; padding: 14px 16px;">'
  f'<div style="font-size: 13.5px; color: {L["tp"]}; line-height: 1.6;">Metis is <b>unscoped because it is '
  f'you</b> — it holds your reach and delegates narrower work. So <b>Agents is what Metis delegates to, and what '
  f'connects in. Everything on it is scoped, because none of it is you.</b></div></div>'
  + nt(L,"That sentence is why permissions belong here and nowhere else, and it is why <b>Metis is not a row</b>. "
        "Drawing Metis with a grant would imply its reach could be less, which is the opposite of what it is "
        "(C52).",14)
  + '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 14px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;"></th><th style="padding: 0 12px 8px 0;">YOURS</th>'
    f'<th style="padding: 0 0 8px 0;">CONNECTED</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 8px 12px 8px 0; color: {L["tt"]}; white-space: nowrap;">{a}</td>'
    f'<td style="padding: 8px 12px 8px 0; color: {L["tp"]};">{b}</td>'
    f'<td style="padding: 8px 0; color: {L["ts"]};">{c}</td></tr>'
    for a,b,c in [
      ("comes from","a markdown file you wrote","a token it authenticated with"),
      ("definition","yours to read and write","<b>none</b> — it is someone else&rsquo;s code"),
      ("what it does","what you wrote, plus what a routine assigns","whatever it asks to do"),
      ("reach","base, plus what a routine grants for a task","base, granted by you"),
      ("runs when","you ask &middot; Metis delegates &middot; a schedule","it connects")])
  + '</table>')

ROWP=pan(L,"THREE THINGS PER ROW — AND WHAT CAME OFF IT",
  f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 11px; overflow: hidden;">'
  + groupbar(L,"YOURS","3")
  + arow(L,name="collator",what="daily at 6:02 AM · Morning Digest",seen="6m",state="working",link="Morning Digest")
  + arow(L,name="vendor-research",what="when Metis delegates",seen="3h")
  + arow(L,name="inbox-triage",what="paused",seen="—",last=True) + '</div>'
  + nt(L,"<b>Who it is, what it is, whether it&rsquo;s working.</b> The first attempt had seven columns.",14)
  + nt(L,"<b>Scope came off the row.</b> <b>folders · 4</b> tells you nothing without knowing <i>which</i> folders "
        "— it was detail-view information pretending to be a summary. <b>Spend came off</b> for the reason already "
        "logged as C3: a number with nothing on the row to compare it to. Both moved into detail, beside the "
        "context that makes them mean something.",12)
  + nt(L,"The <b>what it is</b> column carries the whole taxonomy in four words instead of a section header: "
        "yours-and-scheduled names its routine, yours-and-delegated says so, connected names its project. A "
        "paused agent says <b>paused</b> and nothing else, because a paused agent has no schedule to report.",12))

PRES=pan(L,"PRESENCE — FIVE COMPUTED STATES, TWO COLOURS",
  "".join(f'<div style="display: flex; align-items: center; gap: 12px; padding: 8px 0;'
          + ("" if i==4 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="width: 78px; flex-shrink: 0;">{mono(s,L["tp"],12)}</span>'
          f'<span style="width: 22px; flex-shrink: 0; display: flex;">{presdot(L,s)}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.5;">{w}</span></div>'
    for i,(s,w) in enumerate([
      ("working","filled. The normal case, and the row already names the claim"),
      ("queued","filled, hollow centre. Waiting is not a fault"),
      ("idle","hollow — <b>and no word at all.</b> The resting state does not announce itself"),
      ("interrupted","<b>degraded.</b> An expired lease still holds the claim"),
      ("over-cap","<b>degraded.</b> A bundle of its own is blocked for exceeding a cap")]))
  + nt(L,"Tint carries <b>something is wrong</b> and three of these five are not wrong. Five colours on a roster "
        "is a roster where colour has stopped meaning anything — P2 applied to a list. Neither is <b>failed</b>: a "
        "lease that lapsed while an agent was thinking did not break (C36).",14))

PROV=pan(L,"ACCESS ALWAYS SHOWS ITS PROVENANCE — THREE ROUTES, ONE VOCABULARY",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;">HOW IT GOT THERE</th><th style="padding: 0 0 8px 0;">MARKED AS</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; white-space: nowrap;">{a}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{b}</td></tr>'
    for a,b in [
      ("base configuration","<b>nothing.</b> It is the default, and a marker on everything is a marker on nothing"),
      ("approved in Needs You","<i>approved in Needs You · #311</i>, linking the request you answered"),
      ("granted by a routine","<i>during &lt;routine&gt; only</i>, linking the routine")])
  + '</table>'
  + nt(L,"<b>A routine-granted permission is the most forgettable access in the system.</b> You granted it inside "
        "a routine&rsquo;s setup in March; the agent&rsquo;s page says it reads <b>Areas/Ops</b>; six months later "
        "it reads Finance every morning and nothing ever told you. The marker is not consistency — it is the only "
        "thing standing between the owner and that.",14))

DEFP=pan(L,"THE DEFINITION IS A FILE, AND ONLY YOUR HAND MAY WRITE IT",
  defeditor(L)
  + nt(L,"It lives at <b>agents/&lt;area&gt;/&lt;id&gt;.md</b> — in the vault, so git versions it and every change "
        "has an author. The console edits it <b>as the user</b>, which invariant 2 permits explicitly: <i>anything "
        "defining how the system behaves is a human change</i>. The same invariant is why Metis may never write "
        "it, and the screen says that once, plainly, beside the editor. An assistant that can rewrite its own "
        "delegates&rsquo; instructions is the loop invariant 2 closes.",14)
  + nt(L,"So it is a <b>markdown editor</b>, not a form field. An agent&rsquo;s behaviour is prose with structure, "
        "and a textarea that hides its own headings would teach the user this is configuration rather than "
        "writing. It shows the path, and it says <i>versioned in the vault</i> rather than <i>saved</i>.",12))

PERMP=pan(L,"ONE LINE PER RESOURCE, AND ABSENCE IS THE DENIAL",
  permmatrix(L)
  + nt(L,"The previous pass gave every verb its own row and a control in each one, so <b>Knowledge</b> appeared "
        "twice and the table was mostly furniture. One line per resource, <b>Read</b> and <b>Write</b> as columns, "
        "and the cell says what the verb covers.",14)
  + nt(L,"<b>The Allow / Ask First / Never control is gone.</b> Anything not listed is not granted, which is the "
        "same information in none of the space — and it is the honest shape, because the list of things an agent "
        "<i>cannot</i> do is infinite. A verb that waits for you carries one glyph; nothing else needs a state at "
        "all. Changing any of it is one <b>Edit</b> on the section, not a control per cell.",12)
  + nt(L,"<b>Local agents get the same table.</b> The last pass gave them knowledge only, on the argument that a "
        "routine grants the rest — but an agent Metis delegates to needs Work and Artifacts like any other, and "
        "two different permission surfaces for two kinds of agent was the same mistake as two different detail "
        "layouts. One table, everywhere permissions appear.",12)
  + nt(L,"A marked line is access that arrived some other way &mdash; approved in a queue, or granted by a routine "
        "and held only while it runs. That is the provenance rule, now carried inside the cell rather than in a "
        "section of its own.",12))

MCPP=pan(L,"AND THE ROWS THAT ARE NOT METISTRY AT ALL",
  nt(L,"An <b>external MCP server</b> Metistry holds a credential for is another <b>Model</b> on the same table, "
       "marked <i>Through Metistry</i>. The agent never holds that credential — Metistry does, and mediates — so "
       "this grid is the only thing standing between an agent and a work system.")
  + nt(L,"It also raises the stakes on one distinction the table now has to carry: reading <b>Areas/Finance</b> is "
        "reading your own vault, while commenting on a Jira issue is <b>acting as you in a system other people "
        "watch</b>. That is why Comment is <b>Ask First</b> there and Read is <b>Allow</b> — and it is the reason "
        "a per-server grant cannot be one switch.",12)
  + nt(L,"The servers themselves are defined on <b>Resources</b>, a new top-level row — one place holds the "
        "credential, and it is not this screen. Granting one to an agent or a routine happens here, in the table "
        "above, like everything else.",12))

body=(heading("ROUND E · SCREEN 7, REWRITTEN","Agents — what Metis delegates to, and what connects in",
   "Three renders: the roster, a local agent, a connected agent. The first attempt organised itself around "
   "<b>agents.grants</b> and <b>agents.autonomy</b> — the data&rsquo;s shape — and produced a permissions matrix "
   "with a disclosure triangle on it. This starts from the question the owner arrives with instead.",L)
  + row(win(L,roster2(L)),18)
  + row(WHAT+ROWP,18)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{sub("A LOCAL AGENT",L["tt"])}'
        + f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{localdetail(L)}</div></div>'
        + f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{sub("A CONNECTED AGENT",L["tt"])}'
        + f'<div style="border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{conndetail(L)}</div></div>'
        + '</div>',18)
  + row(DEFP+PROV,18)
  + row(PRES+PERMP,18)
  + row(MCPP,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + f'<div style="flex-grow: 1; flex-basis: 0; border: 1px solid {D["bc"]}; border-radius: 12px; '
          f'overflow: hidden;">{roster2(D)}</div>'
        + f'<div style="flex-grow: 1; flex-basis: 0; border: 1px solid {D["bc"]}; border-radius: 12px; '
          f'overflow: hidden;">{localdetail(D)}</div>'
        + '</div></div>',18))
(PROJ/"Agents.dc.html").write_text(page("Agents",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Agents.dc.html ({CW}x{CH})")
