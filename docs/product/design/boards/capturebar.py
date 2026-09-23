"""Board: the floating bar — Metistry's second interface.

Screen 11, new 2026-09-22, rebuilt the same evening after the owner's review:
thinner glass with Apple's own layering, sheets cut to two lines, a pulse while
recording, and the senses shown while live. PR 253 decides the mechanics
(`docs/research/2026-09-21-live-capture-bar.md`); this decides the craft.

Rulings held: present whenever the bridge is installed, minimal at rest, on an
edge the owner picks, one conversation shared with the window.
"""
from lib import *

CW,CH=2600,5000

REST=pan(L,"AT REST — 30PX, TWO MARKS, AND GLASS YOU CAN SEE THROUGH",
  row(desktop(L,inner=railrest(L),w=560,h=380,label="RESTING")
    + desktop(L,inner=railhover(L),w=560,h=380,label="POINTER NEAR IT"),18,align="flex-start")
  + nt(L,"<b>The resting object is the mark and one dot</b>, 30px wide, on the edge you picked. It is drawn on "
        "the <b>marks-only</b> glass &mdash; 0.75 rather than 0.86 &mdash; because nothing on it is text. That is "
        "the whole trick to making it feel like the OS: <b>transparency is bought by giving up the faintest "
        "ink</b>, not by hoping.",14)
  + nt(L,"Hover names the state in words and offers the four acts. No crossed-out eye, no muted speaker: "
        "<b>absence is the denial</b> (C58), and <i>cannot see</i> is a claim the system cannot back (C71).",12))

GLASSCRAFT=pan(L,"THE GLASS — FOUR LAYERS, ONE OF WHICH IS NOT DECORATION",
  f'<div style="display: flex; gap: 16px; align-items: flex-start;">'
  + f'<div style="flex-shrink: 0;">'
  + desktop(L,inner=f'<div style="position: absolute; right: 11px; top: 30px;">{barpanel(L,w=300)}</div>',
            w=420,h=330,label="LIGHT WALL")
  + '</div>'
  + f'<div style="flex-shrink: 0;">'
  + desktop(D,inner=f'<div style="position: absolute; right: 11px; top: 30px;">{barpanel(D,w=300)}</div>',
            w=420,h=330,label="DARK WALL")
  + '</div>'
  + f'<div style="flex-grow: 1; min-width: 0;">'
  + "".join(f'<div style="padding: 7px 0;' + ("" if i==3 else f' border-bottom: 1px solid {L["border"]};') + '">'
            f'<div style="font-size: 12px; font-weight: 600; color: {L["tp"]};">{a}</div>'
            f'<div style="font-size: 11.5px; color: {L["ts"]}; line-height: 1.5; margin-top: 2px;">{b}</div></div>'
    for i,(a,b) in enumerate([
      ("1 &middot; The lensed backdrop","<b>blur(28px) saturate(185%) brightness(1.04)</b>. The saturation lift is "
       "what makes it read as glass rather than as frosting &mdash; colour from behind survives the blur."),
      ("2 &middot; The scrim","a vertical gradient, <b>0.88 &rarr; 0.85</b>, thicker at the top where the "
       "specular sits. <b>This is the only layer that is not decoration:</b> it is what keeps our inks legal."),
      ("3 &middot; The specular edge","a <b>0.5px</b> border and an <b>inset 0 1px 0</b> highlight &mdash; 0.62 "
       "white in light, 0.20 in dark. This single line is most of why Apple's glass looks lit rather than "
       "painted."),
      ("4 &middot; The ground","a tight 1px contact shadow under a wide soft one, so the panel sits on the "
       "desktop instead of floating over it. Radii are concentric: 18 outside, 11 inside, the difference being "
       "the padding.")]))
  + nt(L,"<b>The measured floors, from C70, now split by what the surface carries.</b> Text needs "
        "<b>0.86</b> (secondary ink in dark binds at 0.83). Marks in <b>ts</b>, <b>agent</b> or <b>accent</b> "
        "hold at <b>0.75</b>. <b>text-tertiary needs 0.81</b>, so it is <i>not allowed on thin glass at all</i> "
        "&mdash; which is exactly why the rail carries no faint label and no numerals.",12)
  + '</div></div>')

LIVE=pan(L,"LIVE — IT BREATHES, AND IT SAYS WHICH SENSE IS OPEN",
  row(desktop(L,inner=raillive(L,senses=("mic",)),w=420,h=360,label="LISTENING")
    + desktop(L,inner=raillive(L,senses=("mic","screen")),w=420,h=360,label="LISTENING AND SHARING")
    + f'<div style="flex-grow: 1; min-width: 0;">{sub("HOVER, WHILE LIVE",L["tt"])}'
    + f'<div style="position: relative; height: 200px;">{railhover(L,live=True,senses=("mic","screen"),top=0)}</div>'
    + '</div>',18,align="flex-start")
  + nt(L,"<b>The senses are shown, not implied.</b> A filled <b>microphone</b> means it is hearing; a filled "
        "<b>display</b> means a window is being shared. Both can be lit at once, and each is the glyph macOS uses "
        "for the same idea, so the row reads without a legend. They are <b>indicators, not switches</b> &mdash; "
        "the act that started each one is what ends it.",14)
  + nt(L,"<b>The breath is ratified under C16, not against it.</b> The rule is <i>motion only where it carries "
        "information the reader cannot otherwise get</i>. In the panel the elapsed count carries liveness, so "
        "nothing moves. On a <b>30px rail seen from across the room</b>, a 14px mark cannot be resolved and a "
        "numeral certainly cannot &mdash; <b>a slow expanding halo is detectable in peripheral vision when "
        "nothing else on it is</b>. That is information the reader cannot otherwise get, at exactly the moment "
        "it matters most.",12)
  + nt(L,"<b>2.6s, ease-in-out, scale 1 &rarr; 1.5 with opacity 0.85 &rarr; 0.12.</b> Slow enough to read as "
        "breathing rather than blinking &mdash; an alarm pulse would say <i>something is wrong</i>, which is the "
        "tint channel's job and not true here. The <b>mark stays filled at all times</b>, so the state never "
        "depends on the animation: under <b>prefers-reduced-motion</b> the halo holds at its widest, still and "
        "visible.",12))

PULSE=pan(L,"THE BREATH, SPECIFIED",
  f'<div style="display: flex; gap: 22px; align-items: flex-end; background: {L["sunken"]}; '
  f'border-radius: 11px; padding: 18px 20px;">'
  + "".join(f'<div style="text-align: center;">'
            f'<div style="height: 34px; display: flex; align-items: center; justify-content: center;">'
            f'{breathmark(L,size=14,frame=f)}</div>'
            f'<div style="font-family: {MONO}; font-size: 10.5px; color: {L["ts"]}; margin-top: 10px;">{t}</div>'
            f'<div style="font-size: 10.5px; color: {L["tt"]};">{s}</div></div>'
    for f,t,s in (("in","0.0s","scale 1 &middot; 0.85"),("mid","0.65s","scale 1.26 &middot; 0.45"),
                  ("out","1.3s","scale 1.5 &middot; 0.12"),("mid","1.95s","scale 1.26 &middot; 0.45"),
                  ("in","2.6s","scale 1 &middot; 0.85")))
  + f'<div style="flex-grow: 1;"></div>'
  + f'<div style="max-width: 300px; font-size: 11.5px; color: {L["ts"]}; line-height: 1.5;">'
  + '<b>One ring, one property pair, no colour change.</b> The halo takes the <b>agent</b> hue at 1.5px and never '
  + 'the warning tint: recording is not a fault.</div></div>'
  + nt(L,"<b>This is now the second and last animation in the product.</b> The waiting dots in Chat and this. "
        "Both pass the same test, both stop under reduced motion, and the list is closed &mdash; a third "
        "candidate should have to displace one of these rather than join them.",12))

PANELS=pan(L,"EXPANDED — ONE CONVERSATION, A SHORTER MEASURE",
  row(f'<div>{sub("ASKED, NOTHING RUNNING",L["tt"])}{barpanel(L)}</div>'
    + f'<div>{sub("ASKED, WHILE LISTENING",L["tt"])}{barpanel(L,live=True,senses=("mic","screen"))}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>One conversation</b> (ruled 2026-09-22): what you say here lands in the same thread as Chat, and "
          "the reply carries the same <b>2px agent rule</b> (C69), so a turn is the same object in both places.",14)
    + nt(L,"<b>The measure is not the same, and that is a ruling rather than a slip (C72).</b> 620px does not fit "
          "beside a meeting; the panel runs at <b>328px</b> and shows the tail. <b>Open in Chat</b> appears on any "
          "reply past four lines. The bar is where you ask; the window is where you read.",12)
    + nt(L,"<b>Staying on this Mac</b> is on the surface while a session runs, because the <b>private</b> tier is "
          "what makes the feature acceptable &mdash; a tier <b>metistry compute assign</b> refuses to point at "
          "anything whose <b>locality</b> is not <b>on_machine</b>.",12)
    + nt(L,"The composer is a <b>recessed</b> field, not another glass plate: glass on glass reads as two windows "
          "rather than one control, so the field takes an inset shadow and a thinner ground.",12) + '</div>',
    18,align="flex-start"))

SHEETS=pan(L,"STARTING — TWO LINES, THEN START",
  row(f'<div>{sub("LISTEN",L["tt"])}{scopesheet(L,kind="audio")}</div>'
    + f'<div>{sub("SHARE A WINDOW",L["tt"])}{scopesheet(L,kind="screen")}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>Cut from eleven lines to four.</b> macOS explains its own permissions better than we can, in its "
          "own words, at the moment it asks &mdash; so the sheet no longer rehearses them. What is left is what "
          "only we know: <b>what it will hear</b>, <b>when it stops</b>, and that <b>nothing is written without "
          "you</b>.",14)
    + nt(L,"<b>The grant table is gone from the sheet</b> and lives in Settings, where someone who wants the full "
          "answer goes. The sheet is a doorway, not a briefing.",12)
    + nt(L,"<b>The one line kept for the screen sheet is the honest one:</b> <i>screen access is not "
          "per-window</i>. Four words and a chip, because C71 means the interface may not let the picker imply a "
          "fence the OS does not provide &mdash; but it also does not need a paragraph to say so.",12)
    + nt(L,"<b>Still one act per sense.</b> Listening takes the meeting and your microphone together, because a "
          "conversation is both halves. Sharing is its own act, with its own sheet and its own glyph.",12)
    + '</div>',18,align="flex-start"))

SETTINGS=pan(L,"SETTINGS — A SWITCH, A PLACE, THREE PERMISSIONS, AND WHAT IT KEEPS",
  row(capturesettings(L)
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>The header rows are gone and a real switch replaces them.</b> <i>The floating bar</i> is now one "
          "toggle that turns the whole surface off &mdash; which is different from the bridge being absent, and "
          "the only control here that changes what is on screen.",14)
    + nt(L,"<b>Permissions say whether, not when.</b> <i>Approved</i> or <i>not yet asked</i>. The date a grant "
          "was given is trivia; what a person wants to know is whether they will be interrupted.",12)
    + nt(L,"<b>What Metis keeps</b>, in three rows of two words: <i>audio &mdash; never kept</i>, <i>transcript "
          "&mdash; 90 minutes, then gone</i>, <i>notes &mdash; only what you approve, in your vault</i>. No "
          "paths: where it is stored is our problem, and naming <b>.metistry/state</b> in a settings pane was "
          "documentation leaking into the product.",12)
    + nt(L,"<b>Purge now</b> keeps its place with the amount beside it, because a destructive verb should say "
          "what it will destroy.",12) + '</div>',18,align="flex-start"))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==5 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 18px;">{i+1}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,v in enumerate([
    "<b>Three TCC grant kinds in the manifest enum</b> &mdash; <b>microphone</b>, <b>audio_capture</b>, and "
    "<b>screen_recording</b> only if sharing ships. The enum is closed at five and now blocks two specs.",
    "<b>The private compute tier</b>, refused at <b>metistry compute assign</b> when pointed off-machine. "
    "<i>Staying on this Mac</i> is only honest if the verb enforces it.",
    "<b>Per-grant state, not a health word</b> &mdash; approved or never asked, per grant, for the Settings pane.",
    "<b>A retention number and a purge verb.</b> The pane draws 90 minutes and an amount; both need a ruling "
    "(daily-flow Q4) and a verb that empties the buffer.",
    "<b>Edge, display and vertical offset</b> as a preference, plus the global on/off. Top and bottom edges are "
    "not offered: the menu bar and the Dock own them.",
    "<b>Nothing in exposes:.</b> The assistant may not start a session &mdash; invariant 9 by absence. The bar "
    "is the owner's hand, and only the owner's."])))

body=(motioncss()
  + heading("ROUND E · SCREEN 11, REVISED","The floating bar — thin glass, one breath, the senses named",
   "Rebuilt after review: the glass is Apple's four layers rather than a flat wash, the sheets are two lines and "
   "a button, Settings is a switch and a place, and while a session runs the rail <b>breathes</b> and shows "
   "<b>which sense is open</b>. The two things the design must still make impossible to miss and impossible to "
   "overclaim: that a session is running, and what Metis can actually reach.",L)
  + row(REST,18)
  + row(GLASSCRAFT,18)
  + row(LIVE,18)
  + row(PULSE,18)
  + row(PANELS,18)
  + row(SHEETS,18)
  + row(SETTINGS,18)
  + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + desktop(D,inner=raillive(D,senses=("mic","screen")),w=430,h=380)
        + barpanel(D,live=True,senses=("mic",)) + scopesheet(D,kind="audio")
        + f'<div style="flex-grow: 1; min-width: 0;">{capturesettings(D,w=470)}</div>'
        + '</div></div>',18))
(PROJ/"CaptureBar.dc.html").write_text(page("CaptureBar",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote CaptureBar.dc.html ({CW}x{CH})")
