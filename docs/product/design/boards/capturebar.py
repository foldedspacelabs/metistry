"""Board: the floating bar — Metistry's second interface.

Screen 11, new 2026-09-22, rebuilt the same evening after the owner's review:
thinner glass with Apple's own layering, sheets cut to two lines, a pulse while
recording, and the senses shown while live. PR 253 decides the mechanics
(`docs/research/2026-09-21-live-capture-bar.md`); this decides the craft.

Rulings held: present whenever the bridge is installed, minimal at rest, on an
edge the owner picks, one conversation shared with the window.
"""
from lib import *

CW,CH=2600,5400

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

RECORD=pan(L,"RECORDING — PICK WHAT IT WATCHES, SAY WHETHER IT HEARS YOU",
  row(f'<div>{sub("A WINDOW",L["tt"])}{recordsheet(L,target="Window")}</div>'
    + f'<div>{sub("THE WHOLE SCREEN",L["tt"])}{recordsheet(L,target="Screen")}</div>'
    + f'<div>{sub("AUDIO ONLY, MIC OFF",L["tt"])}{recordsheet(L,target="Audio only",mic=False)}</div>',
    18,align="flex-start")
  + nt(L,"<b>The owner&rsquo;s correction reshaped this, and the API agrees with him.</b> A meeting is not audio "
        "&mdash; it is <b>a window and its sound</b>, plus your own voice. So the sheet asks one question, "
        "<i>what should it watch</i>, and then one more, <i>should it hear you</i>. Audio comes with the target "
        "rather than being a third thing to switch on.",14)
  + nt(L,"<b>That is one API call, not three.</b> <b>SCStreamConfiguration.capturesAudio</b> (macOS 13) gives the "
        "audio of whatever the content filter covers, so <b>the sound is scoped exactly as the picture is</b> "
        "&mdash; one selection, one scope. <b>captureMicrophone</b> (macOS 15) puts your own voice in the same "
        "stream, separately attributable. Below 15 the microphone is a second session; the app&rsquo;s floor is "
        "14.0, so that fallback is real.",12)
  + nt(L,"<b>Three targets cover the three things the owner described.</b> A meeting is <i>Window</i> with the mic "
        "on. Showing how something works is <i>Window</i> or <i>Screen</i> with the mic on. A call with no screen "
        "is <i>Audio only</i> &mdash; kept because an in-person conversation and a phone call have no window, and "
        "because for audio without video the <b>Core Audio process tap</b> is strictly better: no screen grant, "
        "per-process by construction.",12)
  + nt(L,"<b>Everything explanatory is gone.</b> No <i>stops at 11:30</i>, no <i>nothing is written without "
        "you</i>, no permissions rehearsal. The shape says it: a <b>Record</b> button implies a stop, the bar "
        "carries it, and macOS asks for what it needs when it needs it. Text is <b>left-aligned throughout</b> "
        "&mdash; the label, then its quiet qualifier beside it (<i>your side only</i>, <i>comes with the "
        "window</i>), never a column of right-aligned fragments pretending to be a table.",12))

JOT=pan(L,"DURING A SESSION — ASK, NOTE, TO-DO, WITHOUT LEAVING THE ROOM",
  row(f'<div>{sub("JOTTING WHILE IT RECORDS",L["tt"])}{barpanel(L,live=True,mode="Note")}</div>'
    + f'<div>{sub("ASKING, SAME FIELD",L["tt"])}{barpanel(L,live=True,mode="Ask")}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>One field, three destinations.</b> A thought during a meeting is a <b>note</b>, an obligation is a "
          "<b>to-do</b>, and a question is a <b>question</b> &mdash; and none of them should cost you the meeting. "
          "The mode pills are the whole control; <b>&#8984;&#8997;N</b> and <b>&#8984;&#8997;T</b> reach the field "
          "already in the right mode without opening the panel.",14)
    + nt(L,"<b>What you jot is shown back, timestamped.</b> <i>This session &middot; 2 notes, 1 to-do</i>, "
          "expandable to the lines themselves. That is the trust mechanism: a note you cannot see is a note you "
          "will retype in your own app, and then the bar has cost you more than it saved.",12)
    + nt(L,"<b>The timestamp is the anchor, and it is what makes them foldable.</b> Each jot carries the session "
          "and the second it was made, so afterwards a note sits beside what was being said when you wrote it, and "
          "a to-do arrives as a task-line proposal with <b>source: meeting:&lt;path&gt;</b> &mdash; vocabulary "
          "the daily-flow spec already has.",12)
    + nt(L,"<b>They ride the same proposal as the notes.</b> One thing lands in Needs You afterwards, carrying the "
          "draft, the transcript and your own jots together &mdash; not three separate arrivals. Nothing is "
          "written until you approve it, which is why the sheet no longer needs to promise it.",12)
    + '</div>',18,align="flex-start"))

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
  + heading("ROUND E · SCREEN 11, REVISED","The floating bar — thin glass, one breath, the senses named",
   "Recording is one question &mdash; <b>what should it watch</b> &mdash; and one more: <b>should it hear you</b>. Audio comes with the target. While a session runs the rail <b>breathes</b>, the senses are named, and one field "
   "takes a question, a note or a to-do without costing you the meeting. The two things the design must still make impossible to miss and impossible to "
   "overclaim: that a session is running, and what Metis can actually reach.",L)
  + row(REST,18)
  + row(GLASSCRAFT,18)
  + row(LIVE,18)
  + row(PULSE,18)
  + row(PANELS,18)
  + row(RECORD,18)
  + row(JOT,18)
  + row(PHASE,18)
  + row(SETTINGS,18)
  + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + desktop(D,inner=raillive(D,senses=("mic","screen")),w=430,h=380)
        + barpanel(D,live=True) + recordsheet(D,target="Window")
        + f'<div style="flex-grow: 1; min-width: 0;">{capturesettings(D,w=470)}</div>'
        + '</div></div>',18))
(PROJ/"CaptureBar.dc.html").write_text(page("CaptureBar",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote CaptureBar.dc.html ({CW}x{CH})")
