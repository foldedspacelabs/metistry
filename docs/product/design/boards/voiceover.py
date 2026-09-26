"""Board: VoiceOver — what each thing says (2026-09-25).

C121, C122. Every glyph-only control speaks its name; every mark that carries
meaning speaks it in words; a chart speaks a sentence and offers its table. Reduce
Motion and the largest text size are part of the same pass.
"""
from lib import *
from lib_access import *
from lib_today import taskrow
from lib_needs5 import qstep
from lib_scheduled import occ2
from lib_connect import ref, toolrow3, offerrow

CW,CH=2720,2150

def card(title,visual,table,*,vw=None):
    v=f'<div style="{"width: "+str(vw)+"px; flex-shrink: 0;" if vw else ""}">{visual}</div>'
    return pan(L,title,f'<div style="display: flex; gap: 28px; align-items: flex-start;">{v}<div style="flex-grow: 1; min-width: 0;">{table}</div></div>')

BAR=card("THE CAPTURE BAR — GLYPHS ONLY, SO EVERY ONE IS NAMED",raildemo(L),spoken(L,[
  ("The rail","Metistry capture bar","group"),
  ("Ask","Ask Metis","button"),
  ("Note","Note, Control-Option-Command-N","button &middot; shortcut only when on"),
  ("To-do","To-do","button"),
  ("Record","Start recording. Screen and microphone","button"),
  ("While recording","Recording, 4 minutes. Screen and microphone","status, announced once"),
  ("Stop","Stop recording","button")]),vw=250)

NY=card("NEEDS YOU AND A STEPPED QUESTION",
  f'<div style="width: 250px; border: 1px solid {L["bc"]}; border-radius: 12px; overflow: hidden;">{sidebar8(L,"Needs You")}</div>',
  spoken(L,[("Needs You row","Needs You, 10 waiting","button, selected"),
            ("When the count changes","11 waiting","announcement, not repeated while you&rsquo;re on it"),
            ("Question header","Question 1 of 3. Where should the Resources table live?","heading"),
            ("An answer","Its own file, SettingsResources.swift. 1 of 3","radio button"),
            ("Next","Next question. 2 of 3 answered after this","button"),
            ("Send Answers, not ready","Send answers, dimmed. 1 question unanswered","button")])
  + f'<div style="margin-top: 16px; zoom: 0.8;">{qstep(L,0,sel=(0,))}</div>',vw=250)

TODAY=card("TODAY — MARKS THAT CARRY MEANING SAY IT",
  f'<div style="display: flex; flex-direction: column; gap: 12px; width: 460px;">{gaugepill(L)}'
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]};">'
  + taskrow(L,title="Send Jim the revised Q4 scope",p=2,e="30m",states=[("3rd Day","deg",I["clock"])])
  + taskrow(L,title="Sign the SOW",p=1,d="Today",e="15m",done=True,receipt="done",last=True) + '</div></div>',
  spoken(L,[("Usage gauge","Usage, $1.84 today, 37% of the day&rsquo;s budget","button, opens usage"),
            ("A task","Send Jim the revised Q4 scope. Priority 2, 30 minutes, third day","checkbox, not checked"),
            ("Ticked","Sign the SOW, done. Written to today&rsquo;s note. Undo available","checkbox, checked"),
            ("Undo","Undo completing Sign the SOW","button"),
            ("A failed mark","Failed","part of its row&rsquo;s label, never alone"),
            ("A stale pill","Stale, 3 days","part of its row&rsquo;s label")]),vw=460)

SCHED=card("SCHEDULED AND CONNECTIONS — A CHART SPEAKS A SENTENCE",
  f'<div style="width: 560px; display: flex; flex-direction: column; gap: 12px;">'
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; padding: 12px; background: {L["bg"]};">{timeline(L)}</div>'
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; overflow: hidden;">'
  + occ2(L,at="6:00 AM",name="Standup",runner="metis",recur="Working days at 6:00 AM",state="ok",default=True,feeds="Morning Brief",last=True)
  .replace("grid-template-columns: 15px 74px minmax(0,1fr) 130px 230px","grid-template-columns: 15px 60px minmax(0,1fr) 70px 150px") + '</div>'
  + sunk(L,toolrow3(L,"create_session","Starts a Devin session","ask",last=True)) + sunk(L,offerrow(L,True,note=" "))
  + f'<div>{ref(L,"secret","github_read")}</div></div>',
  spoken(L,[("The week","This week: 39 runs, all by 7 AM or after 6 PM. Show as table","image, with a table in the rotor"),
            ("A routine row","6:00 AM, Standup, default, run by Metis, working days at 6 AM. Succeeded","row"),
            ("On &middot; Ask &middot; Off","create_session. Ask, 2 of 3","radio group"),
            ("Offer switch","Offer to agents through Metistry, on","switch"),
            ("A secret reference","Secret, github_read","text, in its field&rsquo;s value"),
            ("A variable reference","Variable, work_repos: metistry, metistry-instance, drey, fsl-site","text, resolved")]),vw=560)

RULES=pan(L,"THE RULES, AND REDUCE MOTION",
  nt(L,"<b>A glyph-only control says its name</b>, and its shortcut when one is set. <b>A mark that carries "
       "meaning says it in words</b> as part of its row &mdash; never a colour or a shape alone. <b>A chart says one "
       "sentence</b> and offers its table in the rotor. <b>The one badge</b> announces a change once (C121).")
  + nt(L,"<b>Landmarks:</b> sidebar, list, detail, and the capture bar as its own window. Headings mark each section "
        "of a detail, so the rotor walks a routine&rsquo;s Schedule, Task, Reads and Writes, History.",12)
  + nt(L,"<b>Reduce Motion</b> (C122): stepped questions cross-fade instead of sliding; the Needs You row appears "
        "without sliding; the recording mark stops breathing and holds its tint. <b>Larger text</b> is checked at the "
        "largest size macOS offers, not 135%; panes grow longer, never wider.",12))

body=(heading("ROUND F · VOICEOVER","VoiceOver — what each thing says",
   "Every control that is only a glyph is named, every mark that means something says it in words, and a chart "
   "says one sentence with its table behind it.",L)
  + row(BAR+RULES,18) + row(NY,18) + row(TODAY,18) + row(SCHED,18))
(PROJ/"VoiceOver.dc.html").write_text(page("VoiceOver",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote VoiceOver.dc.html ({CW}x{CH})")
