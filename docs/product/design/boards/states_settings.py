"""Board: States — Settings, Scheduled and Connections (2026-09-25; C135).

What each of this week's screens says when a provider is down, a model is
downloading, the disk is short, a sync keeps failing, Doctor is running, a linked
instance goes quiet, or an update fails.
"""
from lib import *
from lib_states2 import *
from lib_settings2 import ibtn, tag, meter

CW,CH=2600,1260
W=600
def r4(label,*tiles):
    return (f'<div style="margin-bottom: 30px;"><div style="font-size: 13px; font-weight: 700; color: {L["tp"]}; margin-bottom: 12px;">{label}</div>'
            f'<div style="display: flex; gap: 24px; align-items: flex-start;">' + "".join(tiles) + '</div></div>')
def pad(x): return f'<div style="padding: 6px 16px 12px;">{x}</div>'

COMPUTE=r4("Compute",
  tile(L,"A PROVIDER NOT ANSWERING",frame(L,"Providers",pad(
      issuerow(L,"LM Studio","Local","Not answering on localhost:1234",btn(L,"Retry","ghost"))
      + issuerow(L,"Groq","Cloud","Key rejected (401)",btn(L,"Replace Key","secondary"))
      + issuerow(L,"OpenRouter","Cloud","Answering",'',kind="ok")),w=W)),
  tile(L,"DOWNLOADING A MODEL",frame(L,"Your Models",pad(meter(L,"Disk","73 GB","1 TB",0.15,L["ts"])
      + '<div style="height: 8px;"></div>'
      + progressrow(L,"Gemma 3 27B","Google &middot; Ollama",0.29,"5.0 of 17 GB &middot; 4 min",btn(L,"Cancel","ghost"))
      + progressrow(L,"Llama 3.2 3B","Meta &middot; LM Studio",1.0,"Loading into memory&hellip;",'')),w=W)),
  tile(L,"NOT ENOUGH DISK",frame(L,"Search &middot; llama 3.3",pad(
      f'<div style="display: flex; align-items: center; gap: 9px; padding: 9px 0;"><span style="font-size: 12.5px; font-weight: 600; color: {L["tp"]}; flex-grow: 1;">LM Studio <span style="font-weight: 400; color: {L["ts"]};">Q8 &middot; 75 GB</span></span>'
      f'{btn(L,"Install","disabled",I["update"])}</div>'
      + f'<div style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: {L["ts"]};"><span style="display: flex; color: {L["deg"]};">{ic(I["warn"],12,2.1)}</span>'
        f'Needs 75 GB; 31 GB free. It also needs 80 GB of memory; this Mac has 64.</div>'),w=W)),
  tile(L,"SEARCH &mdash; NOTHING, OR A PROVIDER SILENT",frame(L,"Search &middot; xyzzy",
      empty(L,"cpu","No models match &ldquo;xyzzy&rdquo;","Searched 5 of 6 providers. Groq didn&rsquo;t answer; its list is from yesterday.",None,secondary="Refresh"),w=W)))

SCHED=r4("Scheduled and Connections",
  tile(L,"A SYNC THAT KEEPS FAILING",frame(L,"Syncs",pad(
      issuerow(L,"Devin Sessions","Devin","Failed 3 times &middot; key expired",btn(L,"Open","ghost"))
      + f'<div style="font-size: 11.5px; color: {L["ts"]}; padding-top: 8px;">After the third failure it stops trying and one request waits in Needs You. The others keep running.</div>'),w=W)),
  tile(L,"A ROUTINE THAT HASN&rsquo;T RUN",frame(L,"Standup",pad(
      f'<div style="display: flex; align-items: center; gap: 8px; padding: 10px 0;"><span style="display: flex; color: {L["ts"]};">{ic(I["clock"],13,2.1)}</span>'
      f'<span style="font-size: 12.5px; color: {L["tp"]}; flex-grow: 1;">Not run yet &middot; first run tomorrow at 6:00 AM</span>{btn(L,"Run Now","secondary",I["spark"],spark=True)}</div>'),w=W)),
  tile(L,"ONLY THE DEFAULTS",frame(L,"Scheduled",empty(L,"repeat","Nothing of yours yet","The routines Metistry ships with are running. Add one to have an agent do something on a schedule.","New Routine"),w=W)),
  tile(L,"A CONNECTION TEST FAILS",frame(L,"Jira",pad(
      band(L,"fail","<b>Test failed.</b> jira.internal answered 401 &mdash; the key was refused.","Replace Key").replace("margin: 10px 14px 0","margin: 6px 0 0")
      + f'<div style="font-size: 11.5px; color: {L["ts"]}; padding-top: 9px;">Agents that use Jira are told it&rsquo;s unavailable; nothing retries until you change something.</div>'),w=W)))

SVC=r4("Services, Instance, Updates",
  tile(L,"DOCTOR RUNNING",frame(L,"Doctor",waitline(L,"Checking <b>9</b> of 16 &middot; eventkit&hellip;",0.56),w=W,h=170)),
  tile(L,"ALL HEALTHY",frame(L,"Doctor",pad(f'<div style="display: flex; align-items: center; gap: 8px; padding: 10px 0;"><span style="display: flex; color: {L["ok"]};">{ic(I["check"],14,2.2)}</span>'
      f'<span style="font-size: 12.5px; color: {L["tp"]}; flex-grow: 1;">Everything is running &middot; 16 checks passed</span>{btn(L,"Run Doctor","ghost",I["wrench"])}</div>'),w=W,h=170)),
  tile(L,"A LINKED INSTANCE GOES QUIET",frame(L,"Linked instances",pad(
      issuerow(L,"studio.local","Knowledge","Not seen for 3 days",f'<span style="display: flex; gap: 5px;">{btn(L,"Check Now","ghost")}{ibtn(L,"x","Remove")}</span>',kind="stale")),w=W,h=170)),
  tile(L,"AN UPDATE FAILS",frame(L,"Metistry runtime",band(L,"fail","Update to <b>2026.09.25</b> failed at migration 42. Rolled back to 2026.09.24; nothing was lost.","View Log"),w=W,h=170)))

NOTE=pan(L,"THE RULES THESE FOLLOW",
  nt(L,"A problem names <b>what failed, what still works, and the one action that fixes it</b>. A sync, provider or "
       "connection that fails three times stops retrying and raises one request (C96). A download says how much and how "
       "long; an install that can&rsquo;t fit says why before you press it. Nothing is lost silently: a failed update rolls "
       "back and says so."))

body=(heading("ROUND F · STATES","States — Settings, Scheduled and Connections",
   "What this week&rsquo;s screens say when something is down, slow, full or failing.",L)
  + row(NOTE,18) + COMPUTE + SCHED + SVC)
(PROJ/"States-Settings.dc.html").write_text(page("States Settings",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote States-Settings.dc.html ({CW}x{CH})")
