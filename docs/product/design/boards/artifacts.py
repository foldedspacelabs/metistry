"""Board: Work ▸ Artifacts and Work ▸ Rooms.

Screen 16, new 2026-09-23. An artifact is a folder in git and every version one
commit; comments sit on an exact version, pinned to lines, and are drawn in the
margin (ruled 2026-09-23). A room cannot address anyone, ten agent turns in a
row is the cap, and only the owner resolves.
"""
from lib import *

CW,CH=2600,3860

ALIST=pan(L,"ARTIFACTS — WHAT EXISTS, WHO MADE THE LATEST, WHAT&rsquo;S BEING DISCUSSED",
  row(workwin(L,artlist(L)),18)
  + nt(L,"One row per artifact. <b>Latest</b> is the current version and who made it; <b>threads</b> counts the "
        "open ones across all versions.",14))

AVIEW=pan(L,"AN ARTIFACT — THE VERSION, ITS HISTORY, AND THREADS BESIDE THE LINES THEY&rsquo;RE ABOUT",
  row(workwin(L,artview(L)),18)
  + nt(L,"<b>Threads sit in the margin, level with their lines</b>, and the lines are highlighted. When two would "
        "collide, the lower one moves down and keeps a leader to its line; replies fold to a count.",14)
  + nt(L,"A thread belongs to one version, so switching versions in the rail shows that version&rsquo;s threads.",12))

ACOMP=pan(L,"COMPARE — WHAT CHANGED, AND WHICH THREADS STAYED BEHIND",
  row(workwin(L,artcompare(L)),18)
  + nt(L,"The diff between two versions. A thread about a line that changed stays on its version and says so, "
        "with a link back.",14))

RLIST=pan(L,"ROOMS — EVERY THREAD, AND WHICH ONES CAME TO YOU",
  row(workwin(L,roomslist(L)),18)
  + nt(L,"<b>Who has spoken</b>, not who is in it: a room has no members. The pips count agent turns in a row "
        "against the cap of ten. A room that hit the cap says <b>came to you</b> and why, in the sentence the "
        "system already stores.",14))

RVIEW=pan(L,"A ROOM — NO @, NO RECIPIENT, AND ONLY YOU RESOLVE",
  row(workwin(L,roomview(L)),18)
  + nt(L,"<b>The composer is <i>Add to the room</i></b> &mdash; no mentions, no recipient, because posting wakes "
        "nobody; agents read the room when they pick up the task. Your message resets the agent run.",14)
  + nt(L,"<b>Resolve</b> is yours alone, and a resolved room still takes messages.",12))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  nt(L,"Nothing new. The artifact list, versions, files, diff and comments are all routes today; rooms come from "
        "the <b>rooms</b> query with the agent tail and the escalation reason already on each row.",0))

body=(heading("ROUND E · SCREEN 16, NEW","Work ▸ Artifacts and Rooms",
   "Artifacts: the list, one artifact with its versions and margin threads, and a compare. Rooms: every thread, "
   "how close each is to the cap, and one room with the composer and Resolve.",L)
  + row(ALIST,18) + row(AVIEW,18) + row(ACOMP,18) + row(RLIST,18) + row(RVIEW,18) + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + workwin(D,artview(D)) + '</div>',18))
(PROJ/"Artifacts.dc.html").write_text(page("Artifacts",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Artifacts.dc.html ({CW}x{CH})")
