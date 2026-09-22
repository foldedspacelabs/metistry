"""Board: Chat — the transcript, waiting, and the picker.

Round D screen 1, ported in round E. Both of the owner's review rulings are
built in: only the user's turns carry a fill, and the column is capped and
centred so resizing moves it without ever rewrapping a line.
"""
from lib import *

CW,CH=2000,3280

def window(T):
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; flex-grow: 1; '
            f'min-width: 0; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Chat")}{transcript(T)}</div></div>')

WAIT=pan(L,"WAITING FOR A REPLY — THE MOTION FALLS AS THE FACTS ARRIVE",
  waitcase(L,"0–2s",waitdots(L),
    "The turn appears at once, attributed and stamped, with <b>Stop</b> from the first frame. Three 5px "
    "<b>agent</b> dots on a 1.45s opacity loop — the <b>only</b> looping animation in the product. They exist "
    "for the seconds when there is genuinely nothing to report.")
  + waitcase(L,"TOOLS RUNNING",toolstrip(L),
    "The dots are gone the instant a tool name exists to print. The running name, the count and the elapsed "
    "second all move, and every frame of it is a fact.")
  + waitcase(L,"PROSE STREAMING",toolstrip(L,collapsed=True),
    "The strip collapses to one line and the text itself is the motion. The caret at the end of the sentence is "
    "the only other thing moving.")
  + waitcase(L,"60s",wait60(L),
    "We report what we know — nothing has come back in 62 seconds — and never that it is stuck, hung or dead. "
    "<b>degraded</b>, not <b>failed</b>: a turn moves to failed only when the transport says so.")
  + waitcase(L,"REDUCED MOTION",waitdots(L,reduced=True),
    "Under <b>prefers-reduced-motion</b> the dots hold at a flat 0.5 and the caret stops blinking. The elapsed "
    "count carries the liveness alone — a number is content, not motion — which is why the count is load-bearing "
    "and not decoration.",last=True))

RULING=pan(L,"A RULING YOU OWE ME — ux-direction.md SAYS NO SPINNER",
  f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 13px 15px;">'
  f'<div style="font-family: {SERIF}; font-size: 13.5px; color: {L["tp"]}; line-height: 1.6;">'
  f'&ldquo;calm — the working state is a <b>word</b>, not a spinner, and nothing auto-scrolls, parallaxes, spins '
  f'or pulses.&rdquo;</div>'
  f'<div style="font-size: 11.5px; color: {L["ts"]}; margin-top: 7px;">ux-direction.md</div></div>'
  + nt(L,"That rule is right about decoration and wrong about liveness. A word alone cannot carry the gap between "
        "send and the first token, because <b>a word that never changes looks exactly like a word that is "
        "stuck</b> — and a reader has no other way to tell working from broken.",14)
  + f'<div style="background: {L["accq"]}; border-radius: 10px; padding: 13px 15px; margin-top: 12px;">'
    f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["acc"]}; '
    f'margin-bottom: 7px;">THE NARROWEST AMENDMENT THAT KEEPS ITS INTENT</div>'
    f'<div style="font-size: 13px; color: {L["tp"]}; line-height: 1.6;">Motion is allowed only where it carries '
    f'information the reader cannot otherwise get, and it stops the moment that information is available in '
    f'words.</div></div>'
  + nt(L,"Everything above falls out of that one sentence: the dots exist only while there is nothing to say, and "
        "they are replaced — not supplemented — the moment a tool name can be printed. (C16)",12))

OUTSIDE=pan(L,"THE OTHER TWO PLACES THE STATE HAS TO BE LEGIBLE",
  row(f'<div style="flex-grow: 1; flex-basis: 0;">{sub("COMPOSER — SEND BECOMES STOP",L["tt"])}'
      + chatcomposer(L,inflight=True,w=380)
      + nt(L,"The field stays live: you can write the next message while it works. This also answers <i>can I "
            "cancel</i>, which is the second thing you want to know when something is slow.",12) + '</div>'
    + f'<div style="flex-grow: 1; flex-basis: 0;">{sub("SIDEBAR — PRESENCE, NOT A BADGE",L["tt"])}'
      + f'<div style="display: inline-flex; border: 1px solid {L["border"]}; border-radius: 10px; overflow: hidden;">'
      + sidebar8(L,"Chat") + '</div>'
      + nt(L,"One <b>agent</b> dot on Chat while a turn runs, so the state survives walking away from it. It "
            "carries no count — Needs You keeps the only badge in the product (P2).",12) + '</div>',18,align="flex-start"))

FILL=pan(L,"THE ASSISTANT'S TURN — NO FILL (DRAWN) AGAINST A QUOTE RULE (ALTERNATIVE)",
  row(f'<div style="flex-grow: 1; flex-basis: 0;">{sub("DRAWN — THE ATTRIBUTION CARRIES IT",L["tt"])}'
      + replyturn(L,"The lease comparables came back 4% under his number, which is the thing you did not have on "
                    "the 6th.",w=420) + '</div>'
    + f'<div style="flex-grow: 1; flex-basis: 0;">{sub("ALTERNATIVE — A 2PX AGENT LEFT RULE",L["tt"])}'
      + replyturn(L,"The lease comparables came back 4% under his number, which is the thing you did not have on "
                    "the 6th.",quotebar=True,w=420) + '</div>',18,align="flex-start")
  + nt(L,"P1 asks for agent text in a container that is <b>visibly quoted</b> — the tint on the attribution and an "
        "<b>agent-quiet</b> wash behind the body. Dropping the wash keeps the first half and loses the second, so "
        "this is <b>a deviation to be ruled on, not a drawing choice</b>.",14)
  + nt(L,"The case for the drawn version: P1&rsquo;s wash is kept for agent data appearing <i>outside</i> a "
        "transcript — a feed row, a card title, tool output, an artifact comment — which is where being mistaken "
        "for the interface actually costs something. Inside a transcript everything is a turn and the attribution "
        "is unambiguous. It also resolves the nesting problem: with the reply body unfilled, tool output goes back "
        "onto <b>agent-quiet</b> exactly as §3.4 says, and the <b>sunken</b> workaround is no longer needed.",12))

PICKER=pan(L,"MODEL &amp; EFFORT — THE ROUTER DECIDES, AND THE UI SAYS SO FIRST",
  row(modelmenu(L)
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>Selection is never carried by fill alone.</b> The selected row takes an <b>accent</b> check glyph "
          "and <b>accent</b> text; the tint is reinforcement, not the signal.")
    + nt(L,"<b>A tier the instance has not configured is listed and disabled with its reason</b>, never hidden "
          "(P4). Hiding it would make the menu a lie about what the product can do, and the owner would have no "
          "way to learn that a tier exists.",12)
    + nt(L,"<b>The control is half-sourced, and that is drawn honestly.</b> Models and providers come from "
          "<b>compute.yaml</b> via the <b>metistry compute</b> verbs, which exist on the Mac today. The preset "
          "list needs a <b>rules.yaml</b> endpoint, which does not. Build model and effort; leave presets behind "
          "the endpoint rather than hard-coding a tier list.",12)
    + '</div>',18,align="flex-start"))

FAULTS=pan(L,"WHAT THIS SCREEN STILL OWES, AND WHAT IT FOUND",
  "".join(f'<div style="display: flex; gap: 10px; align-items: flex-start; padding: 7px 0;'
          + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 34px;">{k}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,(k,v) in enumerate([
    ("C16","the motion ruling above. Still open, and it gates the only animation in the product."),
    ("§2.1","dropping the <b>agent-quiet</b> wash from a reply body is a deviation from P1. Both options are "
            "drawn; the ruling is yours."),
    ("—","the preset list has no endpoint, so the picker ships half-sourced by design rather than by omission."),
    ("—","the cap <b>is</b> the measure: <b>--mt-reply-measure</b> governs the column rather than the prose "
         "inside it, so tool strips, chips and cards fill the same width as the text and there is one number "
         "instead of two.")])))

body=(heading("ROUND D · SCREEN 1, BACK-PATCHED","Chat — one capped column, only yours tinted",
   "The turns run in one left-aligned column. <b>Only your turns carry a fill</b>: a reply is the longest text in "
   "the product and the thing most often read at length, so giving it the full column is worth more than the "
   "symmetry. The column is capped and centred, so resizing the window moves it and <b>never rewraps a line</b>.",L)
  + row(window(L),18)
  + row(WAIT+RULING,18)
  + row(OUTSIDE,18)
  + row(FILL+PICKER,18)
  + row(FAULTS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + f'<div style="border: 1px solid {D["bc"]}; border-radius: 12px; overflow: hidden; flex-grow: 1;">'
        + transcript(D) + '</div>' + modelmenu(D) + '</div></div>',18))
(PROJ/"Chat.dc.html").write_text(page("Chat",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Chat.dc.html ({CW}x{CH})")
