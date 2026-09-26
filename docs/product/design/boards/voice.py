"""Board: The assistant's voice — six system serifs (round D, ported 2026-09-25).

Rebuilt from the published board. The dark samples now carry the configured
assistant name (C88) instead of ASSISTANT.
"""
from lib import *

CW,CH=2320,1560
SAMPLE=("The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
        "He has been waiting on the SOW since Tuesday, and the design review moved to 1:00 PM while you were in the standup.")
FACES=[("Charter","Charter,serif","macOS &middot; iOS &middot; (not Windows)",True,
        "Matthew Carter, 1987, drawn for <i>low-resolution output</i> &mdash; so it is built from the same constraint a screen imposes. Low stroke contrast, sturdy, slightly engineered terminals. Reads technical rather than literary, which is the closest a system serif gets to <i>modern</i>."),
       ("Superclarendon","Superclarendon,serif","macOS &middot; iOS",False,
        "A slab. The most <i>voiced</i> option here by a distance &mdash; nobody mistakes it for a document. Heavier on the page, so it wants the prose kept short, which agent prose should be anyway."),
       ("Sitka","Sitka,'Sitka Text',serif","Windows 8.1+",False,
        "Carter again, 2013, this time <i>designed for screens from the start</i> with real optical sizes. The most contemporary serif any Windows machine has. Pairs with Charter better than Georgia does."),
       ("Constantia","Constantia,serif","Windows &middot; Office on macOS",False,
        "Humanist, moderate contrast, 2007. Genuinely modern in shape, but its <i>numerals are old-style</i> &mdash; they hang below the baseline &mdash; which fights a page full of times, dates and percentages."),
       ("Cambria","Cambria,serif","Windows &middot; Office on macOS",False,
        "Sturdy, near-slab serifs, built for ClearType. Modern in the sense of <i>recent and screen-first</i>, but it is the most corporate of the six &mdash; it reads like a well-set report."),
       ("Iowan Old Style","'Iowan Old Style',serif","macOS &middot; iOS",False,
        "Warm and generous, big x-height, very easy at small sizes. Honest about what it is: an <i>old style</i> face, so it is the least modern here &mdash; included because it is the most <i>readable</i> and that may matter more."),
       ("Times &mdash; the control","'Times New Roman',Times,serif","everywhere",False,
        "<b>Not a candidate.</b> It is here so you can tell what resolved: if any card above looks identical to this one, that face is not installed on the machine you are reading this on, and the browser fell through to Times.")]

def specimen(T,name,stack,where,rec,why,*,w=690):
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["surface"]}; border: 1px solid {T["acc"] if rec else T["border"]}; border-radius: 12px; padding: 16px 18px;">'
            f'<div style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">{name}</span>'
            + (f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["onacc"]}; background: {T["acc"]}; border-radius: 999px; padding: 1px 8px;">RECOMMENDED</span>' if rec else "")
            + f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; color: {T["ts"]};">{where}</span></div>'
            f'<div style="margin-top: 12px; background: {T["agq"]}; border-radius: 9px; padding: 11px 13px;">'
            f'<div style="font-size: 11px; color: {T["ts"]}; margin-bottom: 5px;">{ASSISTANT_NAME} read your notes at 8:41 AM</div>'
            f'<div style="font-family: {stack}; font-size: 15px; line-height: 1.55; color: {T["tp"]};">{SAMPLE}</div>'
            f'<div style="font-family: {stack}; font-size: 13px; color: {T["ts"]}; margin-top: 8px;">0123456789 &middot; 4% &middot; 8:41 AM &middot; 20 Sep &middot; $0.031</div></div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.55; margin-top: 10px;">{why}</div></div>')

GRID=pan(L,"ONE OF THESE, AT THE SIZE IT WILL ACTUALLY BE USED",
  '<div style="display: flex; flex-wrap: wrap; gap: 20px;">' + "".join(specimen(L,*f) for f in FACES) + '</div>')
LOOK=pan(L,"WHAT YOU ARE ACTUALLY LOOKING AT",
  nt(L,"<b>P7 closes the door on the obvious answer.</b> &ldquo;No webfont is ever loaded&rdquo; is stated in "
       "design-system.md P7, again in &sect;2.3, again in the type table, and again in the brief. So Source Serif, Literata, "
       "Newsreader and every other genuinely contemporary serif are out &mdash; not because they are wrong but because "
       "loading one is a rule change, and that is yours to make, not mine to assume.")
  + nt(L,"<b>You may never have seen the face I recommended last round.</b> <span style=\"font-family: "+MONO+";\">ui-serif</span> "
        "and New York both resolve on Apple <i>natively</i>, but Chrome on macOS does not expose New York to CSS &mdash; so the "
        "board fell through to Georgia or Times, and you judged the fallback. That is also why there is a <b>Times control</b> "
        "in the last card.",12)
  + nt(L,"<b>The native app is not affected by any of this.</b> SwiftUI&rsquo;s <span style=\"font-family: "+MONO+";\">.serif</span> "
        "design gives New York on every current Apple OS, free, with Dynamic Type intact. The stack below only governs the "
        "web console and the PWA.",12))
STACK=pan(L,"RECOMMENDED STACK",
  f'<div style="font-family: {MONO}; font-size: 12.5px; color: {L["tp"]}; background: {L["sunken"]}; border-radius: 8px; padding: 10px 12px;">'
  f'Charter, Sitka, &quot;Sitka Text&quot;, Constantia, Georgia, serif</div>'
  + nt(L,"Charter on Apple, Sitka on Windows 8.1+, Constantia on anything with Office, Georgia everywhere else. <b>Every "
        "step is a screen-first face</b> and Times is never reached. The native apps get New York on top of this for free.",12)
  + nt(L,"<b>If none of these are modern enough</b> &mdash; a legitimate conclusion, because the newest face in the set is "
        "from 2013 &mdash; the question becomes a rule: <i>does agent prose justify the one webfont this product loads?</i> "
        "A single self-hosted subset of one weight is roughly 20 KB and no third-party request. It is logged as a decision "
        "for you.",12))

def darkcard(T,label,stack):
    return (f'<div style="flex: 1; min-width: 0;"><div style="background: {T["agq"]}; border-radius: 10px; padding: 12px 14px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]}; margin-bottom: 6px;">{ASSISTANT_NAME.upper()} &middot; 8:41 AM</div>'
            f'<div style="font-family: {stack}; font-size: 15px; line-height: 1.55; color: {T["tp"]};">{SAMPLE}</div></div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 8px;">{label}</div></div>')

body=(heading("ROUND D · THE ASSISTANT'S VOICE","Six system serifs, and a control",
   "You liked Palatino and Georgia but wanted something more modern, and two things were in the way: P7 rules out every "
   "webfont, and the face recommended last round almost certainly never rendered for you &mdash; Chrome on macOS does not "
   "expose New York to CSS. So here are six system serifs at working size, with a Times card at the end so you can see "
   "which ones actually resolved on your machine.",L)
  + row(GRID,18) + row(LOOK+STACK,18)
  + row(f'<div style="background: {D["bg"]}; border-radius: 14px; padding: 22px; flex-grow: 1;">{sub("DARK",D["tt"])}'
        f'<div style="display: flex; gap: 18px;">' + darkcard(D,"Charter","Charter,serif") + darkcard(D,"Superclarendon","Superclarendon,serif")
        + darkcard(D,"Sitka","Sitka,'Sitka Text',serif") + darkcard(D,"Georgia &mdash; today&rsquo;s fallback","Georgia,serif") + '</div></div>',18))
(PROJ/"Voice.dc.html").write_text(page("The assistant's voice",wrap(body,CW,CH,"#ece7dd",L["tp"],40),CW,CH,"#ece7dd"),encoding="utf-8")
print(f"wrote Voice.dc.html ({CW}x{CH})")
