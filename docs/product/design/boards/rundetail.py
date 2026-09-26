"""Board: Run detail — any run, in full.

Screen 12, new 2026-09-22. One page for a routine, an agent or a chat: the
working conversation leads, what it cost sits beside it, and what Metis took
from it sits above that. Owner's ruling: sessions are kept so Metistry can fold
them into knowledge, learn what went well and badly, and build his profile.
"""
from lib import *

CW,CH=2600,3280

PAGE=pan(L,"A ROUTINE RUN — THE CONVERSATION, AND WHAT IT TAUGHT",
  row(rundetail(L),18)
  + nt(L,"<b>The conversation leads</b> because that is what you open this for. The task and the tool calls sit "
        "in it in order; each call shows what it asked and what it got, on the agent wash, because both are "
        "agent-side data (P1). Calls collapse to one line; the definition is collapsed by default.",14)
  + nt(L,"<b>What Metis took from this</b> is at the top of the side column, above cost and timing: the lesson "
        "and the knowledge folded out of this run, each with where it would land and whether you have said yes.",12))

FAILED=pan(L,"A FAILED RUN — THE FAILURE IN THE HEADER, IN THE SEQUENCE, AND IN THE CONVERSATION",
  row(rundetail(L,failed=True),18)
  + nt(L,"The header states the failure in one sentence. The same call is red in the tool sequence and open in "
        "the conversation, with the refusal as its result, so you never have to match a log line to a moment. "
        "C45 holds: the run finished without the step and said so.",14))

CHAT=pan(L,"A CHAT SESSION — WHERE MOST OF WHAT IT LEARNS COMES FROM",
  row(chatsession(L)
    + f'<div style="width: 560px; flex-shrink: 0;">'
    + nt(L,"<b>Chat is in the archive.</b> It is where your preferences are actually said &mdash; <i>lead with "
          "the number</i> is a sentence you type once, and the fold is what makes it stick.",14)
    + nt(L,"<b>A preference lands in Me/Working Style.md and a fact in Me/profile.md</b> &mdash; the two files "
          "the seed already says Metistry should <i>discover from you</i>. Both are <b>source: user</b> and both "
          "change how Metis behaves (one is included word for word into prompts, the other gates routines), so "
          "invariant 2 makes every change a <b>proposal</b>. Accepting writes your words, in your file.",12)
    + '</div>',18,align="flex-start"))

SETTINGS=pan(L,"SETTINGS — HOW LONG, AND WHETHER IT LEARNS",
  row(archivesettings(L)
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"Two controls and a purge. <b>Thirty days</b> (ruled 2026-09-22): a session is raw material, and "
          "what lasts is what the fold took from it. Stored outside git &mdash; a transcript committed to git is "
          "forever. Where exactly is the developer&rsquo;s call; the owner leans to a file cache under "
          "<b>.metistry</b>.",14)
    + nt(L,"Turning learning off keeps sessions for reading and debugging but stops the fold.",12)
    + '</div>',18,align="flex-start"))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==4 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 18px;">{i+1}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,v in enumerate([
    "<b>A session archive (C78)</b> &mdash; every session, chat included: the system prompt as sent, every "
    "message, and each tool call&rsquo;s arguments and result. Read-only: the engine never replays it, which is "
    "what keeps cost decision 3 intact. Outside git; a file cache under <b>.metistry</b> is the owner&rsquo;s lean.",
    "<b>A session fold</b> &mdash; a routine, like <b>knowledge-fold</b>, that reads new sessions and proposes "
    "lessons, knowledge, preferences and profile facts (C79). Every output is a proposal.",
    "<b>Provenance both ways</b> &mdash; each proposal carries its session and turn; each session lists what "
    "was folded from it and whether it was accepted.",
    "<b>Retention and purge</b> &mdash; thirty days, and the fold must have run before a session expires.",
    "<b>run_detail</b> already returns everything in <i>The run</i> and <i>Tool calls</i>; nothing new needed "
    "there."])))

body=(heading("ROUND E · SCREEN 12, NEW","Run detail — the conversation, what it cost, and what it taught",
   "One page for any run. The working conversation is the page; cost and tool calls sit beside it; and above "
   "them, what Metis took from the session &mdash; each item a proposal until you say yes.",L)
  + row(PAGE,18)
  + row(FAILED,18)
  + row(CHAT,18)
  + row(SETTINGS+ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + rundetail(D) + '</div>',18))
(PROJ/"RunDetail.dc.html").write_text(page("RunDetail",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote RunDetail.dc.html ({CW}x{CH})")
