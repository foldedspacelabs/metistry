"""Board: card detail — one popover for both kinds of task.

Screen 14, new 2026-09-22. Owner's rulings: every card click opens this popover,
with the thread as a section inside it; and work rows gain a short description.
A markdown task and a work row share the layout and differ in their verbs.
"""
from lib import *

CW,CH=2200,1880

def stage(T,kind,label):
    t=("Reconcile vendor invoices against the March renewal" if kind=="work"
       else "Send Kessler the revised volume numbers")
    return (f'<div>{sub(label,L["tt"])}'
            f'<div style="display: flex; gap: 14px; align-items: flex-start;">'
            f'{anchorcard(T,kind=kind,title=t)}{detailpop(T,kind=kind)}</div></div>')

BOTH=pan(L,"ONE POPOVER, TWO KINDS OF TASK — SAME LAYOUT, DIFFERENT VERBS",
  row(stage(L,"work","A WORK ROW — AN AGENT HOLDS IT") + stage(L,"md","A MARKDOWN TASK — A LINE IN YOUR NOTE"),
      32,align="flex-start")
  + nt(L,"<b>Title, then the six facets in their fixed order</b>, then what that kind of task has. The lead mark "
        "says which it is before you read anything: the board glyph for a work row, a checkbox for your own line "
        "&mdash; the same distinction Today already draws.",14)
  + nt(L,"<b>A work row</b> shows its description (new, C85), who holds it and for how long, what blocks it, the "
        "thread, and its history &mdash; all but the description are on the row today. <b>A markdown task</b> "
        "shows the lines around it in your note, which is its description.",12)
  + nt(L,"<b>Every click opens this</b> (C84). The thread is a section with <b>Open room</b>, so the same gesture "
        "always lands in the same place.",12))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 18px;">{i+1}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,v in enumerate([
    "<b>A description on work rows</b> (C85) &mdash; short text, set at creation by whoever creates it and "
    "editable by the owner.",
    "<b>Blocked by</b> (C37) &mdash; <b>depends_on</b> is already on the row; the board query needs to return "
    "it resolved to titles and states.",
    "<b>The note context for a markdown task</b> &mdash; the heading above the line and its neighbours, read "
    "through the vault query rather than the file.",
    "<b>history</b>, the lease and the review artifact are all on the row already."])))

body=(heading("ROUND E · SCREEN 14, NEW","Card detail — one popover for both kinds of task",
   "Every card opens the same popover. Title and facets first; then, for a work row, who holds it, what blocks it, "
   "its thread and its history; for your own task, the note it lives in.",L)
  + row(BOTH,18)
  + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 32px;">'
        + f'<div style="display: flex; gap: 14px; align-items: flex-start;">{anchorcard(D)}{detailpop(D)}</div>'
        + f'{detailpop(D,kind="md")}</div></div>',18))
(PROJ/"CardDetail.dc.html").write_text(page("CardDetail",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote CardDetail.dc.html ({CW}x{CH})")
