"""Board: the floating bar — Metistry's second interface.

Screen 11, 2026-09-22, third pass. The rail is now a toolbar: Ask, Note, To-do
and Record are one click each, because two clicks before a thought is a recipe
for non-use. Recording takes a target and two toggles. PR 253 decides the
mechanics (`docs/research/2026-09-21-live-capture-bar.md`); this decides the craft.
"""
from lib import *

CW,CH=2600,5200

REST=pan(L,"AT REST — A TOOLBAR, ONE CLICK PER ACT",
  row(desktop(L,inner=railtool(L,top=90),w=520,h=360,label="RESTING")
    + desktop(L,inner=railtool(L,top=90,hot="note")+tip(L,"Note","&#8984;&#8997;N",top=167),w=520,h=360,
              label="POINTER ON NOTE")
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>Ask &middot; Note &middot; To-do &middot; Record</b>, each its own button. The earlier rail "
          "made every jot cost two clicks before a single word, which the owner rightly called a recipe for "
          "non-use.",14)
    + nt(L,"Glyphs only, with the native tooltip and its shortcut on hover. They sit on the thin glass, so they "
          "are drawn in <b>text-secondary</b>; no labels, because a label on 0.75 glass would need tertiary ink "
          "and tertiary is barred there (C74).",12)
    + nt(L,"Fades to 55% after ten seconds idle; never while recording.",12) + '</div>',18,align="flex-start"))

QUICK=pan(L,"NOTE AND TO-DO — CLICK, TYPE, RETURN",
  row(desktop(L,inner=railtool(L,top=90,hot="note")+quickfield(L,kind="note",top=154),w=560,h=360,
              label="ONE CLICK ON NOTE")
    + desktop(L,inner=railtool(L,top=90,hot="todo")+quickfield(L,kind="todo",top=192),w=560,h=360,
              label="ONE CLICK ON TO-DO")
    + desktop(L,inner=railtool(L,top=90)+quickfield(L,kind="note",saved=True,w=170,top=154),w=400,h=360,
              label="AFTER RETURN"),18,align="flex-start")
  + nt(L,"The field opens beside the button that summoned it, already focused. <b>Return saves and closes</b>; "
        "Escape closes. A one-second confirmation with the time, then nothing. Works the same during a recording, "
        "where each jot also takes the session&rsquo;s timestamp (C77).",14))

LIVE=pan(L,"RECORDING — THE SAME TOOLBAR, BREATHING, WITH THE SENSES SHOWN",
  row(desktop(L,inner=railtool(L,live=True,top=70),w=460,h=380,label="WINDOW, AUDIO, MICROPHONE")
    + desktop(L,inner=railtool(L,live=True,senses=("mic",),top=70),w=460,h=380,label="AUDIO ONLY, MICROPHONE")
    + desktop(L,inner=railtool(L,live=True,top=70,hot="note")+quickfield(L,kind="note",top=179),w=560,h=380,
              label="JOTTING WHILE IT RECORDS"),18,align="flex-start")
  + nt(L,"The mark breathes and the senses that are open sit under it &mdash; a display while a picture is being "
        "taken, a microphone while you are heard. <b>Record becomes Stop</b>, in the same place. Note and To-do "
        "do not move, so a jot during a meeting is the same click as any other time.",14))

PANELS=pan(L,"ASK — THE CHAT, AS IT WAS",
  row(f'<div>{sub("AT REST",L["tt"])}{barpanel(L)}</div>'
    + f'<div>{sub("WHILE RECORDING",L["tt"])}{barpanel(L,live=True)}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"Ask opens the tail of the one conversation and a composer &mdash; no mode pills, since Note and "
          "To-do have their own buttons. Same thread as the window, same 2px agent rule (C69), shorter measure "
          "(C72).",14)
    + nt(L,"While recording, one line counts what you have jotted this session.",12) + '</div>',
    18,align="flex-start"))

RECORD=pan(L,"RECORD — A TARGET AND TWO TOGGLES",
  row(f'<div>{sub("WINDOW",L["tt"])}{recordsheet(L,target="Window")}</div>'
    + f'<div>{sub("SCREEN",L["tt"])}{recordsheet(L,target="Screen")}</div>'
    + f'<div>{sub("AUDIO ONLY",L["tt"])}{recordsheet(L,target="Audio only")}</div>',18,align="flex-start")
  + nt(L,"<b>Audio is a toggle now, on by default</b>, beside the microphone. The label names what it takes "
        "&mdash; <i>app audio</i> for a window, <i>system audio</i> for the screen &mdash; and nothing else is "
        "said. The window row is the picker&rsquo;s choice, with a chevron to change it.",14))

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

PHASE=pan(L,"A FINDING THE OWNER SHOULD SEE BEFORE THE DEVELOPER SCHEDULES THIS",
  f'<div style="background: {L["degq"]}; border-radius: 11px; padding: 14px 16px;">'
  f'<div style="font-size: 12.5px; color: {L["tp"]}; line-height: 1.6;">PR 253 recommended <b>audio first</b> and '
  f'<b>screen not at all for now</b>, on the grounds that audio is the part with kernel-enforced scoping and '
  f'screen is <i>&ldquo;the part the owner himself was unsure he wanted.&rdquo;</i> The owner has since said a '
  f'meeting <b>is</b> screen plus audio. <b>That inverts the phase order:</b> the headline act now needs the '
  f'grant with the weaker scope story.</div></div>'
  + nt(L,"This is not an objection &mdash; it is the trade made visible. <b>What the design can carry:</b> the "
        "picker means you choose the window every session; the helper has one filter path; the rail shows a "
        "display glyph whenever a picture is being taken; and the sheet says <b>screen access is not "
        "per-window</b> once, in the Settings pane, rather than in a dialogue you dismiss.",14)
  + nt(L,"<b>What it cannot carry:</b> the OS will not fence the screen grant for us. A person who wants that "
        "guarantee should use <b>Audio only</b>, which is genuinely per-process &mdash; so the option earns its "
        "place twice over.",12)
  + nt(L,"<b>The sequencing question is the owner&rsquo;s, and it is now a real one:</b> ship <i>Window + audio + "
        "mic</i> first, which is what he asked for and what makes meetings work &mdash; or ship <i>Audio only</i> "
        "first, which is 7&ndash;9 days, needs no screen grant, and proves the whole downstream path (transcript "
        "&rarr; capture &rarr; proposal) with less surface. The second is the research&rsquo;s recommendation; the "
        "first is the product he described.",12))

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
  + heading("ROUND E · SCREEN 11, THIRD PASS","The floating bar — four buttons, one click each",
   "Ask, Note, To-do and Record live on the rail. Recording is a target and two toggles. While it runs the mark "
   "breathes and the senses are shown; everything else stays exactly where it was.",L)
  + row(REST,18)
  + row(QUICK,18)
  + row(LIVE,18)
  + row(PULSE,18)
  + row(PANELS,18)
  + row(RECORD,18)
  + row(GLASSCRAFT,18)
  + row(PHASE,18)
  + row(SETTINGS,18)
  + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + desktop(D,inner=railtool(D,live=True,top=70,hot="note")+quickfield(D,kind="note",top=179),w=520,h=380)
        + barpanel(D,live=True) + recordsheet(D,target="Window")
        + f'<div style="flex-grow: 1; min-width: 0;">{capturesettings(D,w=470)}</div>'
        + '</div></div>',18))
(PROJ/"CaptureBar.dc.html").write_text(page("CaptureBar",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote CaptureBar.dc.html ({CW}x{CH})")
