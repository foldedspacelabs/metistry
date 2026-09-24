"""Board: Work ▸ Board — cards, columns, drags."""
from lib import *

# =========================== THE BOARD ==================================
COLS=[("Backlog","backlog",12,0,"age"),("Addressed To","assigned",5,1,"owner"),
      ("In Progress","in_progress",4,1,"lease"),("Blocked","needs_you",2,2,"why"),
      ("Done","done",31,0,"when"),("Reported","reported",9,0,"report")]

def kindglyph(T,kind):
    g = I["review"] if kind=="review" else I["board"]
    return f'<span style="display: flex; flex-shrink: 0; color: {T["tt"]};">{ic(g,13,1.9)}</span>'

def bcard(T,*,title,kind="task",shows,project=None,owner=None,lease=None,why=None,
          when=None,report=None,age=None,esc=None,thread=False,fromnote=False,artifact=None,last=False):
    # one card, and each column shows only the facet that column is about
    facet=""
    if shows=="age":   facet=gl(T,I["clock"],f"{age} in backlog")
    elif shows=="owner": facet=ent(T,"agent",owner,I["agents"])
    elif shows=="lease": facet=gl(T,I["clock"],lease,T["deg"] if esc else None)
    elif shows=="why":  facet=st(T,why)
    elif shows=="when": facet=gl(T,I["check"],when)
    elif shows=="report": facet=ent(T,"note",report,I["note"])
    marks=""
    if thread:   marks+=f'<span style="display: flex; color: {T["tt"]};">{ic(I["chat"],12,1.9)}</span>'
    if fromnote: marks+=f'<span style="display: flex; color: {T["en"]};">{ic(I["note"],12,1.9)}</span>'
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 9px; background: {T["surface"]}; '
            f'padding: 9px 10px; margin-bottom: 7px;">'
            f'<div style="display: flex; gap: 7px; align-items: flex-start;">{kindglyph(T,kind)}'
            f'<span style="font-size: 12.5px; line-height: 1.35; color: {T["tp"]}; flex-grow: 1; '
            f'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">{title}</span>'
            + (f'<span style="display: flex; gap: 4px; flex-shrink: 0; margin-top: 1px;">{marks}</span>' if marks else "")
            + '</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 7px;">'
            + facet + (st(T,esc) if esc else "")
            + (ent(T,"project",project,I["board"]) if project else "") + '</div></div>')

def compactrow(T,title,meta,report=None,last=False):
    return (f'<div style="padding: 7px 2px;' + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<div style="display: flex; align-items: flex-start; gap: 6px;">'
            + (f'<span style="display: flex; flex-shrink: 0; color: {T["en"]}; margin-top: 1px;">'
               f'{ic(I["note"],11,1.9)}</span>' if report else "")
            + f'<span style="font-size: 12px; color: {T["ts"]}; line-height: 1.35; white-space: nowrap; '
              f'overflow: hidden; text-overflow: ellipsis;">{title}</span></div>'
            f'<div style="font-size: 10.5px; color: {T["tt"]}; margin-top: 2px;">{meta}</div></div>')

def bcol(T,name,count,esc,body,*,narrow=False,showing=None):
    head=(f'<div style="display: flex; align-items: center; gap: 7px; padding: 0 2px 9px;">'
          f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: {T["tp"]};">{name}</span>'
          f'<span style="font-size: 11px; color: {T["ts"]};">{count}</span>'
          + (f'<span style="display: inline-flex; align-items: center; padding: 0 6px; border-radius: 999px; '
             f'background: {T["degq"]}; color: {T["deg"]}; font-size: 10px; font-weight: 700;">{esc}</span>'
             if esc else "")
          + '<span style="flex-grow: 1;"></span>'
          + (f'<span style="font-size: 10px; color: {T["tt"]};">showing {showing}</span>' if showing else "")
          + '</div>')
    return (f'<div style="' + (f'width: 168px; flex-shrink: 0;' if narrow else 'flex-grow: 1; flex-basis: 0; min-width: 0;')
            + f' background: {T["sunken"]}; border-radius: 10px; padding: 11px 9px;">{head}{body}</div>')

def board(T):
    backlog=(bcard(T,title="Migrate the settings pane to tokens",shows="age",age="2d",project="Settings Pane")
             + bcard(T,title="Audit the egress allowlist",shows="age",age="4d")
             + bcard(T,title="Write the lease comparables summary",shows="age",age="6h",
                     fromnote=True,project="Lease Renewal"))
    assigned=(bcard(T,title="Review the migration plan",kind="review",shows="owner",owner="drey-dev",
                    project="Settings Pane",thread=True)
              + bcard(T,title="Reconcile the September invoices",shows="owner",owner="taskuary",
                      esc="Overdue"))
    inprog=(bcard(T,title="Book the follow-up",shows="lease",lease="4m left",thread=True)
            + bcard(T,title="Rebuild the cache report",shows="lease",lease="lease lapsed 12m ago",
                    esc="Lease Lapsed"))
    needs=(bcard(T,title="Publish the tokens package",shows="why",why="Waiting on #417 to merge",thread=True)
           + bcard(T,title="Sign off the vendor SOW",shows="why",why="Waiting on You"))
    done="".join(compactrow(T,t,m,report=r) for t,m,r in
        [("Cache report — 4 findings","claude-usage · 1h",True),
         ("Fix the reconciler lock path","closed 2h ago",False),
         ("Shadow agreement run","drey-dev · yesterday",True),
         ("Bump the eventkit helper","closed 5h ago",False),
         ("Retire the old feed icons","yesterday",False)])
    return (f'<div style="display: flex; gap: 10px; align-items: flex-start;">'
            + bcol(T,"Backlog",12,0,backlog,showing="3 of 12")
            + bcol(T,"Assigned",5,1,assigned)
            + bcol(T,"In Progress",4,1,inprog)
            + bcol(T,"Blocked",2,2,needs)
            + bcol(T,"Done",40,0,done,narrow=True,showing="5 of 40")
            + '</div>')

def bwindow(T,w=1460):
    chips="".join(f'<span style="padding: 3px 10px; border-radius: 999px; font-size: 12px; '
                  f'font-weight: {600 if s else 500}; background: {T["accq"] if s else "transparent"}; '
                  f'border: 1px solid {T["acc"] if s else T["bc"]}; color: {T["acc"] if s else T["ts"]};">{n}</span>'
        for n,s in [("All Projects",True),("Settings Pane",False),("Lease Renewal",False),("Ops",False),("Has Thread",False)])
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{toolbar(T)}<div style="display: flex;">{sidebar8(T,"Work")}'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="padding: 14px 16px 12px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 11px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Board</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">polling · 10s</span></div>'
            f'<div style="display: flex; gap: 7px; flex-wrap: wrap;">{chips}</div></div>'
            f'<div style="padding: 14px;">{board(T)}</div></div></div></div>')

DENSITY=pan(L,"FIVE COLUMNS, AND FOUR OF THEM ARE THE BOARD",
  nt(L,"<b>Reported is gone, and it should never have been a column.</b> <code>board.md</code> says so itself: "
       "Done-vs-Reported “is not on the row — it is reconstructed” from a join between <code>work</code> and "
       "<code>runs.meta.work_id</code>. It was never a <i>status</i>; it was the fact that something came back. "
       "That is a property of the card, so it is a chip on the card: a note glyph and what the report said.")
  + nt(L,"The query need not change at all — <code>last_report_at</code> keeps arriving and the panel simply stops "
         "using it to choose a column. Whether <code>\'reported\'</code> leaves the <code>CASE</code> is the "
         "build\'s call; the design only needs it to stop being a place.",12)
  + nt(L,"<b>Four live columns and one finished one.</b> Done is fixed at 168px with compact rows, and the four "
         "live columns share everything else — which is the density fix, and it gets easier with five columns than "
         "it was with six. At a narrow window Done collapses to a strip with a count.",12)
  + nt(L,"<b>Assigned, not Addressed To.</b> That reverts the 2026-09-17 label ruling, and the reason to take it is "
         "that the wire value has always been <code>assigned</code> — every drop and every <code>runs</code> row "
         "carries it. A label that disagrees with its own value is a bug waiting for someone to “fix” the wrong "
         "side of it. This closes C38 rather than documenting it.",12))

WHATCOL=pan(L,"EACH COLUMN SHOWS THE FACET THAT COLUMN IS ABOUT",
  '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
  + f'<tr>' + "".join(f'<th style="text-align: left; padding: 0 14px 7px 0; font-size: 10.5px; '
                      f'letter-spacing: 0.07em; color: {L["tt"]};">{h}</th>'
      for h in ("COLUMN","THE QUESTION IT ANSWERS","WHAT THE CARD SHOWS")) + '</tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]}; vertical-align: top;">'
            f'<td style="padding: 9px 14px 9px 0; color: {L["tp"]}; white-space: nowrap;">{c}</td>'
            f'<td style="padding: 9px 14px 9px 0; color: {L["ts"]}; line-height: 1.5;">{q}</td>'
            f'<td style="padding: 9px 0;">{v}</td></tr>'
    for c,q,v in [
      ("Backlog","how long has nobody taken this?",gl(L,I["clock"],"2d in backlog")),
      ("Assigned","whose name is on it?",ent(L,"agent","drey-dev",I["agents"])),
      ("In Progress","how much lease is left?",gl(L,I["clock"],"4m left")),
      ("Blocked","what would unblock it?",st(L,"Waiting on #417 to merge")),
      ("Done","when did it close — and did anything come back?",
       gl(L,I["check"],"closed 2h ago") + " " + ent(L,"note","4 findings",I["note"]))])
  + '</table>'
  + nt(L,"<b>The way out of a crowded card is not a smaller card — it is fewer facets.</b> A card in Backlog has an "
         "owner field that is null and a lease that does not exist; a card in Done has an age nobody cares about. "
         "So each column renders <b>one</b> column-specific facet plus whatever is exceptional, and the card gets "
         "quiet without getting small.",16)
  + nt(L,"Everything else is a <b>mark</b> rather than a chip: a speech bubble if the card has a room "
         "(<code>has_thread</code>, already on the wire so the board never asks a second endpoint), a note glyph in "
         "<b>entity-note</b> if it was promoted from your vault (<code>external_ref</code>). Two glyphs, no words, "
         "and both open the card&rsquo;s detail, where the thread is a section (C84).",12))

DRAGS=pan(L,"THE BOARD OFFERS NO DROP THE SERVICE WOULD REFUSE",
  f'<div style="display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap;">'
  f'<div style="width: 330px; flex-shrink: 0;">'
  f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 11px 9px;">'
  f'<div style="font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: {L["tp"]}; '
  f'padding: 0 2px 9px;">IN PROGRESS</div>'
  + bcard(L,title="Rebuild the cache report",shows="lease",lease="lease lapsed 12m ago",esc="Lease Lapsed")
  + f'<div style="border: 1.5px dashed {L["acc"]}; border-radius: 9px; padding: 14px 10px; text-align: center; '
    f'background: {L["accq"]};">'
    f'<span style="font-size: 11.5px; font-weight: 600; color: {L["acc"]};">Release to Assigned</span></div>'
  + '</div></div>'
  f'<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>A drop target is drawn only where a statement in <code>packages/tasks</code> would succeed</b>, and "
         "when the panel and the service disagree the <b>statement wins</b>: the card snaps back carrying the "
         "server's own sentence, never one the interface invented. That is invariant 8 made visible rather than "
         "promised.")
  + nt(L,"<b>Each drop is exactly one route.</b> Anything needing two calls is not a drop — which is why there is no "
         "“assign and claim” gesture. A closed card gets no grab cursor at all, because <code>update()</code> "
         "refuses a closed row — and with Reported folded into Done there is no column left that only a "
         "report could fill.",12)
  + nt(L,"<b>Two absences worth drawing attention to.</b> Nobody drags a card onto another agent’s lease — In "
         "Progress is entered by claiming, and a claim is always your own. And assignment has no agent surface at "
         "all: <code>owner</code> exists on <code>PATCH</code> and nowhere else, so a human may address a card to "
         "any crew and an agent cannot address one. Enforced by absence, not by a check.",12)
  + nt(L,"<b>Keyboard is the same routes.</b> Focus a card, press <code>m</code>, choose a column — same targets, "
         "same refusals. A board that needs a mouse is a board you cannot use half the time.",12)
  + '</div></div>')

FAULTSB=pan(L,"WHAT THIS SCREEN FOUND",
  f'<div style="display: flex; flex-direction: column; gap: 13px; font-size: 12.5px; color: {L["ts"]}; line-height: 1.6;">'
  f'<div><b style="color: {L["tp"]};">1 · Nothing on this board is red, and the ops doc says it should be.</b> '
  f'<code>board.md</code> calls for “the red number” beside a count and “a red chip says why”. But a lapsed lease, '
  f'an overdue card and a blocked row are all <b>degraded</b> in the ratified vocabulary — attention, not failure. '
  f'<b>failed</b> means <i>this broke</i>, and if escalation is red then a busy board is a red board and red stops '
  f'meaning anything. Drawn in <b>degraded</b> throughout; the doc should say degraded.</div>'
  f'<div><b style="color: {L["tp"]};">2 · <code>escalated</code> is a boolean, and the card has to say why.</b> '
  f'<code>board.md</code> is explicit that the panel re-derives the label — <i>lease lapsed</i> / <i>blocked</i> / '
  f'<i>overdue</i> — from <code>lease_expires_at</code>, <code>status</code> and <code>due</code>, while the '
  f'<b>decision</b> stays in the query. That is the right split and it is worth restating, because the obvious '
  f'shortcut is a second boolean per reason, and then two places decide what escalated means.</div>'
  f'<div><b style="color: {L["tp"]};">3 · <code>blocked_by_task</code> is not in <code>board.yaml</code>.</b> '
  f'<code>daily-flow-spec.md</code> §3 says the board gains <code>blocked_by_task</code> and '
  f'<code>blocked_by_task_open</code> so a card can read “waiting on you: Call the dentist”. The columns are not '
  f'there. Today already draws that string on its work rows, so <b>two screens are now waiting on the same two '
  f'columns</b>.</div>'
  f'<div><b style="color: {L["tp"]};">4 · The label and the wire value now agree — and Reported is not a '
  f'column.</b> “Addressed To” is back to <b>Assigned</b>, matching the value every drop and every <code>runs</code> '
  f'row already carries; C38 closes rather than being documented. And <b>Reported folds into Done</b>, which '
  f'<code>board.md</code> half-argues for already: Done-vs-Reported “is not on the row — it is reconstructed”. It '
  f'was never a status, so it is a chip. Both are changes to <code>board.md</code>, logged as <b>C39</b>.</div>'
  f'<div><b style="color: {L["tp"]};">5 · A review card names an artifact and the board cannot show it.</b> '
  f'<code>artifact</code> comes back on every row (<code>meta.bundle.artifact</code>, a handle, never a payload) and '
  f'there is nowhere sensible to put it on a card this size. It belongs in the detail popover, which is where it is '
  f'drawn — noted so it is not later mistaken for an omission.</div>'
  f'</div>')

DARKB=(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px;">' + sub("DARK",D["tt"])
  + bwindow(D,1460) + '</div>')

CW,CH=2560,2760
body=(heading("ROUND D · SCREEN 6","Work ▸ Board",
   "The hardest layout in the product, and the way through it is noticing that the six columns are not peers: four "
   "are live and two are finished. Finished work gets a count and a way in, not a column of cards. And each live "
   "column renders <b>one</b> facet — the one that column exists to answer — so a card gets quiet without getting "
   "small.",L)
  + row(bwindow(L),20)
  + row(f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0;">{WHATCOL}</div>'
        f'<div style="display: flex; flex-direction: column; gap: 20px; flex-grow: 1; flex-basis: 0; min-width: 0;">'
        f'{DENSITY}{DRAGS}</div>',20)
  + row(FAULTSB,20)
  + row(DARKB,20))
(PROJ/"Board.dc.html").write_text(page("Board",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print("wrote Board.dc.html")
