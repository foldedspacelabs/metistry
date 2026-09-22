"""Board: Today — the row, chip and state vocabulary.

Round D screen 5's first pass, ported 2026-09-22. `Today-Hub` is the current
Today; this board's lasting value is the vocabulary it settled — two row origins,
promotion, completing, the five absences, and one filter language.

The window mock is deliberately NOT ported. It was drawn with `hub()`, whose
five-row sidebar is two navigation revisions stale, and it is the only thing on
this board that Today-Hub does not already supersede. Removing it is how C51 gets
fixed: the contradiction was a mock nobody needed, not a nav that needed updating.
"""
from lib import *

CW,CH=2320,3060

def origin(T,label,row,why):
    return (f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{sub(label,T["tt"])}'
            f'<div style="background: {T["bg"]}; border: 1px solid {T["border"]}; border-radius: 11px; '
            f'overflow: hidden;">{row}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.55; margin-top: 9px;">{why}</div></div>')

ORIGINS=pan(L,"TWO ORIGINS, TOLD APART BY WHAT YOU CAN DO TO THEM",
  row(origin(L,"A LINE IN YOUR NOTE",
        trow(L,kind="md",title="Write the design brief for the settings pane",
             bits=["due Wed","P1","~45m","blocking <b>work #418</b>"],last=True),
        "Yours. You can tick it, and ticking it writes two bytes into your file.")
    + origin(L,"A ROW ON THE BOARD",
        trow(L,kind="work",title="Book the follow-up",
             bits=["<b>work #418</b>","drey-dev","lease 4m left"],last=True),
        "Metistry&rsquo;s. You cannot tick it here; it closes where it lives."),18,align="flex-start")
  + nt(L,"The difference is carried by <b>the affordance itself, not by a tint</b>. A row you can tick has a box; a "
        "row you cannot has none. That survives greyscale, it survives a colour-blind reader, and it cannot be "
        "misread the way two shades of one chip can.",14))

PROMO=pan(L,"PROMOTION — ONE CONTROL, ONE CONFIRMATION, ONE WAY",
  f'<div style="background: {L["surface"]}; border: 1px solid {L["bs"]}; border-radius: 12px; padding: 16px; '
  f'box-shadow: 0 8px 26px rgba(26,24,21,0.12);">'
  f'<div style="font-size: 13.5px; font-weight: 600; color: {L["tp"]};">Promote this line to work?</div>'
  f'<div style="font-size: 12px; color: {L["ts"]}; line-height: 1.55; margin-top: 5px;">It becomes a row on the '
  f'board, keeps a link back to this line, and <b>cannot be turned back into a note</b>.</div>'
  f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
  + btn(L,"Promote","affirm",I["promote"]) + btn(L,"Cancel","ghost") + '</div></div>'
  + nt(L,"One-way, and the interface never hints otherwise: there is <b>no return to note</b> verb anywhere, and a "
        "promoted line renders from then on as a work row with its origin named. The wire agrees — "
        "<b>work.external_ref</b> has a partial unique index, so a second promotion is a no-op rather than a second "
        "row. That is why this confirmation can be honest about being safe to press twice.",14)
  + nt(L,"It is the only destructive-shaped control on Today, so it gets the only confirmation. <b>Complete</b> is "
        "confirmed too, but for a different reason: Complete asks because it writes your file, not because it "
        "cannot be undone.",12))

def phase(T,label,inner,why,*,last=False):
    return (f'<div style="padding: 11px 0;' + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<div style="display: flex; align-items: center; gap: 12px;">'
            f'<span style="width: 126px; flex-shrink: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; '
            f'color: {T["tt"]};">{label}</span>{inner}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 7px; '
            f'padding-left: 138px;">{why}</div></div>')

COMPLETE=pan(L,"COMPLETING — AND THE PHASE WHERE IT IS NOT POSSIBLE YET",
  phase(L,"PHASE 1 — NOW",
    f'<span style="display: inline-flex; align-items: center; gap: 9px;">'
    f'<span style="width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; box-sizing: border-box; '
    f'border: 1px dashed {L["tt"]};"></span>'
    f'<span style="font-size: 12.5px; color: {L["ts"]};">Call the dentist</span>'
    f'<span style="font-size: 11px; color: {L["ts"]};">not interactive</span></span>',
    "<b>Read-only.</b> Nothing here writes your note, because anchors have not shipped, so there is no way to find "
    "the line again safely. The checkbox is drawn and not interactive — it is telling you the shape of the thing, "
    "not offering to change it.")
  + phase(L,"PHASE 2 — THE WRITE",
    f'<span style="display: inline-flex; align-items: center; gap: 9px;">{box(L,True)}'
    f'<span style="font-size: 12.5px; color: {L["ts"]}; text-decoration: line-through;">Call the '
    f'dentist</span>' + mono("done 2026-09-20",L["ts"],11.5) + '</span>',
    "Two byte changes and no others: <b>[ ]</b> becomes <b>[x]</b> and <b>done 2026-09-20</b> is appended. The "
    "route takes a <b>task_key</b>, not a patch — it cannot do anything else.")
  + phase(L,"UNDO",
    f'<span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 600; '
    f'color: {L["acc"]};">{ic(I["undo"],13,2)}Undo</span>',
    "A second mechanical write, not a revert: it flips the box back and removes the stamp. There is no history to "
    "roll back to and the design must not pretend otherwise.")
  + phase(L,"SOMEONE ELSE WROTE",
    f'<span style="display: inline-flex; align-items: center; gap: 7px; background: {L["staleq"]}; '
    f'border-radius: 8px; padding: 4px 10px; font-size: 12px; color: {L["stale"]};">'
    f'<span style="display: flex;">{ic(I["clock"],12,2)}</span>409 &mdash; nothing was sent</span>',
    "The route compares the line&rsquo;s text against what the client was shown and answers <b>409</b> rather than "
    "writing over an edit you made in Obsidian thirty seconds ago. The same envelope the request card already uses "
    "— <b>one</b> stale pattern in the product, not two.",last=True)
  + nt(L,"Phase 1 ships read-only and that is not a placeholder — it is the honest state of a system with no "
        "anchors: it cannot find the line again, so it must not try. Drawing the interactive version now is how the "
        "read-only one stays a deliberate stage rather than something that looks unfinished.",14))

STATES=pan(L,"FOUR ABSENCES, AND ONE EMPTY — FIVE DIFFERENT SENTENCES",
  row(card(panel_state(L,I["tray"],L["tt"],"Nothing scheduled for today.",
        "That means nothing is due or planned &mdash; <b>not that you are finished</b>.",
        action="Open today&rsquo;s note"),L)
    + card(panel_state(L,I["cal"],L["abs"],"No calendar connected.",
        "The list below is complete; only the schedule beside it is missing.",action="Connect a calendar"),L)
    + card(panel_state(L,I["person"],L["abs"],"Metistry doesn&rsquo;t know which days you work.",
        "So the plan and the standup draft wrote nothing rather than guessing.",
        reason="Me/profile.md &middot; no working_days",action="Set your working days"),L)
    + card(panel_state(L,I["note"],L["abs"],"There&rsquo;s no plan template, so no plan was written.",
        "A configuration fact, not a failure.",reason="Templates/Plan.md",
        action="Create it from the default"),L),14)
  + nt(L,"Each names what is missing, what therefore did not happen, and the one thing that fixes it. <b>None says "
        "&ldquo;something went wrong&rdquo;</b>, because in all four cases nothing did — the system declined to "
        "guess, which is the behaviour §6.4 asks for.",14)
  + nt(L,"The first is <b>empty</b>, not absent, and it is the one that needs the extra sentence: an empty Today is "
        "ambiguous in a way the others are not, because it looks identical to a finished day.",12))

FILTER=pan(L,"ONE FILTER LANGUAGE — THE CHIPS EMIT THE TEMPLATE, VISIBLY",
  f'<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">'
  + seg(L) + "".join(chip(L,c,L["acc"],L["accq"]) for c in ["Due ≤ 7d","P2 and up","Overdue"])
  + "".join(chip(L,c,L["ts"],L["absq"]) for c in ["Mine","Blocked"]) + '</div>'
  + f'<div style="background: {L["sunken"]}; border-radius: 9px; padding: 11px 13px; margin-top: 12px;">'
    f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["tt"]}; '
    f'margin-bottom: 6px;">WHAT THE CHIPS COMPILED</div>'
  + mono("due &lt;= +7d and priority &gt;= p2 or overdue &nbsp;&nbsp;order priority, due",L["tp"],12.5) + '</div>'
  + nt(L,"§10 calls this &ldquo;the single highest-leverage decision&rdquo;, and it is invisible unless the design "
        "makes it visible. So the compiled <b>where:</b> is shown, selectable and copyable, directly under the "
        "chips that built it. A view you assemble by clicking can be pasted into <b>Templates/Plan.md</b>; a "
        "<b>where:</b> written in a template loads back into these chips. Saved views store the string.",14)
  + nt(L,"That is also the honest way to handle a filter the chips cannot express. The grammar has seven fields and "
        "seven flags; the chips cover the common pairs. Anything else is typed into this same box, in the same "
        "language — so <b>the advanced case is not a second interface</b>, it is the line the beginner case was "
        "writing all along.",12)
  + nt(L,"<b>All</b> is a mode, not a sixth child. The segmented control sits where the section title would put it, "
        "and the sidebar never gains a row. Today and All share the list, the row and every chip on it — only the "
        "question changes.",12))

FOUND=pan(L,"WHAT THIS ROUND FOUND, AND WHAT THIS BOARD IS NOW",
  nt(L,"<b>Today inverts P1, and the design system does not say so.</b> Everywhere else the text on screen was "
       "written by an agent and P1 says it must never look like a control. Here the task line is the owner&rsquo;s "
       "own writing and it <i>must</i> look actionable, because it is. What P1 governs on this screen is everything "
       "<i>around</i> the line — the reason, the ordering, the capacity number — all of which are Metistry&rsquo;s "
       "opinion about the day.")
  + nt(L,"<b>The window mock is gone from this board</b> (2026-09-22). It was drawn with the five-row sidebar from "
        "round D, so the canvas showed two different navigations at once — a contradiction under P6, logged as C51. "
        "Today-Hub is the current Today and already carries the window; what was only ever here is the vocabulary "
        "above. Fixing C51 meant deleting a mock, not updating one.",12))

body=(heading("ROUND D · SCREEN 5, PORTED","Today — the row, chip and state vocabulary",
   "The one screen where <b>you</b> are the actor. Everywhere else you read what agents did or answer what they "
   "asked; here the list is your own handwriting, pulled out of your own notes. <b>Today-Hub</b> is the current "
   "Today — this board is the vocabulary that pass settled, and it is kept because the decisions on it are still "
   "the ones in force.",L)
  + row(f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-grow: 1;">'
        + f'<div>{sub("THE LIST, AND THE STANDUP BLOCK",L["tt"])}{twindow(L)}</div>'
        + f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px;">'
        + ORIGINS + PROMO + '</div></div>',18)
  + row(COMPLETE+FILTER,18)
  + row(STATES,18)
  + row(FOUND,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"]) + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + twindow(D) + f'<div style="flex-grow: 1; min-width: 0;">{standup(D)}</div></div></div>',18))
(PROJ/"Today.dc.html").write_text(page("Today",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Today.dc.html ({CW}x{CH})")
