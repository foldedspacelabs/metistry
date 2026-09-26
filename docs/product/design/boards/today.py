"""Board: Today v7 — one morning, Next Up, close the day (2026-09-24).

Review 01's adopted opportunities 1–5 and 8, and rulings C97 and C98. Three
moments of one day: first open, the half hour before a meeting, the end.
"""
from lib import *
from lib_today import *

CW,CH=2620,7960

def side(title,notes):
    return (f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px;">'
            + pan(L,title,"".join(nt(L,n,0 if i==0 else 12) for i,n in enumerate(notes))) + '</div>')

A=todaywin7(L,at="8:52 AM",top=brief(L)+nextup(L,kind="standup",mins=23),
            spine=spine7(L,at="8:52 AM",past=None,nextup_on=False,standup=True),rail_at="yesterday")
B=todaywin7(L,at="9:04 AM",top=brief(L,state="folded")+nextup(L),spine=spine7(L),rail_at="8:52 AM")
C=todaywin7(L,at="5:08 PM",top=brief(L,state="folded")+closeday(L),
            spine=(fold7(L,"Earlier today &mdash; <b>6 done</b> &middot; 5 meetings &middot; a focus block")
                   + nowbar(L,"5:08 PM")
                   + f'<div style="display: flex; gap: 10px; padding: 11px 0; align-items: center;">{timecol(L,"5:30 PM")}'
                     f'<span style="font-size: 12.5px; color: {L["ts"]};">Your day ends</span></div>'),rail_at="3:40 PM")

A_N=side("8:52 AM &mdash; FIRST OPEN: THE BRIEF IS TODAY (C97)",[
  "<b>One Morning Brief, and it is the top of Today.</b> The plan is not repeated inside it &mdash; the plan <i>is</i> "
  "the day below &mdash; so the brief says what matters and points down. The standup is its one section, with Copy.",
  "The brief writes <b>Journal/Brief/&lt;date&gt;.md</b>; the morning message links here. Plan and Standup Draft stop "
  "being routines of their own on Routines (next pass)."])
B_N=side("9:04 AM &mdash; NEXT UP, AND ONE VOICE AT A TIME",[
  "<b>Next Up sticks under the header from thirty minutes before an event.</b> Who, what you owe them, last time, "
  "one generated line marked as such, and Record &mdash; which opens the floating bar with this meeting already chosen.",
  "<b>One Metis voice is open at a time.</b> Read, the brief folds to a line; calendar help sits folded beside its one "
  "action. Two predictions on the page, each with its reason (&le;3, §12.5).",
  "<b>A checkbox ticks.</b> One click, a receipt with Undo, no dialog (C98) &mdash; see below."])
C_N=side("5:08 PM &mdash; CLOSE THE DAY",[
  "<b>The end of the day has a screen.</b> What got done, what is still open and where it goes, what you owe people, "
  "and the shape of tomorrow.",
  "<b>Owed to people is a list of tasks</b>, tickable and movable like the rest, with the person on each (C102).",
  "<b>Closing keeps today&rsquo;s note current</b>: it rewrites the Metistry section of the daily note, dates each "
  "deferred line, and writes <b>tomorrow&rsquo;s plan</b> at once. Tonight&rsquo;s fold reads it into knowledge."])

def comp(title,inner): return pan(L,title,inner)
BRIEFS=comp("THE BRIEF &mdash; OPEN, FOLDED, ABSENT, FAILED",
  f'<div style="display: flex; flex-direction: column; gap: 12px;">'
  + brief(L,standup_open=True) + brief(L,state="folded") + brief(L,state="absent") + brief(L,state="failed") + '</div>')
TICKS=comp("A CHECKBOX TICKS (C98)",
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]}; overflow: hidden;">'
  + taskrow(L,title="Book the lease walkthrough",p=2,d="Today",e="10m",people=["Tom Reyes"],hover=True)
  + taskrow(L,title="Renew the parking permit",done=True,receipt="done")
  + taskrow(L,title="Call the dentist",p=3,d="18 Sep",dover=True,e="15m",receipt="stale",last=True) + '</div>'
  + nt(L,"<b>No confirmation.</b> The check route changes two bytes and Undo is a second write, so a dialog "
         "would guard nothing (proposed C99). A line edited in Obsidian meanwhile is refused, not overwritten. "
         "Delegate appears on hover, not on every row.",14))
SLIP=comp("SLIPPING &mdash; A SAVED VIEW IN ALL",
  f'<div style="display: flex; gap: 7px; margin-bottom: 11px; flex-wrap: wrap;">'
  + "".join(f'<span style="padding: 3px 11px; border-radius: 999px; font-size: 12px; font-weight: {600 if s else 500}; '
            f'background: {L["accq"] if s else "transparent"}; border: 1px solid {L["acc"] if s else L["bc"]}; '
            f'color: {L["acc"] if s else L["ts"]};">{n}</span>'
            for n,s in (("Today",False),("All",False),("Slipping",True),("Owed",False),("Waiting on Others",False))) + '</div>'
  + f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]}; overflow: hidden;">'
  + taskrow(L,title="Call the dentist",p=3,d="18 Sep",dover=True,e="15m",states=[("5th Day","deg",I["clock"])])
  + taskrow(L,title="Send Jim the revised Q4 scope",p=2,e="30m",people=["Jim Fallon"],states=[("4th Day","deg",I["clock"])])
  + taskrow(L,title="Renew the parking permit",p=3,d="Yesterday",dover=True,e="10m",last=True) + '</div>'
  + nt(L,"Carried three or more times, overdue, or owed to someone &mdash; the filter language, saved. The Sunday "
         "weekly review opens here.",12))
def dest(T,g,where,what,how,last=False):
    return (f'<div style="display: flex; gap: 11px; padding: 10px 0;{"" if last else " border-bottom: 1px solid "+T["border"]+";"}">'
            f'<span style="display: flex; color: {T["acc"]}; margin-top: 2px;">{ic(I[g],15,1.9)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;"><div>{mono(where,T["tp"],12)}</div>'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; margin-top: 3px; line-height: 1.45;">{what}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{how}</div></div></div>')
NOTESEC=("## Today &middot; Metistry<br>"
         "<span style=\"color: "+L["ts"]+";\">&lt;!-- metistry:day &middot; updated 5:14 PM &middot; edits above and below this section are yours --&gt;</span><br>"
         "**Done** &mdash; Sign the SOW &middot; Call the dentist &middot; Write the design brief &middot; +3<br>"
         "**Moved** &mdash; 3 to Wed &middot; Send Jim the revised Q4 scope &rarr; Fri &middot; the walkthrough checklist &rarr; someday<br>"
         "**Meetings** &mdash; [[2026-09-22-vendor-review|Vendor review]] &middot; [[2026-09-22-design-review|Design review]]<br>"
         "**For tomorrow** &mdash; Kessler first &mdash; the volume numbers decide the renewal.<br>"
         "<span style=\"color: "+L["ts"]+";\">&lt;!-- /metistry:day --&gt;</span>")
WRITES=comp("WHAT CLOSING WRITES (C101, C102 &mdash; RULED 2026-09-25)",
  dest(L,"note",F["daily_note"]+" &middot; its Metistry section","Done, what moved and to when, the meetings, and your line for tomorrow.",
       "Only between its markers; the rest of the note is yours. The brief writes it at 6 AM, closing rewrites it (C102).")
  + f'<div style="margin: 2px 0 8px 26px; background: {L["sunken"]}; border-radius: 8px; padding: 9px 11px; '
    f'font-family: {MONO}; font-size: 11px; color: {L["tp"]}; line-height: 1.6;">{NOTESEC}</div>'
  + dest(L,"check","each deferred task&rsquo;s own line","<b>&#9203; 2026-09-23</b> for Tomorrow, the week&rsquo;s last working day for "
         "This Week, <b>#someday</b> for Someday. Owed items are tasks like any other.",
         "The check route&rsquo;s sibling &mdash; one field on one line, refused if the line changed.")
  + dest(L,"spark",F["plan_file"],"Tomorrow&rsquo;s plan, written now rather than at 7 PM, and led by your line.",
         "plan-tomorrow runs on close; closing again re-renders it. It becomes the Morning Brief&rsquo;s day.")
  + dest(L,"know","Knowledge, via tonight&rsquo;s fold","What is owed to whom, as proposals on each person&rsquo;s page; "
         "what slipped, for the weekly review.","Proposals, as ever (C79) &mdash; the fold never writes your pages.",last=True))

NEXTS=comp("NEXT UP &mdash; A STANDUP, AND NOTHING LEFT",
  f'<div style="display: flex; flex-direction: column; gap: 12px;">' + nextup(L,kind="standup",mins=23)
  + nextup(L,kind="none") + closeday(L,closed=True) + '</div>')

body=(heading("TODAY &middot; v7","Today &mdash; one morning, Next Up, and a way to end the day",
   "The first screen, redrawn for the owner&rsquo;s day: the Morning Brief as its first state, the next meeting "
   "prepared, tasks that tick, and a close.",L)
  + row(A+A_N,20) + row(B+B_N,20) + row(C+C_N,20)
  + row(f'<div style="flex: 1.15; min-width: 0;">{BRIEFS}</div><div style="flex: 1; min-width: 0; display: flex; '
        f'flex-direction: column; gap: 20px;">{TICKS}{WRITES}{SLIP}{NEXTS}</div>',20)
  + row(f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{CALP2}</div>'
        f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{POLICY}</div>',20)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px;">' + sub("DARK",D["tt"])
        + todaywin7(D,at="9:04 AM",top=brief(D,state="folded")+nextup(D),spine=spine7(D),dark=True,rail_at="8:52 AM") + '</div>',20))
(PROJ/"Today-Hub.dc.html").write_text(page("Today",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Today-Hub.dc.html (v7, {CW}x{CH})")
