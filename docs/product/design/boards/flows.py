"""Board: Flows — recording through a working day, the destructive-verb rule, and
the buttons that led nowhere (2026-09-25; C136–C138)."""
from lib import *
from lib_states2 import *
from lib_needs import rcard, rhead2, rask, rcontext, ranswers

CW,CH=2600,1500

def notice(T,glyph,tint,title,body,acts=(),*,w=340):
    return (f'<div style="width: {w}px; box-sizing: border-box; {glass(T,radius=14)} padding: 12px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 8px;"><span style="display: flex; color: {tint};">{ic(I[glyph],15,2)}</span>'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{title}</span></div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 4px; line-height: 1.45;">{body}</div>'
            + (f'<div style="display: flex; gap: 7px; margin-top: 10px;">' + "".join(btn(T,a,k) for a,k in acts) + '</div>' if acts else "") + '</div>')

def stage(T,n,label,inner):
    return (f'<div style="width: 360px; flex-shrink: 0;"><div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">'
            f'<span style="width: 20px; height: 20px; border-radius: 50%; background: {T["acc"]}; color: {T["onacc"]}; font-size: 11px; font-weight: 700; '
            f'display: inline-flex; align-items: center; justify-content: center;">{n}</span>'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span></div>{inner}</div>')

def recsheet(T):
    return notice(T,"rec",T["deg"],"Record",
        "Window &middot; Zoom &mdash; Vendor review &middot; app audio and your microphone"
        f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 8px; color: {T["ts"]};">{ic(I["disk"],12,2)}'
        f'About 150 MB an hour &middot; 212 GB free</div>',(("Record","affirm"),("Cancel","ghost")))

REC=(f'<div style="display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start;">'
  + stage(L,1,"BEFORE IT STARTS",recsheet(L))
  + stage(L,2,"SCREEN NOT ALLOWED YET",notice(L,"screen",L["ts"],"Metistry can&rsquo;t see your screen yet",
        "macOS asks once. Allow it in System Settings, then come back &mdash; or record audio only.",(("Open System Settings","secondary"),("Audio Only","ghost"))))
  + stage(L,3,"EVERY TWO HOURS",notice(L,"clock",L["ts"],"Still recording &middot; 2 hours",
        "Zoom &mdash; Vendor review ended 1 h 20 min ago. 310 MB so far.",(("Stop Recording","secondary"),("Keep Going","ghost"))))
  + stage(L,4,"THE WINDOW CLOSED",notice(L,"display",L["ts"],"The window closed",
        "Still recording app audio and your microphone. The screen part stopped at 2:41 PM.",(("Stop Recording","secondary"),)))
  + stage(L,5,"THE MAC SLEPT",notice(L,"moon",L["ts"],"Paused while this Mac slept",
        "Resumed at 3:12 PM. The 22-minute gap is marked in the transcript.",()))
  + stage(L,6,"DISK RUNNING LOW",notice(L,"disk",L["deg"],"Only 9 GB free",
        "Recording stops at 5 GB free so macOS keeps working. Free space, or stop now.",(("Stop Recording","secondary"),("Open Storage","ghost"))))
  + stage(L,7,"AT TEN HOURS",notice(L,"stop",L["ts"],"Stopped at 10 hours",
        "Everything up to 6:02 PM is saved and folding. Start a new recording to keep going.",(("Record Again","secondary"),)))
  + stage(L,8,"THE RECORDER CRASHED",rcard(L,rhead2(L,I["rec"],"REPORT",who="metis",when="4:10 PM")
        + rask(L,"The recording stopped unexpectedly","Saved up to 4:08 PM &middot; 3 h 12 min")
        + ranswers(L,"Record Again",pglyph="rec",revise=None,decline=None,extra=(btn(L,"View Log","ghost"),),help_=False),w=360))
  + '</div>')

EFF=pan(L,"A WORKING DAY FITS ON THE DISK (C137)",
  nt(L,"<b>Up to 10 hours</b>, with a reminder every two hours. Recording is budgeted at <b>about 150 MB an hour</b> "
       "&mdash; compressed audio, and the screen kept as changed frames rather than video &mdash; so a full day is about "
       "1.5 GB. The transcript is written as it goes; the media is deleted once the fold has read it; transcripts keep 30 "
       "days (C91).")
  + nt(L,"<b>Disk is watched</b>: a warning at 10 GB free, a stop at 5 GB. The record sheet shows the estimate before you "
        "start.",12))

UNDO=(f'<div style="display: flex; flex-direction: column; gap: 12px; align-items: flex-start;">'
  + toast(L,"Declined 5 requests") + toast(L,"Kept your version of Vendor terms") + toast(L,"Draft of collator kept","Open")
  + toast(L,"Moved Sign the SOW to Done") + '</div>')
CONF=(f'<div style="display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;">'
  + confirm(L,"Purge 14 minutes of transcript?","The fold hasn&rsquo;t read 3 of these sessions yet. Purged sessions can&rsquo;t come back.",
            [("rec","Vendor review &middot; 42 min &middot; not folded"),("rec","1:1 with Dana &middot; 28 min &middot; not folded"),("rec","Standup &middot; 9 min &middot; not folded")],
            "Purge Anyway",alt="Fold First")
  + confirm(L,"Sign out everywhere?","Each of these must sign in again with a passkey.",
            [("person","iPhone &middot; last seen 4 min ago"),("person","Chrome on the laptop &middot; yesterday")],"Sign Out")
  + confirm(L,"Delete github_read?","Four things use it and will stop working.",
            [("relay","GitHub &middot; connection"),("repeat","GitHub &middot; sync"),("agents","collator"),("agents","drey-dev")],"Delete Secret")
  + '</div>')
RULE2=pan(L,"UNDO WHEN IT CAN BE UNDONE; CONFIRM WHEN IT CAN&rsquo;T (C136)",
  nt(L,"Reversible actions happen at once and offer <b>Undo</b> for ten seconds: Decline All, Keep Mine / Take the "
       "Fold&rsquo;s (the other side stays in history), a move. <b>Esc in the agent editor keeps a draft</b>, like Capture. "
       "Only what cannot come back asks first &mdash; and the question names exactly what it costs.")
  + f'<div style="display: flex; gap: 28px; align-items: flex-start; margin-top: 16px;">{UNDO}{CONF}</div>')

def newagent(T,*,w=520):
    rows=[("agents","A local agent","Runs on this Mac from a definition file. Start from a template or blank."),
          ("relay","Connect an agent","Somewhere Metistry sends work &mdash; A2A or ACP. Added as a connection."),
          ("plug","A tool that works for you","Claude Code, Cursor, OpenCode &mdash; gets a token and its own permissions.")]
    return (f'<div style="width: {w}px; box-sizing: border-box; padding: 16px; border-radius: 13px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; box-shadow: 0 16px 40px rgba(26,24,21,0.2);">'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-bottom: 12px;">New Agent</div>'
            + "".join(f'<div style="display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 10px; align-items: center; padding: 10px 12px; margin-bottom: 7px; border-radius: 9px; '
                      f'border: 1px solid {T["acc"] if i==0 else T["border"]}; background: {T["surface"]};"><span style="display: flex; color: {T["tp"]};">{ic(I[g],17,1.9)}</span>'
                      f'<div><div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{a}</div><div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 1px;">{b}</div></div></div>'
                      for i,(g,a,b) in enumerate(rows))
            + f'<div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">{btn(T,"Cancel","ghost")}{btn(T,"Continue","affirm")}</div></div>')
RUNNOW=(f'<div style="position: relative; width: 420px; height: 120px;"><div style="position: absolute; left: 0; top: 0;">{btn(L,"Run Now","disabled",I["spark"])}</div>'
        f'<div style="position: absolute; left: 0; top: 40px; width: 340px; {glass(L,radius=8)} padding: 7px 10px; font-size: 12px; color: {L["tp"]};">'
        f'collator has no task on a schedule. <span style="font-weight: 600; color: {L["acc"]};">Give it one</span> or ask it in Chat.</div></div>')
DEAD=pan(L,"BUTTONS THAT LED NOWHERE (C138)",
  f'<div style="display: flex; gap: 28px; align-items: flex-start;">{newagent(L)}<div>{RUNNOW}'
  + nt(L,"<b>New Agent</b> asks which kind first. <b>Run Now</b> on an agent with nothing to run is dimmed and says why. "
        "<b>Raise</b> on Usage and Projects opens Settings &#9656; Compute &#9656; Spending limits.",12) + '</div></div>')

body=(heading("ROUND F · FLOWS","Flows — a working day of recording, Undo or confirm, and no dead ends",
   "What recording does across ten hours and every interruption, which actions ask first, and where the dead buttons go now.",L)
  + f'<div style="font-size: 13px; font-weight: 700; color: {L["tp"]}; margin-bottom: 12px;">Recording, start to stop</div>' + REC
  + '<div style="height: 26px;"></div>' + row(EFF,18) + row(RULE2,18) + row(DEAD,18))
(PROJ/"Flows.dc.html").write_text(page("Flows",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Flows.dc.html ({CW}x{CH})")
