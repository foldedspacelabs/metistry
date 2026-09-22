"""Board: Knowledge — the vault, read, and whether it is current.

Screen 10, new 2026-09-22. Drawn while the owner slept; §8 of the spec names every
judgement call made without him.
"""
from lib import *

CW,CH=2440,3060

def win(T,inner):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Knowledge")}{inner}</div></div>')

THREE=pan(L,"THREE QUESTIONS, AND THE WIRE ANSWERS TWO OF THEM",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;">THE QUESTION</th><th style="padding: 0 12px 8px 0;">SERVED BY</th>'
    f'<th style="padding: 0 0 8px 0;"></th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600;">{a}</td>'
    f'<td style="padding: 9px 12px 9px 0;">{b}</td>'
    f'<td style="padding: 9px 0; color: {c2};">{c}</td></tr>'
    for a,b,c,c2 in [
      ("What is in here?",mono("knowledge_pages",L["ts"],11.5),"completely",L["ok"]),
      ("<b>Is it current?</b>",f'<span style="color: {L["deg"]}; font-weight: 600;">nothing</span>',
       "four rounds of <b>stale</b>, drawn nowhere (C48)",L["deg"]),
      ("What links to what?",mono("knowledge_page_links",L["ts"],11.5),"completely",L["ok"])])
  + '</table>'
  + nt(L,"So the screen is ordered by the question, and <b>the unanswerable one leads</b> rather than hiding in a "
        "header — because <i>is this current</i> is what makes everything below it trustworthy. A page list you "
        "cannot date is a list you have to take on faith.",14))

STALE=pan(L,"WHERE STALE FINALLY LANDS, AND WHY FAILED CARRIES TWO TIMES",
  sources(L)
  + nt(L,"Round C specified <b>stale</b> — <i>it was answering and has not lately</i> — and parked it on Knowledge "
        "and Agents. Agents could not answer it (<b>agent_presence</b> has no collector notion) and Activity "
        "deliberately would not (<b>activity_feed</b> takes <b>collector_run</b> only where <b>ok = false</b>, so a "
        "<i>healthy</i> collector is invisible). This surface owns the question and still cannot answer it — "
        "request C1, now four rounds old.",14)
  + nt(L,"<b>The age rides the name and never replaces the value.</b> That is the whole of what stale means, and it "
        "is the one of the four states that annotates rather than replacing content.",12)
  + nt(L,"<b>Failed carries two timestamps, and that is the point.</b> <i>Failed 2 hours ago</i> invites the reader "
        "to assume the data is two hours old. <i>Last succeeded 2 days ago &middot; token expired</i> says what is "
        "true: the data is two days old, and the reason it stopped is known. One timestamp would be a quieter lie.",12))

PARTIAL=pan(L,"CONFLICT IS THE FIRST REAL INSTANCE OF PARTIAL (C28)",
  f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 11px; overflow: hidden;">'
  + f'<div style="display: grid; grid-template-columns: 268px minmax(0,1fr) 116px; gap: 14px; padding: 7px 16px; '
    f'font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {L["tt"]}; background: {L["sunken"]};">'
    f'<span>PATH</span><span>TITLE</span><span style="text-align: right;">MODIFIED</span></div>'
  + pagerow(L,path="Areas/Health/sleep.md",title="Sleep",when="2 hours ago")
  + pagerow(L,path="Areas/Health/2026/sleep.md",title="",when="",status="conflict",last=True) + '</div>'
  + nt(L,"<b>knowledge_files.status</b> is <b>clean | dirty | conflict</b>, and the query&rsquo;s own comment is the "
        "design constraint: a conflict row is a file the reconciler could not settle, <b>so its title and mtime are "
        "not facts yet</b>.",14)
  + nt(L,"That is a row whose <b>path is known and whose metadata is not</b> — which is exactly the fifth state "
        "<b>C28 proposed and could not find a use for</b>. It is not <b>failed</b> (nothing broke), not "
        "<b>absent</b> (the file is right there), and not <b>stale</b> (this is not about age).",12)
  + nt(L,"So where the title would be, the row says <b>why there isn&rsquo;t one</b> — not a blank, and not the "
        "filename dressed up as a title, which is the tempting fallback and a small lie. <b>Recommendation:</b> "
        "ratify <b>partial</b> on the strength of this. Four rounds of a state with no instance is a state that was "
        "guessed at; one shipped instance is an argument.",12))

DRAFT=pan(L,"A DRAFT IS INVISIBLE TO YOU TOO, AND THAT IS DELIBERATE",
  nt(L,"<b>status: draft</b> in frontmatter hides a page at <b>every tier — including the owner&rsquo;s own "
       "list</b>, because the same WHERE clause <b>mcp-brain</b> applies is applied here, &ldquo;so the "
       "owner&rsquo;s list and an agent&rsquo;s index cannot disagree about what a draft is.&rdquo;")
  + nt(L,"That is unusual enough to say on the screen rather than leave as a surprise. The <b>count</b> is shown "
        "and the pages are not: <i>3 drafts, hidden here as they are hidden from agents.</i> Hiding them silently "
        "would make the list look wrong; explaining it once makes the consistency legible — and the count is not "
        "itself a draft, so withholding it buys nothing (request D14).",12)
  + nt(L,"Drawn as a sentence rather than a filter chip, because a chip implies it can be turned on and it cannot.",12))

LINKS=pan(L,"LINKS — TWO LISTS, NOT A GRAPH",
  f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
  f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["tt"]}; '
  f'margin-bottom: 6px;">OUTGOING</div>'
  + linkrow2(L,"out","Areas/Health/protein.md","The protein blend","wikilink")
  + linkrow2(L,"out","Me/profile.md","&mdash;","frontmatter",last=True)
  + f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["tt"]}; '
    f'margin: 13px 0 6px;">INCOMING</div>'
  + linkrow2(L,"in","Journal/2026-09-18.md","Wednesday","wikilink")
  + linkrow2(L,"in","Areas/Health/labs.md","Lab results","embed",last=True) + '</div>'
  + nt(L,"A graph answers <i>what does the whole vault look like</i>, which is a question the owner does not have. "
        "Two lists answer <i>what points at this</i>, which is the one they do.",14)
  + nt(L,"<b>kind</b> is shown because a frontmatter link and a wikilink mean different things about intent: one "
        "was structured on purpose, the other was written mid-sentence. An <b>embed</b> is a third thing again — "
        "the other page&rsquo;s content is <i>in</i> this one.",12))

CALLS=pan(L,"JUDGEMENT CALLS MADE WITHOUT THE OWNER",
  nt(L,"Drawn overnight, so these are named rather than buried. Each is cheap to reverse.")
  + "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 0;'
            + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
            f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
            f'padding-top: 2px; width: 18px;">{i+1}</span>'
            f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
    for i,v in enumerate([
      "<b>Sources at the top, pages below.</b> <i>Is this current</i> makes the rest trustworthy, so it leads. "
      "Pages-first with freshness in a header reads better as a browser and worse as an answer.",
      "<b>No graph view.</b> Two lists per page instead.",
      "<b>partial recommended, not introduced.</b> The conflict row is drawn and the state is proposed as an "
      "argument, rather than added to the ratified four on my own authority.",
      "<b>The folder tree is the navigation.</b> An area is derived from the path — first two segments under "
      "<b>Areas/</b>, first segment elsewhere — so there is no second organising idea layered over the vault."])))

body=(heading("ROUND E · SCREEN 10, NEW","Knowledge — the vault, read, and whether it is current",
   "Three questions: what is in here, is it current, what links to what. The wire answers the first and third "
   "completely and the second not at all — so the one it cannot answer leads, because a page list you cannot date "
   "is a list you have to take on faith.",L)
  + row(win(L,knowledgepane(L)),18)
  + row(THREE+STALE,18)
  + row(PARTIAL+DRAFT,18)
  + row(LINKS+CALLS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden;">'
        + knowledgepane(D) + '</div></div>',18))
(PROJ/"Knowledge.dc.html").write_text(page("Knowledge",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Knowledge.dc.html ({CW}x{CH})")
