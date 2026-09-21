"""Board: Activity — the timeline, and routines on it.

Round E back-patch: regenerated onto the facet system, and the day's plan and the
standup draft gain a row type and an eighth filter chip (C43).
"""
from lib import *

CW,CH=2160,3560

def newpill(T):
    return (f'<div style="display: flex; justify-content: center; padding: 8px 0 2px;">'
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; '
            f'background: {T["accq"]}; color: {T["acc"]}; font-size: 11.5px; font-weight: 600;">'
            f'{ic(I["chevd"],12,2.4)}12 new</span></div>')

def ctl(T,label):
    return (f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 8px; '
            f'border: 1px solid {T["bc"]}; background: {T["surface"]}; font-size: 12px; color: {T["tp"]};">'
            f'{label}<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"],12,2.2)}</span></span>')

def feed(T,*,routines=True,w=None):
    rows=(feedrow(T,glyph=I["clip"],actor="imessage",subject="Ask Drey's landlord about the March renewal",
            detail="imessage · new",when="2m",kind="system")
          + feedrow(T,glyph=I["key"],actor="drey-dev",subject="access_request",
            detail="Read Areas/Finance — the lease comparables are titles-only for this credential",when="12m")
          + feedrow(T,glyph=I["review"],actor="metis",subject="claude-sonnet-5",
            detail="6.2s · 3.1&cent; · 1,840 in / 620 out",when="18m",expand="4 tools"))
    if routines:
        rows+=routinerows(T)
    rows+=(feedrow(T,glyph=I["check"],actor="you",subject="access_request",
             detail="you decided approve: scoped to packages/core",when="1h",kind="system")
           + feedrow(T,glyph=I["work"],actor="metis",subject="Migrate the settings pane to tokens",
             detail="moved -&gt; doing",when="2h")
           + feedrow(T,glyph=I["warn"],actor="github-state",subject="collector_run",
             detail="collector failed: token expired",when="3h",kind="system",tint=T["fail"],last=True))
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Activity</span>'
            f'{ctl(T,"Last 24 hours")}{ctl(T,"agent: every")}{ctl(T,"project: every")}</div>'
            f'<div style="padding: 0 16px 12px;">{chipbar(T)}</div>'
            f'{newpill(T)}'
            f'{band(T,"JUST NOW")}{rows}</div>')

def window(T,w=None):
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; '
            + (f'width: {w}px; flex-shrink: 0;' if w else 'flex-grow: 1; min-width: 0;')
            + f' background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Activity")}{feed(T)}</div></div>')

ANAT=pan(L,"ROW ANATOMY — EVERY PART NAMES A COLUMN",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 12px 8px 0;">PART</th><th style="padding: 0 12px 8px 0;">COLUMN</th>'
    f'<th style="padding: 0 0 8px 0;">WHAT DECIDES IT</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
    f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]}; font-weight: 600; white-space: nowrap;">{a}</td>'
    f'<td style="padding: 9px 12px 9px 0;">{mono(b,L["ts"],11.5)}</td>'
    f'<td style="padding: 9px 0; color: {L["ts"]};">{c}</td></tr>'
    for a,b,c in [
      ("kind glyph","kind","one per kind. It takes <b>failed</b> only when the row failed — never the row"),
      ("actor chip","actor","<b>agent</b> hue for an agent; neutral for a channel, a routine or the system (P1)"),
      ("subject","subject","Title Cased at render only for kinds the console composed — never authored text"),
      ("detail","detail","<b>left(…, 200)</b> server-side, clamped to two lines here"),
      ("time","ts","relative; absolute in the tooltip"),
      ("the row","ref","its destination — <b>inbox: proposals: work: outbound_messages: runs:</b>")])
  + '</table>'
  + nt(L,"Two lines, <b>one left edge</b>. The actor sits <i>before</i> the subject so a long subject truncates "
        "into the gap before the time column instead of pushing anything about.",12))

ROUT=pan(L,"ROUTINES — THE DAY'S PLAN AND THE STANDUP DRAFT",
  nt(L,"A routine is neither a run the assistant chose to make nor a message it sent, so it gets the eighth chip "
       "rather than being folded into one of the seven. What it produces is <b>prose Metis wrote</b>, so the row "
       "carries the spark and expands into the one prose component — not a diff, and never something that looks "
       "like a control (P1).")
  + f'<div style="background: {L["bg"]}; border: 1px solid {L["border"]}; border-radius: 12px; margin-top: 14px; '
    f'overflow: hidden;">{band(L,"THIS MORNING")}{routinerows(L,last_absent=True)}</div>'
  + nt(L,"The third row is the honest one: a routine that <b>did not run</b> is <b>absent</b>, not failed, and it "
        "says which fact stopped it. And a tick that was simply too early writes nothing and gets <b>no row at "
        "all</b> — the schedule working is not an event.",14))

EMPTY=pan(L,"THREE WAYS THIS LIST IS EMPTY, AND THEY ARE NOT THE SAME",
  row(card(panel_state(L,I["tray"],L["tt"],"Nothing in the last 24 hours.",
        "The system ran and nothing happened worth recording. A quiet day, not a fault.",action="Widen to 7 days"),L)
    + card(panel_state(L,I["clip"],L["tt"],"No captures in the last 24 hours.",
        "Six other kinds have rows in this window.",action="Clear the filter"),L)
    + card(panel_state(L,I["warn"],L["fail"],"Couldn't load activity.",
        "<b>Nothing is known</b> about this window. This is not an empty feed.",
        reason="activity_feed · connection refused",action="Try again"),L),14)
  + nt(L,"The third never renders as &ldquo;nothing happened&rdquo;, which is the lie a shared empty state tells "
        "(P5). One case the wire cannot separate: a first run is identical to a quiet day, so the empty state's "
        "action resolves it — widen to 7 days and the answer is the same or it is not.",14))

FOUND=pan(L,"WHAT THIS SCREEN NEEDS FROM THE WIRE",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==5 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 34px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("C43","<b>routine_run</b> into the kind list with its own <b>routine</b> group. Excluded today, so the plan "
           "and the standup draft are invisible here. The eighth chip is drawn against it."),
    ("C19","<b>ok</b> on the select. §3.2 says the glyph takes <b>failed</b>; <b>activity_feed</b> drops the "
           "column, so failure survives only as English inside <b>detail</b>."),
    ("—","a <b>turn_id</b> param. Grouping is client-side over the fetched window, so a turn whose tools fall "
         "past row 100 shows a count larger than expanding can display."),
    ("C18","<b>work_history</b> out of the title-case allow-list in two files — its subject is what a person typed."),
    ("C17","<b>capture</b> into §3.2's kind inventory. The query's first branch is captures."),
    ("—","a destination for a routine's output. <b>ref</b> has no prefix for a vault file, so the row above "
         "opens nothing yet."),])))

body=(heading("ROUND E · SCREEN 2, BACK-PATCHED","Activity — and what the schedule did",
   "Regenerated onto the facet system, and two rows that were missing: the day's plan and the standup draft. "
   "Every row is recent and none is urgent, which removes the one hierarchy a timeline gets for free — so what "
   "is left is time bands, one glyph column, and who did it. Colour is never spent on recency (P2).",L)
  + row(window(L),18)
  + row(ANAT+ROUT,18)
  + row(EMPTY,18)
  + row(FOUND,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden;">{feed(D)}</div></div>',18))
(PROJ/"Activity.dc.html").write_text(page("Activity",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Activity.dc.html ({CW}x{CH})")
