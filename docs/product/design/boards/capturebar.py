"""Board: the floating bar — Metistry's second interface.

Screen 11, new 2026-09-22. Built on PR 253 (`docs/research/2026-09-21-live-capture-bar.md`),
which decides most of the hard parts: the audio scope is enforced by the kernel,
the screen scope is not, and the bar is phase B.

Owner's rulings, 2026-09-22: present at all times while the bridge is installed,
minimal at rest and louder while live, docked to a screen edge he chooses, and the
bar's chat is the same conversation as the Chat destination.
"""
from lib import *

CW,CH=2600,5040

REST=pan(L,"AT REST — 30PX OF GLASS, ONE MARK, ONE WORD IF YOU ASK FOR IT",
  row(desktop(L,inner=railrest(L),w=600,h=400,label="RESTING &mdash; ENABLED, NOTHING HAPPENING")
    + desktop(L,inner=railhover(L),w=600,h=400,label="POINTER NEAR IT &mdash; THE FOUR ACTS, AND THE STATE IN WORDS"),
    18,align="flex-start")
  + nt(L,"<b>Always present while the bridge is installed</b>, because a capability you cannot see is a capability "
        "you do not use. The resting object is <b>the mark and one dot</b> &mdash; 30px wide, the width of the "
        "brand mark plus its air, and nothing else. Hovering says <b>not listening</b> in words and offers the "
        "four things it can do.",14)
  + nt(L,"<b>There is no crossed-out eye, no muted speaker and no muted microphone</b>, and that is C58 again: "
        "<b>absence is the denial</b>. Three negative icons are three claims about what Metis is not doing &mdash; "
        "noise at best, and in the case of the eye, <b>a claim the system cannot back</b> (see the picker panel "
        "below). One state, in one word, is the honest resting form. The grants themselves live in Settings, "
        "where you go when you want the full answer.",12)
  + nt(L,"<b>It fades to 55% after ten seconds of no pointer and returns on approach</b> &mdash; the one place a "
        "fade is allowed, because at rest it carries nothing. <b>While a session runs it may never fade, dim or "
        "hide.</b> That is the anti-Glass rule: Glass sold invisibility as a feature and called "
        "<b>setContentProtection</b> on every window; this bar is the opposite object.",12))

LIVE=pan(L,"LIVE — THE SAME OBJECT, LOUDER, AND IT CANNOT BE HIDDEN",
  row(desktop(L,inner=raillive(L),w=520,h=400,label="A SESSION RUNNING &mdash; MARK FILLED, ELAPSED, STOP")
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"The mark <b>fills</b> and the border takes the <b>agent</b> hue; the elapsed time runs vertically "
          "beside it and <b>Stop</b> is one click from anywhere on screen. That is the whole live state at 30px.",14)
    + nt(L,"<b>The live state uses hue and weight, never the warning tint.</b> Recording is not a fault, and "
          "<b>tint means something is wrong</b> &mdash; borrowing it here would break the channel rule the "
          "system just spent four rounds settling. Metis hearing you is Metis doing something, so it is the "
          "<b>agent</b> hue at full weight.",12)
    + nt(L,"<b>And it does not pulse.</b> C16, ratified this morning: motion only where it carries information the "
          "reader cannot otherwise get, stopping the moment that information is available in words. <b>13:42</b> "
          "advancing <i>is</i> the liveness, and it is content rather than decoration &mdash; so a breathing dot "
          "would be the second loop in a product that has ruled itself one.",12)
    + nt(L,"<b>macOS&rsquo;s own orange indicator stays exactly as it is.</b> We never suppress it and never "
          "imitate it: the system&rsquo;s indicator is the one a sceptical person trusts, and ours is the one "
          "that tells them what it is doing.",12) + '</div>',18,align="flex-start"))

PANELS=pan(L,"EXPANDED — THE SAME CONVERSATION AS THE WINDOW, AT A SHORTER MEASURE",
  row(f'<div>{sub("ASKED, NOTHING RUNNING",L["tt"])}{barpanel(L)}</div>'
    + f'<div>{sub("ASKED, WHILE LISTENING",L["tt"])}{barpanel(L,live=True)}</div>'
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>Ruled 2026-09-22: one conversation.</b> What you say here lands in the same thread as Chat, so "
          "opening the window later shows the turn where you left it. Two threads would mean deciding, every "
          "time, which one a question belongs to &mdash; and being wrong about it later.",14)
    + nt(L,"<b>The reply carries the 2px agent rule</b> (C69, ruled this morning), so a turn is recognisable as "
          "the same object in both places. The <b>measure is not</b>: 620px does not fit beside a meeting, so the "
          "panel runs at 328px and shows <b>the tail</b>, not the transcript. <b>Open in Chat</b> is on every "
          "reply longer than four lines &mdash; the bar is where you ask, the window is where you read.",12)
    + nt(L,"While a session runs, the panel says <b>answers are staying on this Mac</b>, because they are: the "
          "research&rsquo;s <b>private</b> tier may only be assigned to a provider with "
          "<b>locality: on_machine</b>, refused at <b>metistry compute assign</b>. That sentence is the whole "
          "reason the feature is acceptable, so it is on the surface and not in a settings pane.",12)
    + nt(L,"<b>Four acts at rest, three while live.</b> <i>Note</i> is the floating &lsquo;+&rsquo; the UX plan "
          "already ruled (&ldquo;no Capture tab and no Capture screen anywhere&rdquo;) &mdash; this bar is its "
          "home. <i>Action item</i> appears only while there is a transcript to anchor it to, carrying "
          "<b>source: meeting:&lt;path&gt;</b> and a timestamp.",12) + '</div>',18,align="flex-start"))

SCOPE=pan(L,"STARTING A SESSION — ONE ACT PER SENSE, AND THE TRUTH ABOUT EACH",
  row(scopesheet(L,kind="audio",w=470) + scopesheet(L,kind="screen",w=470),18,align="flex-start")
  + nt(L,"<b>One session, not three toggles.</b> The owner&rsquo;s worry &mdash; <i>enabling visual, audio and "
        "microphone for a meeting seems like a lot of work</i> &mdash; is real, and the fix is to stop modelling "
        "senses as switches. <b>Listen to this meeting</b> is one act that takes the meeting&rsquo;s audio and "
        "your microphone together, because a conversation is both halves or it is nothing. The grants are asked "
        "for once, by macOS, in its own words.",14)
  + nt(L,"<b>Hearing and seeing are not siblings, and the sheets say so differently.</b> A Core Audio process tap "
        "only ever yields the named processes&rsquo; audio &mdash; <b>CATapDescription.processes</b>, and "
        "<b>.bundleIDs</b> on macOS 26 &mdash; so <i>the system enforces this list</i> is a fact. For screen "
        "there is no equivalent: the picker is a selection UI and <b>kTCCServiceScreenCapture</b> is held by the "
        "binary. Drawing them as two identical switches would make the second one a lie.",12)
  + nt(L,"<b>Both sheets end with what is kept</b>, in the same three lines, because that is the question a "
        "person actually has. Text for 90 minutes in <b>.metistry/state</b>; the audio transcribed and dropped; "
        "one proposal in Needs You afterwards and <b>nothing written until you approve it</b> &mdash; invariant 2 "
        "holding through the mechanism that already exists.",12))

GLASS=pan(L,"GLASS, AND THE OPACITY FLOOR IT NEEDS TO STAY LEGAL",
  f'<div style="display: flex; gap: 14px; align-items: flex-start;">'
  + desktop(L,inner=(f'<div style="position: absolute; right: 12px; top: 40px;">{barpanel(L,w=300)}</div>'),
            w=430,h=330,label="GLASS OVER A LIGHT WALL")
  + desktop(D,inner=(f'<div style="position: absolute; right: 12px; top: 40px;">{barpanel(D,w=300)}</div>'),
            w=430,h=330,label="GLASS OVER A DARK WALL") + '</div>'
  + nt(L,"<b>§4.4 says &ldquo;nothing here depends on a translucent ground&rdquo;, and C4 logged that no declared "
        "contrast pair holds on a vibrant material.</b> The owner wants the bar to look like the OS, which is a "
        "deliberate exception &mdash; so it needs a number rather than a hope.",14)
  + f'<div style="background: {L["sunken"]}; border-radius: 10px; padding: 13px 15px; margin-top: 11px;">'
  + '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">'
  + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;">'
    f'<th style="padding: 0 10px 7px 0;">INK</th><th style="padding: 0 10px 7px 0;">NEEDS</th>'
    f'<th style="padding: 0 10px 7px 0;">MIN OPACITY, LIGHT</th><th style="padding: 0 0 7px 0;">MIN OPACITY, DARK</th></tr>'
  + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
            f'<td style="padding: 7px 10px 7px 0;">{mono(k,L["tp"],11.5)}</td>'
            f'<td style="padding: 7px 10px 7px 0; color: {L["ts"]};">{n}</td>'
            f'<td style="padding: 7px 10px 7px 0; color: {L["tp"]};">{a}</td>'
            f'<td style="padding: 7px 0; color: {c2};">{b}</td></tr>'
    for k,n,a,b,c2 in [("text-primary","4.5:1","0.51","0.65",L["tp"]),
                       ("text-secondary","4.5:1","0.78","<b>0.83</b>",L["deg"]),
                       ("text-tertiary","3:1","0.77","0.81",L["tp"]),
                       ("accent","3:1","0.66","0.68",L["tp"]),
                       ("agent","3:1","0.71","0.72",L["tp"])])
  + '</table></div>'
  + nt(L,"Measured by compositing each ink over the scrim at every opacity from 1.00 down, against five "
        "backdrops &mdash; white, black, mid grey, a deep blue and a bright yellow &mdash; and taking the worst. "
        "<b>The binding case is secondary text in dark mode at 0.83.</b>",12)
  + nt(L,"<b>The rule: the bar&rsquo;s scrim is never below 0.85, and the blur is decoration on top of it.</b> "
        "At 0.85 every ink clears with margin (secondary 4.95:1 dark, tertiary 3.58:1) and the wallpaper still "
        "shows through enough to read as glass. <b>This is the fourth mechanism by which contrast has failed "
        "here</b> &mdash; wrong token (C49), two inks too close (C54), opacity on the ink (C63), and now "
        "translucency under it. All four are the same lesson: <b>check the composite, never the token</b>.",12))

SETTINGS=pan(L,"SETTINGS — WHERE IT LIVES, WHAT IT HOLDS, AND HOW TO EMPTY IT",
  row(capturesettings(L)
    + f'<div style="flex-grow: 1; min-width: 0;">'
    + nt(L,"<b>You pick the edge, and the display.</b> Left or right, drawn rather than named, plus which screen "
          "and roughly how far down &mdash; then draggable from there. Top and bottom are not offered: the "
          "menu bar owns the top, and the Dock and the system&rsquo;s own recording pill own the bottom.",14)
    + nt(L,"<b>The grant table is a read-through, not a control.</b> macOS holds these, so the pane reports them "
          "and links to System Settings &mdash; the same shape as the Compute pane, and the same reason: a "
          "console that pretended to grant a TCC permission would be lying about who decides.",12)
    + nt(L,"<b>Purge now</b> is the one destructive verb, and it is here rather than on the bar, because the bar "
          "is for the session you are in and this is for everything the machine is still holding. The line above "
          "it says what that is: <i>14 minutes of text from one session</i>.",12)
    + nt(L,"<b>Absent, not off, when the bridge is not installed.</b> The pane says <b>bridge installed</b> "
          "because it is; without it there is no pane, no bar and no grants &mdash; <b>degrades: absent</b>, the "
          "way the router already drops a missing bridge. A personal instance that never installs it has no "
          "capture surface at all.",12) + '</div>',18,align="flex-start"))

PICKER=pan(L,"THE ONE THING THE BRIEF GOT WRONG, AND WHAT IT COSTS THE DESIGN",
  f'<div style="background: {L["degq"]}; border-radius: 11px; padding: 14px 16px;">'
  f'<div style="font-size: 12.5px; color: {L["tp"]}; line-height: 1.6;">The brief said the user picks apps via '
  f'the system picker <i>&ldquo;so the OS enforces the scope, not our prompt.&rdquo;</i> Apple&rsquo;s own '
  f'documentation says two things in adjacent paragraphs: use <b>SCContentSharingPicker</b> as the recommended '
  f'way to let people <b>select</b> content &mdash; and, separately, <b>request screen recording permission</b> '
  f'before capturing. The grant is global to the binary.</div></div>'
  + nt(L,"So the picker makes the scope <b>visible and user-chosen</b>; what makes it <i>enforced</i> is that the "
        "helper is a small signed binary with <b>exactly one code path for building a filter</b>. That is still "
        "&ldquo;enforce at the tool&rdquo; &mdash; invariant 2 &mdash; but it is our boundary, and the interface "
        "may not borrow the kernel&rsquo;s credibility for it.",14)
  + nt(L,"<b>Three consequences, all visible in the drawings above.</b> The screen sheet says <i>macOS picks the "
        "window, not us</i> and then says the grant is not per-window, once, in place. There is no crossed-out "
        "eye at rest, because <i>cannot see</i> is unprovable &mdash; <i>not listening</i> and <i>no stream "
        "running</i> are provable. And seeing is a <b>separate act from hearing</b>, never a checkbox beside it, "
        "so the weaker guarantee is never smuggled in under the stronger one.",12)
  + nt(L,"<b>P5 is the rule doing the work here:</b> state is reported, never inferred. A capability claim is a "
        "state claim about the machine, and this one the machine cannot make.",12))

ASKS=pan(L,"WHAT THIS ASKS OF THE BUILD",
  "".join(f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 8px 0;'
          + ("" if i==5 else f' border-bottom: 1px solid {L["border"]};') + '">'
          f'<span style="font-family: {MONO}; font-size: 11px; color: {L["acc"]}; flex-shrink: 0; '
          f'padding-top: 2px; width: 18px;">{i+1}</span>'
          f'<span style="font-size: 12.5px; color: {L["ts"]}; line-height: 1.55;">{v}</span></div>'
  for i,v in enumerate([
    "<b>Three TCC grant kinds in the manifest enum.</b> <b>microphone</b>, <b>audio_capture</b> and &mdash; only "
    "if the screen act ships &mdash; <b>screen_recording</b>. The enum is closed at five "
    "(<b>packages/core/src/manifest.ts:30-36</b>) and is now blocking two specs, this one and the mail path&rsquo;s "
    "<b>full_disk_access</b>. One decision, owed once.",
    "<b>The private compute tier</b>, refused at <b>metistry compute assign</b> if pointed at a provider whose "
    "<b>locality</b> is not <b>on_machine</b>. The panel&rsquo;s <i>staying on this Mac</i> line is only honest if "
    "the verb enforces it.",
    "<b>A grant read-through for the Settings pane</b> &mdash; each grant&rsquo;s state and when it was given. "
    "The bridge&rsquo;s <b>check()</b> already has the shape; the pane needs it per grant rather than as one "
    "health word.",
    "<b>Retention, and a purge verb.</b> Daily-flow Q4 is still open and this is the first path that would make "
    "transcripts continuously. The bar draws a 90-minute window and a <b>purge now</b> button; both need a number "
    "the owner has ruled and a verb that empties <b>.metistry/state</b>.",
    "<b>A window-position preference</b> per display, and the rule that top and bottom edges are not offered.",
    "<b>Nothing in exposes:.</b> The assistant may not start a session &mdash; invariant 9 by absence, the same "
    "argument <b>mcp-apple-fm</b> makes for keeping <b>/v1</b> off its list. The bar is the owner&rsquo;s hand, "
    "and only the owner&rsquo;s."])))

body=(heading("ROUND E · SCREEN 11, NEW","The floating bar — always there, 30px wide, loud only when listening",
   "A second interface for Metistry, additive to the Chat destination: present whenever the capture bridge is "
   "installed, docked to an edge you choose, and carrying four acts &mdash; ask, note, listen, share a window. "
   "The design&rsquo;s job is to make one thing unmissable and one thing unclaimable: <b>that a session is "
   "running</b>, and <b>that Metis can see anything it has not been handed</b>.",L)
  + row(REST,18)
  + row(LIVE,18)
  + row(PANELS,18)
  + row(SCOPE,18)
  + row(GLASS+PICKER,18)
  + row(SETTINGS,18)
  + row(ASKS,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">'
        + sub("DARK",D["tt"])
        + f'<div style="display: flex; gap: 18px; align-items: flex-start;">'
        + desktop(D,inner=raillive(D),w=470,h=360)
        + barpanel(D,live=True) + scopesheet(D,kind="audio",w=430) + '</div></div>',18))
(PROJ/"CaptureBar.dc.html").write_text(page("CaptureBar",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote CaptureBar.dc.html ({CW}x{CH})")
