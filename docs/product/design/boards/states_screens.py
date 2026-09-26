"""Board: States — the work and reading screens (2026-09-25; C135).

Empty, first load, stale and failed for Board, Card detail, Projects, Artifacts,
Knowledge, Run detail, Usage and Chat. First paint is what Metistry last had.
"""
from lib import *
from lib_states2 import *

CW,CH=2600,2290
W=600
def r4(label,*tiles):
    return (f'<div style="margin-bottom: 30px;"><div style="font-size: 13px; font-weight: 700; color: {L["tp"]}; margin-bottom: 12px;">{label}</div>'
            f'<div style="display: flex; gap: 24px; align-items: flex-start;">' + "".join(tiles) + '</div></div>')
H=300

BOARD=r4("Board",
  tile(L,"EMPTY",frame(L,"Board",empty(L,"board","Nothing on the board","Tasks you capture or agents take on land here.","Capture a Task"),h=H)),
  tile(L,"FIRST LOAD ONLY",frame(L,"Board",skel(L,5),h=H)),
  tile(L,"STALE — WHAT IT HAD",frame(L,"Board",band(L,"off","<b>Can&rsquo;t reach Metistry.</b> Showing the board as of 9:14.")
       + fakerows(L,[("todo","Sign the SOW","Doing"),("todo","Send Jim the revised Q4 scope","Next"),("todo","Review PR 263","Next")]),h=H)),
  tile(L,"FAILED — A MOVE",frame(L,"Board",band(L,"fail","Couldn&rsquo;t move <b>Sign the SOW</b>. It&rsquo;s back in Doing.","Try Again")
       + fakerows(L,[("todo","Sign the SOW","Doing"),("todo","Send Jim the revised Q4 scope","Next")]),h=H)))

CARDS=r4("Card detail and Projects",
  tile(L,"CARD — MOVED ELSEWHERE",frame(L,"Sign the SOW",empty(L,"check","Done, by collator","Moved to Done 2 minutes ago. Nothing here is lost.","Open in Done"),h=H)),
  tile(L,"CARD — SAVE FAILED",frame(L,"Sign the SOW",band(L,"fail","Couldn&rsquo;t save. Your edit is kept here.","Try Again")
       + f'<div style="margin: 12px 16px; padding: 10px 12px; border: 1px solid {L["acc"]}; border-radius: 8px; font-size: 13px; color: {L["tp"]};">Countersign and send back to Dana by Friday</div>',h=H)),
  tile(L,"PROJECTS — EMPTY",frame(L,"Projects",empty(L,"work","No projects yet","A project gathers tasks, agents and a budget under one name.","New Project"),h=H)),
  tile(L,"PROJECTS — STALE",frame(L,"Projects",band(L,"stale","Spend as of 40 minutes ago &mdash; the usage sync is late.","Sync Now")
       + fakerows(L,[("work","Drey","$0.72 of $5"),("work","Metistry","$0.18 of $4"),("work","FSL ops","$0.58 of $0.50")]),h=H)))

ARTS=r4("Artifacts",
  tile(L,"EMPTY",frame(L,"Artifacts",empty(L,"note","No artifacts yet","When an agent saves work to keep &mdash; a summary, a model, a draft &mdash; it lands here, versioned."),h=H)),
  tile(L,"OPENING A LARGE ONE",frame(L,"vendor-summary",waitline(L,"Opening <b>vendor-summary</b> &middot; v3 &middot; 2.1 MB",0.55)+skel(L,3),h=H)),
  tile(L,"A VERSION WON&rsquo;T LOAD",frame(L,"vendor-summary",band(L,"fail","v3 couldn&rsquo;t be read from git.","Show v2")
       + empty(L,"note","v3 is listed but unreadable","The rest of the history is fine.",None,secondary="View Log"),h=H)),
  '')

KNOW=r4("Knowledge",
  tile(L,"FIRST READ OF THE VAULT",frame(L,"Knowledge",waitline(L,"Reading your vault &middot; <b>312</b> of 1,240 notes",0.25)
       + fakerows(L,[("know","Areas/Finance","48 notes"),("know","Areas/Ops","31 notes")]),h=H)),
  tile(L,"NO MATCH",frame(L,"Knowledge",empty(L,"know","Nothing matches &ldquo;zebra&rdquo;","Searched 1,240 notes and 3 linked instances."),h=H)),
  tile(L,"VAULT NOT FOUND",frame(L,"Knowledge",empty(L,"folder","Can&rsquo;t find your vault","It was at ~/Obsidian/Work. Moved or renamed?","Choose Folder"),h=H)),
  '')

RUN=r4("Run detail, Usage, Chat",
  tile(L,"RUN — TRANSCRIPT EXPIRED",frame(L,"Morning Brief &middot; 22 Aug",empty(L,"clock","The transcript is gone","Sessions are kept 30 days. The summary, cost and what it wrote remain."),h=H)),
  tile(L,"USAGE — NOTHING YET",frame(L,"Usage",empty(L,"gauge","Nothing spent this month","Local models are free. Cloud spend shows here as it happens."),h=H)),
  tile(L,"CHAT — FIRST CONVERSATION",frame(L,"Chat",empty(L,"chat","Ask Metis anything","About your day, your notes, or work in flight."),h=H)),
  tile(L,"CHAT — NOT SENT, AND WAITING",frame(L,"Chat",
       f'<div style="padding: 14px 16px;"><div style="margin-left: auto; width: 70%; padding: 9px 12px; border-radius: 12px; background: {L["sunken"]}; font-size: 13px; color: {L["tp"]};">Move my 1:1 to Thursday</div>'
       f'<div style="display: flex; justify-content: flex-end; gap: 8px; align-items: center; margin-top: 5px; font-size: 11.5px; color: {L["fail"]};">{ic(I["failed"],11,2.2)} Not sent <span style="font-weight: 600; color: {L["acc"]};">Retry</span></div>'
       f'<div style="margin-top: 16px; font-size: 12.5px; color: {L["ts"]};">Metis is reading 4 notes&hellip;</div></div>',h=H)))

RULE=pan(L,"FIRST PAINT (C135)",
  nt(L,"<b>Show what Metistry last had, at once.</b> If it is older than the screen&rsquo;s own limit, a stale band says "
       "when it is from. Placeholder rows appear only the very first time a screen loads. A wait longer than a second "
       "says what it waits for &mdash; <i>Reading your vault &middot; 312 of 1,240</i> &mdash; never a bare spinner.")
  + nt(L,"<b>Failed keeps your work.</b> A move that fails goes back where it was and says so; an edit that fails to "
        "save stays in the field.",12))

body=(heading("ROUND F · STATES","States — the work and reading screens",
   "Empty, first load, stale and failed, for every screen that had none.",L)
  + row(RULE,18) + BOARD + CARDS + ARTS + KNOW + RUN)
(PROJ/"States-Screens.dc.html").write_text(page("States Screens",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote States-Screens.dc.html ({CW}x{CH})")
