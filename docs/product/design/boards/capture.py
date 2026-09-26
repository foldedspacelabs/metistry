"""Board: Capture — the "+" and what it opens (screen 4, round D, ported 2026-09-25).

Assembled from the round-D composer components in lib.py. The Mac frame is
redrawn with today's toolbar and sidebar (no toolbar bell, C110; Today first).
"""
from lib import *

CW,CH=2280,2230

def macframe2(T,w=380):
    nav="".join(f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 7px; '
                f'background: {T["accq"] if s else "transparent"};"><span style="display: flex; color: {T["acc"] if s else T["ts"]};">{ic(g,14,1.9)}</span>'
                f'<span style="font-size: 12px; font-weight: {600 if s else 500}; color: {T["tp"]};">{n}</span></div>'
                for n,g,s in [("Today",I["cal"],True),("Chat",I["chat"],False),("Activity",I["activity"],False),("Work",I["work"],False)])
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 10px; overflow: hidden; background: {T["bg"]}; flex-shrink: 0;">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex;">{mark(T,size=13)}</span><span style="font-size: 12px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Metistry</span>'
            f'<span style="display: inline-flex; border-radius: 6px; box-shadow: 0 0 0 3px {rgba(T["acc"],0.25)};">{plusbtn(T,17)}</span>'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["gauge"],16,1.9)}</span></div>'
            f'<div style="display: flex; height: 190px;">'
            f'<div style="width: 150px; background: {T["sunken"]}; border-right: 1px solid {T["border"]}; padding: 9px 7px; display: flex; flex-direction: column;">{nav}'
            f'<span style="flex-grow: 1;"></span>'
            f'<div style="display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid {T["border"]};">'
            f'{plusbtn(T,16)}<span style="font-size: 11.5px; font-weight: 500; color: {T["ts"]};">Capture</span></div></div>'
            f'<div style="flex-grow: 1;"></div></div></div>')

def srow(*cases): return row("".join(cases),28,align="flex-start")

PLACE=pan(L,"ONE AFFORDANCE, ONE POSITION PER PLATFORM",
  f'<div style="display: flex; gap: 28px; align-items: flex-start;">{macframe2(L)}{phoneframe(L)}'
  + '<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>macOS:</b> the toolbar <b>+</b> and the sidebar footer <b>+</b> &mdash; the same control twice, in the two places "
         "a pointer already rests &mdash; plus <b>⌘N</b> and, when turned on, the shortcuts in any app (C120, C127). "
         "<b>iOS:</b> one floating <b>+</b> bottom-right, over the content, clear of the tab bar and the home indicator.")
  + nt(L,"The share extension, the drop target, the Shortcut and the menu-bar item are <b>additional doors to this "
        "control</b>, not alternatives to it. There is no Capture tab and no Capture screen: a place you navigate to "
        "contradicts a five-second promise.",12)
  + '</div></div>')

NEVER=pan(L,"NEVER BLOCKS, NEVER DROPS — AND NEVER CLAIMS",
  nt(L,"<b>The popover does not wait for 201.</b> Press <b>⌘↩</b> and the field clears, the receipt line says "
       "<i>capturing… you can close this</i>, and closing the popover does not cancel anything.")
  + nt(L,"<b>But clearing the field is not a claim that it worked.</b> State is reported, never inferred (P5). The text "
        "moves into the pending receipt and lives there until the server answers. On failure it comes <b>back into the "
        "field</b>, with the reason and Try Again. Nothing is ever typed twice.",12)
  + nt(L,"<b>Offline is a state, not an error.</b> The queued line is degraded and says so. What makes that safe is the "
        "idempotency key the composer mints and keeps across every retry.",12)
  + nt(L,"<b>Capture never opens a request, never asks a question, never waits on the model.</b> It writes to the inbox "
        "and returns; what the classifier later decides shows up on Activity as its own row.",12))

FOUND=pan(L,"WHAT THIS ROUND FOUND",
  nt(L,"<b>1 · The spec asked for a receipt the endpoint cannot produce.</b> POST /capture returns 201 {id, path, sha256} "
       "and nothing else; classification happens later in the drain. Drawn as <i>captured → inbox #418 · the vault path</i>.")
  + nt(L,"<b>2 · What makes &ldquo;never drops&rdquo; safe was not in the design system.</b> Idempotency-Key, replayed with "
        "the original response. The composer mints a key on Capture and keeps it across retries.",12)
  + nt(L,"<b>3 · The app&rsquo;s own captures looked like any HTTP caller</b> (<i>source: http</i>). Add a source value the apps send.",12)
  + nt(L,"<b>4 · inbox.status has five values and two are ever seen.</b> The rest belong to a triage surface that did not yet exist.",12)
  + nt(L,"<b>5 · One receipt line and a fast hand.</b> It shows the oldest unresolved capture with a count &mdash; "
        "<i>capturing… (2)</i> &mdash; and a failure always wins the line.",12))

body=(heading("ROUND D · SCREEN 4","Capture — the &ldquo;+&rdquo; and what it opens",
   "The fast path. One affordance in one position per platform, seven states, and a promise that it never blocks and "
   "never drops.",L)
  + srow(statecase(L,"empty","Empty","The placeholder is <i>note…</i>, lowercase, because it is a prompt and not a label. No title field: a capture is a thought, not a document."),
         statecase(L,"typing","Typing","Autogrowing from three lines. Nothing validates, nothing suggests, nothing completes &mdash; the model is not in this loop."),
         statecase(L,"attaching","Attaching","A named chip with its size and a remove. What you attached has to be legible before you send it."))
  + row(PLACE,18)
  + srow(statecase(L,"sending","Sending","The field is already clear and the receipt is pending. You may close the popover here."),
         statecase(L,"captured","Captured","The id and the vault path, because those are what came back."),
         statecase(L,"queued","Queued offline","Degraded, and says so. It holds an idempotency key, which is why this is safe."))
  + row(NEVER,18)
  + srow(statecase(L,"failed","Failed","The reason in the server&rsquo;s words, the text back in the field, the attachment still attached, and Try Again reusing the same key."),
         f'<div><div style="font-size: 12.5px; font-weight: 600; color: {L["tp"]};">iOS &mdash; a medium-detent sheet</div>'
         f'<div style="font-size: 12px; color: {L["ts"]}; line-height: 1.5; margin: 3px 0 10px; max-width: 320px;">Rising from the floating +. The keyboard takes the lower half, so the field sits above it.</div>{capsheet(L)}</div>')
  + row(FOUND,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">{sub("DARK",D["tt"])}'
        f'<div style="display: flex; gap: 20px; flex-wrap: wrap;">' + "".join(composer(D,state=s,w=380) for s in ("typing","captured","queued","failed")) + '</div></div>',18))
(PROJ/"Capture.dc.html").write_text(page("Capture",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Capture.dc.html ({CW}x{CH})")
