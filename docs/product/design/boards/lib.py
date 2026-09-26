"""Metistry design canvas — shared machinery.

Tokens, icons, primitives and every component the boards are built from.
Edit this file in place. Do not paste it into a conversation: that is what
made the last pass expensive.

  METISTRY_CANVAS=/path/to/canvas python3 build.py
"""
import os
import pathlib
ROOT=pathlib.Path(os.environ.get("METISTRY_CANVAS","./canvas"))
PROJ=ROOT/"project"
PROJ.mkdir(parents=True,exist_ok=True)   # a board module writes straight into it; a fresh canvas dir should not need mkdir -p first
SANS='-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI Variable Text","Segoe UI",Roboto,Cantarell,"Helvetica Neue",sans-serif'
SERIF="Charter,Sitka,'Sitka Text',Constantia,Georgia,serif"
MONO='ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
L=dict(bg="#f7f4ee",surface="#fffdf8",elevated="#fffdf8",sunken="#efeadf",border="#e4ded1",bs="#c3baa9",bc="#8e8676",ep="#bd2c40",epq="#ede0e1",en="#1b734a",enq="#cfe9dd",ej="#345dcf",ejq="#dee3f0",
 tp="#1a1815",ts="#57514a",tt="#6f6960",acc="#125f6b",accq="#d9e4e1",onacc="#f7f4ee",
 ag="#6a4bbd",agq="#e7e1ef",ok="#1c7a45",okq="#eff4eb",deg="#8a5a00",degq="#efe6d5",
 fail="#b3261e",failq="#f3dbd5",abs="#6f6960",absq="#f2f0ea",stale="#5a6670",staleq="#e8e8e5",
 dest="#b3261e",ondest="#ffffff",aff="#1c6b42",onaff="#ffffff")
D=dict(bg="#0e1216",surface="#171c22",elevated="#212831",sunken="#0b0e12",border="#2b333d",bs="#3d4854",bc="#68717c",ep="#e17d8b",epq="#3b3031",en="#29af71",enq="#1d382b",ej="#7d98e1",ejq="#27324e",
 tp="#e9edf1",ts="#a7b1bc",tt="#8b96a1",acc="#6ec9d6",accq="#25383f",onacc="#07161a",
 ag="#b9a2f5",agq="#313144",ok="#68d391",okq="#243934",deg="#e8b84b",degq="#383529",
 fail="#f4837c",failq="#3a2c30",abs="#8b96a1",absq="#242930",stale="#96a4b0",staleq="#2b3239",
 dest="#8f322c",ondest="#ffeceb",aff="#48b87b",onaff="#04170d")
def ic(d,size=17,sw=1.7):
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="currentColor" '
            f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{d}</svg>')
I=dict(review='<circle cx="11" cy="11" r="5.6"/><path d="M15.2 15.2L20 20"/>',
 spark='<path d="M12 3.4l1.75 4.85 4.85 1.75-4.85 1.75L12 16.6l-1.75-4.85L5.4 10l4.85-1.75z"/><path d="M18.4 15.1l.7 1.95 1.95.7-1.95.7-.7 1.95-.7-1.95-1.95-.7 1.95-.7z"/>',
 up='<path d="M7 20.5V10.5l4.2-7a1.8 1.8 0 012.9 1.9L13 9.5h4.9a2 2 0 011.95 2.45l-1.3 6A2 2 0 0116.6 19.5H7z"/><path d="M7 10.5H4.5v10H7z"/>',
 down='<path d="M17 3.5v10l-4.2 7a1.8 1.8 0 01-2.9-1.9L11 14.5H6.1a2 2 0 01-1.95-2.45l1.3-6A2 2 0 017.4 4.5H17z"/><path d="M17 13.5h2.5v-10H17z"/>',
 chat='<path d="M4.5 5.5h15v9.5h-9l-4 3.5v-3.5h-2z"/>',
 activity='<path d="M3 12.5h3.5l2.2-6 3.2 11.5 2.6-8 1.7 2.5H21"/>',
 work='<path d="M4.5 5.5h15v13h-15z"/><path d="M8 12l2.6 2.6L16 9.6"/>',
 know='<path d="M6 4.5h9.5a2.5 2.5 0 012.5 2.5v12.5H8.5A2.5 2.5 0 016 17z"/><path d="M6 15.5h12"/>',
 agents='<circle cx="9.5" cy="9" r="2.8"/><path d="M4.5 18.5a5 5 0 0110 0"/><path d="M16 7.4a2.6 2.6 0 010 5.2"/><path d="M16.8 14.4a4.6 4.6 0 013.2 4.1"/>',
 gauge='<path d="M4 17a8 8 0 0116 0"/><path d="M12 17l4.2-4.6"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
 chevdn='<path d="M6 9.5l6 6 6-6"/>',
 grip='<path d="M9 6.5h.01M9 12h.01M9 17.5h.01M15 6.5h.01M15 12h.01M15 17.5h.01" stroke-width="2.6"/>',
 board='<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14M15.5 5v14"/>',
 cal='<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10.5h16M8.5 4v4M15.5 4v4"/>',
 copy='<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2"/>',
 person='<circle cx="12" cy="8.5" r="3.2"/><path d="M5.5 19.5a6.5 6.5 0 0113 0"/>',
 promote='<path d="M8 16L16.5 7.5"/><path d="M10 7.5h6.5V14"/>',
 note='<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h4"/>',
 plus='<path d="M12 5.5v13M5.5 12h13"/>',
 clip='<path d="M16.5 7.2L9.3 14.4a2.1 2.1 0 003 3l7.4-7.4a4 4 0 10-5.7-5.7L6.2 11.6a6 6 0 108.5 8.5l6.1-6.1"/>',
 cmd='<path d="M9 9h6v6H9z"/><path d="M9 9V7a2 2 0 10-2 2zM15 9V7a2 2 0 112 2zM9 15v2a2 2 0 11-2-2zM15 15v2a2 2 0 102-2z"/>',
 bell='<path d="M7 10.5a5 5 0 0110 0c0 4 1.4 5.2 1.4 5.2H5.6S7 14.5 7 10.5z"/><path d="M10.4 18.6a1.9 1.9 0 003.2 0"/>',
 
 tray='<path d="M3.5 14.5h4l1.5 2.5h6l1.5-2.5h4"/><path d="M5.5 4.5h13l2 10v3a2 2 0 01-2 2h-13a2 2 0 01-2-2v-3z"/>',
 plug='<path d="M8 3.5v5M16 3.5v5"/><path d="M5.5 8.5h13v3a6.5 6.5 0 01-13 0z"/><path d="M12 18v3"/>',
 warn='<path d="M12 4.8L21 19.2H3z"/><path d="M12 10.4v3.6M12 16.4v.1"/>',
 clock='<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3 1.8"/>',
 later='<path d="M4.2 11a8 8 0 112.2 6.4"/><path d="M4 6.5V11h4.5"/><path d="M12 8.6V12l2.6 1.6"/>',
 book='<path d="M6 4.5h9.5a2.5 2.5 0 012.5 2.5v12.5H8.5A2.5 2.5 0 016 17z"/><path d="M6 15.5h12"/>',
 key='<circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20M17 12v3M20 12v2.4"/>',
 lock='<rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/>',
 undo='<path d="M4 9.5h9a5 5 0 110 10H8"/><path d="M7.5 6L4 9.5 7.5 13"/>',
 check='<path d="M5 12.5l4.5 4.5L19 7.5"/>',
 x='<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
 pencil='<path d="M4.5 19.5h4L19 9a2.5 2.5 0 00-3.5-3.5L5 16z"/><path d="M14 7l3 3"/>',
 chevd='<path d="M6 9.5l6 6 6-6"/>',
 chevr='<path d="M9 6l6 6-6 6"/>')
# `repeat` lives here rather than beside its first use: module-level panels are built at
# import time, so an icon added later in the file does not exist when they render.
I["repeat"]='<path d="M4 12a8 8 0 0113.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 01-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>'
I["mic"]='<rect x="9" y="3.5" width="6" height="10" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0"/><path d="M12 18v2.5M8.5 20.5h7"/>'
I["eye"]='<path d="M2.8 12S6.5 6 12 6s9.2 6 9.2 6-3.7 6-9.2 6-9.2-6-9.2-6z"/><circle cx="12" cy="12" r="2.6"/>'
I["stop"]='<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'
I["send"]='<path d="M4.5 12h14.5"/><path d="M12.5 5.5L19 12l-6.5 6.5"/>'
I["display"]='<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>'

from fixture import F
ASSISTANT_NAME="Metis"   # C88: the name the owner configures, default Metis — every attribution label reads it
AN=ASSISTANT_NAME.upper()
I["failed"]='<circle cx="12" cy="12" r="8.2"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>'
I["relay"]='<rect x="7.5" y="6.5" width="9" height="11" rx="2.2"/><path d="M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
I["ask"]='<path d="M5 5.5h14v10h-8.5L6 19v-3.5H5z"/><path d="M10.3 9.1a1.8 1.8 0 113.1 1.3c-.7.5-1.4.8-1.4 1.7"/><circle cx="12" cy="13.9" r=".55" fill="currentColor" stroke="none"/>'

def page(title,body,w,h,ground):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body {{ margin: 0; font-family: {SANS}; background: {ground}; }}
a {{ color: #125f6b; }} a:hover {{ color: #0d4a54; }}
</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}
</script>
</body>
</html>
'''
def wrap(b,w,h,g,ink,pad=40):
    return (f'<div style="width: {w}px; height: {h}px; box-sizing: border-box; padding: {pad}px; '
            f'display: flex; flex-direction: column; gap: 22px; background: {g}; color: {ink};">{b}</div>')
def heading(k,n,l,T):
    return (f'<div style="display: flex; flex-direction: column; gap: 6px;">'
            f'<div style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: {T["ts"]};">{k}</div>'
            f'<div style="font-size: 22px; font-weight: 600; letter-spacing: -0.01em; color: {T["tp"]};">{n}</div>'
            f'<div style="font-size: 13px; color: {T["ts"]}; max-width: 1180px; line-height: 1.5;">{l}</div></div>')
def sub(t,c): return (f'<div style="font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: {c}; '
                      f'margin-bottom: 14px;">{t}</div>')
def card(inner,T,pad=22,grow=True):
    g="flex-grow: 1; flex-basis: 0;" if grow else ""
    return (f'<div style="{g} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 14px; '
            f'padding: {pad}px; box-sizing: border-box;">{inner}</div>')
def row(i,gap=18,align="stretch"): return f'<div style="display: flex; gap: {gap}px; align-items: {align};">{i}</div>'
def mono(t,c,s=12): return f'<span style="font-family: {MONO}; font-size: {s}px; color: {c};">{t}</span>'
def pill(T,text,fg,bg,glyph=None):
    g=(f'{ic(glyph,11,2.2)}') if glyph else ""
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; '
            f'border-radius: 999px; background: {bg}; color: {fg}; font-size: 11px; font-weight: 500; '
            f'white-space: nowrap;">{g}{text}</span>')

# ---------------- refined status row: fixed columns, pill welded to the name ----------------
def statusrow(T,name,probe,label,tint,age=None,last=False):
    bd="" if last else f'border-bottom: 1px solid {T["border"]};'
    ag=pill(T,age,T["stale"],T["staleq"],I["clock"]) if age else ""
    return (f'<li style="display: grid; grid-template-columns: 9px minmax(0,1fr) 116px 96px; align-items: center; '
            f'gap: 12px; padding: 11px 16px; {bd} list-style: none;">'
            f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {tint};"></span>'
            f'<span style="display: flex; align-items: center; gap: 8px; min-width: 0;">'
            f'<span style="font-size: 13px; color: {T["tp"]}; overflow: hidden; text-overflow: ellipsis; '
            f'white-space: nowrap;">{name}</span>{ag}</span>'
            f'<span style="text-align: right;">{mono(probe,T["ts"],11.5)}</span>'
            f'<span style="font-size: 11px; font-weight: 600; color: {tint}; text-align: right;">{label}</span></li>')

def panel_state(T,glyph,tint,title,body,action=None,reason=None):
    act=(f'<button style="font: inherit; font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 8px; '
         f'border: 1px solid {T["bs"]}; background: {T["surface"]}; color: {T["tp"]}; margin-top: 14px;">{action}</button>') if action else ""
    rz=(f'<div style="margin-top: 10px; padding: 8px 10px; background: {T["sunken"]}; border-radius: 8px;">'
        f'{mono(reason,T["ts"],11.5)}</div>') if reason else ""
    return (f'<div style="display: flex; flex-direction: column; align-items: center; text-align: center; padding: 26px 18px;">'
            f'<span style="display: flex; color: {tint};">{ic(glyph,26,1.6)}</span>'
            f'<div style="font-size: 13px; font-weight: 600; color: {T["tp"]}; margin-top: 12px;">{title}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 5px; max-width: 250px; line-height: 1.5;">{body}</div>'
            f'{rz}{act}</div>')

def states_panel(T,name):
    rows=(f'<ul style="margin: 0; padding: 0; background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px;">'
          + statusrow(T,"postgres","tcp 5432","ok",T["ok"])
          + statusrow(T,"aws-costs","collector","ok",T["ok"],age="3d")
          + statusrow(T,"slack-bridge","bridge","not configured",T["abs"])
          + statusrow(T,"github-state","collector","failed",T["fail"],last=True)+'</ul>')
    panels=row(card(panel_state(T,I["tray"],T["tt"],"Nothing in the last 24h","Activity fills as agents work and collectors run."),T)
      + card(panel_state(T,I["plug"],T["abs"],"Not configured",
             'Set <span style="font-family: '+MONO+'; font-size: 11px;">METISTRY_AWS_*</span> to fill this in.',action="Open the doc"),T)
      + card(panel_state(T,I["failed"],T["fail"],"Could not read spend","The collector answered, and the answer was an error.",
             reason="over_cap · aws-costs · run 4f21",action="Try Again"),T),14)
    stale=(f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; padding: 18px;">'
           f'<div style="display: flex; align-items: center; gap: 10px;">'
           f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: {T["tt"]};">AWS SPEND · 30D</span>'
           f'{pill(T,"3d old",T["stale"],T["staleq"],I["clock"])}</div>'
           f'<div style="font-size: 30px; font-weight: 600; color: {T["tp"]}; margin-top: 10px;">$128.44</div>'
           f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 4px;">last collected 16 Sep, 4:10 AM</div></div>')
    disabled=(f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; padding: 18px;">'
              f'<div style="display: flex; gap: 8px; align-items: center;">'
              f'<button disabled style="font: inherit; font-size: 12px; font-weight: 600; padding: 7px 15px; '
              f'border-radius: 8px; border: 0; background: {T["sunken"]}; color: {T["tt"]};">Approve</button>'
              f'<button disabled style="font: inherit; font-size: 12px; font-weight: 600; padding: 7px 15px; '
              f'border-radius: 8px; border: 1px solid {T["border"]}; background: transparent; color: {T["tt"]};">Decline</button></div>'
              f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 12px; color: {T["stale"]};">'
              f'{ic(I["lock"],14,1.8)}<span style="font-size: 12px;">the instance is unreachable — decisions are never queued</span></div></div>')
    return (f'<div style="flex-grow: 1; flex-basis: 0; display: flex; flex-direction: column; gap: 16px; '
            f'background: {T["bg"]}; border-radius: 16px; padding: 24px; box-sizing: border-box;">'
            f'<div style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: {T["tt"]};">{name}</div>'
            f'{sub("IN A ROW — FOUR COLUMNS, AND THE AGE RIDES THE NAME",T["tt"])}{rows}'
            f'{sub("AS A PANEL — EMPTY, ABSENT, FAILED. EACH REPLACES THE CONTENT",T["tt"])}{panels}'
            f'{sub("STALE NEVER REPLACES CONTENT — IT ANNOTATES IT",T["tt"])}{stale}'
            f'{sub("A CONTROL THAT IS OFF BECAUSE OF A FACT, NOT A SELECTION",T["tt"])}{disabled}</div>')

SW,SH=1860,1460
copy=(f'<div style="background: {L["surface"]}; border: 1px solid {L["border"]}; border-radius: 14px; padding: 22px;">'
      + sub("THE FOUR, AND WHY THEY ARE NOT ONE PATTERN",L["tt"])
      + '<table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
      + f'<tr style="color: {L["tt"]}; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.06em;">'
        f'<th style="padding: 0 12px 8px 0;">STATE</th><th style="padding: 0 12px 8px 0;">MEANS</th>'
        f'<th style="padding: 0 12px 8px 0;">REPLACES CONTENT?</th><th style="padding: 0 0 8px 0;">THE SENTENCE</th></tr>'
      + "".join(f'<tr style="border-top: 1px solid {L["border"]};">'
        f'<td style="padding: 9px 12px 9px 0; color: {t}; font-weight: 600; white-space: nowrap;">{n}</td>'
        f'<td style="padding: 9px 12px 9px 0; color: {L["ts"]};">{m}</td>'
        f'<td style="padding: 9px 12px 9px 0; color: {L["tp"]};">{r}</td>'
        f'<td style="padding: 9px 0; color: {L["ts"]};">{s}</td></tr>'
        for n,t,m,r,s in [
          ("empty",L["tt"],"nothing has happened yet","yes","“nothing in the last 24h”"),
          ("absent",L["abs"],"never configured — a fact, not a fault","yes",'“not configured — set <span style="font-family: '+MONO+'; font-size: 11px;">METISTRY_AWS_*</span> to fill this in”'),
          ("failed",L["fail"],"it answered, and the answer was an error","yes","“could not read spend” + the reason verbatim"),
          ("stale",L["stale"],"it was answering and has not lately","<b>no — it annotates</b>","“3d” beside the name; the row keeps its own state")])
      + '</table></div>')
def btn(T,label,kind="secondary",glyph=None,icon_only=False,title=None,spark=False):
    # C92: the one filled answer is the accent. "affirm" kept as the name so call sites read as before.
    if kind in ("affirm","primary"): st=f'border: 0; background: {T["acc"]}; color: {T["onacc"]};'
    elif kind=="dest": st=f'border: 0; background: {T["dest"]}; color: {T["ondest"]};'
    elif kind=="disabled": st=f'border: 1px solid {T["border"]}; background: transparent; color: {T["tt"]};'
    elif kind=="ghost": st=f'border: 1px solid {T["bc"]}; background: transparent; color: {T["ts"]};'
    else: st=f'border: 1px solid {T["bc"]}; background: {T["surface"]}; color: {T["tp"]};'
    tt=f' title="{title}" aria-label="{title}"' if title else ""
    # the spark keeps the agent hue wherever it lands, so an AI action is findable at a glance
    gcol = f'color: {T["ag"]};' if (spark or glyph is I["spark"]) else ""
    if icon_only:
        return (f'<button{tt} style="font: inherit; padding: 0; width: 30px; height: 30px; border-radius: 8px; '
                f'display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; {st}">'
                f'<span style="display: flex; {gcol}">{ic(glyph,15,1.9)}</span></button>')
    g=(f'<span style="display: inline-flex; margin-right: 6px; {gcol}">{ic(glyph,13,2.2)}</span>') if glyph else ""
    return (f'<button{tt} style="font: inherit; font-size: 12px; font-weight: 600; padding: 7px 13px; '
            f'border-radius: 8px; display: inline-flex; align-items: center; white-space: nowrap; {st}">{g}{label}</button>')

def actions(T,icons=True,disabled=False):
    g=lambda k: (I[k] if icons else None)
    k=lambda kind: "disabled" if disabled else kind   # C63: a disabled control takes a dimmer ink, never opacity
    return (f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
            f'{btn(T,"Approve",k("affirm"),g("check"))}{btn(T,"Revise",k("secondary"),g("pencil"))}'
            f'{btn(T,"Decline",k("secondary"),g("x"))}'
            f'<span style="flex-grow: 1;"></span>'
            f'{btn(T,"","ghost",I["later"],icon_only=True,title="Review later")}</div>')

def scope_preview(T,expanded=False):
    head=(f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
          f'margin-bottom: 9px;">WHAT APPROVE DOES</div>')
    add=(f'<div style="display: flex; align-items: baseline; gap: 9px;">'
         f'<span style="font-size: 12px; color: {T["ts"]};">Adds</span>'
         f'<span style="font-family: {MONO}; font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Areas/Finance</span></div>')
    chev = I["chevd"] if expanded else I["chevr"]
    disc=(f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 10px; color: {T["acc"]}; '
          f'font-size: 11.5px; font-weight: 600;">{ic(chev,12,2.4)}'
          f'<span>It would then read 4 folders</span></div>')
    full=""
    if expanded:
        full=('<div style="margin-top: 9px; display: flex; flex-direction: column; gap: 4px; padding-left: 18px;">'
              + "".join(f'<div style="display: flex; align-items: baseline; gap: 8px;">'
                        f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["tp"] if new else T["ts"]}; '
                        f'font-weight: {600 if new else 400};">{p}</span>'
                        + (f'<span style="font-size: 10.5px; font-weight: 600; color: {T["aff"]};">new</span>' if new else "")
                        + '</div>'
                for p,new in [("Areas/Projects",False),("Areas/Ops",False),("Areas/Personal",False),("Areas/Finance",True)])
              + '</div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 14px; margin-top: 12px;">'
            f'{head}{add}{disc}{full}</div>')

def note_preview(T):
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 14px; margin-top: 12px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 9px;">WHAT APPROVE DOES</div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px;">'
            f'<span style="font-size: 12px; color: {T["ts"]};">Writes</span>'
            f'<span style="font-family: {MONO}; font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Areas/Ops/leases.md</span></div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px; margin-top: 6px;">'
            f'<span style="font-size: 12px; color: {T["ts"]};">Adds</span>'
            f'<span style="font-size: 12.5px; color: {T["tp"]};">task #418 to the board</span></div></div>')

def head_row(T,glyph,typ,agent,when):
    return (f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(glyph,15,1.8)}</span>'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-family: {MONO}; font-size: 11px; padding: 1px 7px; border-radius: 5px; '
            f'background: {T["agq"]}; color: {T["ag"]};">{agent}</span>'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>')

def reqcard(T,*,glyph,typ,title,agent,when,prev="",acts=True,icons=True,state="pending",width=None):
    w=f"width: {width}px;" if width else ""
    ttl=(f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-top: 10px; line-height: 1.35;">{title}</div>') if title else ""
    if state=="approved":
        return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
                f'padding: 16px; box-sizing: border-box;">{head_row(T,glyph,typ,agent,when)}'
                f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 12px;">'
                f'<span style="display: flex; color: {T["aff"]};">{ic(I["check"],16,2.2)}</span>'
                f'<span style="font-size: 12.5px; color: {T["ts"]}; flex-grow: 1;">Approved · '
                f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["tp"]};">Areas/Finance</span> granted</span>'
                f'<span style="display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; '
                f'color: {T["acc"]};">{ic(I["undo"],13,2)}Undo</span></div></div>')
    if state=="stale":
        return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["stale"]}; border-radius: 12px; '
                f'padding: 16px; box-sizing: border-box;">{head_row(T,glyph,typ,agent,when)}{ttl}'
                f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["staleq"]}; '
                f'border-radius: 9px; padding: 10px 12px; margin-top: 12px;">'
                f'<span style="display: flex; color: {T["stale"]}; flex-shrink: 0;">{ic(I["clock"],14,2)}</span>'
                f'<span style="font-size: 12px; color: {T["stale"]}; line-height: 1.5;">This moved while the card was open, '
                f'so nothing was sent. The card below is the current version.</span></div></div>')
    a=actions(T,icons,disabled=(state=="deciding")) if acts else ""
    return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 16px; box-sizing: border-box;">{head_row(T,glyph,typ,agent,when)}{ttl}{prev}{a}</div>')

# `bellpanel()` was removed in round E: its header read "4 waiting · 1 snoozed", and
# C21 established that the query cannot count snoozed rows. `panel2()` is the
# corrected panel — use it.


# ===================== NEEDS YOU — bell, panel, list ======================
def bell(T,count=None,size=18):
    badge=""
    if count:
        badge=(f'<span style="position: absolute; top: -5px; right: -7px; background: {T["acc"]}; color: {T["onacc"]}; '
               f'font-size: 9px; font-weight: 700; border-radius: 999px; padding: 0 5px; line-height: 15px;">{count}</span>')
    return (f'<span style="position: relative; display: inline-flex; color: {T["ts"]};">{ic(I["bell"],size)}{badge}</span>')

def bellcase(T,count,label,why):
    return (f'<div style="display: flex; gap: 14px; align-items: flex-start;">'
            f'<span style="width: 40px; height: 34px; display: inline-flex; align-items: center; justify-content: center; '
            f'flex-shrink: 0; border: 1px solid {T["border"]}; border-radius: 8px; background: {T["surface"]};">'
            f'{bell(T,count)}</span>'
            f'<div style="min-width: 0;"><div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{label}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5; margin-top: 3px;">{why}</div></div></div>')

def trustmark(T,kind):
    if kind=="internal": return ""
    fg,bg,txt = (T["ts"],T["absq"],"external" if kind=="external" else "you")   # provenance, not a fault (amendments §8.3)
    return (f'<span style="display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; '
            f'background: {bg}; color: {fg}; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;">{txt}</span>')

def grouplabel(T,t,n):
    return (f'<div style="display: flex; align-items: baseline; gap: 7px; padding: 2px 4px 0;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{t}</span>'
            f'<span style="font-size: 10.5px; color: {T["tt"]};">{n}</span></div>')

def panel2(T,empty=False,w=400):
    head=(f'<div style="padding: 14px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
          + ("" if empty else f'<span style="font-size: 12px; color: {T["ts"]};">4 waiting</span>')
          + '</div>'
          + ("" if empty else
             f'<div style="display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap;">'
             + "".join(f'<span style="padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; '
                       f'background: {T["accq"] if s else "transparent"}; color: {T["acc"] if s else T["ts"]}; '
                       f'border: 1px solid {"transparent" if s else T["bc"]};">{t}</span>'
                       for t,s in [("All",True),("Access",False),("Notes",False),("Reviews",False)])
             + '</div>') + '</div>')
    if empty:
        body=(f'<div style="padding: 38px 24px; text-align: center; background: {T["bg"]};">'
              f'<span style="display: inline-flex; color: {T["tt"]}; margin-bottom: 10px;">{ic(I["check"],24,1.6)}</span>'
              f'<div style="font-size: 13.5px; font-weight: 600; color: {T["tp"]};">Nothing needs you.</div>'
              f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5; margin-top: 5px;">'
              f'Agents are working and nothing is waiting on a decision.</div></div>')
        foot=""
    else:
        a=reqcard(T,glyph=I["key"],typ="ACCESS",title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
                  agent="drey-dev",when="12m",prev=scope_preview(T))
        b=reqcard(T,glyph=I["book"],typ="NOTE",title="Keep the note on lease renewal",agent="metis",when="1h",
                  prev=note_preview(T))
        body=(f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
              + grouplabel(T,"ACCESS","2") + a + grouplabel(T,"NOTES","1") + b + '</div>')
        foot=(f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]};">'
              f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Open Needs You →</span></div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; display: flex; flex-direction: column; '
            f'flex-shrink: 0;">{head}{body}{foot}</div>')

# ---- the full list -------------------------------------------------------
def cb(T,on=False):
    return (f'<span style="width: 15px; height: 15px; border-radius: 4px; flex-shrink: 0; display: inline-flex; '
            f'align-items: center; justify-content: center; margin-top: 2px; '
            + (f'background: {T["acc"]}; color: {T["onacc"]};">{ic(I["check"],10,3)}' if on
               else f'border: 1px solid {T["bc"]};">') + '</span>')

def listrow(T,glyph,typ,title,agent,when,sel=False,trust="internal",result=None,last=False):
    tint = T["accq"] if sel else "transparent"
    res=""
    if result:
        ok,txt=result
        res=(f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 12px; '
             f'color: {T["tp"]};">'
             f'<span style="display: flex; color: {T["ok"] if ok else T["deg"]};">'
             f'{ic(I["check"] if ok else I["later"],12,2.4)}</span><span>{txt}</span></div>')
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 12px 16px; background: {tint};'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{cb(T,sel)}'
            f'<span style="display: flex; flex-shrink: 0; color: {T["tt"]}; margin-top: 1px;">{ic(glyph,17,1.8)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ts"]};">{typ}</span>'
            f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["ag"]};">{agent}</span>'
            f'{trustmark(T,trust)}</div>'
            f'<div style="font-size: 13.5px; font-weight: 500; color: {T["tp"]}; margin-top: 3px;">{title}</div>{res}</div>'
            f'<span style="flex-shrink: 0; font-size: 12.5px; color: {T["ts"]}; margin-top: 2px;">{when}</span></div>')

LIST=[(I["key"],"ACCESS",'Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',"drey-dev","12m","internal"),
      (I["key"],"ACCESS","Write to the release notes folder","taskuary","41m","external"),
      (I["book"],"NOTE","Keep the note on lease renewal","metis","1h","internal"),
      (I["book"],"NOTE","Keep the note on Q4 compute pricing","metis","2h","internal"),
      (I["key"],"ACCESS","Enroll a new agent on the Studio","—","3h","external")]

def fulllist(T,mode="select",w=760):
    n=3 if mode!="plain" else 0
    bar=""
    if mode=="select":
        bar=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: {T["accq"]}; '
             f'border-bottom: 1px solid {T["border"]};">'
             f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{n} selected</span>'
             f'<span style="flex-grow: 1;"></span>'
             f'{btn(T,"Later","secondary",I["later"])}{btn(T,"Skip","secondary")}{btn(T,"Decline","secondary",I["x"])}'
             f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]}; margin-left: 4px;">Clear</span></div>')
    if mode=="result":
        bar=(f'<div style="display: flex; align-items: flex-start; gap: 10px; padding: 11px 16px; background: {T["degq"]}; '
             f'border-bottom: 1px solid {T["border"]};">'
             f'<span style="display: flex; color: {T["deg"]}; margin-top: 1px;">{ic(I["later"],15,2)}</span>'
             f'<div style="flex-grow: 1;">'
             f'<div style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">2 of 3 declined.</div>'
             f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5; margin-top: 2px;">'
             f'One was answered somewhere else while this was open. It is still selected — nothing was lost and '
             f'nothing was re-sent.</div></div>'
             f'{btn(T,"Try Again","secondary")}</div>')
    rows=""
    for i,(g,t,ti,a,w2,tr) in enumerate(LIST):
        sel = (mode in ("select","result")) and i<3
        res=None
        if mode=="result" and i<3:
            res=(True,"declined") if i<2 else (False,"answered on another device 30s ago")
        rows+=listrow(T,g,t,ti,a,w2,sel=sel,trust=tr,result=res,last=(i==len(LIST)-1))
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; background: {T["surface"]}; '
          f'border-bottom: 1px solid {T["border"]};">'
          f'<span style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
          f'<span style="font-size: 12.5px; color: {T["ts"]}; flex-grow: 1;">{len(LIST)} waiting</span>'
          f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Select all on this page</span></div>')
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{head}{bar}{rows}</div>')

def sheet(T,w=330):
    a=reqcard(T,glyph=I["key"],typ="ACCESS",title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
              agent="drey-dev",when="12m")
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 16px 16px 0 0; overflow: hidden; flex-shrink: 0;">'
            f'<div style="display: flex; justify-content: center; padding: 8px 0 2px;">'
            f'<span style="width: 34px; height: 4px; border-radius: 999px; background: {T["bc"]};"></span></div>'
            f'<div style="padding: 8px 16px 12px; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: baseline; gap: 8px;">'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">4 waiting</span></div></div>'
            f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
            f'{grouplabel(T,"ACCESS","2")}{a}</div>'
            f'<div style="padding: 13px 16px; border-top: 1px solid {T["border"]}; text-align: center;">'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["acc"]};">Open Needs You</span></div></div>')

def pan(T,title,inner,w=None):
    return (f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 14px; padding: 22px;'
            + (f' width: {w}px; flex-shrink: 0;' if w else ' flex-grow: 1; flex-basis: 0; min-width: 0;')
            + f'">{sub(title,T["tt"])}{inner}</div>')
def nt(T,html,mt=0):
    return f'<div style="font-size: 12.5px; color: {T["ts"]}; line-height: 1.6; margin-top: {mt}px;">{html}</div>'


# ========================= CAPTURE COMPOSER ==============================
def filechip(T,name="lease-renewal.pdf",size="184 KB"):
    return (f'<span style="display: inline-flex; align-items: center; gap: 8px; padding: 5px 7px 5px 10px; '
            f'border-radius: 9px; background: {T["sunken"]}; border: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["clip"],13,1.9)}</span>'
            f'<span style="font-size: 12.5px; font-weight: 500; color: {T["tp"]};">{name}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{size}</span>'
            f'<span style="display: flex; color: {T["tt"]}; margin-left: 2px;">{ic(I["x"],13,2.2)}</span></span>')

def receipt(T,mode):
    """mode: none | pending | done | queued | failed"""
    if mode=="none": return ""
    if mode=="pending":
        g,c,txt=(ic(I["later"],13,2.2),T["ts"],"capturing… you can close this")
    elif mode=="done":
        g,c,txt=(ic(I["check"],13,2.6),T["ok"],
                 f'captured → inbox #418 · {mono("Inbox/2026-09-20-note.md",T["ts"],11.5)}')
    elif mode=="queued":
        g,c,txt=(ic(I["clock"],13,2.2),T["deg"],"queued — will send when the instance is reachable")
    else:
        g,c,txt=(ic(I["failed"],13,2.2),T["fail"],"couldn’t reach the instance — <b>connection refused</b>")
    return (f'<div style="display: flex; align-items: flex-start; gap: 7px; margin-top: 11px; font-size: 12px; '
            f'color: {T["ts"]}; line-height: 1.45;">'
            f'<span style="display: flex; color: {c}; margin-top: 1px; flex-shrink: 0;">{g}</span>'
            f'<span style="min-width: 0;">{txt}</span></div>')

PLACEHOLDER="note…"
BODY=("Ask the landlord whether the March renewal can hold the 4% the block is "
      "listing at, and get it in writing before the 60-day notice.")

def composer(T,*,state="empty",w=380):
    txt = PLACEHOLDER if state=="empty" else BODY
    col = T["tt"] if state=="empty" else T["tp"]
    field=(f'<div style="min-height: 66px; font-size: 14px; line-height: 1.5; color: {col};">{txt}</div>')
    attach = f'<div style="margin-top: 10px;">{filechip(T)}</div>' if state in ("attaching","failed") else ""
    disabled = state=="sending"
    prim=(f'<button style="font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 15px; border-radius: 8px; '
          f'border: 0; background: {T["sunken"] if disabled else T["acc"]}; color: {T["tt"] if disabled else T["onacc"]};">Capture</button>')
    rmode={"empty":"none","typing":"none","attaching":"none","sending":"pending",
           "captured":"done","queued":"queued","failed":"failed"}[state]
    extra=""
    if state=="failed":
        extra=(f'<div style="display: flex; gap: 8px; margin-top: 10px;">{btn(T,"Try Again","secondary")}'
               f'{btn(T,"Copy the Text","ghost")}</div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); padding: 16px; flex-shrink: 0;">'
            f'<div style="border: 1px solid {T["bc"]}; border-radius: 10px; padding: 11px 12px; background: {T["surface"]};">'
            f'{field}</div>{attach}'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 12px;">'
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 8px; '
            f'border: 1px solid {T["bc"]}; color: {T["ts"]}; font-size: 12px; font-weight: 500;">'
            f'{ic(I["clip"],13,1.9)}Attach</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="display: inline-flex; align-items: center; gap: 3px; color: {T["tt"]}; font-size: 11.5px;">'
            f'{ic(I["cmd"],12,1.6)}↩</span>{prim}</div>{receipt(T,rmode)}{extra}</div>')

def statecase(T,state,label,why,w=380):
    return (f'<div style="display: flex; flex-direction: column; gap: 10px;">'
            f'<div><div style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{label}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5; margin-top: 3px; max-width: {w}px;">{why}</div></div>'
            f'{composer(T,state=state,w=w)}</div>')

def plusbtn(T,size=18,filled=False):
    if filled:
        return (f'<span style="width: 46px; height: 46px; border-radius: 999px; background: {T["acc"]}; '
                f'color: {T["onacc"]}; display: inline-flex; align-items: center; justify-content: center; '
                f'box-shadow: 0 5px 16px rgba(26,24,21,0.22);">{ic(I["plus"],22,2.1)}</span>')
    return f'<span style="display: inline-flex; color: {T["acc"]};">{ic(I["plus"],size,1.9)}</span>'

def macframe(T,w=330):
    nav="".join(f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 7px; '
                f'background: {T["accq"] if s else "transparent"};">'
                f'<span style="width: 15px; height: 15px; border-radius: 4px; background: {T["acc"] if s else T["tt"]}; '
                f'opacity: {1 if s else 0.5};"></span>'
                f'<span style="font-size: 12px; font-weight: {600 if s else 500}; color: {T["tp"]};">{n}</span></div>'
        for n,s in [("Chat",True),("Activity",False),("Work",False)])
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 10px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">'
            f'<div style="display: flex; align-items: center; gap: 9px; padding: 9px 12px; background: {T["surface"]}; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 12px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Metistry</span>'
            f'{plusbtn(T,17)}{bell(T,"4",16)}</div>'
            f'<div style="display: flex; height: 168px;">'
            f'<div style="width: 132px; background: {T["sunken"]}; border-right: 1px solid {T["border"]}; '
            f'padding: 9px 7px; display: flex; flex-direction: column;">{nav}'
            f'<span style="flex-grow: 1;"></span>'
            f'<div style="display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid {T["border"]};">'
            f'{plusbtn(T,16)}<span style="font-size: 11.5px; font-weight: 500; color: {T["ts"]};">Capture</span></div></div>'
            f'<div style="flex-grow: 1;"></div></div></div>')

def phoneframe(T,w=200):
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 18px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0; position: relative; height: 230px;">'
            f'<div style="padding: 12px 14px 8px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Activity</div></div>'
            + "".join(f'<div style="padding: 9px 14px; border-bottom: 1px solid {T["border"]};">'
                      f'<div style="height: 7px; width: {x}%; border-radius: 3px; background: {T["border"]};"></div>'
                      f'<div style="height: 6px; width: {x-22}%; border-radius: 3px; background: {T["sunken"]}; '
                      f'margin-top: 6px;"></div></div>' for x in (72,58,80))
            + f'<div style="position: absolute; right: 14px; bottom: 44px;">{plusbtn(T,filled=True)}</div>'
              f'<div style="position: absolute; left: 0; right: 0; bottom: 0; height: 34px; background: {T["surface"]}; '
              f'border-top: 1px solid {T["border"]};"></div></div>')

def capsheet(T,w=300):
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 16px 16px 0 0; overflow: hidden; flex-shrink: 0; padding-bottom: 4px;">'
            f'<div style="display: flex; justify-content: center; padding: 8px 0 4px;">'
            f'<span style="width: 34px; height: 4px; border-radius: 999px; background: {T["bc"]};"></span></div>'
            f'<div style="padding: 4px 14px 14px;">'
            f'<div style="border: 1px solid {T["bc"]}; border-radius: 10px; padding: 11px 12px; background: {T["surface"]}; '
            f'min-height: 70px; font-size: 14px; line-height: 1.5; color: {T["tp"]};">{BODY}</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 11px;">'
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 8px; '
            f'border: 1px solid {T["bc"]}; color: {T["ts"]}; font-size: 12.5px; font-weight: 500;">'
            f'{ic(I["clip"],13,1.9)}Attach</span><span style="flex-grow: 1;"></span>'
            f'<button style="font: inherit; font-size: 13px; font-weight: 600; padding: 8px 17px; border-radius: 8px; '
            f'border: 0; background: {T["acc"]}; color: {T["onacc"]};">Capture</button></div></div></div>')


# ============================== TODAY ====================================
def box(T,checked=False):
    if checked:
        return (f'<span style="width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; display: inline-flex; '
                f'align-items: center; justify-content: center; background: {T["acc"]}; color: {T["onacc"]};">'
                f'{ic(I["check"],11,3)}</span>')
    return (f'<span style="width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; '
            f'border: 1px solid {T["bc"]};"></span>')

def chip(T,text,fg,bg,glyph=None,strong=False):
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: {2 if not strong else 2.5}px 8px; '
            f'border-radius: 999px; background: {bg}; color: {fg}; font-size: 11px; '
            f'font-weight: {700 if strong else 600}; white-space: nowrap;">'
            + (f'<span style="display: flex;">{ic(glyph,11,2.2)}</span>' if glyph else "") + f'{text}</span>')

def carry(T,n):
    """1 -> nothing. 2 -> neutral. 3-4 -> degraded quiet. 5+ -> degraded strong."""
    if n<2: return ""
    label={2:"2nd day",3:"3rd day",4:"4th day"}.get(n,f"{n}th day")
    if n==2:  return chip(T,label,T["ts"],T["absq"])
    if n<5:   return chip(T,label,T["deg"],T["degq"])
    return chip(T,label,T["deg"],T["degq"],glyph=I["clock"],strong=True)

def reason(T,parts):
    return (f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.45; margin-top: 3px;">'
            + ' <span style="opacity: 0.5;">·</span> '.join(parts) + '</div>')

def trow(T,*,kind="md",title,bits,done=False,carried=0,chips2=None,warn=None,last=False,drag=True,sel=False):
    """kind: md (a line in your note) | work (a row on the board)"""
    lead = box(T,done) if kind=="md" else (
        f'<span style="display: flex; flex-shrink: 0; color: {T["ag"]}; width: 16px;">{ic(I["board"],16,1.8)}</span>')
    extra="".join(chips2 or [])
    w=""
    if warn:
        w=(f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11.5px; '
           f'color: {T["ts"]};"><span style="display: flex; color: {T["deg"]};">{ic(I["warn"],12,2.1)}</span>{warn}</div>')
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 11px 14px; '
            f'background: {T["accq"] if sel else "transparent"};'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            + (f'<span style="display: flex; flex-shrink: 0; color: {T["tt"]}; margin-top: 1px;">'
               f'{ic(I["grip"],15,2.6)}</span>' if drag else "")
            + f'<span style="margin-top: 1px; display: flex;">{lead}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
            f'<span style="font-size: 14px; color: {T["tp"]}; '
            + (f"text-decoration: line-through; color: {T['tt']};" if done else "") + f'">{title}</span>'
            f'{carry(T,carried)}{extra}</div>{reason(T,bits)}{w}</div></div>')

def meter(T,planned,cap):
    over = planned>cap
    fill = min(planned,cap)/max(planned,cap)*100
    ov   = 0 if not over else (planned-cap)/planned*100
    label=(f'{planned} of {cap} min planned' if not over
           else f'{planned} of {cap} min planned <span style="color: {T["deg"]}; font-weight: 600;">· {planned-cap} over</span>')
    return (f'<div>'
            f'<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">CAPACITY</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{label}</span></div>'
            f'<div style="display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: {T["sunken"]};">'
            f'<div style="width: {fill:.1f}%; background: {T["acc"]};"></div>'
            + (f'<div style="width: {ov:.1f}%; background: {T["deg"]};"></div>' if over else "")
            + '</div></div>')

def standup(T):
    lines=["Yesterday — shipped the tokens pass; reviewed drey-dev's migration.",
           "Today — the settings pane; the lease note.",
           "Blockers — waiting on the SOW signature."]
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 12px; background: {T["surface"]}; '
            f'overflow: hidden;">'
            f'<div style="display: flex; align-items: center; gap: 9px; padding: 11px 14px; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Standup draft</span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">9:15 AM</span>'
            f'{btn(T,"Copy","secondary",I["copy"])}</div>'
            f'<div style="padding: 12px 14px; font-size: 12.5px; line-height: 1.6; color: {T["tp"]};">'
            + "".join(f'<div>{l}</div>' for l in lines)
            + f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 10px; padding-top: 9px; '
              f'border-top: 1px solid {T["border"]};">Metistry does not post this. Copy it and paste it yourself.</div>'
            f'</div></div>')

def seg(T,active="Today"):
    return (f'<div style="display: inline-flex; border: 1px solid {T["bc"]}; border-radius: 8px; overflow: hidden;">'
            + "".join(f'<span style="padding: 4px 14px; font-size: 12.5px; font-weight: 600; '
                      f'background: {T["acc"] if n==active else "transparent"}; '
                      f'color: {T["onacc"] if n==active else T["ts"]};">{n}</span>' for n in ("Today","All"))
            + '</div>')

def todayhead(T,stale="2 min ago"):
    return (f'<div style="padding: 14px 16px 13px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Today</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{F["day"]}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">as of {stale}</span>'
            f'{seg(T)}</div>{meter(T,285,240)}</div>')

MD_ROWS=[
 dict(kind="md",title="Write the design brief for the settings pane",
      bits=["due Wed","P1","~45m",f'blocking <b>work #418</b>'],carried=0),
 dict(kind="md",title="Call the dentist",bits=["overdue by 2 days","P2","~15m"],carried=5),
 dict(kind="md",title="Sign the SOW",bits=["due today","P1","~15m","waiting on Jim"],carried=2),
 dict(kind="md",title="Water the plants",bits=["every weekday","~15m"],carried=3),
]
def todaylist(T,chips_for=None,warn_for=None):
    rows=[]
    n=len(MD_ROWS)
    for i,r in enumerate(MD_ROWS):
        extra=(chips_for or {}).get(i)
        rows.append(trow(T,**r,chips2=extra,warn=(warn_for or {}).get(i)))
    rows.append(trow(T,kind="work",title="Book the follow-up",
        bits=["<b>work #418</b>","drey-dev","lease 4m left","waiting on you: Call the dentist"],
        carried=0,last=True))
    return "".join(rows)

def twindow(T,w=760):
    cf = {1: [chip(T,"2 places",T["ts"],T["absq"],glyph=I["note"])]}
    wf = {3: "couldn\u2019t read <code>every weekdy</code> \u2014 the rest of the line is fine"}
    inner = todaylist(T,chips_for=cf,warn_for=wf)
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{todayhead(T)}<div>{inner}</div>'
            f'<div style="padding: 14px;">{standup(T)}</div></div>')



def toolbar(T):
    return (f'<div style="display: flex; align-items: center; gap: 12px; padding: 11px 16px; '
            f'border-bottom: 1px solid {T["border"]}; background: {T["surface"]};">'
            f'<span style="color: {T["acc"]}; display: flex;"><svg viewBox="0 0 64 64" width="17" height="17" aria-hidden="true">'
            f'<path d="M12 12 H52 V52 H38 L12 26 Z" fill="none" stroke="currentColor" stroke-width="11" stroke-linejoin="miter"/></svg></span>'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Metistry</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="display: flex; color: {T["acc"]};">{ic(I["plus"],18)}</span>'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["gauge"],18)}</span></div>')   # the bell moved to the sidebar (C110)

def sidebar(T,sel="Work",child="Today"):
    out=[]
    for n,g in [("Chat",I["chat"]),("Activity",I["activity"]),("Work",I["work"]),
                ("Knowledge",I["know"]),("Agents",I["agents"])]:
        on = (n==sel)
        out.append(f'<div style="position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 12px; '
                   f'border-radius: 8px;">'
                   + f'<span style="display: flex; color: {T["ts"]};">{ic(g)}</span>'
                     f'<span style="font-size: 13px; font-weight: 500; color: {T["tp"]}; flex-grow: 1;">{n}</span>'
                   + (f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevdn"],13,2.2)}</span>' if on else "")
                   + '</div>')
        if on:
            for c in ["Board","Projects","Artifacts","Rooms","Today"]:
                s2 = (c==child)
                out.append(f'<div style="position: relative; display: flex; align-items: center; gap: 10px; '
                           f'padding: 6px 12px 6px 38px; border-radius: 8px; '
                           f'background: {T["accq"] if s2 else "transparent"};">'
                           + (f'<span style="position: absolute; left: 0; top: 5px; bottom: 5px; width: 3px; '
                              f'border-radius: 0 3px 3px 0; background: {T["acc"]};"></span>' if s2 else "")
                           + f'<span style="font-size: 12.5px; font-weight: {600 if s2 else 500}; '
                             f'color: {T["acc"] if s2 else T["ts"]};">{c}</span></div>')
    return (f'<div style="width: 178px; padding: 12px 8px; background: {T["sunken"]}; '
            f'border-right: 1px solid {T["border"]}; flex-shrink: 0;">' + "".join(out) + '</div>')

# ====================== TODAY AS A SPINE =================================
def timecol(T,label,dim=False):
    return (f'<span style="width: 92px; flex-shrink: 0; font-variant-numeric: tabular-nums; font-size: 12px; '
            f'color: {T["tt"] if dim else T["ts"]}; padding-top: 2px;">{label}</span>')

def nowline(T,at="8:52 AM"):
    return (f'<div style="display: flex; align-items: center; gap: 10px; margin: 4px 0 2px;">'
            f'{timecol(T,at)}'
            f'<span style="width: 7px; height: 7px; border-radius: 50%; background: {T["acc"]}; flex-shrink: 0;"></span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["acc"]}; opacity: 0.45;"></span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["acc"]};">NOW</span></div>')

def earlier(T,n=3):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 0;">{timecol(T,"",dim=True)}'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.4)}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{n} earlier today</span></div>')

def prep(T,glyph,text,link=None):
    return (f'<div style="display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: {T["ts"]}; '
            f'line-height: 1.5; margin-top: 5px;">'
            f'<span style="display: flex; color: {T["tt"]}; margin-top: 2px; flex-shrink: 0;">{ic(glyph,13,1.9)}</span>'
            f'<span>{text}</span></div>')

def generated(T,text):
    return (f'<div style="margin-top: 10px; background: {T["agq"]}; border-radius: 9px; padding: 9px 11px;">'
            f'<div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">{AN}</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">written, not retrieved</span></div>'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.5;">{text}</div></div>')

def predicted(T,label,why,glyph=None):
    return (f'<div style="display: inline-flex; align-items: center; gap: 9px; margin-top: 11px;">'
            f'{btn(T,label,"secondary",glyph)}'
            f'<span style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.4;">{why}</span></div>')

def meeting(T,*,time,title,sub,preps,gen=None,pred=None,actions_=True,last=False):
    return (f'<div style="display: flex; gap: 10px; padding: 12px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{timecol(T,time)}'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{sub}</span>'
            f'<span style="flex-grow: 1;"></span>'
            + (btn(T,"Open Notes","secondary",I["note"]) if actions_ else "") + '</div>'
            + "".join(prep(T,g,t) for g,t in preps)
            + (generated(T,gen) if gen else "")
            + (predicted(T,*pred) if pred else "") + '</div></div>')

def gap(T,mins,rows_html,fits):
    return (f'<div style="display: flex; gap: 10px; padding: 12px 0; border-bottom: 1px solid {T["border"]};">'
            f'{timecol(T,"",dim=True)}'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 9px; margin-bottom: 4px;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">{mins} FREE</span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["border"]};"></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{fits}</span></div>'
            f'<div style="margin: 0 -14px;">{rows_html}</div></div></div>')

def meter3(T,meetings=150,tasks=90,over=45,cap=240):
    tot=meetings+tasks+over
    w=lambda x: x/tot*100
    return (f'<div><div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">THE DAY</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">'
            f'{meetings}m in meetings · {tasks}m of tasks that fit · '
            f'<span style="color: {T["deg"]}; font-weight: 600;">{over}m that do not</span></span></div>'
            f'<div style="display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: {T["sunken"]};">'
            f'<div style="width: {w(meetings):.1f}%; background: {T["ag"]};"></div>'
            f'<div style="width: {w(tasks):.1f}%; background: {T["acc"]};"></div>'
            f'<div style="width: {w(over):.1f}%; background: {T["deg"]};"></div></div>'
            f'<div style="display: flex; gap: 14px; margin-top: 7px; font-size: 11px; color: {T["ts"]};">'
            + "".join(f'<span style="display: inline-flex; align-items: center; gap: 5px;">'
                      f'<span style="width: 8px; height: 8px; border-radius: 2px; background: {c};"></span>{l}</span>'
              for c,l in [(T["ag"],"committed"),(T["acc"],"fits the gaps"),(T["deg"],"does not fit")])
            + '</div></div>')

def railsec(T,title,inner,right=None):
    return (f'<div style="margin-bottom: 18px;">'
            f'<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{title}</span>'
            f'<span style="flex-grow: 1;"></span>'
            + (f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">{right}</span>' if right else "")
            + f'</div>{inner}</div>')

def agentrow(T,name,what,state,last=False):
    # amendments §8.3: presence is filled/hollow plus degraded — no presence palette of its own
    dot=presdot(T,{"working":"working","waiting":"queued","done":"idle"}[state])
    return (f'<div style="display: flex; align-items: flex-start; gap: 9px; padding: 8px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="display: flex; margin-top: 4px;">{dot}</span>'
            f'<div style="min-width: 0; flex-grow: 1;">'
            f'<div style="font-family: {MONO}; font-size: 11.5px; color: {T["tp"]};">{name}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.45; margin-top: 2px;">{what}</div>'
            f'</div></div>')

def changerow(T,txt,when,last=False):
    return (f'<div style="display: flex; align-items: flex-start; gap: 8px; padding: 7px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<div style="flex-grow: 1; font-size: 12px; color: {T["ts"]}; line-height: 1.45;">{txt}</div>'
            f'<span style="font-size: 11px; color: {T["tt"]}; flex-shrink: 0;">{when}</span></div>')

def rail(T,w=286):
    agents=(agentrow(T,"drey-dev","migrating the settings pane · 12m in","working")
            + agentrow(T,"taskuary","wants write access to <b>docs/</b>","waiting")
            + agentrow(T,"claude-usage","cache report finished · 4 findings","done",last=True))
    changes=(changerow(T,"<b>Design review</b> moved to 11:00 AM","20m ago")
             + changerow(T,"Jim replied about the SOW","41m ago")
             + changerow(T,"<b>work #418</b> went to in_review","1h ago",last=True))
    return (f'<div style="width: {w}px; flex-shrink: 0; border-left: 1px solid {T["border"]}; padding: 16px 16px 16px 18px; '
            f'background: {T["bg"]};">'
            + railsec(T,"NEEDS YOU",
                f'<div style="display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: {T["ts"]};">'
                f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"],15)}</span>'
                f'<span><b style="color: {T["tp"]};">4 waiting</b> — one is about today</span></div>',"Open")
            + railsec(T,"AGENTS",agents)
            + railsec(T,"SINCE YOU LAST LOOKED",changes,"9:04 AM") + '</div>')

def slimrow(T,title,bits,carried=0,last=False):
    return trow(T,kind="md",title=title,bits=bits,carried=carried,drag=True,last=last)

def spine(T):
    g1=(slimrow(T,"Sign the SOW",["due today","P1","~15m","Jim asks at 9:30 AM"],carried=2)
        + slimrow(T,"Call the dentist",["overdue by 2 days","P2","~15m"],carried=5,last=True))
    g2=(slimrow(T,"Write the design brief for the settings pane",
                ["due Wed","P1","~45m","blocking <b>work #418</b>"])
        + slimrow(T,"Review the lease comparables",["due Fri","P2","~90m"],last=True))
    return (earlier(T)
      + nowline(T)
      + meeting(T,time="9:15 AM",title="Standup draft",sub="ready to copy",preps=[],actions_=False,
                pred=("Copy","— posting is yours; Metistry never sends it",I["copy"]))
      + meeting(T,time="9:30–10:00 AM",title="1:1 with Jim Fallon",sub="2 people",
          preps=[(I["person"],'<b>People/Jim Fallon</b> — 3 open tasks assigned to him, last met 6 September'),
                 (I["check"],'you owe him: <b>Sign the SOW</b> — P1, on today’s list'),
                 (I["note"],'last time: <b>Journal/Meetings/2026-09-06-jim.md</b> — “revisit the Q4 scope once the lease lands”')],
          gen="The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
              "He has been waiting on the SOW since Tuesday.",
          pred=("Draft the Agenda","— you have 3 open items with Jim",I["pencil"]))
      + gap(T,"1h 30m",g1,"2 tasks fit · 30m to spare")
      + meeting(T,time="11:00–11:45 AM",title="Design review",sub="4 people · moved from 1:00 PM",
          preps=[(I["board"],'<b>work #418</b> is in review and is what this is about'),
                 (I["note"],'the settings brief is not written yet — it is in the gap above')],
          pred=("Open work #418","— the review is about it",I["board"]))
      + gap(T,"3h 15m",g2,"1 of 2 fits"))

def hub(T,w=1180):
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{toolbar(T)}<div style="display: flex;">{sidebar(T,"Work")}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex;">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="padding: 14px 16px 13px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Today</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{F["day"]}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">as of 2 min ago</span>{seg(T)}</div>'
            f'{meter3(T)}</div>'
            f'<div style="padding: 6px 14px 16px;">{spine(T)}</div></div>{rail(T)}</div></div></div>')



# ======================= THREE CHANNELS ==================================
def prio(T,n):
    """One badge shape for all four. P1 is filled because it is the top of the scale;
    2-4 are outlined in border-control, which clears 3:1 on every ground in both themes."""
    if n==1:
        return (f'<span style="display: inline-flex; align-items: center; justify-content: center; min-width: 26px; '
                f'height: 18px; padding: 0 6px; border-radius: 5px; background: {T["tp"]}; color: {T["bg"]}; '
                f'font-size: 11px; font-weight: 700; letter-spacing: 0.02em; box-sizing: border-box;">P1</span>')
    ink={2:T["tp"],3:T["ts"],4:T["tt"]}[n]
    return (f'<span style="display: inline-flex; align-items: center; justify-content: center; min-width: 26px; '
            f'height: 18px; padding: 0 6px; border-radius: 5px; border: 1px solid {T["bc"]}; color: {ink}; '
            f'font-size: 11px; font-weight: {700 if n==2 else 600}; box-sizing: border-box;">P{n}</span>')

def prio_red(T):   # the alternative, drawn so it can be compared and rejected
    return (f'<span style="display: inline-flex; align-items: center; justify-content: center; min-width: 22px; '
            f'padding: 1px 6px; border-radius: 5px; background: {T["fail"]}; color: {T["ondest"]}; '
            f'font-size: 11px; font-weight: 700;">P1</span>')

def ent(T,kind,label,glyph=None,mono_=False):
    fg,bg={"person":(T["ep"],T["epq"]),"note":(T["en"],T["enq"]),"project":(T["ej"],T["ejq"]),
           "agent":(T["ag"],T["agq"]),"plain":(T["ts"],T["absq"])}[kind]
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 1.5px 8px; '
            f'border-radius: 999px; background: {bg}; color: {fg}; font-size: 11.5px; font-weight: 600; '
            + (f"font-family: {MONO}; " if mono_ else "") + 'white-space: nowrap;">'
            + (f'<span style="display: flex;">{ic(glyph,11,2.1)}</span>' if glyph else "") + f'{label}</span>')

def st(T,label,tone="deg",glyph=None):
    fg,bg={"deg":(T["deg"],T["degq"]),"fail":(T["fail"],T["failq"]),"stale":(T["stale"],T["staleq"]),
           "ok":(T["ok"],T["okq"])}[tone]
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 1.5px 8px; '
            f'border-radius: 999px; background: {bg}; color: {fg}; font-size: 11.5px; font-weight: 700; '
            f'white-space: nowrap;">'
            + (f'<span style="display: flex;">{ic(glyph,11,2.3)}</span>' if glyph else "") + f'{label}</span>')

def gl(T,glyph,t,tone=None):
    """rung 0.5 — a glyph-prefixed value. No pill: it is not a target, it is a reading aid."""
    return (f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; '
            f'color: {tone or T["ts"]};"><span style="display: flex; opacity: 0.85;">{ic(glyph,12,2)}</span>{t}</span>')

def due(T,t,over=False):
    return st(T,t,"deg",I["cal"]) if over else gl(T,I["cal"],t)

def est(T,t): return gl(T,I["clock"],t)

def plainf(T,t): return f'<span style="font-size: 12px; color: {T["ts"]};">{t}</span>'

def channel(T,name,carries,swatches,rule):
    return (f'<div style="flex-grow: 1; flex-basis: 0; min-width: 0; border: 1px solid {T["border"]}; '
            f'border-radius: 11px; padding: 15px; background: {T["bg"]};">'
            f'<div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 3px;">{carries}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 13px 0 12px;">{swatches}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; padding-top: 11px; '
            f'border-top: 1px solid {T["border"]};">{rule}</div></div>')

CHAN=pan(L,"THREE CHANNELS — AND THEY NEVER BORROW FROM EACH OTHER",
  f'<div style="display: flex; gap: 16px; align-items: stretch;">'
  + channel(L,"Hue says <i>what kind of thing</i>","a target you can open",
      ent(L,"person","Jim Fallon",I["person"]) + ent(L,"note","Lease Renewal",I["note"])
      + ent(L,"project","Settings Pane",I["board"]) + ent(L,"agent","drey-dev",I["agents"])
      + ent(L,"plain","linear:ABC-123",None,True),
      "Three new hues plus the agent purple. A chip is coloured because of <b>what it points at</b> — never "
      "because it is urgent. This is where the page gets its colour, and it is safe to be generous here because "
      "hue is carrying a fact, not a judgement.")
  + channel(L,"Weight says <i>how much it matters</i>","priority, and only priority",
      prio(L,1) + prio(L,2) + prio(L,3) + prio(L,4),
      "P1 is a solid badge in <b>text-primary</b> on <b>bg</b> — the loudest mark available and it spends no hue. "
      "P2 is outlined. P3 and P4 are plain text, and P3 is usually omitted since unset sorts there.")
  + channel(L,"Tint says <i>something is wrong</i>","the ratified state vocabulary",
      st(L,"Overdue") + st(L,"Blocked") + st(L,"Stale","stale") + st(L,"Failed","fail")
      + st(L,"5th Day","deg",I["clock"]),
      "Only <b>degraded</b>, <b>failed</b>, <b>stale</b> and <b>ok</b>, and only when something actually is wrong. "
      "These are the one channel that is allowed to interrupt you, which is exactly why nothing else may use them.")
  + '</div>'
  + nt(L,"<b>The previous pass was too grey and you were right.</b> But the fix is not a louder ladder — it is "
         "noticing that the page was trying to say three different things in one channel. Split them and colour "
         "becomes cheap: hue can be generous because it is only ever naming a kind, and the state tints stay rare "
         "and therefore still mean something.",16)
  + nt(L,"<b>The cap survives, loosened.</b> At most <b>three</b> chips on one item, of which at most <b>one</b> may "
         "be a state tint. Entity chips are no longer rationed — they are how you read the line.",12))

# ---- the row, rebuilt with all three channels ---------------------------
def row2(T,*,title,prn=None,facets=(),states=(),done=False,last=False,spark=False):
    bits=[]
    if prn: bits.append(prio(T,prn))
    bits += [plainf(T,f) if isinstance(f,str) else ent(T,*f) for f in facets]
    bits += [st(T,*s) for s in states]
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 11px 14px;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="display: flex; color: {T["tt"]}; margin-top: 2px;">{ic(I["grip"],15,2.6)}</span>'
            f'<span style="margin-top: 2px; display: flex;">{box(T,done)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 14px; color: {T["tp"]};">{title}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px;">'
            + " ".join(bits) + '</div></div>'
            + (f'<span style="flex-shrink: 0;">{btn(T,"Delegate","secondary",I["spark"])}</span>' if spark else "")
            + '</div>')

def sample(T):
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 11px; background: {T["bg"]}; '
            f'overflow: hidden;">'
            + row2(T,title="Sign the SOW",prn=1,
                   facets=["Due Today","~15m",("person","Jim Fallon",I["person"])],
                   states=[("Waiting",)],spark=False)
            + row2(T,title="Write the design brief for the settings pane",prn=1,
                   facets=["Due Wed","~45m",("project","Settings Pane",I["board"]),("agent","work #418",I["agents"])],
                   spark=True)
            + row2(T,title="Review the lease comparables",prn=2,
                   facets=["Due Fri","~90m",("note","Lease Renewal",I["note"])],spark=True)
            + row2(T,title="Call the dentist",
                   facets=["~15m"],states=[("Overdue",),("5th Day","deg",I["clock"])],last=True)
            + '</div>')

ROWP=pan(L,"THE SAME FOUR ROWS, READ IN ONE PASS",
  sample(L)
  + nt(L,"Four rows, eleven facets, and you can tell at a glance which is urgent (the solid P1), which involves a "
         "person (rose), which touches a project (blue), which an agent already owns (purple), which is a document "
         "(green) and which is in trouble (amber). None of that needed a second look, and nothing is red.",14)
  + nt(L,"<b>The spark is Metis.</b> One mark, two uses: on a button it means <i>Metis can do this</i>; on content "
         "it means <i>Metis wrote this</i>. It appears on the two rows that could be handed over and not on the two "
         "that could not — the SOW needs your signature and the dentist needs your voice, so offering to delegate "
         "them would be noise pretending to be help.",12))

PRIOP=pan(L,"P1 — TWO WAYS, AND WHY I DREW THE QUIET ONE",
  f'<div style="display: flex; gap: 22px; align-items: flex-start;">'
  f'<div><div style="font-size: 12px; font-weight: 600; color: {L["tp"]}; margin-bottom: 9px;">Drawn</div>'
  f'<div style="display: flex; gap: 6px; align-items: center;">{prio(L,1)}{prio(L,2)}{prio(L,3)}{prio(L,4)}</div></div>'
  f'<div><div style="font-size: 12px; font-weight: 600; color: {L["tp"]}; margin-bottom: 9px;">The alternative</div>'
  f'<div style="display: flex; gap: 6px; align-items: center;">{prio_red(L)}'
  f'<span style="font-size: 11.5px; color: {L["ts"]};">P1 in <b>failed</b> red</span></div></div></div>'
  + nt(L,"<b>Your call, and here is mine.</b> Red for P1 costs the page twice. It collides with <b>failed</b>, which "
         "already means <i>this broke</i> — so an overdue P1 next to a failed collector is two reds meaning two "
         "different things. And in a system you run for yourself, everything becomes P1 within a month; a red P1 "
         "makes the whole page red and trains you to stop seeing red, which is expensive because red is the only "
         "thing left that can interrupt you.",16)
  + nt(L,"The solid badge is <b>louder than red in greyscale</b> and spends nothing. If you want it warmer, the "
         "honest move is a fourth channel token — a <code>priority</code> hue of its own, not a borrowed state "
         "colour — and I would still argue against it.",12))

# ---- capitalisation ------------------------------------------------------
def caprow(T,wrong,right,why,last=False):
    return (f'<tr style="border-top: 1px solid {T["border"]}; vertical-align: top;">'
            f'<td style="padding: 9px 14px 9px 0;">{wrong}</td>'
            f'<td style="padding: 9px 14px 9px 0;">{right}</td>'
            f'<td style="padding: 9px 0; font-size: 12.5px; color: {T["ts"]}; line-height: 1.5;">{why}</td></tr>')

CAPP=pan(L,"CAPITALISATION — ONE RULE, AND IT PROTECTS P1 TOO",
  nt(L,"<b>An attribute name is Title Case. A value is verbatim, always.</b> That is the whole rule, and the second "
       "half is not a style choice — a value is often something you or an agent wrote, and P1 says data is not "
       "case-corrected.")
  + '<table style="width: 100%; border-collapse: collapse; margin-top: 12px;">'
  + f'<tr>' + "".join(f'<th style="text-align: left; padding: 0 14px 7px 0; font-size: 10.5px; '
                      f'letter-spacing: 0.07em; color: {L["tt"]};">{h}</th>'
      for h in ("WAS","IS","WHY")) + '</tr>'
  + caprow(L,st(L,"overdue"),st(L,"Overdue"),"an attribute name — Title Case")
  + caprow(L,ent(L,"plain","2 places"),ent(L,"plain","2 Places"),"an attribute name, even when it starts with a number")
  + caprow(L,ent(L,"person","jim fallon",I["person"]),ent(L,"person","Jim Fallon",I["person"]),
           "a <b>value</b> — rendered exactly as the vault spells it, never recased by us")
  + caprow(L,ent(L,"plain","LINEAR:ABC-123",None,True),ent(L,"plain","linear:ABC-123",None,True),
           "an identifier is a value. Uppercasing it makes it a different string to the eye")
  + caprow(L,plainf(L,"due wed"),plainf(L,"Due Wed"),"attribute plus value, and both are ours to case")
  + caprow(L,ent(L,"note","lease-renewal.md",I["note"],True),ent(L,"note","Lease Renewal",I["note"]),
           "the <b>title</b> is the value; the path belongs in the tooltip, not the chip",last=True)
  + '</table>'
  + nt(L,"Section labels stay in the small all-caps style they already use — they are furniture, not attributes.",14))

# ---- agent prose: serif + feedback --------------------------------------
def thumbs(T,state=None):
    def b(g,on,tone):
        col = tone if on else T["tt"]
        bgc = (T["okq"] if tone==T["ok"] else T["degq"]) if on else "transparent"
        return (f'<span style="display: inline-flex; align-items: center; justify-content: center; width: 24px; '
                f'height: 24px; border-radius: 7px; background: {bgc}; color: {col};">{ic(g,14,1.8)}</span>')
    return (f'<span style="display: inline-flex; gap: 2px;">'
            f'{b(I["up"],state=="up",T["ok"])}{b(I["down"],state=="down",T["deg"])}</span>')

def agentprose(T,text,*,who=ASSISTANT_NAME,when="8:47 AM",state=None,note=False,w=None):
    n=""
    if note:
        n=(f'<div style="margin-top: 10px; padding: 9px 11px; border-radius: 8px; background: {T["surface"]}; '
           f'border: 1px solid {T["bc"]};">'
           f'<span style="font-size: 12px; color: {T["tt"]};">What was wrong with it? (optional)</span></div>')
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'background: {T["agq"]}; border-radius: 11px; '
            f'padding: 12px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],14,1.7)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">{who}</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">{when}</span>'
            f'<span style="flex-grow: 1;"></span>{thumbs(T,state)}</div>'
            f'<div style="font-family: {SERIF}; font-size: 14.5px; line-height: 1.55; color: {T["tp"]};">{text}</div>'
            f'{n}</div>')

PROSEP=pan(L,"AGENT PROSE — A DIFFERENT TYPEFACE, AND A VERDICT ON EVERY PIECE OF IT",
  f'<div style="display: flex; flex-direction: column; gap: 12px;">'
  + agentprose(L,"The lease comparables came back 4% under his number, which is the thing you did not have on the "
                 "6th. He has been waiting on the SOW since Tuesday.")
  + agentprose(L,"Two of the four tasks you carried into today were also on Monday’s plan. They are both small.",
               when="9:02 AM",state="down",note=True)
  + '</div>'
  + nt(L,"<b>Agent prose is set in the system serif</b> — <code>ui-serif</code>, which is New York on Apple and "
         "Georgia elsewhere. No font is loaded, so P7 holds. The point is that you can tell it is the assistant "
         "<b>before you have read a word</b>: you know a model can be wrong, and the typeface is what lets you hold "
         "that thought without a warning label on every paragraph.",16)
  + nt(L,"It also does something the tint alone could not: <b>it survives being quoted.</b> Copy a briefing into a "
         "note and the purple wash is gone, but the serif is still there saying where the sentence came from.",12)
  + nt(L,"<b>Thumbs on every piece of agent prose</b>, not only in Chat — same control, same two verbs, same "
         "optional note on a thumbs-down. If the assistant's output is worth rating in one place it is worth rating "
         "everywhere, and one feedback signal beats three. Needs a stable id per piece of prose: request <b>B7</b>.",12))

SPARKP=pan(L,"THE SPARK — ONE MARK FOR METIS, TWO MEANINGS",
  f'<div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin-bottom: 4px;">'
  f'{btn(L,"Delegate","secondary",I["spark"])}'
  f'{btn(L,"Draft the Agenda","secondary",I["spark"])}'
  f'{btn(L,"Revise","ghost",I["spark"])}'
  f'<span style="display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; '
  f'background: {L["agq"]}; color: {L["ag"]}; font-size: 11.5px; font-weight: 600;">'
  f'{ic(I["spark"],12,1.9)}Metis wrote this</span></div>'
  + nt(L,"On a <b>button</b> it means <i>Metis can do this for you</i>. On <b>content</b> it means <i>Metis wrote "
         "this</i>. Those are the same promise from two directions, so they get the same mark and the same colour — "
         "and the mark is how you find where the system is being useful without reading every row.",14)
  + nt(L,"<b>Purple stays.</b> It is 87° from the person rose, 113° from the note green, 41° from the project blue "
         "and 75° from the accent teal — the only hue in the set with that much room on both sides, which matters "
         "because it is the one that has to be recognisable when it is a 7px dot. I would not change it.",12)
  + nt(L,"<b>The delegate button appears only where delegation is real.</b> A task needing your signature or your "
         "voice does not get one. A spark on something Metis cannot actually take is worse than no spark at all — "
         "it is the mark losing its meaning in exchange for looking helpful.",12))

# ---- the Obsidian mirror -------------------------------------------------
OB_L=dict(bg="#ffffff",text="#2e3338",faint="#6e7683",rule="#e3e5e8",sel="#e8eaed")
OB_D=dict(bg="#1e1e1e",text="#dcddde",faint="#8f9094",rule="#33363a",sel="#2c2f33")

def obs_line(T,OB,*,raw=False):
    chips=(prio(T,1) + " " + plainf(T,"Due Fri") + " "
           + ent(T,"person","Jim Fallon",I["person"]) + " " + ent(T,"note","Lease Renewal",I["note"]))
    body=(f'<div style="display: flex; gap: 9px; align-items: flex-start;">'
          f'<span style="width: 15px; height: 15px; border-radius: 4px; border: 1px solid {OB["faint"]}; '
          f'flex-shrink: 0; margin-top: 3px;"></span>'
          f'<div style="min-width: 0;"><span style="font-size: 14.5px; color: {OB["text"]};">'
          f'Review the lease comparables</span>'
          f'<div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px;">{chips}</div>'
          f'</div></div>')
    rawl=""
    if raw:
        rawl=(f'<div style="margin-top: 11px; padding-top: 10px; border-top: 1px dashed {OB["rule"]}; '
              f'font-family: {MONO}; font-size: 11.5px; color: {OB["faint"]}; overflow-wrap: anywhere;">'
              f'- [ ] Review the lease comparables due friday p1 @[[Jim Fallon]] [[Lease Renewal]] ^mt-3f9a</div>')
    return body+rawl

def obspane(T,OB,title,raw=True,w=390):
    return (f'<div style="width: {w}px; flex-shrink: 0;">'
            f'<div style="font-size: 12px; font-weight: 600; color: {T["tp"]}; margin-bottom: 8px;">{title}</div>'
            f'<div style="border: 1px solid {T["border"]}; border-radius: 10px; overflow: hidden; '
            f'background: {OB["bg"]}; padding: 14px 16px;">'
            f'<div style="font-size: 11px; color: {OB["faint"]}; margin-bottom: 10px;">Journal/2026-09-20.md</div>'
            f'{obs_line(T,OB,raw=raw)}</div></div>')

MIRROR=pan(L,"THE SAME LINE IN THREE PLACES",
  f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap;">'
  f'<div style="width: 390px; flex-shrink: 0;">'
  f'<div style="font-size: 12px; font-weight: 600; color: {L["tp"]}; margin-bottom: 8px;">Metistry — Today</div>'
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; overflow: hidden; background: {L["bg"]};">'
  + row2(L,title="Review the lease comparables",prn=1,
         facets=["Due Fri",("person","Jim Fallon",I["person"]),("note","Lease Renewal",I["note"])],
         last=True,spark=True) + '</div></div>'
  + obspane(L,OB_L,"Obsidian — light, live preview")
  + obspane(L,OB_D,"Obsidian — dark, live preview")
  + '</div>'
  + nt(L,"<b>The chips are the same object in all three</b> — same geometry, same radius, same hue, same "
         "capitalisation. What changes is the ground underneath, because Obsidian's themes are the user's and the "
         "plugin has no business overriding them. So the plugin reads its grounds from Obsidian's own CSS variables "
         "and brings only the entity hues and the geometry with it.",16)
  + nt(L,"<b>The raw line is always one keystroke away</b>, and it is the thing that actually exists — markdown is "
         "the record. The chips are a rendering of a line you could have typed by hand, which is why the plugin can "
         "be uninstalled without losing anything.",12)
  + nt(L,"<b>Two hues need checking against a user's theme, not ours.</b> Obsidian themes vary wildly, and an entity "
         "quiet computed against our <b>bg</b> can fall below 4.5:1 on someone's midnight purple. The plugin should "
         "compute the quiet fill from the <i>live</i> background at render time — a <code>color-mix()</code> against "
         "<code>--background-primary</code> — rather than shipping our six hex values. Request <b>B8</b>.",12))

# ---- the plugin's attribute picker --------------------------------------
def menurow(T,label,shorthand,glyph,sel=False,last=False):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 11px; border-radius: 7px; '
            f'background: {T["accq"] if sel else "transparent"};">'
            f'<span style="display: flex; color: {T["acc"] if sel else T["ts"]};">{ic(glyph,14,1.9)}</span>'
            f'<span style="font-size: 13px; font-weight: {600 if sel else 500}; color: {T["tp"]}; '
            f'flex-grow: 1;">{label}</span>'
            f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["ts"]};">{shorthand}</span></div>')

def picker(T,w=290):
    rows=[("Due","due …",I["cal"],True),("Planned","do …",I["clock"],False),
          ("Priority","p1–p4",I["warn"],False),("Assign","@…",I["person"],False),
          ("Size","size s/m/l",I["board"],False),("Project","+…",I["note"],False),
          ("Repeat","every …",I["undo"],False),("Link","work 418",I["agents"],False)]
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 11px; box-shadow: 0 10px 30px rgba(26,24,21,0.18); overflow: hidden; padding: 5px 5px 6px;">'
            f'<div style="padding: 8px 11px 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; '
            f'color: {T["tt"]};">ADD TO THIS TASK</div>'
            + "".join(menurow(T,*r) for r in rows) + '</div>')

def valuepicker(T,w=290):
    vals=[("Today","due today",True),("Tomorrow","due tomorrow",False),("Friday","due friday",False),
          ("Next week","due +7d",False),("Pick a date…","",False)]
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 11px; box-shadow: 0 10px 30px rgba(26,24,21,0.18); overflow: hidden; padding: 5px 5px 6px;">'
            f'<div style="padding: 8px 11px 6px; display: flex; align-items: center; gap: 7px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["cal"],13,2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">DUE</span></div>'
            + "".join(f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 11px; '
                      f'border-radius: 7px; background: {T["accq"] if s else "transparent"};">'
                      f'<span style="font-size: 13px; font-weight: {600 if s else 500}; color: {T["tp"]}; '
                      f'flex-grow: 1;">{n}</span>'
                      f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["ts"]};">{sh}</span></div>'
              for n,sh,s in vals) + '</div>')

def typing(T,OB,hint=True,w=420):
    return (f'<div style="width: {w}px; flex-shrink: 0; border: 1px solid {T["border"]}; border-radius: 10px; '
            f'background: {OB["bg"]}; padding: 14px 16px;">'
            f'<div style="font-size: 11px; color: {OB["faint"]}; margin-bottom: 10px;">Journal/Meetings/2026-09-20-design-review.md</div>'
            f'<div style="font-size: 14px; color: {OB["text"]}; line-height: 1.7;">'
            f'Ryan will own the migration plan.<br>'
            f'<span style="display: inline-flex; align-items: center; gap: 8px;">'
            f'<span style="width: 14px; height: 14px; border-radius: 4px; border: 1px solid {OB["faint"]};"></span>'
            f'Send Jim the revised Q4 scope<span style="display: inline-block; width: 1.5px; height: 17px; '
            f'background: {T["ag"]}; vertical-align: middle;"></span></span>'
            + (f'<span style="display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; '
               f'padding: 2px 8px; border-radius: 999px; background: {T["agq"]}; color: {T["ag"]}; '
               f'font-size: 11px; font-weight: 600;">{ic(I["spark"],11,2)}⌘J to add due, priority, people</span>'
               if hint else "") + '</div></div>')

DISC=pan(L,"DISCOVERY — THE MENU TEACHES THE SHORTHAND IT INSERTS",
  f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap;">'
  f'{typing(L,OB_D)}'
  f'<div><div style="font-size: 12px; font-weight: 600; color: {L["tp"]}; margin-bottom: 8px;">⌘J — or type /</div>'
  f'{picker(L)}</div>'
  f'<div><div style="font-size: 12px; font-weight: 600; color: {L["tp"]}; margin-bottom: 8px;">then a value</div>'
  f'{valuepicker(L)}</div></div>'
  + nt(L,"<b>The hint only appears on a line that is a task</b>, once the checkbox is typed, and it fades after "
         "you have used the menu a few times. Nothing appears while you are writing prose — this is a note-taking "
         "app first and a task app second.",16)
  + nt(L,"<b>Every menu row shows the literal text it will insert.</b> That is the whole design: you pick <i>Due → "
         "Friday</i> the first three times and read <code>due friday</code> on the right each time, and by the "
         "fourth you type it. <b>The menu is the discovery path and typing is the speed path, and the menu's job is "
         "to make itself unnecessary.</b> A picker that hides its own syntax keeps you dependent on it forever, "
         "which is fatal when the real use is typing fast in a meeting.",12)
  + nt(L,"So both paths are always live: <code>⌘J</code> opens the menu, <code>/</code> opens it inline, and typing "
         "<code>p1</code> or <code>@Jim</code> or <code>due fri</code> skips it entirely. Anything the menu can "
         "produce, the keyboard can produce, and the parser is the same one — "
         "<code>packages/core/src/task-filter.ts</code> already being the single grammar in the system.",12)
  + nt(L,"<b>Autocomplete is scoped to what exists.</b> <code>@</code> completes from People/ pages, <code>+</code> "
         "from projects, <code>[[</code> from notes — so an assignment can only name a person you have a page for, "
         "and a typo becomes a miss rather than a new person. That is the same discipline as the meeting card "
         "refusing to guess an attendee's page.",12))

def artcard(T,*,name,made,body,forwhat,changed=None,w=None,compact=False):
    head=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 10px 13px; '
          f'border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ag"]};">{ic(I["note"],15,1.8)}</span>'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</span>'
          f'<span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 11px; color: {T["tt"]};">{made}</span></div>')
    prev=(f'<div style="padding: 11px 13px; font-size: 12.5px; line-height: 1.55; color: {T["tp"]};">'
          + "".join(f'<div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{l}</div>'
                    for l in body)
          + '</div>')
    fresh=""
    if changed:
        fresh=(f'<div style="padding: 0 13px 11px;">{st(T,changed,"stale")}</div>')
    acts=(f'<div style="display: flex; align-items: center; gap: 8px; padding: 11px 13px; '
          f'border-top: 1px solid {T["border"]}; flex-wrap: wrap;">'
          f'{btn(T,"Open","secondary")}{btn(T,"Copy","ghost",I["copy"])}'
          f'{btn(T,"Revise","ghost",I["pencil"])}'
          f'<span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 11.5px; color: {T["ts"]};">for <b style="color: {T["tp"]};">{forwhat}</b></span></div>')
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'border: 1px solid {T["border"]}; border-radius: 11px; '
            f'background: {T["surface"]}; overflow: hidden;">{head}{prev}{fresh}{acts}</div>')

def revision(T,w=None):
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'background: {T["agq"]}; border-radius: 11px; '
            f'padding: 12px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 6px;">'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">{AN}</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">changed your day · 8:47 AM</span></div>'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.55;">'
            f'You asked to push the lease review to tomorrow and put the brief first. '
            f'<b>3 items moved</b> — the brief is now in the 9:45 AM gap, and the review is on tomorrow’s plan.</div>'
            f'<div style="display: flex; gap: 8px; margin-top: 11px;">{btn(T,"Undo","secondary",I["undo"])}'
            f'{btn(T,"Show What Moved","ghost")}</div></div>')

def askbar(T):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 13px; border-radius: 11px; '
            f'border: 1px solid {T["bc"]}; background: {T["surface"]};">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["chat"],17)}</span>'
            f'<span style="flex-grow: 1; font-size: 13.5px; color: {T["tt"]};">Ask about today, or tell me to change it…</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 3px; color: {T["tt"]}; font-size: 11.5px;">'
            f'{ic(I["cmd"],12,1.6)}↩</span></div>')

def sidebar7(T,sel="Today"):
    out=[]
    for n,g,kids in [("Chat",I["chat"],None),("Today",I["cal"],None),("Activity",I["activity"],None),
                     ("Work",I["work"],["Board","Projects","Artifacts","Rooms"]),
                     ("Knowledge",I["know"],None),("Agents",I["agents"],None)]:
        on=(n==sel)
        out.append(f'<div style="position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 12px; '
                   f'border-radius: 8px; background: {T["accq"] if on else "transparent"};">'
                   + (f'<span style="position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; '
                      f'border-radius: 0 3px 3px 0; background: {T["acc"]};"></span>' if on else "")
                   + f'<span style="display: flex; color: {T["acc"] if on else T["ts"]};">{ic(g)}</span>'
                     f'<span style="font-size: 13px; font-weight: {600 if on else 500}; color: {T["tp"]}; '
                     f'flex-grow: 1;">{n}</span>'
                   + (f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.2)}</span>' if kids else "")
                   + '</div>')
    out.append(f'<div style="margin-top: 10px; padding: 8px 12px 4px; border-top: 1px solid {T["border"]};">'
               f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">PINNED</span></div>')
    for p in ["Lease renewal","Settings pane"]:
        out.append(f'<div style="display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 8px;">'
                   f'<span style="display: flex; color: {T["tt"]};">{ic(I["note"],15,1.8)}</span>'
                   f'<span style="font-size: 12.5px; color: {T["ts"]};">{p}</span></div>')
    return (f'<div style="width: 178px; padding: 12px 8px; background: {T["sunken"]}; '
            f'border-right: 1px solid {T["border"]}; flex-shrink: 0;">' + "".join(out) + '</div>')

def meeting2(T,*,time,title,sub,preps,gen=None,pred=None,series=None,last=False):
    ser=""
    if series:
        done,openn,path=series
        ser=(f'<div style="margin-top: 9px; border-left: 2px solid {T["border"]}; padding-left: 11px;">'
             f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
             f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">LAST TIME</span>'
             f'{f2(T,path,I["note"],True)}'
             f'<span style="font-size: 12px; color: {T["ts"]};">{done+openn} action items · {done} done</span></div>'
             f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 7px;">'
             f'{box(T)}<span style="font-size: 13px; color: {T["tp"]};">Send Jim the revised Q4 scope</span>'
             f'{f4(T,"3rd day",I["clock"])}</div></div>')
    return (f'<div style="display: flex; gap: 10px; padding: 12px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{timecol(T,time)}'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{sub}</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Open Notes","secondary",I["note"])}</div>'
            + "".join(prep(T,g,t) for g,t in preps) + ser
            + (generated(T,gen) if gen else "")
            + (predicted(T,*pred) if pred else "") + '</div></div>')



# ============ THE DIFF — one component, collapsed by default =============
def diff(T,*,summary,lines,open_=False,w=None):
    """lines: (kind, text) where kind is ' ' | '-' | '+'"""
    def ln(k,t):
        bg={"+":T["okq"],"-":T["failq"]," ":"transparent"}[k]
        fg={"+":T["ok"],"-":T["fail"]," ":T["tt"]}[k]
        return (f'<div style="display: flex; gap: 10px; background: {bg}; padding: 3px 11px;">'
                f'<span style="width: 8px; flex-shrink: 0; color: {fg}; font-family: {MONO}; '
                f'font-size: 11.5px; font-weight: 700;">{k.strip() or "&nbsp;"}</span>'
                f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["tp"]}; '
                f'overflow-wrap: anywhere;">{t}</span></div>')
    adds=sum(1 for k,_ in lines if k=="+"); dels=sum(1 for k,_ in lines if k=="-")
    head=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 8px 11px;">'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"] if open_ else I["chevr"],13,2.3)}</span>'
          f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{summary}</span>'
          f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["ok"]};">+{adds}</span>'
          f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["fail"]};">−{dels}</span></div>')
    body=("" if not open_ else
          f'<div style="border-top: 1px solid {T["border"]}; padding: 7px 0;">'
          + "".join(ln(k,t) for k,t in lines) + '</div>')
    return (f'<div style="' + (f'width: {w}px; ' if w else "")
            + f'border: 1px solid {T["border"]}; border-radius: 9px; background: {T["surface"]}; '
              f'overflow: hidden;">{head}{body}</div>')

# ============ AGENT PROSE — one treatment, everywhere ====================
def prose(T,text,*,when="8:47 AM",state=None,acts=None,diffblock=None,w=None):
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'background: {T["agq"]}; border-radius: 11px; '
            f'padding: 12px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],14,1.7)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">{AN}</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">{when}</span>'
            f'<span style="flex-grow: 1;"></span>{thumbs(T,state)}</div>'
            f'<div style="font-family: {SERIF}; font-size: 14.5px; line-height: 1.55; color: {T["tp"]};">{text}</div>'
            + (f'<div style="margin-top: 11px;">{diffblock}</div>' if diffblock else "")
            + (f'<div style="display: flex; gap: 8px; margin-top: 11px; flex-wrap: wrap;">'
               + "".join(acts) + '</div>' if acts else "") + '</div>')

# ============ THE DAY BAR — five segments, travel included ===============
SEGS=[("Meetings",160,0),("Travel",50,1),("Focus Blocked",90,2),("Tasks That Fit",55,3),("Doesn’t Fit",45,"deg")]
CHART_L=["#0a3239","#145c67","#1e7784","#2a8b9a"]
CHART_D=["#1b7584","#2ca5b8","#66c4d3","#aad9e1"]
def seghex(T,k,dark):
    if k=="deg": return T["deg"]
    return (CHART_D if dark else CHART_L)[k]
def daybar(T,dark=False):
    tot=sum(v for _,v,_ in SEGS)
    # 2px gaps in the track colour: the segments never touch, so adjacency is not
    # carrying meaning and each one only has to clear 3:1 against the ground it sits on
    bars="".join(f'<div style="width: {v/tot*100:.1f}%; background: {seghex(T,k,dark)};"></div>' for _,v,k in SEGS)
    legend="".join(f'<span style="display: inline-flex; align-items: center; gap: 5px;">'
                   f'<span style="width: 8px; height: 8px; border-radius: 2px; background: {seghex(T,k,dark)};"></span>'
                   f'<span style="color: {T["ts"]};">{n}</span>'
                   f'<span style="color: {T["tt"]};">{v}m</span></span>' for n,v,k in SEGS)
    return (f'<div><div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; flex-wrap: wrap;">'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">THE DAY</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">5h committed against a 9-hour day · '
            f'<span style="color: {T["deg"]}; font-weight: 600;">45m does not fit</span></span></div>'
            f'<div style="display: flex; gap: 2px; height: 8px; border-radius: 999px; overflow: hidden; '
            f'background: {T["sunken"]};">{bars}</div>'
            f'<div style="display: flex; gap: 14px; margin-top: 8px; font-size: 11px; flex-wrap: wrap;">{legend}</div></div>')

# ============ THE FOLD — the past collapses behind you ===================
def fold(T,open_=False):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0 9px 0;">'
            f'{timecol(T,"")}'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"] if open_ else I["chevr"],13,2.3)}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">Earlier today — '
            f'<b style="color: {T["tp"]};">3 done</b> · 1 meeting · 2 carried forward</span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["border"]};"></span></div>')

def nowbar(T,at="8:52 AM"):
    return (f'<div style="position: sticky; top: 0; display: flex; align-items: center; gap: 10px; '
            f'padding: 7px 0; background: {T["bg"]};">'
            f'<span style="width: 92px; flex-shrink: 0; font-size: 12px; font-weight: 700; color: {T["acc"]};">{at}</span>'
            f'<span style="width: 7px; height: 7px; border-radius: 50%; background: {T["acc"]}; flex-shrink: 0;"></span>'
            f'<span style="flex-grow: 1; height: 1px; background: {T["acc"]}; opacity: 0.45;"></span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["acc"]};">NOW</span></div>')

# ============ CALENDAR MANAGEMENT ========================================
CALDIFF=[(" ","11:00 AM  Design review        4 people"),
         ("-","1:00 PM   Vendor sync          2 people"),
         ("+","11:45 AM  Vendor sync          2 people   — draft, not sent"),
         ("-","2:00 PM   (free)"),
         ("+","12:30 PM  Focus — settings brief          90m, no attendees")]
def calblock(T,w=None):
    return prose(T,"Your afternoon is four gaps of half an hour. Moving the vendor sync up by an hour and fifteen "
                   "clears <b>12:30 to 2:00</b> for the settings brief, which is the only thing today that needs a "
                   "long run at it.",
      when="8:41 AM",
      diffblock=diff(T,summary="What would change on your calendar",lines=CALDIFF,open_=True),
      acts=[btn(T,"Block the Focus Time","secondary",I["spark"]),
            btn(T,"Draft the Move to Vendor","ghost",I["spark"]),
            btn(T,"Not Today","ghost")],w=w)

CALP=pan(L,"CALENDAR HELP — AND THE LINE METIS DOES NOT CROSS",
  calblock(L)
  + nt(L,"<b>Two tiers, and the test is one question: does anyone else feel this?</b> A focus block is an event on "
         "your calendar with no other attendees — nobody else is affected, it is reversible, and Metis can just do "
         "it. Moving a meeting with people in it is a different object: it changes <i>their</i> day, and "
         "<code>ACTION_KINDS</code> excludes sending anything, so <b>Metistry cannot tell them it moved</b>.",16)
  + nt(L,"So the second tier stops one step short: Metis prepares the move and hands you the message. The two "
         "buttons above are deliberately not the same verb — <b>Block</b> does it, <b>Draft</b> gets it ready. "
         "Moving someone's meeting without telling them is worse than leaving the day fragmented, and a product that "
         "quietly did it once would never be trusted with a calendar again.",12)
  + nt(L,"<b>The offer is proactive but it is not a nag.</b> It appears when the day is measurably fragmented — the "
         "bar above is how it knows — and <b>Not Today</b> means not today, not <i>ask me again in an hour</i>. "
         "<code>POST /events</code> already has a preview-then-execute shape, so the mechanism exists; what is new "
         "is the reason and the restraint.",12))

DIFFP=pan(L,"ONE DIFF, WHEREVER SOMETHING CHANGED",
  f'<div style="display: flex; flex-direction: column; gap: 12px;">'
  + diff(L,summary="3 items moved on today’s plan",lines=[
      (" ","09:30 AM  1:1 with Jim Fallon"),
      ("-","Review the lease comparables   due Fri  P2"),
      ("+","Review the lease comparables   due Mon  P2   — moved to tomorrow"),
      ("-","Write the design brief         3rd in the list"),
      ("+","Write the design brief         1st in the list")])
  + diff(L,summary="3 items moved on today’s plan",open_=True,lines=[
      (" ","09:30 AM  1:1 with Jim Fallon"),
      ("-","Review the lease comparables   due Fri  P2"),
      ("+","Review the lease comparables   due Mon  P2   — moved to tomorrow"),
      ("-","Write the design brief         3rd in the list"),
      ("+","Write the design brief         1st in the list")])
  + '</div>'
  + nt(L,"<b>“Show me what changed” was appearing in three places with three treatments.</b> It is one component: "
         "collapsed to a summary and two counts, expanding in place to added and removed lines. Green is added, red "
         "is removed, unchanged lines are context — the grammar everyone already knows from a pull request, which is "
         "the point.",16)
  + nt(L,"It carries a revision the assistant made to your day, a calendar change it is proposing, a task line it is "
         "about to write, and anything after that. <b>Collapsed by default</b>, because the summary is enough nine "
         "times out of ten and the tenth is the one where you want every line.",12)
  + nt(L,"Note that green and red here are <b>ok</b> and <b>failed</b> doing a different job — added and removed, "
         "not good and bad. That is the one place in the product where a state token means something else, and it "
         "is safe because a diff is a closed context that announces itself.",12))

ATTN=pan(L,"WHAT STAYS IN FRONT OF YOU — NOT A THIRD FILTER",
  nt(L,"<b>You were right that “Upcoming” feels wrong, and it is worth naming why:</b> Today / All is a "
       "<i>scope</i> — which tasks are in the list. Upcoming is a <i>position in time</i>. Putting them in one "
       "control asks it to answer two questions, which is exactly the mushy feeling. The segmented control stays "
       "Today / All, and the attention problem gets its own answer.")
  + f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]}; padding: 14px; '
    f'margin-top: 14px;">{fold(L)}{nowbar(L)}'
    f'<div style="display: flex; gap: 10px; padding: 11px 0 2px;">{timecol(L,"9:15 AM")}'
    f'<span style="font-size: 13.5px; color: {L["ts"]};">…the day continues from here</span></div></div>'
  + nt(L,"<b>Three behaviours, no new control.</b>",14)
  + nt(L,"<b>1 · The page opens at now.</b> Opening Today at two in the afternoon should not show you eight in the "
         "morning. This is the whole fix, most of the time, and it costs nothing.",10)
  + nt(L,"<b>2 · The past folds itself</b> into one line — <i>3 done · 1 meeting · 2 carried forward</i> — expanding "
         "in place when you want it. Not a preference: the morning <i>is</i> a summary by the afternoon, and a list "
         "of things you already did is the least useful thing on a screen about what to do next.",10)
  + nt(L,"<b>3 · Now sticks.</b> The marker pins under the header as you scroll, so you never lose where you are in "
         "the day — the same trick a table view uses for section headers.",10)
  + nt(L,"One preference, for the people who disagree with 2: <b>keep the morning open</b>. That is the only setting "
         "this needs, and it is a setting rather than a control because it is a habit, not a decision you remake "
         "every time you look.",14))

NAVP2=pan(L,"TODAY FIRST",
  f'<div style="display: flex; gap: 20px; align-items: flex-start;">'
  f'<div style="width: 190px; flex-shrink: 0;">{sidebar7(L)}</div>'
  f'<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>Today is the first row now, above Chat.</b> The argument that put it second was that Chat is where you "
         "go with a question — but that is not how you <i>open</i> an app. You open it to find out where you stand, "
         "and then you ask something. The first row should be the answer to “what is going on”, and Chat is the "
         "second move, not the first.")
  + nt(L,"It also makes the landing screen the one that can send you anywhere: every other section is reachable from "
         "something on Today. Chat first made the app a chat client with attachments.",12)
  + '</div></div>')

def prep2(T,glyph,text,chips=()):
    return (f'<div style="display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: {T["ts"]}; '
            f'line-height: 1.5; margin-top: 6px; flex-wrap: wrap;">'
            f'<span style="display: flex; color: {T["tt"]}; margin-top: 2px; flex-shrink: 0;">{ic(glyph,13,1.9)}</span>'
            f'<span>{text}</span>' + " ".join(ent(T,*c) for c in chips) + '</div>')

def pred2(T,label,why):
    return (f'<div style="display: inline-flex; align-items: center; gap: 9px; margin-top: 11px; flex-wrap: wrap;">'
            f'{btn(T,label,"secondary",I["spark"])}'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{why}</span></div>')

# ============ TODAY, v5 ==================================================
def sidebar8(T,sel="Today",needs="fixture"):
    """C110 (ruled 2026-09-25): Needs You is a sidebar row, above Today, with the bell
    glyph — present only while something is waiting. Its count is the product's one
    badge; the toolbar bell is gone on the Mac. needs=None or 0 draws the empty sidebar."""
    out=[]
    n=F["needs_you"] if needs=="fixture" else needs
    if n:
        on=(sel=="Needs You")
        out.append(f'<div style="position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 12px; '
                   f'border-radius: 8px; background: {T["accq"] if on else "transparent"};">'
                   + (f'<span style="position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; '
                      f'border-radius: 0 3px 3px 0; background: {T["acc"]};"></span>' if on else "")
                   + f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"])}</span>'
                     f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Needs You</span>'
                     f'<span style="font-size: 11px; font-weight: 700; color: {T["onacc"]}; background: {T["acc"]}; '
                     f'border-radius: 999px; padding: 0 7px; line-height: 17px;">{n}</span></div>')
    # Eight rows (ruled 2026-09-22). Scheduled (was Routines, C113) is top-level because "what is Metistry
    # running for me every day" is a daily question a child row would bury; Agents
    # sits ABOVE it, because a routine is an assignment of an agent and the reader
    # meets the noun before the assignment. Resources went to Settings, which is why
    # this is eight and not nine — see C57.
    for n,g,kids in [("Today",I["cal"],None),("Chat",I["chat"],None),("Activity",I["activity"],None),
                     ("Work",I["work"],True),("Knowledge",I["know"],None),("Agents",I["agents"],None),
                     ("Scheduled",I["repeat"],None)]:
        on=(n==sel)
        out.append(f'<div style="position: relative; display: flex; align-items: center; gap: 10px; padding: 8px 12px; '
                   f'border-radius: 8px; background: {T["accq"] if on else "transparent"};">'
                   + (f'<span style="position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; '
                      f'border-radius: 0 3px 3px 0; background: {T["acc"]};"></span>' if on else "")
                   + f'<span style="display: flex; color: {T["acc"] if on else T["ts"]};">{ic(g)}</span>'
                     f'<span style="font-size: 13px; font-weight: {600 if on else 500}; color: {T["tp"]}; '
                     f'flex-grow: 1;">{n}</span>'
                   + (f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],12,2.2)}</span>' if kids else "")
                   + '</div>')
    out.append(f'<div style="margin-top: 10px; padding: 8px 12px 4px; border-top: 1px solid {T["border"]};">'
               f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">PINNED</span></div>')
    for p in ["Lease Renewal","Settings Pane"]:
        out.append(f'<div style="display: flex; align-items: center; gap: 10px; padding: 6px 12px;">'
                   f'<span style="display: flex; color: {T["tt"]};">{ic(I["note"],15,1.8)}</span>'
                   f'<span style="font-size: 12.5px; color: {T["ts"]};">{p}</span></div>')
    return (f'<div style="width: 178px; padding: 12px 8px; background: {T["sunken"]}; '
            f'border-right: 1px solid {T["border"]}; flex-shrink: 0;">' + "".join(out) + '</div>')

def travel(T,mins,where):
    return (f'<div style="display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid {T["border"]};">'
            f'{timecol(T,"")}'
            f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["promote"],13,2)}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{mins} travel — {where}</span></div></div>')

def meeting4(T,*,time,title,sub,preps,gen=None,pred=None,series=None,last=False):
    ser=""
    if series:
        ser=(f'<div style="margin-top: 10px; border-left: 2px solid {T["border"]}; padding-left: 11px;">'
             f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
             f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">LAST TIME</span>'
             f'{ent(T,"note","6 September",I["note"])}'
             f'<span style="font-size: 12px; color: {T["ts"]};">3 action items · 2 done</span></div>'
             f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap;">'
             f'{box(T)}<span style="font-size: 13px; color: {T["tp"]};">Send Jim the revised Q4 scope</span>'
             f'{prio(T,2)}{st(T,"3rd Day","deg",I["clock"])}</div></div>')
    return (f'<div style="display: flex; gap: 10px; padding: 13px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{timecol(T,time)}<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{sub}</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Open Notes","secondary",I["note"])}</div>'
            + "".join(prep2(T,*p) for p in preps) + ser
            + (f'<div style="margin-top: 11px;">{prose(T,gen,when="8:41 AM")}</div>' if gen else "")
            + (pred2(T,*pred) if pred else "") + '</div></div>')

def focusblock(T,time,title,mins):
    return (f'<div style="display: flex; gap: 10px; padding: 12px 0; border-bottom: 1px solid {T["border"]};">'
            f'{timecol(T,time)}<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 9px; flex-wrap: wrap;">'
            f'<span style="display: flex; color: {T["acc"]};">{ic(I["clock"],15,1.9)}</span>'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'{ent(T,"plain",mins)}'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">blocked on your calendar</span></div></div></div>')

# ============ ONE FACET ORDER, EVERYWHERE ================================
# priority · due · estimate · people · links · state — declared once, obeyed everywhere
def facets(T,*,p=None,d=None,dover=False,e=None,people=(),links=(),states=()):
    out=[]
    if p: out.append(prio(T,p))
    if d: out.append(due(T,d,dover))
    if e: out.append(est(T,e))
    out += [ent(T,"person",n,I["person"]) for n in people]
    out += [ent(T,k,n,g) for k,n,g in links]
    out += [st(T,*s) for s in states]
    return out

def trow3(T,*,title,done=False,last=False,spark=False,indent=0,**kw):
    bits=facets(T,**kw)
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 11px 14px 11px {14+indent}px;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="display: flex; color: {T["tt"]}; margin-top: 2px;">{ic(I["grip"],15,2.6)}</span>'
            f'<span style="margin-top: 2px; display: flex;">{box(T,done)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 14px; color: {T["tp"]};">{title}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px;">'
            + "".join(bits) + '</div></div>'
            + (f'<span style="flex-shrink: 0;">{btn(T,"Delegate","secondary",I["spark"])}</span>' if spark else "")
            + '</div>')

ORDERP=pan(L,"ONE FACET ORDER, WHEREVER A TASK APPEARS",
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]}; overflow: hidden;">'
  + trow3(L,title="Sign the SOW",p=1,d="Today",e="15m",people=["Jim Fallon"],states=[("Waiting",)])
  + trow3(L,title="Send Jim the revised Q4 scope",p=2,d="Wed",e="30m",people=["Jim Fallon"],
          states=[("3rd Day","deg",I["clock"])],indent=22)
  + trow3(L,title="Review the lease comparables",p=2,d="Fri",e="90m",
          links=[("note","Lease Renewal",I["note"])],spark=True,last=True)
  + '</div>'
  + nt(L,"<b>Priority · Due · Estimate · People · Links · State.</b> Declared once and obeyed everywhere a task is "
         "drawn — in a gap, under <i>Last time</i> on a meeting, on the All list, in the plugin. The second row "
         "above is a <i>Last time</i> item and it is now built from the same component, indented, rather than "
         "hand-assembled inline. That was the inconsistency.",16)
  + nt(L,"<b>Due and Estimate are glyph-prefixed, not pills.</b> A calendar and a clock, then the value. They are "
         "not targets you can open, so a chip would overstate them — but they are the two things the eye hunts for "
         "first, and a glyph is what lets it skip the words. When Due goes overdue it escalates into the tinted "
         "chip, which is the ladder doing exactly what it is for.",12))

# ============ SERIF OPTIONS ==============================================
SPECIMEN=("The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
          "He has been waiting on the SOW since Tuesday.")
FACES=[("New York → Charter → Georgia","\"New York\",Charter,'Iowan Old Style',Georgia,serif",
        "<b>Recommended.</b> New York on Apple — Apple drew it to sit beside SF, so it is a <i>companion</i> serif, "
        "not a document serif. Charter and Iowan Old Style catch older macOS and iOS; Georgia catches Windows. "
        "<b>Times is never reached</b>, which was the actual problem: <code>ui-serif</code> resolves to Times in a "
        "browser, and Times is what made it look unformatted."),
       ("Georgia only","Georgia,serif",
        "Warm, large x-height, designed for screens in 1996 and still good at it. Identical on every platform, which "
        "is its real argument — no chance of a surprise. Slightly wide, so long prose runs longer."),
       ("Palatino","Palatino,'Palatino Linotype','Book Antiqua',serif",
        "Humanist and calligraphic — the most obviously <i>voiced</i> of the four. Some will find it too literary "
        "for a status sentence, and its numerals are old-style, which fights a line full of times and dates."),
       ("The sans, set apart","-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
        "The fallback if no serif convinces: same face as the app, but larger, looser and behind a rule. Honest, and "
        "it loses the thing a serif buys — being recognisable at a glance from across the page.")]
def specimen(T,name,stack,why,rec=False):
    return (f'<div style="border: 1px solid {T["bc"] if rec else T["border"]}; border-radius: 11px; '
            f'padding: 15px; background: {T["agq"] if rec else T["surface"]};">'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 9px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,1.7)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">{AN}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11px; color: {T["tt"]};">{name}</span></div>'
            + (f'<div style="font-family: {stack}; font-size: 14.5px; line-height: 1.55; color: {T["tp"]}; '
               f'border-left: 2px solid {T["ag"]}; padding-left: 12px;">{SPECIMEN}</div>' if "sans" in stack
               else f'<div style="font-family: {stack}; font-size: 14.5px; line-height: 1.55; color: {T["tp"]};">{SPECIMEN}</div>')
            + f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.55; margin-top: 11px; '
              f'padding-top: 10px; border-top: 1px solid {T["border"]};">{why}</div></div>')

SERIFP=pan(L,"THE ASSISTANT'S VOICE — FOUR FACES, NO FONT LOADED",
  f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">'
  + "".join(specimen(L,n,s,w,rec=(i==0)) for i,(n,s,w) in enumerate(FACES)) + '</div>'
  + nt(L,"<b>You were seeing Times, and Times was the problem.</b> <code>ui-serif</code> is a generic family: on "
         "Apple it resolves to New York, but in a browser — which is where you are looking at these boards — it "
         "falls straight through to Times. So the stack now <b>names the faces</b> and stops at Georgia, which "
         "exists everywhere. Times is never in the chain.",16)
  + nt(L,"P7 still holds in all four: every one of these is a system face, and nothing is downloaded.",12))

# ============ CALENDAR — A TIMELINE, NOT A DIFF ==========================
BEFORE=[("9:30","1:1 Jim","m",10),("11:00","Design review","m",14),("1:00","Vendor review","m",14),
        ("","","g",12),("3:00","Lease call","m",10),("3:30","Focus","f",22),("","","g",8)]
AFTER =[("9:30","1:1 Jim","m",10),("11:00","Design review","m",14),("1:00","Vendor review","m",14),
        ("1:45","Lease call","mv",10),("2:15","Focus — settings brief","f",36),("","","g",6)]
def strip(T,rows,dark=False,label=""):
    def blk(t,n,k,w):
        col={"m":(CHART_D[1] if dark else CHART_L[0]),"mv":T["ag"],"f":T["acc"],"g":T["sunken"]}[k]
        ink={"m":T["bg"] if not dark else T["bg"],"mv":T["bg"],"f":T["bg"],"g":T["ts"]}[k]
        if not dark and k!="g": ink="#ffffff"
        if dark and k!="g": ink=T["bg"]
        return (f'<div style="width: {w}%; background: {col}; padding: 6px 8px; border-radius: 5px; '
                f'overflow: hidden; white-space: nowrap; text-overflow: ellipsis;">'
                + (f'<span style="font-size: 10.5px; font-weight: 600; color: {ink};">{t} {n}</span>' if n else "")
                + '</div>')
    return (f'<div style="margin-bottom: 10px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; '
            f'margin-bottom: 5px;">{label}</div>'
            f'<div style="display: flex; gap: 3px;">' + "".join(blk(*r) for r in rows) + '</div></div>')

def calplan(T,dark=False):
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 9px; background: {T["surface"]}; '
            f'padding: 12px 13px;">'
            + strip(T,BEFORE,dark,"NOW") + strip(T,AFTER,dark,"IF YOU SAY YES")
            + f'<div style="display: flex; gap: 14px; margin-top: 9px; font-size: 11px; flex-wrap: wrap;">'
            + "".join(f'<span style="display: inline-flex; align-items: center; gap: 5px;">'
                      f'<span style="width: 8px; height: 8px; border-radius: 2px; background: {c};"></span>'
                      f'<span style="color: {T["ts"]};">{n}</span></span>'
              for c,n in [((CHART_D[1] if dark else CHART_L[0]),"unchanged"),(T["ag"],"moved"),
                          (T["acc"],"focus block")]) + '</div></div>')

def calblock2(T,dark=False,w=None):
    return prose(T,"The lease call at 3:00 cuts your afternoon in two. Moving it to <b>1:45</b>, straight after the "
                   "vendor review, lets the focus block start at <b>2:15</b> — two and three-quarter hours for the "
                   "settings brief instead of ninety minutes.",
      when="8:41 AM",
      diffblock=calplan(T,dark),
      acts=[btn(T,"Move the Lease Call&hellip;","secondary",I["spark"]),
            btn(T,"Not Today","ghost")],w=w)

def policyrow(T,label,value,why,last=False):
    return (f'<div style="display: flex; gap: 14px; align-items: flex-start; padding: 10px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="width: 176px; flex-shrink: 0; font-size: 12.5px; color: {T["tp"]};">{label}</span>'
            f'<span style="width: 190px; flex-shrink: 0;">{value}</span>'
            f'<span style="flex-grow: 1; font-size: 11.5px; color: {T["ts"]}; line-height: 1.5;">{why}</span></div>')

def opt(T,t,on=False):
    return (f'<span style="display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 7px; '
            f'border: 1px solid {T["acc"] if on else T["bc"]}; background: {T["accq"] if on else "transparent"}; '
            f'color: {T["acc"] if on else T["ts"]}; font-size: 11.5px; font-weight: 600;">{t}</span>')

POLICY=pan(L,"YOUR RESCHEDULING RULES — METIS ACTS INSIDE THEM, NEVER OUTSIDE",
  f'<div style="border: 1px solid {L["border"]}; border-radius: 10px; background: {L["bg"]}; padding: 4px 14px;">'
  + policyrow(L,"Meetings Metis may move",
      f'{opt(L,"Ones I own",True)} {opt(L,"Any")} {opt(L,"None")}',
      "A 1:1 you scheduled is yours to move; a meeting someone else called is not. This is the setting that makes "
      "the whole feature safe, so it is first and it defaults to the narrow answer. Any meeting with other people "
      "in it <b>warns first</b>, naming who will be told (C90).")
  + policyrow(L,"Least notice",f'{opt(L,"2 hours",True)} {opt(L,"1 day")}',
      "Below this, Metis proposes and never moves — a meeting starting in twenty minutes is not a scheduling "
      "problem, it is a phone call.")
  + policyrow(L,"Protect",f'{opt(L,"Before 10 AM",True)} {opt(L,"After 4 PM",True)}',
      "Hours Metis may move things <i>out of</i> but never <i>into</i>. Most people have a shape to their day that "
      "no calendar knows about.")
  + policyrow(L,"Other people’s calendars",f'{opt(L,"Avoid conflicts",True)} {opt(L,"Ignore")}',
      "Free/busy only, and only for attendees whose calendars you can already see. Metis does not learn anything "
      "about their day beyond whether a slot is taken.")
  + policyrow(L,"Tell them",f'{opt(L,"The calendar tells them",True)} {opt(L,"Draft a note too")}',
      "Metistry itself never sends. Moving the event is what tells them — the calendar sends its own update — and "
      "the warning before the move names every person who gets one.",last=True)
  + '</div>'
  + nt(L,"<b>Rescheduling is opt-in and per-user, because the rules are personal.</b> A manager moving their own "
         "1:1s is a different risk from someone shuffling a customer call, and no default can tell them apart. So "
         "the policy is a small set of questions asked once, and every offer says which rule let it through: "
         "<i>“you own this meeting, and your policy allows moving it with 2 hours’ notice.”</i>",16)
  + nt(L,"<b>Per-meeting opt-out sits on the event itself</b> — <i>never move this one</i> — because there is always "
         "one recurring meeting that looks movable and is not. A policy without an escape hatch gets turned off "
         "entirely the first time it is wrong.",12))

def moveconfirm(T,w=380):
    """C90: Metis may move a meeting with other people in it, and warns first. Neutral — moving a
    meeting is not a fault — and it names people, because *Are you sure?* names nothing."""
    ppl="".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 3px 0;">'
                f'<span style="display: flex; color: {T["ts"]};">{ic(I["person"],13,1.9)}</span>'
                f'<span style="font-size: 12.5px; color: {T["tp"]};">{n}</span></div>'
                for n in ("Tom Reyes",))
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 12px; '
            f'box-shadow: 0 12px 34px rgba(26,24,21,0.18); padding: 14px 16px;">'
            f'<div style="font-size: 14px; font-weight: 600; color: {T["tp"]};">Move the Lease Call to 1:45 PM?</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 4px;">Your calendar sends him the update.</div>'
            f'<div style="margin-top: 9px; padding: 6px 10px; background: {T["sunken"]}; border-radius: 8px;">{ppl}</div>'
            f'<div style="display: flex; gap: 7px; margin-top: 12px;">{btn(T,"Move It","affirm")}'
            f'{btn(T,"Cancel","secondary")}</div></div>')

CALP2=pan(L,"A CALENDAR CHANGE IS A SHAPE, NOT A DIFF",
  calblock2(L)
  + f'<div style="display: flex; gap: 16px; align-items: flex-start; margin-top: 14px;">{moveconfirm(L)}'
  + f'<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>Moving a meeting with other people in it warns first</b> (C90). The warning names who will be told "
         "and the new time; nothing is tinted, because a move is not a fault. A meeting that is only yours moves "
         "without it.") + '</div></div>'
  + nt(L,"<b>You were right that the diff was wrong here.</b> A diff is a <i>text</i> grammar: it reads top to "
         "bottom, every line is equal, and it says nothing about duration or adjacency. A calendar change is about "
         "<b>shape</b> — how long the blocks are, what sits next to what, how big the hole in the middle is. Two "
         "strips, now and after, answer that in one glance and a diff cannot answer it at all.",16)
  + nt(L,"<b>The diff keeps everything textual</b> — a revision to your plan, a task line about to be written, a "
         "template change. One grammar per kind of change, rather than one grammar stretched over both.",12))

# ============ PLUGIN — overlay hint, editable chips ======================

def editor(T,OB,*,active_hint=True,w=470):
    line=lambda t,extra="": (f'<div style="position: relative; padding: 2px 0; font-size: 14px; '
                             f'color: {OB["text"]}; line-height: 1.75;">{t}{extra}</div>')
    hint=("" if not active_hint else
          f'<span style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); '
          f'display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; '
          f'background: {T["agq"]}; color: {T["ag"]}; font-size: 10.5px; font-weight: 600; '
          f'pointer-events: none; white-space: nowrap;">{ic(I["spark"],11,2)}⌘J</span>')
    chips=(" " + prio(T,1) + " " + due(T,"Fri") + " " + ent(T,"person","Jim Fallon",I["person"]))
    return (f'<div style="width: {w}px; flex-shrink: 0; border: 1px solid {T["border"]}; border-radius: 10px; '
            f'background: {OB["bg"]}; padding: 14px 16px; overflow: hidden;">'
            f'<div style="font-size: 11px; color: {OB["faint"]}; margin-bottom: 8px;">'
            f'Journal/Meetings/2026-09-20-design-review.md</div>'
            + line("Ryan will own the migration plan.")
            + line(f'<span style="display: inline-flex; align-items: center; gap: 8px; vertical-align: middle;">'
                   f'<span style="width: 14px; height: 14px; border-radius: 4px; border: 1px solid {OB["faint"]}; '
                   f'flex-shrink: 0;"></span>Send Jim the revised Q4 scope'
                   f'<span style="display: inline-block; width: 1.5px; height: 17px; background: {T["ag"]};"></span>'
                   f'</span>',hint)
            + line("We agreed to revisit the Q4 scope once the lease lands.")
            + line(f'<span style="display: inline-flex; align-items: center; gap: 8px; vertical-align: middle; '
                   f'flex-wrap: wrap;">'
                   f'<span style="width: 14px; height: 14px; border-radius: 4px; border: 1px solid {OB["faint"]}; '
                   f'flex-shrink: 0;"></span>Review the lease comparables{chips}</span>')
            + '</div>')

def chipedit(T,w=200):
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'border-radius: 10px; box-shadow: 0 10px 28px rgba(26,24,21,0.18); padding: 5px;">'
            + "".join(f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 9px; '
                      f'border-radius: 6px; background: {T["accq"] if s else "transparent"};">'
                      f'{prio(T,n)}<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{lab}</span>'
                      f'<span style="font-family: {MONO}; font-size: 11px; color: {T["ts"]};">p{n}</span></div>'
              for n,lab,s in [(1,"Critical",True),(2,"High",False),(3,"Normal",False),(4,"Low",False)])
            + f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 9px; border-radius: 6px; '
              f'border-top: 1px solid {T["border"]}; margin-top: 4px;">'
              f'<span style="font-size: 12.5px; color: {T["ts"]}; flex-grow: 1;">Remove</span>'
              f'<span style="display: flex; color: {T["tt"]};">{ic(I["x"],12,2.2)}</span></div></div>')

PLUGFIX=pan(L,"THE HINT NEVER MOVES YOUR TEXT",
  f'<div style="display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap;">'
  f'{editor(L,OB_D)}'
  f'<div style="min-width: 0; flex-grow: 1;">'
  + nt(L,"<b>You are right, and a hint that reflows the document is unusable.</b> So it is not in the line — it is "
         "an <b>overlay pinned to the right edge of the active line</b>, out of the text flow entirely. Nothing "
         "below it moves, whether it appears, disappears, or the line rewraps under it.")
  + nt(L,"Three things keep it out of the way: it is only ever on the line the cursor is in; it is "
         "<code>pointer-events: none</code> so it can never eat a click meant for the text; and it shrinks to just "
         "<code>⌘J</code> once you have used it a few times, then stops appearing at all.",12)
  + nt(L,"<b>Inline was the other option and it is worse</b> — it would push the line into a second row exactly when "
         "you are typing fast, which is the moment that matters most. The margin is free space that the editor is "
         "not using.",12)
  + '</div></div>')

CHIPEDP=pan(L,"AND A CHIP IS A CONTROL, NOT A LABEL",
  f'<div style="display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;">'
  f'<div style="display: flex; flex-direction: column; gap: 9px; align-items: flex-start;">'
  f'<div style="display: flex; gap: 7px; align-items: center; padding: 9px 11px; border-radius: 8px; '
  f'background: {OB_D["bg"]};">{prio(D,1)}{due(D,"Fri")}{ent(D,"person","Jim Fallon",I["person"])}</div>'
  f'<span style="font-size: 11.5px; color: {L["ts"]};">click the P1 →</span></div>'
  f'{chipedit(L)}'
  f'<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"Once the metadata is on the line it is <b>editable in place</b>: click <b>P1</b> for the priority list, "
         "the date chip for a date, the person chip for the People/ list. Each one writes the same shorthand back "
         "into the line, so the file stays a file you could have typed.")
  + nt(L,"<b>The list shows the shorthand again</b> — <code>p3</code> beside <i>Normal</i> — because editing is the "
         "second place you learn it, and because the person who eventually types <code>p3</code> instead of "
         "clicking is the person this plugin was built for.",12)
  + nt(L,"<b>Remove is on the same menu</b>, not a separate gesture. A chip you can add and cannot take off is a "
         "trap, and hovering for a tiny × is not something you can do while talking in a meeting.",12)
  + '</div></div>')

# ============ REBUILD THE THREE BOARDS ==================================

def meeting5(T,*,time,title,sub,preps,gen=None,pred=None,series=False,last=False):
    ser=""
    if series:
        ser=(f'<div style="margin-top: 10px; border-left: 2px solid {T["border"]}; padding-left: 11px;">'
             f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
             f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">LAST TIME</span>'
             f'{ent(T,"note","6 September",I["note"])}'
             f'<span style="font-size: 12px; color: {T["ts"]};">3 action items · 2 done</span></div>'
             f'<div style="margin: 6px -14px 0;">'
             + trow3(T,title="Send Jim the revised Q4 scope",p=2,d="Wed",e="30m",people=["Jim Fallon"],
                     states=[("3rd Day","deg",I["clock"])],last=True) + '</div></div>')
    return (f'<div style="display: flex; gap: 10px; padding: 13px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{timecol(T,time)}<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{sub}</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Open Notes","secondary",I["note"])}</div>'
            + "".join(prep2(T,*p) for p in preps) + ser
            + (f'<div style="margin-top: 11px;">{prose(T,gen,when="8:41 AM")}</div>' if gen else "")
            + (pred2(T,*pred) if pred else "") + '</div></div>')

def spine6(T):
    g1=(trow3(T,title="Sign the SOW",p=1,d="Today",e="15m",people=["Jim Fallon"],states=[("Waiting",)])
        + trow3(T,title="Call the dentist",p=3,d="18 Sep",dover=True,e="15m",
                states=[("5th Day","deg",I["clock"])],last=True))
    g2=(trow3(T,title="Write the design brief for the settings pane",p=1,d="Wed",e="45m",
              links=[("project","Settings Pane",I["board"]),("agent","Work #418",I["agents"])],spark=True)
        + trow3(T,title="Review the lease comparables",p=2,d="Wed",e="90m",
                links=[("note","Lease Renewal",I["note"])],spark=True,last=True))
    art=(f'<div style="display: flex; gap: 10px; padding: 13px 0; border-bottom: 1px solid {T["border"]};">'
         f'{timecol(T,"9:15 AM")}<div style="flex-grow: 1; min-width: 0; max-width: 560px;">'
         + artcard(T,name="Standup Draft",made="standup-draft · 6:02 AM",
             body=["Yesterday — shipped the tokens pass; reviewed drey-dev’s migration.",
                   "Today — the settings pane; the lease note.",
                   "Blockers — waiting on the SOW signature."],
             forwhat="Standup · 9:15 AM · recurring",changed="2 Things Changed Since This Was Written")
         + '</div></div>')
    return (fold(T) + nowbar(T) + art
      + meeting5(T,time="9:30–10:00 AM",title="1:1 with Jim Fallon",sub="every other Tuesday",
          preps=[(I["person"],"3 open tasks assigned to",(("person","Jim Fallon",I["person"]),)),
                 (I["check"],"you owe him",(("plain","Sign the SOW",I["check"]),))],
          series=True,
          gen="The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
              "He has been waiting on the SOW since Tuesday.",
          pred=("Draft the Agenda","— 3 open items, and one carried from last time"))
      + gap(T,"35m",g1,"2 tasks fit · 5m to spare")
      + travel(T,"25m","to the Ann Arbor office")
      + meeting5(T,time=F["design_review"],title="Design review",sub="4 people · in person · moved from 1:00 PM",
          preps=[(I["board"],"in review, and what this is about",(("agent","Work #418",I["agents"]),)),
                 (I["note"],"its brief gets the focus block after it",(("project","Settings Pane",I["board"]),))],
          pred=("Open Work #418","— the review is about it"))
      + travel(T,"25m","back")
      + focusblock(T,"12:30 PM","Focus — the settings brief","90m")
      + gap(T,"2h",g2,"1 of 2 fits"))

def hub6(T,dark=False,w=1280):
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{toolbar(T)}<div style="display: flex;">{sidebar8(T)}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex;">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="padding: 14px 16px 13px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Today</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{F["day"]}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">as of 2 min ago</span>{seg(T)}</div>'
            f'{daybar(T,dark)}</div>'
            f'<div style="padding: 12px 14px 0;">'
            + prose(T,"You asked to push the lease review to tomorrow and put the brief first. <b>3 items moved.</b>",
                    when="8:47 AM",
                    diffblock=diff(T,summary="3 items moved on today’s plan",lines=[
                        (" ","9:30 AM  1:1 with Jim Fallon"),
                        ("-","Review the lease comparables   due Fri"),
                        ("+","Review the lease comparables   due Wed"),
                        ("-","Write the design brief         3rd"),
                        ("+","Write the design brief         1st")]),
                    acts=[btn(T,"Undo","secondary",I["undo"])]) + '</div>'
            f'<div style="padding: 10px 14px 14px;">{spine6(T)}</div>'
            f'<div style="padding: 0 14px 14px;">{calblock2(T,dark)}</div>'
            f'<div style="padding: 0 14px 16px;">{askbar(T)}</div></div>{rail(T)}</div></div></div>')

NAVP3=pan(L,"TODAY FIRST",
  f'<div style="display: flex; gap: 20px; align-items: flex-start;">'
  f'<div style="width: 190px; flex-shrink: 0;">{sidebar8(L)}</div>'
  f'<div style="flex-grow: 1; min-width: 0;">'
  + nt(L,"<b>Today is the first row, above Chat.</b> The argument that put it second was that Chat is where you go "
         "with a question — but that is not how you <i>open</i> an app. You open it to find out where you stand, "
         "and then you ask something.")
  + nt(L,"It also makes the landing screen the one that can send you anywhere: every other section is reachable "
         "from something on Today. Chat first made the app a chat client with attachments.",12)
  + '</div></div>')


# ===================== BACK-PATCH: access_request, and routines in Activity ==============
# Added round E. Both are drawn against wire that does not fully exist yet — the owner
# ruled 2026-09-20 that designing ahead of the surface is allowed and the developer adapts
# afterwards. Every gap is named in the request list rather than drawn around.


# ---------- the scope triple: one line, the same words in the CLI, console and queue -----
def scopeline(T,*,who,access,extras,label="WHAT IT HOLDS NOW"):
    """`current_scope.line` (core's describeScope) rendered verbatim. The card never
    composes this sentence itself — P3 §3.4: one record, said one way."""
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 11px 13px; margin-top: 10px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 7px;">{label}</div>'
            f'<div style="display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; font-size: 12px; '
            f'color: {T["ts"]};"><span style="color: {T["tp"]}; font-weight: 600;">{who}</span>'
            f'<span style="opacity: 0.45;">·</span>{mono(access,T["tp"],12)}'
            f'<span style="opacity: 0.45;">·</span><span>{extras}</span></div></div>')

# ---------- what Approve does, and what it costs -----------------------------------------
def approvebox(T,*,adds,trade=None):
    """The widening, and the tier trade when there is one. `widenedGrants` sets tier
    `folders` unconditionally, so an agent at `titles` LOSES whole-vault browsing — a
    cost, drawn as one, in `degraded`. Colour never carries it alone: the words do."""
    tr=""
    if trade:
        tr=(f'<div style="display: flex; gap: 8px; align-items: flex-start; background: {T["degq"]}; '
            f'border-radius: 8px; padding: 9px 11px; margin-top: 10px;">'
            f'<span style="display: flex; color: {T["deg"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["warn"],13,2)}</span>'
            f'<span style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.5;">{trade}</span></div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 14px; margin-top: 10px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 8px;">WHAT APPROVE DOES</div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px;">'
            f'<span style="font-size: 12px; color: {T["ts"]};">Adds</span>{mono(adds,T["tp"],12.5)}</div>{tr}</div>')

# ---------- the agent's reason: data, never interface (P1) --------------------------------
def askreason(T,text,*,folded=True):
    more=(f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 8px; color: {T["acc"]}; '
          f'font-size: 11.5px; font-weight: 600;">{ic(I["chevr"],12,2.4)}<span>the rest of the reason</span></div>') if folded else ""
    return (f'<div style="background: {T["agq"]}; border-radius: 10px; padding: 12px 14px; margin-top: 10px;">'
            f'<div style="display: flex; align-items: center; gap: 6px; margin-bottom: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],12,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">WHY IT IS ASKING</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.55;">{text}</div>{more}</div>')

# ---------- asked again after a decline --------------------------------------------------
def askedagain(T,*,when,prior):
    """`escalated` + `prior_proposal` + `prior_declined_at` on the payload. NEUTRAL, not
    tinted: the three channels reserve tint for something being WRONG, and a second ask
    is provenance, not a fault (ratified channel rule)."""
    return (f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["absq"]}; '
            f'border-radius: 9px; padding: 10px 12px; margin-top: 12px;">'
            f'<span style="display: flex; color: {T["ts"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["repeat"],14,1.9)}</span>'
            f'<div style="min-width: 0;"><div style="font-size: 12px; font-weight: 600; color: {T["tp"]};">Asked again</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 2px;">'
            f'You declined this {when}. <span style="color: {T["acc"]}; font-weight: 600;">Read what you answered</span>'
            f' — request #{prior}. The next decline closes it: the tool refuses a third ask.</div></div></div>')

# ---------- Revise: a control that can only grant LESS ------------------------------------
def prefixctl(T,*,asked,granting,children):
    """The asked prefix is a CEILING. Every option is at or below it, so the gesture can
    only narrow. Granting more than was asked is not a revision — it is a different
    decision, and it is not on this control."""
    opts=""
    for p,kind in children:
        if kind=="asked":
            tag=f'<span style="font-size: 10.5px; color: {T["tt"]};">as asked</span>'
            ink,wt=T["ts"],400
        elif kind=="sel":
            tag=(f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; '
                 f'font-weight: 700; color: {T["aff"]};">{ic(I["check"],11,3)}granting</span>')
            ink,wt=T["tp"],600
        else:
            tag=""
            ink,wt=T["ts"],400
        opts+=(f'<div style="display: flex; align-items: baseline; gap: 9px; padding: 5px 0;">'
               f'<span style="font-family: {MONO}; font-size: 11.5px; color: {ink}; font-weight: {wt};">{p}</span>{tag}</div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 14px; margin-top: 10px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 9px;">REVISE — GRANT LESS THAN WAS ASKED</div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px; padding-bottom: 8px; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 12px; color: {T["ts"]};">Ceiling</span>{mono(asked,T["tp"],12.5)}</div>'
            f'<div style="margin-top: 6px;">{opts}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.55; margin-top: 8px; '
            f'padding-top: 9px; border-top: 1px solid {T["border"]};">'
            f'Nothing above {mono(asked,T["ts"],11.5)} is on this control. Granting more than was asked is not a '
            f'revision of this request — it is a new decision, and it belongs on Agents.</div></div>')

# ---------- a refusal, inline, leaving the row exactly where it was -----------------------
def refusal(T,*,code,text):
    """Every access refusal runs BEFORE the row is settled, so the card is still pending
    and still answerable. The band says so, because a refusal that looks like a decision
    is the lie P5 forbids."""
    return (f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["failq"]}; '
            f'border-radius: 9px; padding: 10px 12px; margin-top: 12px;">'
            f'<span style="display: flex; color: {T["fail"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["warn"],14,2)}</span>'
            f'<div style="min-width: 0;">'
            f'<div style="font-size: 12px; color: {T["tp"]}; line-height: 1.55;">{text}</div>'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 7px;">'
            f'{mono(code,T["ts"],11)}'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">· still waiting on you — nothing was decided</span>'
            f'</div></div></div>')

# ---------- the card ---------------------------------------------------------------------
ASK_REASON=("The lease comparables live in <b>Areas/Finance/Vendors</b> and I can see the titles but not the "
            "text, so I cannot answer what the March renewal is being measured against without guessing.")

def accesscard(T,*,state="pending",width=None,agent="drey-dev",trust="internal",when="12m",
               asked="Areas/Finance",tier="titles"):
    w=f"width: {width}px;" if width else ""
    head=(f'<div style="display: flex; align-items: center; gap: 8px;">'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["key"],15,1.8)}</span>'
          f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">ACCESS</span>'
          f'<span style="flex-grow: 1;"></span>'
          f'{mono(agent,T["ag"],11)}{trustmark(T,trust)}'
          f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>')
    title=(f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]}; margin-top: 10px; line-height: 1.35;">'
           f'Read {mono(asked,T["tp"],14)}</div>')
    trade=("It is browsing every title in the vault today. An area grant ends that: it would see titles "
           "only inside its own folders." if tier=="titles" else None)
    scope=scopeline(T,who="an agent",access=("titles: every folder" if tier=="titles" else f"folders: {asked}"),
                    extras="no queries · every project")
    body=head+title+askreason(T,ASK_REASON)+scope
    acts=(f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
          f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Revise","secondary",I["pencil"])}'
          f'{btn(T,"Decline","secondary",I["x"])}'
          f'<span style="flex-grow: 1;"></span>'
          f'{btn(T,"","ghost",I["later"],icon_only=True,title="Later — it comes back on its own")}</div>')
    if state=="pending":
        body+=approvebox(T,adds=asked,trade=trade)+acts
    elif state=="escalated":
        body=head+title+askedagain(T,when="on the 18th",prior="311")+askreason(T,ASK_REASON,folded=False)+scope \
             +approvebox(T,adds=asked,trade=trade)+acts
    elif state=="revising":
        body+=prefixctl(T,asked=asked,granting="Areas/Finance/Vendors",
                        children=[("Areas/Finance","asked"),("Areas/Finance/Vendors","sel"),
                                  ("Areas/Finance/Payroll",""),("Areas/Finance/Vendors/2026","")]) \
             +approvebox(T,adds="Areas/Finance/Vendors",trade=trade)+acts
    elif state=="refused":
        mf=mono("agents/ops/taskuary.md",T["tp"],11.5)
        body+=refusal(T,code="forbidden",
                      text=("<b>taskuary</b>'s scope is configuration, not a grant: it is re-synced from its "
                            "manifest, so approving this would be undone at the next crew sync. Decline this "
                            "request and edit "+mf+"."))+acts
    return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 16px; box-sizing: border-box;">{body}</div>')

# ===================== ACTIVITY — bands, rows, chips, and routines =======================
FEED_CHIPS=[("All",True),("Captures",False),("Proposals",False),("Decisions",False),("Work",False),
            ("Runs",False),("Routines",False),("Messages",False)]

def chipbar(T,chips=None):
    """Eight chips. Seven are the query's own `group` column plus All — `routine` is the
    eighth and new (C43): a routine is neither a run the assistant made nor a message it
    sent, and a system that runs on a schedule deserves to be filterable by it."""
    return (f'<div style="display: flex; gap: 6px; flex-wrap: wrap;">'
            + "".join(f'<span style="padding: 3.5px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 500; '
                      f'background: {T["accq"] if s else "transparent"}; color: {T["acc"] if s else T["ts"]}; '
                      f'border: 1px solid {"transparent" if s else T["border"]};">{t}</span>'
                      for t,s in (chips or FEED_CHIPS)) + '</div>')

def band(T,label):
    return (f'<div style="padding: 7px 16px; background: {T["sunken"]}; font-size: 10.5px; font-weight: 700; '
            f'letter-spacing: 0.08em; color: {T["tt"]};">{label}</div>')

def feedrow(T,*,glyph,actor,subject,detail,when,kind="agent",last=False,spark=False,tint=None,expand=None):
    """`[kind glyph] [actor chip] [subject] … [time]`, detail on a second line, ONE left
    edge. The actor sits before the subject so a long subject truncates into the gap
    before the time column instead of pushing anything about."""
    bd="" if last else f'border-bottom: 1px solid {T["border"]};'
    ac=ent(T,"agent",actor,mono_=True) if kind=="agent" else ent(T,"plain",actor,mono_=True)
    sp=(f'<span style="display: inline-flex; color: {T["ag"]}; margin-left: 2px;">{ic(I["spark"],12,2.2)}</span>') if spark else ""
    ex=""
    if expand:
        ex=(f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; color: {T["acc"]}; '
            f'font-size: 11.5px; font-weight: 600;">{ic(I["chevr"],12,2.4)}<span>{expand}</span></div>')
    return (f'<div style="display: flex; gap: 11px; align-items: flex-start; padding: 11px 16px; {bd}">'
            f'<span style="display: flex; flex-shrink: 0; color: {tint or T["tt"]}; margin-top: 1px;">{ic(glyph,17,1.8)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 8px; min-width: 0;">{ac}'
            f'<span style="font-size: 13.5px; font-weight: 500; color: {T["tp"]}; overflow: hidden; '
            f'text-overflow: ellipsis; white-space: nowrap;">{subject}</span>{sp}</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.45; margin-top: 3px;">{detail}</div>{ex}</div>'
            f'<span style="flex-shrink: 0; font-size: 12px; color: {T["ts"]}; margin-top: 2px;">{when}</span></div>')

def routineprose(T,text,*,when,w=None):
    """A routine's output is agent-written prose, so it gets the one prose component:
    spark, label, serif body, a verdict on it. Expanding the row shows THIS, not a diff."""
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} background: {T["agq"]}; border-radius: 10px; padding: 13px 15px; '
            f'margin: 2px 16px 12px 44px; box-sizing: border-box;">'
            f'<div style="display: flex; align-items: center; gap: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">{AN} WROTE THIS</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11px; color: {T["ts"]};">{when}</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.6; margin-top: 9px;">{text}</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 11px;">'
            f'{btn(T,"Open the File","secondary",I["note"])}'
            f'<span style="flex-grow: 1;"></span>'
            + thumbs(T) + '</div></div>')

PLAN_PROSE=("Tomorrow is thin before 11 and full after it. I have put the two lease items in the morning because "
            "the 11:00 review is the thing they feed, and left the 45 minutes after lunch empty rather than "
            "filling it — you have moved that block three days running.")
STANDUP_PROSE=("Yesterday: closed the vendor comparison and the Q4 pricing note. Today: the lease renewal reply "
               "and the 11:00 design review. Nothing is blocked.")

def routinerows(T,*,last_absent=False):
    """Two cases, and they do not share an actor. A BUILT-IN routine is the system on
    a schedule, so its actor is neutral. A routine that assigns work to one of the
    owner's agents has that AGENT as its actor, with the routine named as the reason
    it ran (ruled 2026-09-21: a routine is an assignment, not a species of actor)."""
    ms = chr(60)+'span style="font-family: '+MONO+'; font-size: 11.5px;"'+chr(62)
    rows=(feedrow(T,glyph=I["cal"],actor="plan-tomorrow",subject="Tomorrow's Plan",
            detail=ms+"Journal/Plan/2026-09-21.md</span> &middot; default &middot; 9 tasks, 2 meetings, 45m left empty",
            when="6m",kind="system",spark=True,expand="what it wrote")
          + routineprose(T,PLAN_PROSE,when="6:02 AM")
          + feedrow(T,glyph=I["repeat"],actor="collator",subject="Morning Brief",
            detail="ran its routine &middot; "+ms+"Journal/Digest/2026-09-21.md</span> &middot; 6 rows from 4 files",
            when="1h",kind="agent",spark=True,expand="what it wrote")
          + routineprose(T,STANDUP_PROSE,when="9:02 AM"))
    if last_absent:
        rows+=feedrow(T,glyph=I["plug"],actor="knowledge-fold",subject="Knowledge Fold",
            detail="did not run — no reconciler bridge, so there was nothing to read and nowhere to write",
            when="2h",kind="system",tint=T["abs"],last=True)
    return rows


# ===================== AGENTS — the credential surface ===================
# Round E, screen 7. The only screen where grants and autonomy move, so every
# component here is built around making the owner's own change legible to them.

def presdot(T,state):
    """Five computed presence states, TWO colours. Tint carries `something is
    wrong` and nothing else, and working/queued/idle are not wrong."""
    if state=="working":  return f'<span style="width: 9px; height: 9px; border-radius: 50%; background: {T["tp"]}; flex-shrink: 0;"></span>'
    if state=="queued":   return (f'<span style="width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box; '
                                  f'border: 2.5px solid {T["tp"]}; flex-shrink: 0;"></span>')
    if state in ("interrupted","over-cap"):
        return f'<span style="width: 9px; height: 9px; border-radius: 50%; background: {T["deg"]}; flex-shrink: 0;"></span>'
    # `bs` is a DIVIDING token and fails 3:1 against every ground (1.75:1 on bg) — a mark that carries meaning takes an ink
    return f'<span style="width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid {T["tt"]}; flex-shrink: 0;"></span>'

def credrow(T,*,id_,role,external=False,scope,spend,seen,state="idle",note=None,open_=False,last=False,ceiling=None):
    bd="" if (last or open_) else f'border-bottom: 1px solid {T["border"]};'
    chev=ic(I["chevd"] if open_ else I["chevr"],13,2.2)
    ext=trustmark(T,"external") if external else ""
    nt_=""
    if note:
        nt_=(f'<div style="font-size: 11.5px; color: {T["deg"]}; margin-top: 3px;">{note}</div>')
    cl=""
    if ceiling:
        cl=(f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 4px;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["lock"],12,1.9)}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{ceiling}</span></div>')
    return (f'<div style="display: grid; grid-template-columns: 9px minmax(0,1fr) 150px 116px 64px 54px 16px; '
            f'align-items: center; gap: 12px; padding: 12px 16px; {bd}">'
            f'{presdot(T,state)}'
            f'<div style="min-width: 0;"><div style="display: flex; align-items: center; gap: 8px;">'
            f'{mono(id_,T["tp"],13)}{ext}</div>{nt_}{cl}</div>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{role}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{scope}</span>'
            f'<span style="font-size: 12px; color: {T["tp"]}; text-align: right; font-variant-numeric: tabular-nums;">{spend}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right;">{seen}</span>'
            f'<span style="display: flex; color: {T["tt"]};">{chev}</span></div>')

def seg3(T,steps,active):
    out=""
    for i,s in enumerate(steps):
        on=(s==active)
        out+=(f'<span style="padding: 4px 12px; font-size: 12px; font-weight: {600 if on else 500}; '
              f'background: {T["surface"] if on else "transparent"}; color: {T["tp"] if on else T["ts"]}; '
              + ("" if i==0 else f'border-left: 1px solid {T["border"]};') + '">'+s+'</span>')
    return (f'<span style="display: inline-flex; border: 1px solid {T["bc"]}; border-radius: 8px; overflow: hidden; '
            f'background: {T["sunken"]};">{out}</span>')

def modepip(T,mode,dim=False):
    """The weight channel, not colour. A configuration is not a moral position,
    and red is spoken for by `failed`."""
    ink=T["tt"] if dim else T["tp"]
    if mode=="allow":
        st=f'background: {ink}; border: 1px solid {ink};'
    elif mode=="propose":
        st=f'background: transparent; border: 1.5px solid {ink};'
    else:
        st=f'background: transparent; border: 1px dashed {T["tt"]};'   # not `bs`: a signifying mark needs an ink (1.6:1 on sunken)
    lab=T["tt"] if (dim or mode=="deny") else T["tp"]
    return (f'<span style="display: inline-flex; align-items: center; gap: 7px;">'
            f'<span style="width: 11px; height: 11px; border-radius: 3px; box-sizing: border-box; {st}"></span>'
            f'<span style="font-size: 12.5px; font-weight: {600 if mode=="allow" and not dim else 500}; '
            f'color: {lab};">{mode}</span></span>')

def autorow(T,kind,effective,*,reason=None,stored=None,last=False):
    """The EFFECTIVE mode is the value. Two different reasons a cell is not
    `allow` — defaulted and clamped — and they must not read alike."""
    bd="" if last else f'border-bottom: 1px solid {T["border"]};'
    rz=""
    if stored:
        rz=(f'<span style="display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: {T["ts"]};">'
            f'<span style="opacity: 0.6;">you set</span>{modepip(T,stored,dim=True)}'
            f'<span style="opacity: 0.45;">·</span><span>the level is the ceiling</span></span>')
    elif reason:
        rz=f'<span style="font-size: 11.5px; color: {T["ts"]};">{reason}</span>'
    return (f'<div style="display: grid; grid-template-columns: 116px 104px minmax(0,1fr); align-items: center; '
            f'gap: 14px; padding: 9px 0; {bd}">'
            f'{mono(kind,T["tp"],12.5)}{modepip(T,effective)}{rz}</div>')

AUTO=[("dispatch","propose","off-machine is a human decision by default",None),
      ("task_update","allow",None,None),
      ("comment","propose",None,"allow"),
      ("capture","allow",None,None)]

def autoblock(T,level="act_within_scope"):
    rows="".join(autorow(T,k,e,reason=r,stored=s,last=(i==len(AUTO)-1)) for i,(k,e,r,s) in enumerate(AUTO))
    fields="".join(f'<div style="display: flex; align-items: baseline; gap: 10px; padding: 5px 0;">'
                   f'{mono(k,T["ts"],11.5)}<span style="font-size: 12px; color: {T["tp"]};">{v}</span></div>'
                   for k,v in [("May Dispatch To","devin, cursor"),("Accept From","metis"),("Max Open Bundles","3")])
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">LEVEL — A CEILING</span>'
            f'{seg3(T,["observe","propose","act_within_scope"],level)}</div>'
            f'<div style="margin-top: 12px;">{rows}</div>'
            f'<div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid {T["border"]};">{fields}</div></div>')

def arealine(T,p,*,approved=None,last=False):
    tag=""
    if approved:
        tag=(f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; '
             f'color: {T["acc"]};">{ic(I["check"],11,2.8)}approved in Needs You · #{approved}</span>')
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 5px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            + mono(p,T["tp"],12) + tag
            + f'<span style="flex-grow: 1;"></span>'
              f'<span style="display: flex; color: {T["tt"]};">{ic(I["x"],12,2)}</span></div>')

def scopeblock(T,*,crew=False):
    if crew:
        return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
                + scopeline(T,who="a crew",access="folders: Areas/Ops",extras="no queries · 2 projects",
                            label="WHAT IT HOLDS NOW")
                + f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["absq"]}; '
                  f'border-radius: 9px; padding: 10px 12px; margin-top: 12px;">'
                  f'<span style="display: flex; color: {T["ts"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["lock"],14,1.9)}</span>'
                  f'<span style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.55;">This scope is '
                  f'<b>configuration, not a grant</b>: it is re-synced from '
                  + mono("agents/ops/research-crew.md",T["tp"],11.5) +
                  f' on every crew sync, so a control here would be undone at the next one. A crew also cannot ask '
                  f'for access — {mono("request_access",T["ts"],11)} is in {mono("CREW_NEVER_TOOLS",T["ts"],11)}.'
                  f'</span></div></div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            + scopeline(T,who="the instance assistant",access="folders: 4 areas",extras="no queries · every project")
            + f'<div style="display: flex; align-items: center; gap: 12px; margin-top: 13px;">'
              f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">TIER</span>'
              f'{seg3(T,["none","titles","folders"],"folders")}</div>'
            + f'<div style="margin-top: 12px;">'
              f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
              f'margin-bottom: 5px;">AREAS</div>'
            + arealine(T,"Areas/Projects") + arealine(T,"Areas/Ops")
            + arealine(T,"Areas/Personal") + arealine(T,"Areas/Finance",approved="311",last=True)
            + '</div>'
            + f'<div style="display: flex; gap: 22px; margin-top: 12px; padding-top: 11px; '
              f'border-top: 1px solid {T["border"]};">'
              f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">PROJECTS</div>'
              f'<div style="font-size: 12px; color: {T["tp"]}; margin-top: 4px;">every project</div></div>'
              f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">QUERIES</div>'
              f'<div style="font-size: 12px; color: {T["tp"]}; margin-top: 4px;">off — a separate axis; '
              f'approving an area never touches it</div></div></div></div>')

def doingblock(T):
    def line(g,txt,tone=None,last=False):
        return (f'<div style="display: flex; align-items: flex-start; gap: 9px; padding: 7px 0;'
                + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
                f'<span style="display: flex; flex-shrink: 0; color: {tone or T["tt"]}; margin-top: 1px;">{ic(g,14,1.8)}</span>'
                f'<span style="font-size: 12px; color: {T["tp"]}; line-height: 1.5;">{txt}</span></div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 4px;">WHAT IT IS DOING</div>'
            + line(I["work"],'Holding <b>#418 Migrate the settings pane to tokens</b> — lease until 9:40 AM')
            + line(I["clock"],'The lease on <b>#402</b> expired 20 minutes ago and the claim is still held',tone=T["deg"])
            + line(I["review"],'1 review bundle waiting, none claimed')
            + line(I["gauge"],'<b>$0.31</b> today',last=True) + '</div>')

def openrow(T,w=None):
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} background: {T["surface"]}; border-top: 1px solid {T["border"]}; '
            f'border-bottom: 1px solid {T["border"]}; padding: 4px 16px 16px 37px; box-sizing: border-box;">'
            f'<div style="display: flex; flex-direction: column; gap: 12px;">'
            f'{scopeblock(T)}{autoblock(T)}{doingblock(T)}'
            f'<div style="display: flex; align-items: center; gap: 9px;">'
            f'{btn(T,"Save","affirm",I["check"])}{btn(T,"Revert","ghost")}'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Revoke","dest",I["x"])}</div></div></div>')

def revokedgroup(T):
    rows="".join(f'<div style="display: grid; grid-template-columns: 9px minmax(0,1fr) 150px 1fr; align-items: center; '
                 f'gap: 12px; padding: 9px 16px 9px 16px;'
                 + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
                 f'<span style="width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box; '
                 f'border: 1.5px dashed {T["abs"]};"></span>'
                 + mono(i,T["ts"],12.5)
                 + f'<span style="font-size: 12px; color: {T["abs"]};">revoked {when}</span>'
                   f'<span style="font-size: 11.5px; color: {T["ts"]};">{what}</span></div>'
        for i,when,what,last in [
          ("old-runner","4 Sep","2 pending asks settled · 1 approved area removed with it",False),
          ("scratch-bot","22 Aug","nothing pending, nothing granted",True)])
    return (f'<div style="border-top: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 8px; padding: 10px 16px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"],13,2.2)}</span>'
            f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">REVOKED</span>'
            f'<span style="font-size: 11px; color: {T["tt"]};">2</span></div>{rows}</div>')

def roster(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Agents</span>'
          f'{btn(T,"New Credential","secondary",I["plus"])}</div>'
          f'<div style="display: grid; grid-template-columns: 9px minmax(0,1fr) 150px 116px 64px 54px 16px; gap: 12px; '
          f'padding: 0 16px 7px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>CREDENTIAL</span><span>ROLE</span><span>SEES</span>'
          f'<span style="text-align: right;">TODAY</span><span style="text-align: right;">SEEN</span><span></span></div>')
    rows=(credrow(T,id_="metis",role="the instance assistant",scope="folders · 4",spend="$0.31",seen="now",
            state="working",open_=True)
          + openrow(T)
          + credrow(T,id_="drey-dev",role="an agent",scope="folders · 1",spend="$0.52",seen="12m",state="queued",
              note="1 bundle waiting")
          + credrow(T,id_="taskuary",role="an agent",external=True,scope="titles",spend="—",seen="41m",state="idle",
              ceiling="asked twice for <b>Areas/Finance</b> · declined both · it can no longer ask")
          + credrow(T,id_="research-crew",role="a crew",scope="folders · 2",spend="$0.19",seen="3h",
              state="interrupted",note="a lease expired 20m ago and the claim is still held",last=True))
    return (f'<div style="{wd} background: {T["bg"]};">{head}{rows}{revokedgroup(T)}</div>')


# ===================== CHAT — the transcript, waiting, the picker ============
# Round C/D board, ported in round E. Two rulings from the owner's review are
# built in: only the user's turns carry a fill, and the column is capped and
# centred so resizing moves it without ever rewrapping a line.

MEASURE=620

def userturn(T,text,when="8:46 AM",w=MEASURE):
    return (f'<div style="width: {w}px; box-sizing: border-box;">'
            f'<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ts"]};">YOU</span>'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>'
            f'<div style="background: {T["accq"]}; border-radius: 12px; padding: 12px 14px; font-size: 13.5px; '
            f'color: {T["tp"]}; line-height: 1.55;">{text}</div></div>')

def replyturn(T,text,*,when="8:47 AM",quotebar=True,hang=True,w=MEASURE,state=None):
    """A 2px `agent` rule at the left of the body, ruled 2026-09-22 (C69).

    The rule hangs in the gutter — `width` is the measure plus the rule and its
    padding, pulled back by the same amount — so the prose starts on the user
    turn's own left edge and `--mt-reply-measure` still governs the text and not
    the text minus a rule. `hang=False` keeps it inside the width, for a panel
    where the turn cannot spill into its neighbour. `quotebar=False` is the
    version that was considered and not taken, kept so the board can show both.
    """
    if quotebar:
        bar=(f'width: {w+18}px; border-left: 2px solid {T["ag"]}; padding-left: 16px;'
             + (' margin-left: -18px;' if hang else ''))
    else:
        bar=f'width: {w}px;'
    return (f'<div style="{bar} box-sizing: border-box;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 6px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">{AN}</span>'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span>'
            f'<span style="flex-grow: 1;"></span>{thumbs(T,state)}</div>'
            f'<div style="font-family: {SERIF}; font-size: 14.5px; color: {T["tp"]}; line-height: 1.62;">{text}</div></div>')

def waitdots(T,reduced=False):
    op=["0.5","0.5","0.5"] if reduced else ["1","0.55","0.3"]
    dots="".join(f'<span style="width: 5px; height: 5px; border-radius: 50%; background: {T["ag"]}; '
                 f'opacity: {o};"></span>' for o in op)
    return (f'<span style="display: inline-flex; align-items: center; gap: 9px;">'
            f'<span style="display: inline-flex; gap: 4px; align-items: center;">{dots}</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">working</span></span>')

def toolstrip(T,*,tool="knowledge_search",n=2,secs="6s",collapsed=False):
    if collapsed:
        return (f'<span style="display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: {T["ts"]};">'
                f'{mono(tool,T["ts"],11.5)}<span style="opacity: 0.45;">·</span>{n} tools<span style="opacity: 0.45;">·</span>{secs}</span>')
    return (f'<span style="display: inline-flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],12,2.2)}</span>'
            f'{mono(tool,T["tp"],12)}<span style="font-size: 12px; color: {T["ts"]};">'
            f'<span style="opacity: 0.45;">·</span> {n} tools <span style="opacity: 0.45;">·</span> {secs}</span></span>')

def waitcase(T,label,inner,why,*,last=False):
    return (f'<div style="padding: 11px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<div style="display: flex; align-items: center; gap: 12px;">'
            f'<span style="width: 132px; flex-shrink: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; '
            f'color: {T["tt"]};">{label}</span>{inner}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 6px; '
            f'padding-left: 144px;">{why}</div></div>')

def wait60(T):
    return (f'<span style="display: inline-flex; align-items: center; gap: 8px; background: {T["degq"]}; '
            f'border-radius: 8px; padding: 4px 10px;">'
            f'<span style="font-size: 12.5px; color: {T["tp"]};">working</span>'
            f'<span style="font-size: 12px; color: {T["deg"]};">· nothing back for 62s</span></span>')

def chatcomposer(T,*,inflight=False,w=MEASURE):
    act = btn(T,"Stop","secondary",I["x"]) if inflight else btn(T,"Send","affirm")
    return (f'<div style="width: {w}px; box-sizing: border-box; background: {T["surface"]}; '
            f'border: 1px solid {T["bc"]}; border-radius: 12px; padding: 12px 14px;">'
            f'<div style="font-size: 13.5px; color: {T["tt"]};">Ask anything&hellip;</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 12px;">'
            # the chip OPENS the menu, so its outline is a control boundary: `bc`, not the
            # divider token `border`, which sits at 1.32:1 on surface (C49's fault class again)
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; '
            f'border: 1px solid {T["bc"]}; font-size: 11.5px; color: {T["ts"]};">'
            f'fast <span style="opacity: 0.45;">·</span> medium'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"],11,2.2)}</span></span>'
            f'<span style="flex-grow: 1;"></span>{act}</div></div>')

def menurow2(T,label,why,*,sel=False,disabled=False,last=False):
    ink = T["tt"] if disabled else (T["acc"] if sel else T["tp"])
    ck=(f'<span style="display: flex; color: {T["acc"]}; flex-shrink: 0;">{ic(I["check"],13,2.6)}</span>'
        if sel else '<span style="width: 13px; flex-shrink: 0;"></span>')
    return (f'<div style="display: flex; gap: 9px; align-items: flex-start; padding: 7px 12px; '
            f'background: {T["accq"] if sel else "transparent"};'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'{ck}<div style="min-width: 0;">'
            f'<div style="font-size: 12.5px; font-weight: {600 if sel else 500}; color: {ink};">{label}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.45; margin-top: 2px;">{why}</div>'
            f'</div></div>')

def modelmenu(T,w=330):
    def sec(t,inner):
        return (f'<div style="padding: 9px 12px 4px;"><span style="font-size: 10.5px; font-weight: 700; '
                f'letter-spacing: 0.08em; color: {T["tt"]};">{t}</span></div>{inner}')
    return (f'<div style="width: {w}px; flex-shrink: 0; background: {T["elevated"]}; border: 1px solid {T["bs"]}; '
            f'border-radius: 12px; box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden;">'
            f'<div style="padding: 12px 14px; border-bottom: 1px solid {T["border"]}; background: {T["sunken"]};">'
            f'<div style="font-size: 12px; color: {T["tp"]};">The router picked {mono("fast",T["tp"],11.5)} for this turn</div>'
            f'<div style="font-size: 11px; color: {T["ts"]}; margin-top: 3px;">No model decides which model runs '
            f'(invariant 4), so the menu says that before it offers you anything.</div></div>'
            + sec("PRESET",
                menurow2(T,"fast","short answers, cheapest tier",sel=True)
                + menurow2(T,"deep","long reasoning, higher cost")
                + menurow2(T,"research","web and vault sweep before answering")
                + menurow2(T,"shadow","runs a candidate model beside the answer",disabled=True,last=True))
            + f'<div style="padding: 6px 12px 10px; font-size: 11px; color: {T["ts"]}; '
              f'border-bottom: 1px solid {T["border"]};">'
              f'{mono("shadow",T["ts"],11)} is listed and disabled with its reason, never hidden (P4): '
              f'{mono("rules.yaml",T["ts"],11)} has no shadow tier on this instance.</div>'
            + sec("MODEL",
                menurow2(T,"claude-sonnet-5","anthropic",sel=True)
                + menurow2(T,"llama-4-70b","local &middot; lm studio",last=True))
            + f'<div style="padding: 10px 12px; border-top: 1px solid {T["border"]}; '
              f'border-bottom: 1px solid {T["border"]};">'
              f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
              f'margin-bottom: 7px;">EFFORT</div>{seg3(T,["low","medium","high"],"medium")}</div>'
            + f'<div style="padding: 10px 12px; display: flex; align-items: center; gap: 10px;">'
              f'{seg3(T,["this turn","this conversation"],"this turn")}'
              f'<span style="flex-grow: 1;"></span>'
              f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Reset</span></div></div>')

def transcript(T,*,w=None,inflight=True):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    strip=""
    if inflight:
        strip=(f'<div style="width: {MEASURE}px; box-sizing: border-box;">'
               f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 6px;">'
               f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2.2)}</span>'
               f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">{AN}</span>'
               f'<span style="font-size: 11px; color: {T["tt"]};">8:48 AM</span></div>'
               f'<div style="background: {T["agq"]}; border-radius: 10px; padding: 10px 12px;">'
               f'{toolstrip(T)}</div></div>')
    return (f'<div style="{wd} background: {T["bg"]}; padding: 18px 0 16px;">'
            f'<div style="display: flex; flex-direction: column; align-items: center; gap: 20px;">'
            f'{userturn(T,"What is the March renewal being measured against?")}'
            f'{replyturn(T,"The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. Two of the four are in the same block and both signed inside the last quarter, so the comparison holds without needing the other two.",state="up")}'
            f'{userturn(T,"Check the vendor folder too.",when="8:48 AM")}'
            f'{strip}'
            f'{chatcomposer(T,inflight=inflight)}</div></div>')


# ===================== AGENTS, REWRITTEN + ROUTINES ======================
# Round E, 2026-09-21. The first Agents attempt organised itself around
# `agents.grants` and produced a permissions matrix; the owner rejected it.
# Metis is off the roster entirely (C52): it is unscoped because it IS the user.

def bd_(T,last): return "" if last else f'border-bottom: 1px solid {T["border"]};'

def groupbar(T,label,n):
    return (f'<div style="display: flex; align-items: baseline; gap: 8px; padding: 13px 16px 6px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
            f'<span style="font-size: 10.5px; color: {T["tt"]};">{n}</span></div>')

def arow(T,*,name,what,seen,state="idle",sel=False,last=False,link=None):
    """Three things: who it is, what it is, whether it is working. Scope and spend
    moved into detail, where they have something to be compared against."""
    w=what if not link else (what.replace(link,f'<span style="color: {T["acc"]}; font-weight: 600;">{link}</span>',1))
    return (f'<div style="display: grid; grid-template-columns: 9px 172px minmax(0,1fr) 54px 16px; align-items: center; '
            f'gap: 14px; padding: 11px 16px; {bd_(T,last)} background: {T["accq"] if sel else "transparent"};">'
            f'{presdot(T,state)}{mono(name,T["tp"],13)}'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">{w}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right;">{seen}</span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],13,2.2)}</span></div>')

def roster2(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 4px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Agents</span>'
          f'{btn(T,"New Agent","secondary",I["plus"])}</div>')
    yours=(groupbar(T,"YOURS","3")
           + arow(T,name="collator",what="daily at 6:02 AM · Morning Brief",seen="6m",state="working",
                  sel=True,link="Morning Brief")
           + arow(T,name="vendor-research",what="when Metis delegates",seen="3h")
           + arow(T,name="inbox-triage",what="paused",seen="—",last=True))
    conn=(groupbar(T,"CONNECTED","2")
          + arow(T,name="drey-dev",what="Drey · you granted 1 folder",seen="12m",state="queued")
          + arow(T,name="taskuary",what="external · 1 folder",seen="41m",last=True))
    rev=(f'<div style="border-top: 1px solid {T["border"]}; display: flex; align-items: center; gap: 8px; '
         f'padding: 11px 16px;"><span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],13,2.2)}</span>'
         f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">REVOKED</span>'
         f'<span style="font-size: 11px; color: {T["tt"]};">2</span></div>')
    return f'<div style="{wd} background: {T["bg"]};">{head}{yours}{conn}{rev}</div>'

# ---- the definition: a file, and only the user's hand may write it -----------
DEFN=("<b>You organise and collate.</b> You prefer tables to prose, you never invent a figure, and you cite the "
      "file every claim came from.\n\nWhen a source disagrees with another, say so rather than picking one.")

def defeditor(T,*,path="agents/ops/collator.md",body=DEFN,editable=True,w=None):
    wd=f"width: {w}px;" if w else ""
    para="".join(f'<p style="margin: 0 0 9px;">{p}</p>' for p in body.split("\n\n"))
    return (f'<div style="{wd}">'
            f'<div style="display: flex; align-items: center; gap: 9px; margin-bottom: 7px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">DEFINITION</span>'
            f'{mono(path,T["ts"],11)}<span style="flex-grow: 1;"></span>'
            + (btn(T,"Edit","secondary",I["pencil"]) if editable else "") + '</div>'
            f'<div style="background: {T["surface"]}; border: 1px solid {T["bc"]}; border-radius: 10px; '
            f'padding: 14px 16px; font-size: 13px; color: {T["tp"]}; line-height: 1.6;">{para}</div>'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 8px;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["lock"],13,1.9)}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">Versioned in the vault. '
            f'<b>Metis may never write this file</b> — a definition is how the system behaves, so it is your hand '
            f'only (invariant 2).</span></div></div>')

# ---- reach, with provenance on every route ----------------------------------
def reachrow(T,path,*,mark=None,tone=None,last=False):
    tag=""
    if mark:
        tag=(f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; '
             f'color: {tone or T["acc"]};">{ic(I["check"] if tone is None else I["clock"],11,2.6)}{mark}</span>')
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 6px 0; {bd_(T,last)}">'
            + mono(path,T["tp"],12) + tag + '</div>')

def reachblock(T,*,routine_extra=True):
    extra=""
    if routine_extra:
        extra=(f'<div style="background: {T["degq"]}; border-radius: 9px; padding: 11px 13px; margin-top: 11px;">'
               f'<div style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.55;">'
               f'During <span style="font-weight: 600; color: {T["acc"]};">Morning Brief</span> it can also read '
               + mono("Areas/Finance",T["tp"],11.5) + ' and write ' + mono("Journal/Digest/",T["tp"],11.5) + '.'
               f'</div><div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 5px;">'
               f'It holds neither the rest of the time.</div></div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            + scopeline(T,who="an agent",access="folders: Areas/Ops",extras="no queries · 1 project",label="REACH")
            + f'<div style="margin-top: 12px;">'
            + reachrow(T,"Areas/Ops")
            + reachrow(T,"Areas/Finance",mark="approved in Needs You · #311",last=True)
            + '</div>' + extra + '</div>')

def linkrow(T,label,sub_,*,last=False):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 8px 0; {bd_(T,last)}">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 12.5px; font-weight: 600; color: {T["acc"]};">{label}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{sub_}</div></div>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],13,2.2)}</span></div>')

def runrow(T,when,what,cost,*,ok=True,last=False):
    g=I["check"] if ok else I["warn"]
    return (f'<div style="display: grid; grid-template-columns: 16px 88px minmax(0,1fr) 54px; align-items: center; '
            f'gap: 11px; padding: 7px 0; {bd_(T,last)}">'
            f'<span style="display: flex; color: {T["ok"] if ok else T["deg"]};">{ic(g,13,2.2)}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{when}</span>'
            f'<span style="font-size: 12px; color: {T["tp"]};">{what}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right; '
            f'font-variant-numeric: tabular-nums;">{cost}</span></div>')

def block(T,label,inner):
    return (f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 7px;">{label}</div>{inner}</div>')

def sunk(T,inner):
    return f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 13px 15px;">{inner}</div>'

def detailhead(T,*,name,what,state,actions_):
    return (f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],15,2.2)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 9px;">{presdot(T,state)}'
            + mono(name,T["tp"],15) + '</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 3px;">{what}</div></div>'
            f'{actions_}</div>')

def localdetail(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    acts=f'<div style="display: flex; gap: 8px;">{btn(T,"Run Now","secondary",I["spark"],spark=True)}{btn(T,"Pause","ghost")}</div>'
    return (f'<div style="{wd} background: {T["bg"]};">'
            + detailhead(T,name="collator",what="yours · runs daily at 6:02 AM for Morning Brief",
                         state="working",actions_=acts)
            + f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + defeditor(T)
            + permmatrix(T,routine_grant=True,
                note="A marked line is access this agent does not hold on its own. Outside "
                     "<b>Morning Brief</b> it cannot read <b>Areas/Vendors</b> or write to "
                     "<b>Journal/Digest/</b>.")
            + block(T,"ITS ROUTINES",sunk(T,
                linkrow(T,"Morning Brief","each day at 6:02 AM · grants 2 more paths for the task")
                + linkrow(T,"Vendor Sweep","each day at 7:00 AM · failed 2 days ago",last=True)))
            + block(T,"RECENT RUNS",sunk(T,
                runrow(T,"today 6:02 AM","wrote Journal/Digest/2026-09-21.md","2.1&cent;")
                + runrow(T,"yesterday","wrote Journal/Digest/2026-09-20.md","1.9&cent;")
                + runrow(T,"2 days ago","refused: Areas/Finance not readable","—",ok=False,last=True)))
            + '</div></div>')

def conndetail(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    acts=btn(T,"Revoke","dest",I["x"])
    conn="".join(f'<div style="display: flex; align-items: baseline; gap: 10px; padding: 5px 0;">'
                 f'<span style="width: 104px; flex-shrink: 0; font-size: 11.5px; color: {T["ts"]};">{k}</span>'
                 f'<span style="font-size: 12px; color: {T["tp"]};">{v}</span></div>'
        for k,v in [("First Connected","4 Sep 2026"),("Last Seen","41 minutes ago"),
                    ("Transport","Remote &middot; token"),("Trust","External")])
    return (f'<div style="{wd} background: {T["bg"]};">'
            + detailhead(T,name="taskuary",what="connected · external · you granted 1 folder",
                         state="idle",actions_=acts)
            + f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["absq"]}; '
              f'border-radius: 9px; padding: 11px 13px;">'
              f'<span style="display: flex; color: {T["ts"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["lock"],14,1.9)}</span>'
              f'<span style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.55;">'
              f'<b>You did not write this and cannot read it.</b> What it does is its own; what it may touch is '
              f'yours.</span></div>'
            + block(T,"HOW IT CONNECTS",sunk(T,conn))
            + permmatrix(T)
            + f'<div style="display: flex; gap: 9px; align-items: flex-start; background: {T["absq"]}; '
              f'border-radius: 9px; padding: 11px 13px;">'
              f'<span style="display: flex; color: {T["ts"]}; flex-shrink: 0; margin-top: 1px;">{ic(I["repeat"],14,1.9)}</span>'
              f'<span style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.55;">Asked twice for '
              + mono("Areas/Finance",T["tp"],11.5) + ' &middot; declined both &middot; <b>it can no longer ask</b>. '
              f'The tool refuses a third; nothing writes a row, so this line is the only place it appears.</span></div>'
            + '</div></div>')

# ===================== ROUTINES ==========================================
def rrow(T,*,name,who,when,how,nxt,state="ok",last=False,built=False):
    gl_,tone = {"ok":(I["check"],T["ok"]),"none":(None,T["ts"]),"fail":(I["failed"],T["fail"]),
                "paused":(None,T["tt"])}[state]
    mark=(f'<span style="display: flex; color: {tone};">{ic(gl_,13,2.2)}</span>' if gl_ else
          '<span style="width: 13px;"></span>')
    whoc=(f'<span style="font-size: 12px; color: {T["ts"]};">built-in</span>' if built else
          f'<span style="font-size: 12px; color: {T["acc"]}; font-weight: 600;">{who}</span>')
    return (f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 126px 150px 152px 92px; '
            f'align-items: center; gap: 12px; padding: 11px 16px; {bd_(T,last)}">'
            f'<span style="font-size: 13px; font-weight: 500; color: {T["tp"]};">{name}</span>{whoc}'
            f'<span style="font-size: 12px; color: {T["ts"]};">{when}</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 7px;">{mark}'
            f'<span style="font-size: 12px; color: {T["ts"]};">{how}</span></span>'
            f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right;">{nxt}</span></div>')

def routineroster(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 4px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Routines</span>'
          f'{btn(T,"New Routine","secondary",I["plus"])}</div>'
          f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 126px 150px 152px 92px; gap: 12px; '
          f'padding: 6px 16px 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span>ROUTINE</span><span>WHO RUNS IT</span><span>WHEN IT ACTS</span><span>HOW IT WENT</span>'
          f'<span style="text-align: right;">NEXT</span></div>')
    day=(groupbar(T,"EACH DAY","4")
         + rrow(T,name="Morning Brief",who="collator",when="6:02 AM",how="6m ago",nxt="6:02 AM")
         + rrow(T,name="Tomorrow&rsquo;s Plan",who="",when="each evening",how="9:14 PM",nxt="tonight",built=True)
         + rrow(T,name="Reply Review",who="",when="overnight",how="nothing to do",nxt="tonight",
                state="none",built=True)
         + rrow(T,name="Vendor Sweep",who="vendor-research",when="7:00 AM",how="failed 2d ago",nxt="7:00 AM",
                state="fail",last=True))
    week=(groupbar(T,"EACH WEEK","1")
          + rrow(T,name="Weekly Review",who="",when="Sunday 6:00 PM",how="Sunday",nxt="Sunday",built=True,last=True))
    paused=(groupbar(T,"PAUSED","1")
            + rrow(T,name="Inbox Triage",who="inbox-triage",when="&mdash;",how="&mdash;",nxt="&mdash;",
                   state="paused",last=True))
    return f'<div style="{wd} background: {T["bg"]};">{head}{day}{week}{paused}</div>'

TASKP=("Summarise everything added to <b>Areas/Finance</b> since yesterday into one table: vendor, amount, what "
       "changed. Write it to <b>Journal/Digest/&lt;date&gt;.md</b>.")

def promptlayers(T):
    return (f'<div style="display: flex; flex-direction: column; gap: 12px;">'
            f'<div>'
            f'<div style="display: flex; align-items: center; gap: 9px; margin-bottom: 7px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">DEFINITION</span>'
            f'<span style="font-size: 11px; color: {T["ts"]};">from</span>'
            f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">collator</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Edit on Agents &rarr;</span></div>'
            f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 13px 15px; font-size: 12.5px; '
            f'color: {T["ts"]}; line-height: 1.6;">You organise and collate. You prefer tables to prose, you never '
            f'invent a figure, and you cite the file every claim came from.</div></div>'
            f'<div style="display: flex; align-items: center; gap: 7px; padding-left: 2px;">'
            f'<span style="font-size: 15px; color: {T["tt"]};">+</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">the task is <b>appended</b>, never a replacement</span></div>'
            f'<div>'
            f'<div style="display: flex; align-items: center; gap: 9px; margin-bottom: 7px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">TASK</span>'
            f'<span style="font-size: 11px; color: {T["ts"]};">this routine</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Edit","secondary",I["pencil"])}</div>'
            f'<div style="background: {T["surface"]}; border: 1px solid {T["bc"]}; border-radius: 10px; '
            f'padding: 13px 15px; font-size: 13px; color: {T["tp"]}; line-height: 1.6;">{TASKP}</div></div></div>')

def reachlayers(T):
    return sunk(T,
        f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
        f'margin-bottom: 9px;">REACH FOR THIS RUN</div>'
        + f'<div style="display: flex; align-items: baseline; gap: 10px; padding: 5px 0;">'
          f'<span style="width: 132px; flex-shrink: 0; font-size: 11.5px; color: {T["ts"]};">inherited</span>'
          + mono("folders: Areas/Ops",T["tp"],12) + '</div>'
        + f'<div style="display: flex; align-items: flex-start; gap: 10px; padding: 5px 0;">'
          f'<span style="width: 132px; flex-shrink: 0; font-size: 11.5px; font-weight: 600; color: {T["deg"]};">'
          f'granted for this</span><span>'
          + mono("Areas/Finance",T["tp"],12) + f'<span style="font-size: 11.5px; color: {T["ts"]};"> read</span> &nbsp; '
          + mono("Journal/Digest/",T["tp"],12) + f'<span style="font-size: 11.5px; color: {T["ts"]};"> write</span>'
          f'</span></div>'
        + f'<div style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.55; margin-top: 9px; padding-top: 9px; '
          f'border-top: 1px solid {T["border"]};">Outside this routine, '
          + mono("collator",T["tp"],11.5) + ' <b>cannot read</b> ' + mono("Areas/Finance",T["tp"],11.5) + '.</div>')

def actsblock(T):
    return sunk(T,"".join(
        f'<div style="display: flex; align-items: baseline; gap: 10px; padding: 5px 0;">'
        f'<span style="width: 92px; flex-shrink: 0; font-size: 11.5px; color: {T["ts"]};">{k}</span>'
        f'<span style="font-size: 12px; color: {T["tp"]}; line-height: 1.5;">{v}</span></div>'
        for k,v in [("acts","each day at 6:02 AM, before your first meeting"),
                    ("ticks",mono("@hourly",L["tp"],11.5)+" — the runner has no time of day"),
                    ("silent","when nothing was added to the folders it reads")]))

def routinedetail(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    acts=f'<div style="display: flex; gap: 8px;">{btn(T,"Run Now","secondary",I["spark"],spark=True)}{btn(T,"Pause","ghost")}</div>'
    return (f'<div style="{wd} background: {T["bg"]};">'
            + detailhead(T,name="Morning Brief",what="collator &middot; each day at 6:02 AM",
                         state="working",actions_=acts)
            + f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + promptlayers(T) + reachlayers(T)
            + block(T,"WHEN IT ACTS",actsblock(T))
            + block(T,"OUTPUT",sunk(T,
                f'<div style="display: flex; align-items: baseline; gap: 10px;">'
                + mono("Journal/Digest/&lt;date&gt;.md",T["tp"],12)
                + f'<span style="font-size: 11.5px; color: {T["ts"]};">machine-owned &middot; one writer</span></div>'))
            + block(T,"HISTORY",sunk(T,
                runrow(T,"today","wrote 6 rows from 4 files","2.1&cent;")
                + runrow(T,"yesterday","wrote 3 rows from 2 files","1.9&cent;")
                + runrow(T,"2 days ago","nothing to do","—",ok=True)
                + runrow(T,"this month","18 runs","34&cent;",last=True)))
            + '</div></div>')


# ============ REFINEMENTS, 2026-09-21 ============================
# Owner feedback: the four action kinds are not permissions, they are VERBS ON
# DOMAIN MODELS, and naming them so collapses the confusing section into
# something consistent with the rest of the product. Terminology: Knowledge (not
# "reach"), Schedule (not "when it acts"), Recurrence (not "ticks"), and "silent"
# is gone. Attribute names are Title Case; values stay verbatim.

MODEL_GLYPH={"Knowledge":"know","Work":"work","Artifacts":"note","Inbox":"tray",
             "Jira":"plug","Confluence":"plug"}

def maylabel(T,mode):
    """The wire says allow | propose | deny. The owner reads On | Ask | Off (C93,
    ruled 2026-09-23) — the same rename the tier words already got (`titles`/`folders` for
    `index`/`areas`). Weight channel, never green-for-yes and red-for-no."""
    lab={"allow":"On","propose":"Ask","deny":"Off"}[mode]
    if mode=="allow":   st=f'background: {T["tp"]}; border: 1px solid {T["tp"]};'
    elif mode=="propose": st=f'background: transparent; border: 1.5px solid {T["tp"]};'
    else:               st=f'background: transparent; border: 1px dashed {T["tt"]};'
    ink=T["tt"] if mode=="deny" else T["tp"]
    return (f'<span style="display: inline-flex; align-items: center; gap: 7px;">'
            f'<span style="width: 11px; height: 11px; border-radius: 3px; box-sizing: border-box; {st}"></span>'
            f'<span style="font-size: 12.5px; font-weight: {600 if mode=="allow" else 500}; color: {ink};">{lab}</span></span>')

def permrow(T,*,model,action,mode=None,value=None,note=None,prov=None,first=False,last=False):
    """One verb on one model. The model is named once per group; `first` carries it."""
    m=""
    if first:
        m=(f'<span style="display: inline-flex; align-items: center; gap: 7px;">'
           f'<span style="display: flex; color: {T["ts"]};">{ic(I[MODEL_GLYPH[model]],14,1.8)}</span>'
           f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{model}</span></span>')
    right = maylabel(T,mode) if mode else mono(value,T["tp"],12)
    pv=""
    if prov:
        pv=(f'<div style="font-size: 11px; color: {T["acc"]}; font-weight: 600; margin-top: 2px;">{prov}</div>')
    nt_=(f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{note}</div>') if note else ""
    return (f'<div style="display: grid; grid-template-columns: 118px 104px minmax(0,1fr); align-items: start; '
            f'gap: 14px; padding: 8px 0; {bd_(T,last)}">{m}'
            f'<span style="font-size: 12.5px; color: {T["ts"]}; padding-top: 1px;">{action}</span>'
            f'<div>{right}{nt_}{pv}</div></div>')

def permtable(T,*,knowledge=True,rows=None,proxied=None,label="Permissions"):
    """Model x Action x May. An EXTERNAL MCP server proxied by Metistry is another
    Model in the same table, with `Through Metistry` as its provenance: the agent
    never holds that credential, Metistry does, so this grid is the only thing
    between an agent and a work system."""
    body=""
    if knowledge:
        body+=permrow(T,model="Knowledge",action="Read",value="Areas/Ops",first=True,
                      note="Titles and contents inside this folder")
        body+=permrow(T,model="Knowledge",action="Read",value="Areas/Finance",
                      prov="Approved in Needs You · #311")
    for i,(mdl,act,mode,note,first) in enumerate(rows or []):
        body+=permrow(T,model=mdl,action=act,mode=mode,note=note,first=first,
                      last=(i==len(rows)-1 and not proxied))
    for i,(mdl,act,mode,note,first) in enumerate(proxied or []):
        body+=permrow(T,model=mdl,action=act,mode=mode,note=note,first=first,
                      prov="Through Metistry",last=(i==len(proxied)-1))
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'<div style="display: grid; grid-template-columns: 118px 104px minmax(0,1fr); gap: 14px; '
            f'padding-bottom: 7px; border-bottom: 1px solid {T["border"]}; font-size: 10.5px; font-weight: 700; '
            f'letter-spacing: 0.07em; color: {T["tt"]};">'
            f'<span>MODEL</span><span>ACTION</span><span>MAY</span></div>'
            f'<div style="margin-top: 4px;">{body}</div></div>')

CONN_ROWS=[("Work","Update","allow","Status, owner, project or title",True),
           ("Work","Dispatch","propose","Hands the task to an off-machine target, so it stays your decision",False),
           ("Work","Comment","allow","In the task&rsquo;s room",False),
           ("Artifacts","Comment","allow","On one version&rsquo;s thread",True),
           ("Inbox","Capture","allow","Writes a note into your inbox",True)]

# ---------- the schedule grid: one hue, two weights ------------------------
SCHED=[("Mon",[(6,1),(7,0),(18,0),(22,0)]),("Tue",[(6,1),(7,0),(9,1),(18,0),(22,0)]),
       ("Wed",[(6,1),(7,0),(18,0),(22,0)]),("Thu",[(6,1),(7,0),(18,0),(22,0)]),
       ("Fri",[(6,1),(7,0),(18,0),(22,0)]),("Sat",[(22,0)]),("Sun",[(18,0),(22,0)])]

def tick(T,agentrun):
    """Filled = one of your agents ran it. Outlined = built-in. NOT two colours:
    the two dark-mode inks separate at 14.3 ΔE, below the hard floor of 15, so
    colour alone cannot carry this. Weight can, and does elsewhere already."""
    if agentrun:
        return f'<span style="width: 9px; height: 9px; border-radius: 2px; background: {T["ag"]};"></span>'
    return (f'<span style="width: 9px; height: 9px; border-radius: 2px; box-sizing: border-box; '
            f'border: 1.5px solid {T["ag"]};"></span>')

def schedgrid(T,w=None):
    hours=list(range(0,24,3))
    head=(f'<div style="display: grid; grid-template-columns: 38px repeat(24, 1fr); gap: 2px; '
          f'margin-bottom: 4px;"><span></span>'
          + "".join(f'<span style="grid-column: span 3; font-size: 10px; color: {T["tt"]}; '
                    f'font-variant-numeric: tabular-nums;">{h:02d}</span>' for h in hours) + '</div>')
    rows=""
    for day,runs in SCHED:
        cells=""
        byhour={h:a for h,a in runs}
        for h in range(24):
            inner=tick(T,byhour[h]) if h in byhour else ""
            cells+=(f'<span style="height: 16px; display: flex; align-items: center; justify-content: center; '
                    f'background: {T["surface"] if h in byhour else "transparent"}; border-radius: 3px;">{inner}</span>')
        rows+=(f'<div style="display: grid; grid-template-columns: 38px repeat(24, 1fr); gap: 2px; '
               f'margin-bottom: 2px;">'
               f'<span style="font-size: 11px; color: {T["ts"]}; display: flex; align-items: center;">{day}</span>'
               f'{cells}</div>')
    leg=(f'<div style="display: flex; align-items: center; gap: 16px; margin-top: 11px;">'
         f'<span style="display: inline-flex; align-items: center; gap: 7px;">{tick(T,True)}'
         f'<span style="font-size: 11.5px; color: {T["ts"]};">Run by one of your agents</span></span>'
         f'<span style="display: inline-flex; align-items: center; gap: 7px;">{tick(T,False)}'
         f'<span style="font-size: 11.5px; color: {T["ts"]};">Built-in</span></span></div>')
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'{head}{rows}{leg}'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 10px; '
            f'padding-top: 10px; border-top: 1px solid {T["border"]};">Everything you own runs between '
            f'<b>6 and 7 AM</b>. The list below is the same data in reading order, so nothing here is '
            f'carried by the picture alone.</div></div>')

# ---------- the list, ordered by what runs next ---------------------------
def dayband(T,label):
    return (f'<div style="padding: 8px 16px; background: {T["sunken"]}; font-size: 10.5px; font-weight: 700; '
            f'letter-spacing: 0.08em; color: {T["tt"]};">{label}</div>')

def occrow(T,*,at,name,agent,recur,state=None,last=False):
    mark=""
    if state=="fail":
        mark=f'<span style="display: flex; color: {T["deg"]};">{ic(I["warn"],13,2.2)}</span>'
    elif state=="paused":
        mark=f'<span style="display: flex; color: {T["tt"]};">{ic(I["later"],13,2)}</span>'
    who=(f'<span style="font-size: 12.5px; color: {T["ts"]};">Built-in</span>' if agent is None else
         f'<span style="display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; '
         f'font-weight: 600; color: {T["acc"]};">{agent}'
         f'<span style="display: flex;">{ic(I["chevr"],11,2.4)}</span></span>')
    return (f'<div style="display: grid; grid-template-columns: 15px 74px minmax(0,1fr) 168px 210px; '
            f'align-items: center; gap: 13px; padding: 11px 16px; {bd_(T,last)}">{mark or "<span></span>"}'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; font-variant-numeric: tabular-nums;">{at}</span>'
            f'<span style="font-size: 13px; font-weight: 500; color: {T["tp"]};">{name}</span>{who}'
            f'<span style="display: inline-flex; align-items: center; gap: 6px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["repeat"],13,1.9)}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{recur}</span></span></div>')

def routinelist2(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 4px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Routines</span>'
          f'{btn(T,"New Routine","secondary",I["plus"])}</div>'
          # the shape of the week belongs ON the screen, not in a panel beside it
          f'<div style="padding: 8px 16px 14px;">{timeline(T)}</div>'
          f'<div style="display: grid; grid-template-columns: 15px 74px minmax(0,1fr) 168px 210px; gap: 13px; '
          f'padding: 6px 16px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>WHEN</span><span>ROUTINE</span><span>AGENT</span><span>RECURRENCE</span></div>')
    today=(dayband(T,"TODAY")
           + occrow(T,at="6:02 AM",name="Morning Brief",agent="collator",recur="Every day at 6:02 AM")
           + occrow(T,at="7:00 AM",name="Vendor Sweep",agent="vendor-research",recur="Every day at 7:00 AM",
                    state="fail")
           + occrow(T,at="6:00 PM",name="Knowledge Fold",agent=None,recur="Every evening")
           + occrow(T,at="10:00 PM",name="Tomorrow&rsquo;s Plan",agent=None,recur="Every evening",last=True))
    tom=(dayband(T,"TOMORROW · TUESDAY")
         + occrow(T,at="6:02 AM",name="Morning Brief",agent="collator",recur="Every day at 6:02 AM")
         + occrow(T,at="7:00 AM",name="Vendor Sweep",agent="vendor-research",recur="Every day at 7:00 AM")
         + occrow(T,at="9:00 AM",name="Standup Notes",agent="collator",recur="Every Tuesday at 9:00 AM")
         + occrow(T,at="6:00 PM",name="Knowledge Fold",agent=None,recur="Every evening",last=True))
    sun=(dayband(T,"SUNDAY")
         + occrow(T,at="6:00 PM",name="Weekly Review",agent=None,recur="Every week on Sunday",last=True))
    off=(dayband(T,"INACTIVE")
         + occrow(T,at="—",name="Inbox Triage",agent="inbox-triage",recur="Paused 4 days ago by you",
                  state="paused",last=True))
    return f'<div style="{wd} background: {T["bg"]};">{head}{today}{tom}{sun}{off}</div>'


def renamefield(T,name,*,w=None):
    """A routine's name is the user's, not its directory name. Editable in place."""
    wd=f"width: {w}px;" if w else ""
    return (f'<span style="{wd} display: inline-flex; align-items: center; gap: 8px; padding: 3px 9px 3px 10px; '
            f'border: 1px solid transparent; border-radius: 8px; background: {T["surface"]};">'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]};">{name}</span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["pencil"],12,2)}</span></span>')

def kv(T,k,v,*,last=False,mono_=False):
    val = mono(v,T["tp"],12) if mono_ else f'<span style="font-size: 12.5px; color: {T["tp"]};">{v}</span>'
    return (f'<div style="display: grid; grid-template-columns: 126px minmax(0,1fr); align-items: baseline; '
            f'gap: 12px; padding: 7px 0; {bd_(T,last)}">'
            f'<span style="font-size: 12px; color: {T["ts"]};">{k}</span>{val}</div>')

def scheduleblock(T):
    return sunk(T,
        f'<div style="display: flex; align-items: center; gap: 9px; padding-bottom: 10px; '
        f'border-bottom: 1px solid {T["border"]};">'
        f'<span style="display: flex; color: {T["ag"]};">{ic(I["repeat"],15,1.9)}</span>'
        f'<span style="font-size: 13.5px; font-weight: 600; color: {T["tp"]};">Every day at 6:02 AM</span></div>'
        + f'<div style="margin-top: 4px;">'
        + kv(T,"Next Run","Tomorrow, 6:02 AM")
        + kv(T,"Then","Wednesday, 6:02 AM &middot; Thursday, 6:02 AM")
        + kv(T,"Time Zone","America/New_York",last=True) + '</div>')

def outputblock(T):
    return sunk(T,
        kv(T,"Writes","Journal/Digest/&lt;date&gt;.md",mono_=True)
        + kv(T,"Ownership","Machine-owned &mdash; one writer, and this is it")
        + kv(T,"Last Written","Today, 6:02 AM &middot; 6 rows from 4 files",last=True))

PROMPT_SENT=("<b>Definition</b> &mdash; You organise and collate. You prefer tables to prose, you never invent a "
             "figure, and you cite the file every claim came from.<br><br><b>Task</b> &mdash; Summarise everything "
             "added to Areas/Finance since yesterday into one table: vendor, amount, what changed. Write it to "
             "Journal/Digest/&lt;date&gt;.md.")
OUT_SAMPLE=("Four vendors changed terms since yesterday. Two are inside the block you asked about; both signed "
            "within the quarter, so the March comparison holds on them alone.")
SUGGEST=("This routine has written an empty table on three of the last seven days, and on each of those the folder "
         "it reads had no changes. Moving it to <b>every weekday</b> would skip the two days that are always "
         "empty, and cost nothing you are using.")

def sessionview(T):
    return (f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 9px; '
            f'padding: 13px 15px; margin: 2px 0 4px;">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'margin-bottom: 7px;">PROMPT SENT</div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.6;">{PROMPT_SENT}</div>'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]}; '
            f'margin: 13px 0 7px;">WHAT IT WROTE</div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.6;">{OUT_SAMPLE}</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 11px; padding-top: 11px; '
            f'border-top: 1px solid {T["border"]};">'
            f'{btn(T,"Open the File","secondary",I["note"])}{btn(T,"Copy Prompt","ghost",I["copy"])}'
            f'<span style="flex-grow: 1;"></span>{thumbs(T)}</div></div>')

def histrow(T,when,what,cost,*,ok=True,open_=False,last=False):
    g=I["check"] if ok else I["warn"]
    chev=I["chevd"] if open_ else I["chevr"]
    head=(f'<div style="display: grid; grid-template-columns: 16px 96px minmax(0,1fr) 54px 14px; '
          f'align-items: center; gap: 11px; padding: 8px 0;'
          + ("" if (open_ or last) else f' border-bottom: 1px solid {T["border"]};') + '">'
          f'<span style="display: flex; color: {T["ok"] if ok else T["deg"]};">{ic(g,13,2.2)}</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">{when}</span>'
          f'<span style="font-size: 12px; color: {T["tp"]};">{what}</span>'
          f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right; '
          f'font-variant-numeric: tabular-nums;">{cost}</span>'
          f'<span style="display: flex; color: {T["tt"]};">{ic(chev,13,2.2)}</span></div>')
    return head + (sessionview(T) if open_ else "")

def suggestion(T):
    return (f'<div style="background: {T["agq"]}; border-radius: 10px; padding: 13px 15px; margin-top: 12px;">'
            f'<div style="display: flex; align-items: center; gap: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">'
            f'{AN} SUGGESTS</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.6; '
            f'margin-top: 9px;">{SUGGEST}</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 12px;">'
            f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Revise","secondary",I["pencil"])}{btn(T,"Decline","secondary",I["x"])}'
            f'<span style="flex-grow: 1;"></span>{thumbs(T)}</div></div>')

def historyblock(T):
    return sunk(T,
        histrow(T,"Today","Wrote 6 rows from 4 files","2.1&cent;",open_=True)
        + histrow(T,"Yesterday","Wrote 3 rows from 2 files","1.9&cent;")
        + histrow(T,"2 days ago","Wrote an empty table &mdash; nothing had changed","1.1&cent;")
        + histrow(T,"3 days ago","Refused: Areas/Finance was not readable","&mdash;",ok=False,last=True)
        ) + suggestion(T)

def routinedetail2(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    acts=f'<div style="display: flex; gap: 8px;">{btn(T,"Run Now","secondary",I["spark"],spark=True)}{btn(T,"Pause","ghost")}</div>'
    head=(f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; '
          f'border-bottom: 1px solid {T["border"]};">'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],15,2.2)}</span>'
          f'<div style="flex-grow: 1; min-width: 0;">{renamefield(T,"Morning Brief")}'
          f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 5px; padding-left: 10px;">'
          f'<span style="font-size: 12px; color: {T["ts"]};">Run by</span>'
          f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; '
          f'color: {T["acc"]};">collator<span style="display: flex;">{ic(I["chevr"],11,2.4)}</span></span></div></div>'
          f'{acts}</div>')
    return (f'<div style="{wd} background: {T["bg"]};">{head}'
            f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 16px;">'
            + promptlayers(T)
            + permmatrix(T,label="PERMISSIONS FOR THIS RUN",routine_grant=True,
                note="A marked line is granted by this routine and holds only while it runs. "
                     "Everything else is what <b>collator</b> carries anyway.")
            + block(T,"SCHEDULE",scheduleblock(T))
            + block(T,"OUTPUTS",outputblock(T))
            + block(T,"HISTORY",historyblock(T))
            + '</div></div>')

PROXY_ROWS=[("Jira","Read Issues","allow","The three projects you connected",True),
            ("Jira","Comment","propose","Visible to your team, so it stays your decision",False),
            ("Confluence","Read Pages","allow","The spaces you connected",True)]


# ============ PERMISSIONS AS A MATRIX, 2026-09-22 =====================
# Owner: one line per resource, Read and Write columns, no Allow/Never control in
# the table — an Edit button on the section instead. DENIAL IS ABSENCE: a resource
# with nothing in either column is not granted, and the infinite list of things an
# agent cannot do is never drawn.

RES_GLYPH={"Knowledge":"know","Work":"work","Artifacts":"note","Inbox":"tray",
           "Jira":"plug","Confluence":"plug"}

def askmark(T):
    """This verb lands as a request instead of running. The wire's `propose`."""
    return (f'<span title="Ask" style="display: inline-flex; align-items: center; '
            f'color: {T["ts"]}; vertical-align: -1px;">{ic(I["ask"],11,2.0)}</span>')

def provmark(T,label):
    return (f'<span style="display: inline-flex; align-items: center; gap: 3px; font-size: 10px; '
            f'font-weight: 600; color: {T["acc"]}; vertical-align: 1px;">{ic(I["check"],10,3)}{label}</span>')

def cell(T,items):
    """items: list of (text, mono?, ask?, prov). Empty renders an em dash."""
    if not items:
        return f'<span style="font-size: 12.5px; color: {T["tt"]};">&mdash;</span>'
    out=[]
    for txt,mono_,ask,prov in items:
        piece = mono(txt,T["tp"],12) if mono_ else f'<span style="font-size: 12.5px; color: {T["tp"]};">{txt}</span>'
        if ask:  piece += " " + askmark(T)
        if prov: piece += " " + provmark(T,prov)
        out.append(piece)
    sep=f'<span style="color: {T["tt"]}; opacity: 0.6;"> &middot; </span>'
    return sep.join(out)

def resrow(T,*,res,read,write,proxied=False,last=False):
    g=(f'<span style="display: flex; color: {T["ag"] if proxied else T["ts"]};">'
       f'{ic(I[RES_GLYPH[res]],14,1.8)}</span>')
    nm=(f'<span style="display: inline-flex; align-items: center; gap: 7px;">{g}'
        f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{res}</span></span>')
    return (f'<div style="display: grid; grid-template-columns: 148px minmax(0,1fr) minmax(0,1.15fr); '
            f'align-items: baseline; gap: 16px; padding: 9px 0; {bd_(T,last)}">'
            f'{nm}<div>{cell(T,read)}</div><div>{cell(T,write)}</div></div>')

def permmatrix(T,*,proxied=True,label="PERMISSIONS",note=None,routine_grant=False):
    kread=[("Areas/Ops",True,False,None),("Areas/Finance",True,False,"Needs You #311")]
    kwrite=[]
    if routine_grant:
        kread=kread+[("Areas/Vendors",True,False,"Morning Brief only")]
        kwrite=[("Journal/Digest/",True,False,"Morning Brief only")]
    rows=(resrow(T,res="Knowledge",read=kread,write=kwrite)
          + resrow(T,res="Work",read=[("All tasks",False,False,None)],
            write=[("Update",False,False,None),("Comment",False,False,None),("Dispatch",False,True,None)])
          + resrow(T,res="Artifacts",read=[("All",False,False,None)],
            write=[("Comment",False,False,None)],last=not proxied)
          + resrow(T,res="Inbox",read=[],write=[("Capture",False,False,None)],last=not proxied))
    if proxied:
        rows+=(resrow(T,res="Jira",read=[("3 projects",False,False,None)],
                 write=[("Comment",False,True,None)],proxied=True)
               + resrow(T,res="Confluence",read=[("2 spaces",False,False,None)],
                 write=[],proxied=True,last=True))
    leg=(f'<div style="display: flex; align-items: center; gap: 18px; margin-top: 11px; padding-top: 10px; '
         f'border-top: 1px solid {T["border"]};">'
         f'<span style="display: inline-flex; align-items: center; gap: 6px;">{askmark(T)}'
         f'<span style="font-size: 11.5px; color: {T["ts"]};">Ask &mdash; comes to you first</span></span>'
         + (f'<span style="display: inline-flex; align-items: center; gap: 6px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["relay"],12,1.9)}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">Reached through Metistry</span></span>' if proxied else "")
         + f'<span style="flex-grow: 1;"></span>'
           f'<span style="font-size: 11.5px; color: {T["ts"]};">Anything not listed is not granted.</span></div>')
    head=(f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">'
          f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
          f'<span style="flex-grow: 1;"></span>{btn(T,"Edit","secondary",I["pencil"])}</div>')
    cols=(f'<div style="display: grid; grid-template-columns: 148px minmax(0,1fr) minmax(0,1.15fr); gap: 16px; '
          f'padding-bottom: 7px; border-bottom: 1px solid {T["border"]}; font-size: 10.5px; font-weight: 700; '
          f'letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span>REACHES</span><span>READ</span><span>WRITE</span></div>')
    nt_=(f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 9px;">{note}</div>') if note else ""
    return (head + f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'{cols}<div style="margin-top: 3px;">{rows}</div>{leg}{nt_}</div>')

# ---------- a horizontal timeline, replacing the week grid --------------------
# The week x hour grid was seven rows to say one thing. One axis says it, and the
# agent-versus-built-in distinction leaves with it: the Agent column below already
# carries that, so the picture does not need to.
# The week of Scheduled v3 (C111): Standup and Tomorrow's Plan on working days; Brief,
# Vendor Sweep, Fold and Reply Review daily; Weekly Review Sunday. Throughout-the-day
# housekeeping (Inbox Sort, Usage Rollup) is not drawn — it would be a solid bar.
TL=[("Mon",[("6:00",1),("6:02",1),("7:00",1),("19:00",0),("22:00",0),("23:00",0)]),("Tue",[("6:00",1),("6:02",1),("7:00",1),("19:00",0),("22:00",0),("23:00",0)]),("Wed",[("6:00",1),("6:02",1),("7:00",1),("19:00",0),("22:00",0),("23:00",0)]),("Thu",[("6:00",1),("6:02",1),("7:00",1),("19:00",0),("22:00",0),("23:00",0)]),("Fri",[("6:00",1),("6:02",1),("7:00",1),("19:00",0),("22:00",0),("23:00",0)]),
    ("Sat",[("6:02",1),("7:00",1),("22:00",0),("23:00",0)]),
    ("Sun",[("6:02",1),("7:00",1),("18:00",0),("22:00",0),("23:00",0)])]

def timeline(T,*,w=None):
    total=7*24.0
    marks=""
    for di,(day,runs) in enumerate(TL):
        for hhmm,_ in runs:
            h,m=hhmm.split(":")
            pos=((di*24)+int(h)+int(m)/60.0)/total*100
            marks+=(f'<span style="position: absolute; left: {pos:.3f}%; top: 8px; width: 3px; height: 22px; '
                    f'border-radius: 2px; background: {T["ag"]}; transform: translateX(-1.5px);"></span>')
    ticks=""
    for di,(day,_) in enumerate(TL):
        pos=(di*24)/total*100
        ticks+=(f'<span style="position: absolute; left: {pos:.3f}%; top: 0; bottom: 0; width: 1px; '
                f'background: {T["bs"]};"></span>')
        ticks+=(f'<span style="position: absolute; left: calc({pos:.3f}% + 6px); top: 36px; font-size: 10.5px; '
                f'color: {T["ts"]};">{day}</span>')
    # noon guides, recessive
    for di in range(7):
        pos=((di*24)+12)/total*100
        ticks+=(f'<span style="position: absolute; left: {pos:.3f}%; top: 8px; height: 22px; width: 1px; '
                f'background: {T["border"]}; opacity: 0.55;"></span>')
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} background: {T["sunken"]}; border-radius: 10px; padding: 14px 16px;">'
            f'<div style="display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">THIS WEEK</span>'
            f'<span style="flex-grow: 1;"></span>'
            + seg3(T,["Day","Week","Month"],"Week") + '</div>'
            f'<div style="position: relative; height: 54px;">{ticks}{marks}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5; margin-top: 8px; '
            f'padding-top: 9px; border-top: 1px solid {T["border"]};">Every mark is one run &mdash; <b>all by 7 AM or after 6 PM</b>. The faint line is noon.</div></div>')

# ---------- Resources: where a connection is defined -------------------------
def connrow(T,*,name,kind,tools,used,state="ok",last=False):
    # C95: an expired credential is failed, with its own mark, not the degraded dot
    dot=(f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["ok"]};"></span>'
         if state=="ok" else
         f'<span style="display: flex; color: {T["fail"]}; margin-left: -2px;">{ic(I["failed"],12,2.2)}</span>')
    return (f'<div style="display: grid; grid-template-columns: 9px 140px 124px 80px minmax(0,1fr) 16px; '
            f'align-items: center; gap: 12px; padding: 11px 16px; {bd_(T,last)}">{dot}'
            f'<span style="display: inline-flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["relay"],14,1.8)}</span>'
            f'<span style="font-size: 13px; font-weight: 500; color: {T["tp"]};">{name}</span></span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{kind}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{tools}</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{used}</span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],13,2.2)}</span></div>')

def resourcelist(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    head=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 4px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Resources</span>'
          f'{btn(T,"Connect a Server","secondary",I["plus"])}</div>'
          f'<div style="display: grid; grid-template-columns: 9px 140px 124px 80px minmax(0,1fr) 16px; gap: 12px; '
          f'padding: 6px 16px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>SERVER</span><span>KIND</span><span>TOOLS</span><span>GRANTED TO</span><span></span></div>')
    rows=(connrow(T,name="Jira",kind="MCP &middot; work network",tools="14 tools",
            used="collator &middot; drey-dev &middot; 1 routine")
          + connrow(T,name="Confluence",kind="MCP &middot; work network",tools="6 tools",used="collator")
          + connrow(T,name="Linear",kind="MCP &middot; hosted",tools="9 tools",used="Nobody yet")
          + connrow(T,name="Sentry",kind="MCP &middot; hosted",tools="4 tools",
            used="Last worked 2 days ago &middot; token expired",state="fail",last=True))
    return f'<div style="{wd} background: {T["bg"]};">{head}{rows}</div>'


# ---------- three states per tool (ruled 2026-09-22) -------------------------
# On the RESOURCE this is explicit, because it is where the state is set. In an
# agent's or a routine's permissions matrix the same three states are read off
# absence and one glyph: listed = On, listed with the clock = Ask, absent = Off.

def tristate(T,state):
    opts=[("On","on"),("Ask","ask"),("Off","off")]
    out=""
    for i,(lab,key) in enumerate(opts):
        on=(key==state)
        ink = T["tp"] if on else T["ts"]
        out+=(f'<span style="padding: 3px 9px; font-size: 11px; font-weight: {700 if on else 500}; '
              f'background: {T["surface"] if on else "transparent"}; color: {ink};'
              + ("" if i==0 else f' border-left: 1px solid {T["border"]};') + f'">{lab}</span>')
    return (f'<span style="display: inline-flex; border: 1px solid {T["bc"]}; border-radius: 7px; '
            f'overflow: hidden; background: {T["sunken"]};">{out}</span>')

def toolrow2(T,name,desc,*,state="on",last=False):
    """No separate preview marker. Preview-then-confirm IS what Ask means, and On
    means on — the owner's choice is the whole control (ruled 2026-09-22). What a
    tool does is carried by its description, which is where it belongs."""
    return (f'<div style="display: grid; grid-template-columns: 178px minmax(0,1fr) 124px; '
            f'align-items: center; gap: 14px; padding: 8px 0; {bd_(T,last)}">'
            f'{mono(name,T["tp"],12)}'
            f'<span style="font-size: 12px; color: {T["ts"]};">{desc}</span>{tristate(T,state)}</div>')

def toolblock(T):
    return sunk(T,
        f'<div style="display: grid; grid-template-columns: 178px minmax(0,1fr) 124px; gap: 12px; '
        f'padding-bottom: 7px; border-bottom: 1px solid {T["border"]}; font-size: 10.5px; font-weight: 700; '
        f'letter-spacing: 0.07em; color: {T["tt"]};">'
        f'<span>TOOL</span><span>WHAT IT DOES</span><span></span></div>'
        + f'<div style="margin-top: 3px;">'
        + toolrow2(T,"search_issues","Finds issues by project, status or text",state="on")
        + toolrow2(T,"get_issue","Reads one issue and its comments",state="on")
        + toolrow2(T,"add_comment","Writes a comment other people will see",state="ask")
        + toolrow2(T,"transition_issue","Moves an issue between statuses",state="ask")
        + toolrow2(T,"delete_issue","Removes an issue",state="off",last=True)
        + '</div>'
        + f'<div style="display: flex; gap: 20px; margin-top: 11px; padding-top: 10px; '
          f'border-top: 1px solid {T["border"]}; flex-wrap: wrap;">'
        + "".join(f'<span style="font-size: 11.5px; color: {T["ts"]};">'
                  f'<b style="color: {T["tp"]};">{k}</b> &nbsp;{v}</span>'
            for k,v in [("On","runs when an agent calls it &mdash; no preview, because you chose it"),
                        ("Ask","shows what it would do, then waits for you in Needs You"),
                        ("Off","refused at the proxy, and not offered to the agent at all")])
        + '</div>')


SETTINGS_W, SETTINGS_H, SETTINGS_NAV = 840, 600, 200
SETTINGS_GROUPS=[(None,[("Instance","folder"),("Services","server"),("Compute","cpu"),("Updates","update")]),
                 ("ACCESS",[("Account","person"),("Connections","plug"),("Secrets","key"),("Variables","brace")]),
                 ("CAPTURE",[("Live Capture","mic"),("Sessions","repeat")]),
                 (None,[("Keyboard","keyboard"),("Advanced","wrench")])]
I.setdefault("brace",'<path d="M9 4.5H8a2 2 0 00-2 2v3a2.5 2.5 0 01-2 2.5 2.5 2.5 0 012 2.5v3a2 2 0 002 2h1M15 4.5h1a2 2 0 012 2v3a2.5 2.5 0 002 2.5 2.5 2.5 0 00-2 2.5v3a2 2 0 01-2 2h-1"/>')
I["gear"]='<path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/>'  # a real cog (was a sun-like mark)
I.setdefault("server",'<rect x="3.5" y="4.5" width="17" height="6.5" rx="1.8"/><rect x="3.5" y="13" width="17" height="6.5" rx="1.8"/><path d="M7 7.75h.01M7 16.25h.01"/>')
I.setdefault("update",'<path d="M12 3.5v10.5M7.8 10l4.2 4.2 4.2-4.2"/><path d="M4.5 15.5v2.5a2 2 0 002 2h11a2 2 0 002-2v-2.5"/>')
I.setdefault("keyboard",'<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13.5h10"/>')
I.setdefault("gear",'<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>')
I.setdefault("cpu",'<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>')
I.setdefault("down",'<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5v8M8.5 12.5L12 16l3.5-3.5"/>')
I.setdefault("folder",'<path d="M3.5 7a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>')
I.setdefault("wrench",'<path d="M14.5 5.5a4 4 0 00-5 5L4.5 15.5l4 4 5-5a4 4 0 005-5l-2.5 2.5-2.5-.5-.5-2.5z"/>')

def settingsnav(T,sel="Resources"):
    """The real sections, grouped (ruled 2026-09-22): Instance, Services, Compute,
    Updates; Access — Account (was Connections), Resources, Secrets; Capture —
    Live Capture, Sessions; Advanced. Replaces the invented list the Resources
    board first drew."""
    out=""
    for head,items in SETTINGS_GROUPS:
        if head:
            out+=(f'<div style="padding: 12px 16px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; '
                  f'color: {T["tt"]};">{head}</div>')
        else:
            out+='<div style="height: 8px;"></div>'
        for n,g in items:
            on=(n==sel)
            out+=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 10px; margin: 0 6px; '
                  f'border-radius: 7px; background: {T["accq"] if on else "transparent"};">'
                  f'<span style="display: flex; color: {T["acc"] if on else T["ts"]};">{ic(I[g],15,1.8)}</span>'
                  f'<span style="font-size: 12.5px; font-weight: {600 if on else 500}; '
                  f'color: {T["tp"]};">{n}</span></div>')
    return (f'<div style="width: {SETTINGS_NAV}px; padding: 6px 0 12px; background: {T["sunken"]}; '
            f'border-right: 1px solid {T["border"]}; flex-shrink: 0; box-sizing: border-box;">{out}</div>')

def settingswindow(T,inner,*,w=None,sel="Resources",full=False,scrolled=None):
    """Settings is its own window at a FIXED size (ruled 2026-09-22, closing C62):
    840x600, set by the widest pane. Panes scroll vertically, so larger text makes a
    pane longer and never clips it. `full` draws a pane's whole length for spec
    boards; `scrolled` draws the scroll thumb at that fraction."""
    dots="".join(f'<span style="width: 10px; height: 10px; border-radius: 50%; background: {c};"></span>'
                 for c in (T["bs"],T["bs"],T["bs"]))
    height="" if full else f"height: {SETTINGS_H-38}px; overflow: hidden;"
    thumb=(f'<span style="position: absolute; right: 3px; top: {int(8+(SETTINGS_H-150)*scrolled)}px; width: 5px; '
           f'height: 90px; border-radius: 3px; background: {rgba(T["tp"],0.28)};"></span>') if scrolled is not None else ""
    return (f'<div style="width: {SETTINGS_W}px; flex-shrink: 0; border: 1px solid {T["bc"]}; border-radius: 12px; '
            f'overflow: hidden; background: {T["surface"]}; box-shadow: 0 14px 40px rgba(26,24,21,0.14);">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 14px; height: 38px; '
            f'box-sizing: border-box; background: {T["elevated"]}; border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: inline-flex; gap: 6px;">{dots}</span>'
            f'<span style="flex-grow: 1; text-align: center; font-size: 12.5px; font-weight: 600; '
            f'color: {T["tp"]};">{sel}</span><span style="width: 46px;"></span></div>'
            f'<div style="display: flex; align-items: stretch; {height}">{settingsnav(T,sel)}'
            f'<div style="position: relative; width: {SETTINGS_W-SETTINGS_NAV}px; min-width: 0; background: {T["bg"]}; '
            f'overflow: hidden;">{inner}{thumb}</div></div></div>')

def srcrow(T,*,name,when,state="ok",age=None,why=None,last=False):
    dot={"ok":f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["ok"]};"></span>',
         "stale":f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["ok"]};"></span>',
         "absent":(f'<span style="width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; '
                   f'border: 1.5px solid {T["abs"]};"></span>'),
         "failed":f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["fail"]};"></span>'}[state]
    ag=pill(T,age,T["stale"],T["staleq"],I["clock"]) if age else ""
    w=(f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 3px;">{why}</div>') if why else ""
    return (f'<div style="display: grid; grid-template-columns: 9px minmax(0,1fr) 190px; align-items: start; '
            f'gap: 13px; padding: 10px 16px; {bd_(T,last)}">'
            f'<span style="margin-top: 5px;">{dot}</span>'
            f'<div><span style="display: inline-flex; align-items: center; gap: 9px;">'
            + mono(name,T["tp"],12.5) + ag + '</span>' + w + '</div>'
            f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right; padding-top: 2px;">{when}</span></div>')

def sources(T):
    return (f'<div style="border: 1px solid {T["border"]}; border-radius: 11px; overflow: hidden; '
            f'background: {T["bg"]};">'
            f'<div style="display: flex; align-items: baseline; gap: 9px; padding: 11px 16px; '
            f'background: {T["sunken"]};">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">SOURCES</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">4 sources &middot; 1 behind</span></div>'
            + srcrow(T,name="github-state",when="checked 4 minutes ago")
            + srcrow(T,name="aws-costs",when="checked 3 days ago",state="stale",age="3d old")
            + srcrow(T,name="slack-bridge",when="&mdash;",state="absent",
                     why="Never configured &mdash; set "+mono("METISTRY_SLACK_*",T["ts"],11)+" to fill this in")
            + srcrow(T,name="devin-sessions",when="last succeeded 2 days ago",state="failed",
                     why="The answer was an error: <b>token expired</b>",last=True) + '</div>')

def pagerow(T,*,path,title,when,status="clean",last=False):
    if status=="conflict":
        t=(f'<span style="display: inline-flex; align-items: flex-start; gap: 7px;">'
           f'<span style="display: flex; color: {T["deg"]}; margin-top: 1px;">{ic(I["warn"],12,2.1)}</span>'
           f'<span style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.45;">conflict &mdash; the reconciler '
           f'couldn&rsquo;t settle this file, so its title isn&rsquo;t a fact yet</span></span>')
        w=f'<span style="font-size: 12px; color: {T["tt"]}; text-align: right;">&mdash;</span>'
    else:
        t=f'<span style="font-size: 12.5px; color: {T["tp"]};">{title}</span>'
        w=f'<span style="font-size: 12px; color: {T["ts"]}; text-align: right;">{when}</span>'
    return (f'<div style="display: grid; grid-template-columns: 268px minmax(0,1fr) 116px; align-items: start; '
            f'gap: 14px; padding: 9px 16px; {bd_(T,last)}">'
            + mono(path,T["tp"] if status!="conflict" else T["ts"],12) + t + w + '</div>')

def areabar(T,sel="Areas/Health"):
    return (f'<div style="display: flex; gap: 6px; flex-wrap: wrap; padding: 0 16px 12px;">'
            + "".join(f'<span style="padding: 3.5px 10px; border-radius: 999px; font-size: 11.5px; '
                      f'font-weight: 500; background: {T["accq"] if a==sel else "transparent"}; '
                      f'color: {T["acc"] if a==sel else T["ts"]}; '
                      f'border: 1px solid {"transparent" if a==sel else T["border"]};">{a}</span>'
                      for a in ["Areas/Fsl","Areas/Health","Areas/Ops","Journal","Me","Inbox"]) + '</div>')

def knowledgepane(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Knowledge</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; '
            f'border-radius: 8px; border: 1px solid {T["bc"]}; background: {T["surface"]}; font-size: 12px; '
            f'color: {T["tp"]};">Every area'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"],12,2.2)}</span></span></div>'
            f'{areabar(T)}'
            f'<div style="padding: 0 16px 14px;">{sources(T)}</div>'
            f'<div style="display: grid; grid-template-columns: 268px minmax(0,1fr) 116px; gap: 14px; '
            f'padding: 6px 16px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; '
            f'border-top: 1px solid {T["border"]};">'
            f'<span>PATH</span><span>TITLE</span><span style="text-align: right;">MODIFIED</span></div>'
            + pagerow(T,path="Areas/Health/sleep.md",title="Sleep",when="2 hours ago")
            + pagerow(T,path="Areas/Health/2026/sleep.md",title="",when="",status="conflict")
            + pagerow(T,path="Areas/Health/labs.md",title="Lab results",when="yesterday")
            + pagerow(T,path="Areas/Health/protein.md",title="The protein blend",when="4 days ago",last=True)
            + f'<div style="display: flex; align-items: center; gap: 8px; padding: 12px 16px; '
              f'border-top: 1px solid {T["border"]};">'
              f'<span style="display: flex; color: {T["tt"]};">{ic(I["lock"],13,1.9)}</span>'
              f'<span style="font-size: 11.5px; color: {T["ts"]};"><b>3 drafts</b>, hidden here as they are hidden '
              f'from agents.</span></div>'
            + '</div>')

def linkrow2(T,d,path,title,kind,*,last=False):
    return (f'<div style="display: grid; grid-template-columns: 18px 230px minmax(0,1fr) 92px; align-items: center; '
            f'gap: 12px; padding: 7px 0; {bd_(T,last)}">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"] if d=="out" else I["chevd"],12,2.2)}</span>'
            + mono(path,T["tp"],11.5)
            + f'<span style="font-size: 12px; color: {T["ts"]};">{title}</span>'
            + f'<span style="font-size: 11px; color: {T["tt"]}; text-align: right;">{kind}</span></div>')


# ============ KNOWLEDGE v2 — intent-led (2026-09-22) ==================
# The first pass organised itself around `knowledge_pages` and `collector_health`
# and came out a file browser with a status header — §5.1 of the amendments, the
# mistake it warns about, committed the same night it was written. Rebuilt around
# what the owner came for: what Metis learned, what needs their eye, and how it
# works. Sources demote to one line, because a source that is working should be
# ignorable.

def teachline(T,text):
    """The contract, said where it applies. Not a help page — the same habit the
    states already have of naming their own reason."""
    return (f'<div style="display: flex; gap: 8px; align-items: flex-start; margin-top: 10px;">'
            f'<span style="display: flex; color: {T["tt"]}; flex-shrink: 0; margin-top: 1px;">'
            f'{ic(I["know"],13,1.8)}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.5;">{text}</span></div>')

def klink(T,t):
    return (f'<span style="font-weight: 600; color: {T["acc"]}; border-bottom: 1px solid {T["acc"]}; '
            f'padding-bottom: 1px;">{t}</span>')

FOLD_PROSE=("Three things moved in the lease thread yesterday. The comparables you asked for came back "
            "<b>4% under</b> his number, which is the figure you did not have on the 6th — two of the four are in "
            "the same block and both signed inside the quarter, so the comparison holds on those alone. "
            "Separately, the vendor terms in {V} changed enough that the March renewal is no longer the cheapest "
            "option on the table, and {L} now disagrees with {P} about the protein cost basis; I have not tried to "
            "settle that one.")

def folddigest(T,w=None):
    wd=f"width: {w}px;" if w else ""
    body=(FOLD_PROSE.replace("{V}",klink(T,"Areas/Fsl/vendors.md"))
                    .replace("{L}",klink(T,"Areas/Health/labs.md"))
                    .replace("{P}",klink(T,"Areas/Health/protein.md")))
    return (f'<div style="{wd} background: {T["agq"]}; border-radius: 12px; padding: 16px 18px;">'
            f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],14,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">'
            f'LAST NIGHT&rsquo;S FOLD</span>'
            f'<span style="flex-grow: 1;"></span>'
            + mono("Journal/Fold/2026-09-22.md",T["ts"],11) + '</div>'
            f'<div style="font-family: {SERIF}; font-size: 14.5px; color: {T["tp"]}; line-height: 1.65; '
            f'margin-top: 11px;">{body}</div>'
            f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 13px;">'
            + btn(T,"Open the Fold","secondary",I["note"]) + btn(T,"Earlier Folds","ghost")
            + f'<span style="flex-grow: 1;"></span>{thumbs(T)}</div>'
            + teachline(T,"Metis writes here, in its own voice, as its own commit. In your daily note it writes "
                          "<b>only its own section</b>, between its markers; the rest of the note is yours.") + '</div>')

def eyerow(T,*,glyph,what,page,why,action,tone=None,last=False):
    return (f'<div style="display: grid; grid-template-columns: 17px 128px minmax(0,1fr) 128px; '
            f'align-items: start; gap: 13px; padding: 10px 0; {bd_(T,last)}">'
            f'<span style="display: flex; color: {tone or T["ts"]}; margin-top: 1px;">{ic(glyph,15,1.8)}</span>'
            f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{what}</span>'
            f'<div><div>{mono(page,T["tp"],11.5)}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; line-height: 1.45; margin-top: 3px;">{why}</div></div>'
            f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]}; text-align: right;">{action} &rarr;</span></div>')

def needsyoureye(T):
    return (f'<div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px; margin-bottom: 4px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">'
            f'NEEDS YOUR EYE</span>'
            f'<span style="font-size: 10.5px; color: {T["tt"]};">4</span></div>'
            f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 15px;">'
            + eyerow(T,glyph=I["pencil"],what="Draft",page="Areas/Fsl/vendors.md",
                     why="Metis rewrote the vendor summary from three captures",action="Review")
            + eyerow(T,glyph=I["pencil"],what="Draft",page="Areas/Health/protein.md",
                     why="New section on the cost basis",action="Review")
            + eyerow(T,glyph=I["warn"],what="Conflict",page="Areas/Health/2026/sleep.md",
                     why="You edited it while the fold was writing &mdash; two writers met",
                     action="Resolve",tone=T["deg"])
            + eyerow(T,glyph=I["spark"],what="Suggestion",page="Areas/Health/",
                     why="Metis thinks these four notes are one area, not four",action="Read",last=True)
            + '</div>'
            + teachline(T,"A draft is <b>never served to an agent</b>. Marking a note <b>status: draft</b> is how "
                          "you keep it from your own agents until you have read it.") + '</div>')

def arearow(T,*,name,summary,why,last=False):
    return (f'<div style="display: grid; grid-template-columns: 172px minmax(0,1fr) 190px; align-items: start; '
            f'gap: 16px; padding: 10px 0; {bd_(T,last)}">'
            + mono(name,T["acc"],12.5)
            + f'<span style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.5;">{summary}</span>'
            + f'<span style="font-size: 11.5px; color: {T["ts"]}; text-align: right;">{why}</span></div>')

def areas(T):
    return (f'<div>'
            f'<div style="display: flex; align-items: baseline; gap: 9px; margin-bottom: 4px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">AREAS</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">Why it is here, not how much of it there is</span></div>'
            f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 12px 15px;">'
            + arearow(T,name="Areas/Fsl",summary="Drey, the business setup, and the vendor thread you are in now",
                      why="Named by last night&rsquo;s fold")
            + arearow(T,name="Areas/Health",summary="Sleep, labs, and the protein blend",
                      why="Changed by you 2 hours ago")
            + arearow(T,name="Areas/Ops",summary="The lease, the studio, and the things with dates on them",
                      why="Behind work #418")
            + arearow(T,name="Journal",summary="Your daily notes, and the fold&rsquo;s own file beside them",
                      why="Linked from 6 pages",last=True)
            + '</div>'
            + teachline(T,"A folder <b>is</b> a permission boundary: a grant names a path prefix, so organising "
                          "your vault is also configuring what an agent can reach.") + '</div>')

def sourceline(T,*,ok=True):
    if ok:
        return (f'<div style="display: flex; align-items: center; gap: 10px; background: {T["sunken"]}; '
                f'border-radius: 9px; padding: 10px 14px;">'
                f'<span style="width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid {T["tt"]};"></span>'
                f'<span style="font-size: 12px; color: {T["tp"]};">4 sources &middot; freshness unknown</span>'
                f'<span style="flex-grow: 1;"></span>'
                f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevr"],13,2.2)}</span></div>')
    return (f'<div style="background: {T["sunken"]}; border-radius: 9px; padding: 10px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 10px;">'
            f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["deg"]};"></span>'
            f'<span style="font-size: 12px; color: {T["tp"]};">4 sources &middot; '
            f'<span style="color: {T["deg"]}; font-weight: 600;">1 behind</span></span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"],13,2.2)}</span></div>'
            f'<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid {T["border"]};">'
            + srcrow(T,name="aws-costs",when="checked 3 days ago",state="stale",age="3d old")
            + srcrow(T,name="devin-sessions",when="last succeeded 2 days ago",state="failed",
                     why="The answer was an error: <b>token expired</b>",last=True) + '</div></div>')

def knowledgepane2(T,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Knowledge</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; '
            f'border-radius: 8px; border: 1px solid {T["bc"]}; background: {T["surface"]}; font-size: 12px; '
            f'color: {T["tp"]};">Search<span style="display: flex; color: {T["tt"]};">'
            f'{ic(I["review"],13,1.9)}</span></span></div>'
            f'<div style="padding: 0 16px 16px; display: flex; flex-direction: column; gap: 18px;">'
            + folddigest(T) + needsyoureye(T) + areas(T) + sourceline(T,ok=True) + '</div></div>')

# ---------- render 2: settling a draft --------------------------------------
DRAFT_BODY=("Three vendors changed terms this quarter. <b>Kessler</b> moved to net-45 and dropped the volume tier, "
            "which is the change that matters for March. <b>Orlin</b> and <b>Baymark</b> are unchanged. The cheapest "
            "option is no longer the renewal, on the terms as written.")

def draftreview(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevr"],15,2.2)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Vendor terms, this quarter</div>'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 3px;">'
            + mono("Areas/Fsl/vendors.md",T["ts"],11.5)
            + pill(T,"draft",T["ts"],T["absq"]) + '</div></div></div>'
            f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 15px;">'
            f'<div style="background: {T["agq"]}; border-radius: 10px; padding: 14px 16px;">'
            f'<div style="display: flex; align-items: center; gap: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],13,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">'
            f'{AN} WROTE THIS FROM 3 CAPTURES</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 14px; color: {T["tp"]}; line-height: 1.65; '
            f'margin-top: 10px;">{DRAFT_BODY}</div></div>'
            + block(T,"WHERE IT CAME FROM",sunk(T,
                linkrow(T,"imessage · 18 Sep","&ldquo;Kessler moved us to net-45&rdquo;")
                + linkrow(T,"Areas/Fsl/vendors.md","The section it would replace")
                + linkrow(T,"work #418","The task that will read it",last=True)))
            + block(T,"WHAT ACCEPTING DOES",sunk(T,
                kv(T,"Writes","Areas/Fsl/vendors.md",mono_=True)
                + kv(T,"Removes","status: draft &mdash; agents can read it from then on")
                + kv(T,"Answers","the request waiting in Needs You",last=True)))
            + f'<div style="display: flex; align-items: center; gap: 9px;">'
            + btn(T,"Approve","affirm",I["check"]) + btn(T,"Revise","secondary",I["pencil"])
            + btn(T,"Decline","secondary",I["x"]) + '</div>'
            + teachline(T,"This arrived as a request, so answering it here answers it there. <b>Needs You</b> is "
                          "where a decision is asked for; this is where there is room to correct the prose.")
            + '</div></div>')

# ---------- render 3: resolving a conflict ----------------------------------
CONFLICT=[(" ","## Sleep"),(" ",""),("-","Average 6h40 across the last fortnight, which is down."),
          ("+","Average 6h52 across the last fortnight — up slightly on the previous two weeks."),
          (" ",""),("-","The magnesium change did not move anything measurable."),
          ("+","The magnesium change did not move anything measurable yet; three weeks is short."),
          (" ",""),(" ","See [[Areas/Health/labs]] for the panel.")]

def conflictresolve(T,w=None):
    wd=f"width: {w}px; flex-shrink: 0;" if w else "flex-grow: 1; min-width: 0;"
    return (f'<div style="{wd} background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 12px; padding: 13px 16px; '
            f'border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: flex; color: {T["deg"]};">{ic(I["warn"],15,2)}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 15px; font-weight: 600; color: {T["tp"]};">Two writers met</div>'
            f'<div style="margin-top: 3px;">' + mono("Areas/Health/2026/sleep.md",T["ts"],11.5) + '</div></div></div>'
            f'<div style="padding: 16px; display: flex; flex-direction: column; gap: 15px;">'
            f'<div style="background: {T["degq"]}; border-radius: 10px; padding: 12px 14px;">'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.55;">You edited this file at '
            f'<b>9:12 PM</b>. The fold wrote to it at <b>9:14 PM</b>. Neither write was lost — the reconciler '
            f'stopped rather than choosing, so <b>the title and date on this row are not facts yet</b>.</div></div>'
            + diff(T,summary="Yours, against what the fold wrote",lines=CONFLICT,open_=True)
            + f'<div style="display: flex; align-items: center; gap: 9px; flex-wrap: wrap;">'
            + btn(T,"Keep Mine","secondary") + btn(T,"Take the Fold&rsquo;s","secondary")
            + btn(T,"Merge in Obsidian","ghost",I["note"]) + '</div>'
            + teachline(T,"<b>One writer per file</b> is the rule that makes the vault safe to share with agents. A "
                          "conflict is that rule holding — the alternative is a silent overwrite.")
            + '</div></div>')

# ============ THE FLOATING BAR — round 2 (2026-09-22) ==================
# Rebuilt after the owner's review: more transparent, more of Apple's glass
# language, far less prose in the sheets, a pulse while recording, and the senses
# shown while live. PR 253 still decides the mechanics; this decides the craft.

GLASS_TEXT=0.86   # a glass surface carrying TEXT (measured floor 0.83, dark secondary)
GLASS_MARK=0.75   # a glass surface carrying only MARKS in ts / agent / accent

def rgba(h,a):
    h=h.lstrip("#"); r,g,b=(int(h[i:i+2],16) for i in (0,2,4))
    return f"rgba({r}, {g}, {b}, {a})"

def glass(T,*,radius=18,marks=False,tint=None):
    """Apple's glass, in the four layers it is actually made of: a lensed
    backdrop, a scrim thick enough for our inks, a specular top edge, and a
    grounding shadow. The scrim is the only one that is not decoration."""
    dark = T is D
    a = GLASS_MARK if marks else GLASS_TEXT
    top,bot = (a+0.02, a)   # C74: the floor is the floor — no stop may dip under it
    spec = "rgba(255, 255, 255, 0.20)" if dark else "rgba(255, 255, 255, 0.62)"
    lip  = "rgba(255, 255, 255, 0.07)" if dark else "rgba(255, 255, 255, 0.24)"
    base = "rgba(0, 0, 0, 0.30)" if dark else "rgba(0, 0, 0, 0.055)"
    edge = rgba(T["bc"],0.55) if not dark else "rgba(255, 255, 255, 0.13)"
    ring = rgba(tint,0.60) if tint else edge
    return (f'background: linear-gradient(to bottom, {rgba(T["surface"],round(top,3))} 0%, '
            f'{rgba(T["surface"],round(a,3))} 46%, {rgba(T["surface"],round(bot,3))} 100%); '
            f'backdrop-filter: blur(28px) saturate(185%) brightness(1.04); '
            f'-webkit-backdrop-filter: blur(28px) saturate(185%) brightness(1.04); '
            f'border: 0.5px solid {ring}; border-radius: {radius}px; '
            f'box-shadow: inset 0 1px 0 {spec}, inset 0 0 0 0.5px {lip}, '
            f'inset 0 -14px 22px -14px {base}, '
            f'0 1px 2px rgba(0,0,0,0.10), 0 12px 34px -8px rgba(0,0,0,0.28);')

def motioncss():
    """One animation in the product, and now one more: the recording breath. Both
    stop under prefers-reduced-motion, where the ring holds at its widest."""
    return ('<style>'
            '@keyframes mtbreath { 0%,100% { transform: scale(1); opacity: 0.85; } '
            '50% { transform: scale(1.5); opacity: 0.12; } }'
            '.mt-breath { animation: mtbreath 2.6s cubic-bezier(.42,0,.58,1) infinite; }'
            '@media (prefers-reduced-motion: reduce) { .mt-breath { animation: none; '
            'transform: scale(1.5); opacity: 0.4; } }'
            '</style>')

# ---------- the mark, the senses ----------------------------------------------
def mark(T,*,size=15,live=False):
    c=T["ag"] if live else T["ts"]
    fill=f'background: {rgba(T["ag"],0.26)};' if live else ""
    return (f'<span style="display: inline-flex; width: {size}px; height: {size}px; border-radius: 4.5px; '
            f'border: 1.6px solid {c}; {fill} align-items: center; justify-content: center;">'
            f'<span style="width: {max(3,size//4)}px; height: 1.6px; background: {c};"></span></span>')

def breathmark(T,*,size=15,frame=None):
    """The live mark with its halo. `frame` draws one still of the cycle instead
    of animating, for the timing panel."""
    st={"in":"transform: scale(1); opacity: 0.85;",
        "mid":"transform: scale(1.26); opacity: 0.45;",
        "out":"transform: scale(1.5); opacity: 0.12;"}.get(frame)
    cls="" if st else ' class="mt-breath"'
    style=st or ""
    return (f'<span style="position: relative; display: inline-flex; width: {size}px; height: {size}px; '
            f'align-items: center; justify-content: center;">'
            f'<span{cls} style="position: absolute; inset: -5px; border-radius: 9px; '
            f'border: 1.5px solid {T["ag"]}; {style}"></span>'
            f'{mark(T,size=size,live=True)}</span>')

I["screen"]='<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>'

def sensepip(T,kind,*,size=13):
    """The glyph alone, in the agent ink, on whatever glass it sits on.

    The first version put an `agent` glyph on an `agent` tint plate and measured
    **2.69:1 light / 2.60:1 dark** against its own background — the C54 fault in a
    new costume: a mark and its ground drawn from one hue. Without the plate the
    same glyph clears 3.36 / 3.43 on the thin rail glass."""
    g=I["mic"] if kind=="mic" else I["screen"]
    return (f'<span style="display: inline-flex; align-items: center; justify-content: center; '
            f'color: {T["ag"]};">{ic(g,size+2,2)}</span>')

# ---------- the desktop it sits on -------------------------------------------
WALL_L="linear-gradient(145deg, #cfd8dc 0%, #e8e2d6 30%, #b9c6cc 62%, #7d95a1 100%)"
WALL_D="linear-gradient(145deg, #0f1f2b 0%, #1f2f3b 36%, #0b1620 70%, #26404f 100%)"

def desktop(T,*,inner,w=600,h=400,label=None):
    wl=WALL_L if T is L else WALL_D
    win=(f'<div style="position: absolute; left: 24px; top: 30px; right: 70px; bottom: 24px; '
         f'background: {T["bg"]}; border: 0.5px solid {rgba(T["bc"],0.8)}; border-radius: 11px; '
         f'box-shadow: 0 10px 30px rgba(0,0,0,0.22); overflow: hidden;">'
         f'<div style="height: 27px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]}; '
         f'display: flex; align-items: center; gap: 5px; padding: 0 9px;">'
         + "".join(f'<span style="width: 8px; height: 8px; border-radius: 50%; background: {T["tt"]}; '
                   f'opacity: 0.45;"></span>' for _ in range(3))
         + f'<span style="font-size: 9.5px; color: {T["tt"]}; margin-left: 7px;">Zoom &mdash; Vendor review</span>'
           '</div>'
         f'<div style="padding: 13px; display: flex; flex-direction: column; gap: 8px;">'
         + "".join(f'<div style="height: {hh}px; width: {ww}%; background: {T["sunken"]}; '
                   f'border-radius: 5px;"></div>' for hh,ww in ((10,64),(10,88),(10,42),(58,100),(10,71)))
         + '</div></div>')
    cap=(f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {L["tt"]}; '
         f'margin-bottom: 7px;">{label}</div>') if label else ""
    return (cap + f'<div style="position: relative; width: {w}px; height: {h}px; background: {wl}; '
            f'border-radius: 12px; overflow: hidden;">{win}{inner}</div>')

# ---------- the rail: a toolbar, one click per act ---------------------------
I["rec"]='<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>'

def railbtn(T,glyph,*,hot=False,tone=None):
    """A 28px hit target holding a 16px glyph. `hot` is the pressed / pointer-over
    state: a quiet plate behind the glyph, never a colour change of the glyph."""
    plate=f'background: {rgba(T["ink"] if "ink" in T else T["tp"],0.08)};' if hot else ""
    return (f'<span style="display: flex; align-items: center; justify-content: center; width: 28px; '
            f'height: 28px; border-radius: 8px; {plate} color: {tone or T["ts"]};">{ic(glyph,16,1.9)}</span>')

def railsep(T):
    return f'<span style="width: 14px; height: 0.5px; background: {rgba(T["ts"],0.35)}; margin: 2px 0;"></span>'

def railtool(T,*,live=False,senses=("screen","mic"),top=96,hot=None,frame=None):
    head = breathmark(T,size=14,frame=frame) if live else mark(T,size=14)
    pips = "".join(sensepip(T,s,size=12) for s in senses) if live else ""
    rec  = railbtn(T,I["stop"],tone=T["deg"],hot=hot=="rec") if live else railbtn(T,I["rec"],hot=hot=="rec")
    return (f'<div style="position: absolute; right: 9px; top: {top}px; '
            f'{glass(T,radius=17,marks=True,tint=T["ag"] if live else None)} '
            f'width: 34px; padding: 10px 0 5px; display: flex; flex-direction: column; align-items: center; '
            f'gap: 3px;">'
            f'<span style="height: 22px; display: flex; align-items: center;">{head}</span>'
            + (f'<span style="display: flex; flex-direction: column; align-items: center; gap: 7px; '
               f'padding: 4px 0 3px;">{pips}</span>' if live else "")
            + railsep(T)
            + railbtn(T,I["chat"],hot=hot=="ask")
            + railbtn(T,I["note"],hot=hot=="note")
            + railbtn(T,I["todo"],hot=hot=="todo")
            + railsep(T) + rec + '</div>')

def tip(T,text,key,*,top,right=52):
    return (f'<div style="position: absolute; right: {right}px; top: {top}px; {glass(T,radius=7)} '
            f'padding: 4px 8px; display: flex; gap: 8px; align-items: center; box-shadow: 0 4px 14px rgba(0,0,0,0.18);">'
            f'<span style="font-size: 11px; color: {T["tp"]};">{text}</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]}; font-family: {MONO};">{key}</span></div>')

def quickfield(T,*,kind="note",saved=False,w=270,top=0,right=52):
    """One click on Note or To-do opens this beside the rail, already focused.
    Type, Return, gone. Three motions total, and one of them is the thought."""
    g = I["note"] if kind=="note" else I["todo"]
    if saved:
        inner=(f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],14,2.2)}</span>'
               f'<span style="font-size: 12px; color: {T["tp"]};">{"Noted" if kind=="note" else "To-do added"}</span>'
               f'<span style="font-family: {MONO}; font-size: 11px; color: {T["ts"]};">1:02 PM</span>')
    else:
        ph = "Send him the comparables before Friday" if kind=="todo" else "Measuring against last year, not the comps"
        inner=(f'<span style="display: flex; color: {T["ts"]};">{ic(g,14,1.9)}</span>'
               f'<span style="flex-grow: 1; font-size: 12px; color: {T["tp"]};">{ph}'
               f'<span style="display: inline-block; width: 1.5px; height: 13px; background: {T["acc"]}; '
               f'vertical-align: -2px; margin-left: 1px;"></span></span>'
               f'<span style="font-size: 10.5px; color: {T["ts"]}; font-family: {MONO};">&#8617;</span>')
    return (f'<div style="position: absolute; right: {right}px; top: {top}px; width: {w}px; '
            f'{glass(T,radius=12)} padding: 9px 11px; display: flex; align-items: center; gap: 9px;">{inner}</div>')

# ---------- the panel ---------------------------------------------------------
def barturn(T,*,text,who="agent",more=False):
    if who=="user":
        return (f'<div style="background: {T["accq"]}; border-radius: 11px; padding: 9px 12px; '
                f'font-size: 12px; color: {T["tp"]}; line-height: 1.5;">{text}</div>')
    tail=(f'<div style="font-size: 11px; color: {T["acc"]}; font-weight: 600; margin-top: 6px;">'
          f'Open in Chat &nearr;</div>') if more else ""
    return (f'<div style="border-left: 2px solid {T["ag"]}; padding-left: 12px;">'
            f'<div style="font-family: {SERIF}; font-size: 12.5px; color: {T["tp"]}; line-height: 1.58;">{text}</div>'
            f'{tail}</div>')

def barcomposer(T):
    return (f'<div style="display: flex; align-items: center; gap: 8px; background: {rgba(T["bg"],0.72)}; '
            f'border: 0.5px solid {rgba(T["bc"],0.7)}; border-radius: 11px; padding: 8px 10px; '
            f'box-shadow: inset 0 1px 2px rgba(0,0,0,0.06);">'
            f'<span style="flex-grow: 1; font-size: 12px; color: {T["tt"]};">Ask Metis&hellip;</span>'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["send"],14,1.9)}</span></div>')

def baract(T,g,t,*,tone=None):
    return (f'<span style="display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; '
            f'border-radius: 9px; border: 0.5px solid {rgba(tone or T["bc"],0.75)}; '
            f'background: {rgba(T["bg"],0.55)};">'
            f'<span style="display: flex; color: {tone or T["ts"]};">{ic(g,13,1.9)}</span>'
            f'<span style="font-size: 11.5px; color: {tone or T["tp"]};">{t}</span></span>')

I["sound"]='<path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z"/><path d="M15.5 9a4 4 0 010 6"/><path d="M18 6.5a7.5 7.5 0 010 11"/>'
I["todo"]='<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M8 12.2l2.4 2.4L16 9"/>'

SENSE_GLYPH={"mic":"mic","screen":"screen","audio":"sound"}

def jotrow(T,*,kind,when,text,last=False):
    g=I["note"] if kind=="note" else I["todo"]
    return (f'<div style="display: flex; align-items: baseline; gap: 9px; padding: 6px 0; {bd_(T,last)}">'
            f'<span style="display: flex; color: {T["ts"]}; align-self: center;">{ic(g,12,1.9)}</span>'
            f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["tt"]}; flex-shrink: 0;">{when}</span>'
            f'<span style="font-size: 11.5px; color: {T["tp"]}; line-height: 1.45;">{text}</span></div>')

def jotlog(T,*,open_=True):
    head=(f'<div style="display: flex; align-items: center; gap: 7px;">'
          f'<span style="font-size: 11px; color: {T["ts"]};">This session &middot; '
          f'<b style="color: '+T["tp"]+'">2 notes</b>, <b style="color: '+T["tp"]+'">1 to-do</b></span>'
          f'<span style="flex-grow: 1;"></span>'
          f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"] if open_ else I["chevr"],12,2.2)}</span></div>')
    if not open_: return head
    return (head + f'<div style="margin-top: 6px;">'
            + jotrow(T,kind="note",when="1:02 PM",text="He is measuring against last year, not the comparables")
            + jotrow(T,kind="todo",when="1:20 PM",text="Send him the four comparables before Friday")
            + jotrow(T,kind="note",when="1:38 PM",text="Volume tier claim needs checking",last=True) + '</div>')

def barpanel(T,*,live=False,w=328,senses=("screen","mic")):
    """Chat, as it was before the mode pills: the tail of the one conversation and
    a composer. Note and To-do live on the rail, one click each."""
    if live:
        head=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 11px 13px 10px;">'
              f'{breathmark(T,size=15)}'
              f'<span style="font-family: {MONO}; font-size: 12px; color: {T["ag"]};">13m 42s</span>'
              f'<span style="font-size: 11.5px; color: {T["ts"]};">Zoom</span>'
              f'<span style="flex-grow: 1;"></span>'
              + "".join(sensepip(T,s,size=12) for s in senses) + '</div>')
    else:
        head=(f'<div style="display: flex; align-items: center; gap: 9px; padding: 11px 13px 10px;">'
              f'{mark(T,size=15)}'
              f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Metis</span></div>')
    turns=(f'<div style="display: flex; flex-direction: column; gap: 10px;">'
           + barturn(T,text="What did he say about the March number?",who="user")
           + barturn(T,text="He put it 4% over the comparables you pulled, and named the volume tier as the "
                            "reason. You have not agreed to that framing.",more=True) + '</div>')
    log=(f'<div style="border-top: 0.5px solid {rgba(T["border"],0.85)}; padding-top: 9px;">'
         + jotlog(T,open_=False) + '</div>') if live else ""
    return (f'<div style="width: {w}px; {glass(T,radius=18,tint=T["ag"] if live else None)}">{head}'
            f'<div style="height: 0.5px; background: {rgba(T["border"],0.85)};"></div>'
            f'<div style="padding: 12px 13px 13px; display: flex; flex-direction: column; gap: 11px;">'
            f'{turns}{barcomposer(T)}{log}</div></div>')

# ---------- the record sheet --------------------------------------------------
def segchoice(T,items,sel):
    cell=lambda g,t,on:(f'<span style="display: inline-flex; align-items: center; gap: 6px; '
                        f'padding: 6px 11px; border-radius: 8px; font-size: 12px; '
                        f'font-weight: {600 if on else 400}; color: {T["tp"] if on else T["ts"]}; '
                        f'background: {T["bg"] if on else "transparent"}; '
                        f'box-shadow: {"0 1px 2px rgba(0,0,0,0.12)" if on else "none"};">'
                        f'<span style="display: flex; color: {T["acc"] if on else T["ts"]};">{ic(g,14,1.9)}</span>'
                        f'{t}</span>')
    return (f'<span style="display: inline-flex; gap: 2px; padding: 3px; border-radius: 11px; '
            f'background: {rgba(T["sunken"],0.9)}; border: 0.5px solid {rgba(T["bc"],0.5)};">'
            + "".join(cell(g,t,t==sel) for g,t in items) + '</span>')

def targetline(T,*,glyph,text,extra=None,control=None):
    return (f'<div style="display: flex; align-items: center; gap: 9px; padding: 7px 0;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(glyph,15,1.9)}</span>'
            f'<span style="font-size: 12.5px; color: {T["tp"]};">{text}</span>'
            + (f'<span style="font-size: 11.5px; color: {T["tt"]};">{extra}</span>' if extra else '')
            + (f'<span style="flex-grow: 1;"></span>{control}' if control else '') + '</div>')

def recordsheet(T,*,target="Window",audio=True,mic=True,w=360):
    seg=segchoice(T,[(I["screen"],"Screen"),(I["display"],"Window"),(I["sound"],"Audio only")],target)
    what=""
    if target=="Window":
        what=targetline(T,glyph=I["display"],text="Zoom &mdash; Vendor review",
                        control=f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"],13,2.1)}</span>')
    elif target=="Screen":
        what=targetline(T,glyph=I["screen"],text="Studio Display",
                        control=f'<span style="display: flex; color: {T["ts"]};">{ic(I["chevd"],13,2.1)}</span>')
    alabel={"Window":"App audio","Screen":"System audio","Audio only":"System audio"}[target]
    rows=(targetline(T,glyph=I["sound"],text=alabel,control=toggle(T,audio))
          + targetline(T,glyph=I["mic"],text="Your microphone",extra="your side only",control=toggle(T,mic)))
    div=f'<div style="height: 0.5px; background: {rgba(T["border"],0.85)}; margin: 5px 0;"></div>'
    return (f'<div style="width: {w}px; {glass(T,radius=18)}">'
            f'<div style="padding: 13px 15px 10px; font-size: 14px; font-weight: 600; color: {T["tp"]};">Record</div>'
            f'<div style="padding: 0 15px 4px;">{seg}</div>'
            f'<div style="padding: 4px 15px 0;">{what}{div if what else ""}{rows}</div>'
            f'<div style="padding: 11px 15px 14px; display: flex; align-items: center; gap: 9px;">'
            + btn(T,"Record","affirm",I["rec"]) + btn(T,"Cancel","ghost") + '</div></div>')

# ---------- Settings, trimmed ------------------------------------------------
def toggle(T,on=True):
    return (f'<span style="display: inline-flex; align-items: center; width: 40px; height: 23px; '
            f'border-radius: 12px; background: {T["acc"] if on else T["sunken"]}; '
            f'border: 1px solid {T["acc"] if on else T["bc"]}; padding: 2px; '
            f'justify-content: {"flex-end" if on else "flex-start"};">'
            f'<span style="width: 17px; height: 17px; border-radius: 50%; background: {T["bg"] if on else T["ts"]}; '
            f'box-shadow: 0 1px 2px rgba(0,0,0,0.25);"></span></span>')

def setrow(T,*,label,control,note=None,last=False):
    return (f'<div style="display: flex; align-items: center; gap: 14px; padding: 11px 0; {bd_(T,last)}">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="font-size: 12.5px; color: {T["tp"]};">{label}</div>'
            + (f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">{note}</div>' if note else '')
            + f'</div>{control}</div>')

def grantpip(T,*,ok=True):
    return (f'<span style="display: inline-flex; align-items: center; gap: 6px;">'
            f'<span style="display: flex; color: {T["ok"] if ok else T["ts"]};">'
            f'{ic(I["check"] if ok else I["clock"],13,2.1)}</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">'
            f'{"Approved" if ok else "Not yet asked"}</span></span>')

def sidepicker(T,*,sel="right"):
    cell=lambda s,on:(f'<div style="text-align: center;">'
                      f'<div style="position: relative; width: 62px; height: 44px; border-radius: 7px; '
                      f'border: 1px solid {T["acc"] if on else T["border"]}; background: {T["sunken"]}; '
                      f'overflow: hidden;">'
                      f'<span style="position: absolute; {s}: 4px; top: 13px; width: 4px; height: 18px; '
                      f'border-radius: 2px; background: {T["acc"] if on else T["tt"]};"></span></div>'
                      f'<div style="font-size: 11px; color: {T["acc"] if on else T["ts"]}; margin-top: 4px; '
                      f'font-weight: {600 if on else 400};">{"Left" if s=="left" else "Right"}</div></div>')
    return (f'<span style="display: inline-flex; gap: 10px;">'
            f'{cell("left",sel=="left")}{cell("right",sel=="right")}</span>')

def kept(T):
    return (f'<div style="background: {T["sunken"]}; border-radius: 10px; padding: 11px 13px;">'
            + "".join(f'<div style="display: flex; align-items: baseline; gap: 12px; padding: 5px 0;'
                      + ("" if i==2 else f' border-bottom: 1px solid {T["border"]};') + '">'
                      f'<span style="width: 92px; flex-shrink: 0; font-size: 12px; font-weight: 600; '
                      f'color: {T["tp"]};">{a}</span>'
                      f'<span style="font-size: 12px; color: {T["ts"]};">{b}</span></div>'
              for i,(a,b) in enumerate([
                ("Audio","never kept"),
                ("Transcript","30 days"),
                ("Notes","only what you approve, in your vault")])) + '</div>')

def capturesettings(T,w=520,bare=False):
    return (f'<div style="width: {"100%" if bare else str(w)+"px"}; box-sizing: border-box; background: {T["bg"]}; '
            + ('' if bare else f'border: 1px solid {T["bc"]}; border-radius: 12px; ')
            + 'overflow: hidden;">'
            f'<div style="padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">Live capture</span></div>'
            f'<div style="padding: 4px 16px 15px;">'
            + setrow(T,label="The floating bar",note="Always on screen while this is on",control=toggle(T,True))
            + setrow(T,label="Which edge",control=sidepicker(T))
            + setrow(T,label="Which display",
                     control=f'<span style="font-size: 12px; color: {T["tp"]};">Studio Display &nbsp;'
                             f'<span style="color: {T["ts"]};">&#9662;</span></span>')
            + setrow(T,label="Microphone",control=grantpip(T,ok=True))
            + setrow(T,label="System audio",control=grantpip(T,ok=True))
            + setrow(T,label="Screen recording",control=grantpip(T,ok=False),last=True)
            + f'<div style="margin-top: 14px;">{sub("WHAT METIS KEEPS",T["tt"])}{kept(T)}</div>'
            + f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 12px;">'
            + btn(T,"Purge Now","dest",I["x"])
            + f'<span style="font-size: 11.5px; color: {T["ts"]};">14 minutes of transcript right now</span>'
            + '</div></div></div>')


# ============ RUN DETAIL — a session, in full (2026-09-22) =============
# Screen 12. One page for any run: a routine, an agent, or a chat. The working
# conversation leads; what it cost sits beside it; what Metis took from it sits
# under that. The conversation comes from a session archive the build does not
# have yet (C78) — designed against the right system, per the owner's ruling.

def crumb(T,parts):
    out=[]
    for i,pt in enumerate(parts):
        last=i==len(parts)-1
        out.append(f'<span style="font-size: 12px; color: {T["tp"] if last else T["acc"]}; '
                   f'font-weight: {600 if last else 400};">{pt}</span>')
    sep=f'<span style="color: {T["tt"]}; font-size: 11px;">&#9656;</span>'
    return f'<span style="display: inline-flex; align-items: center; gap: 8px;">{sep.join(out)}</span>'

def runheader(T,*,crumbs,title,when,ok=True,why=None):
    state=(pill(T,"ran clean",T["ok"],T["okq"]) if ok else pill(T,"failed",T["fail"],T["failq"],I["failed"]))
    err=(f'<div style="margin-top: 11px; background: {T["degq"]}; border-radius: 9px; padding: 10px 13px; '
         f'font-size: 12.5px; color: {T["tp"]}; line-height: 1.5;">{why}</div>') if why else ""
    return (f'<div style="padding: 14px 18px 13px; border-bottom: 1px solid {T["border"]};">'
            f'{crumb(T,crumbs)}'
            f'<div style="display: flex; align-items: center; gap: 11px; margin-top: 8px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">{title}</span>{state}'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">{when}</span></div>{err}</div>')

# ---------- the working conversation -----------------------------------------
def layerrow(T,label,who,text,*,open_=False):
    body=(f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.6; margin-top: 7px;">{text}</div>'
          if open_ else "")
    return (f'<div style="padding: 8px 0; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"] if open_ else I["chevr"],12,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
            f'<span style="font-size: 12px; color: {T["acc"]}; font-weight: 600;">{who}</span></div>{body}</div>')

def ownturn(T,label,text,when):
    return (f'<div>'
            f'<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ts"]};">{label}</span>'
            f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["tt"]};">{when}</span></div>'
            f'<div style="background: {T["accq"]}; border-radius: 11px; padding: 10px 13px; font-size: 13px; '
            f'color: {T["tp"]}; line-height: 1.55;">{text}</div></div>')

def agentturn(T,text,when):
    return (f'<div style="border-left: 2px solid {T["ag"]}; padding-left: 14px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 5px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["spark"],12,2.2)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">{AN}</span>'
            f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["tt"]};">{when}</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13.5px; color: {T["tp"]}; line-height: 1.62;">{text}</div></div>')

def toolcall(T,*,name,args,result,ms,ok=True,open_=True,error=None):
    tone=T["ts"] if ok else T["deg"]
    head=(f'<div style="display: flex; align-items: center; gap: 8px;">'
          f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"] if open_ else I["chevr"],12,2.2)}</span>'
          f'{mono(name,T["tp"],12)}'
          f'<span style="flex-grow: 1;"></span>'
          + ('' if ok else f'<span style="font-size: 11px; font-weight: 600; color: {T["deg"]};">failed</span>')
          + f'<span style="font-family: {MONO}; font-size: 10.5px; color: {tone};">{ms}</span></div>')
    if not open_:
        return (f'<div style="margin-left: 16px; background: {T["agq"]}; border-radius: 9px; padding: 8px 12px;">'
                f'{head}</div>')
    res=(f'<div style="font-size: 12px; color: {T["deg"]}; line-height: 1.5;">{error}</div>' if error else
         f'<div style="font-family: {MONO}; font-size: 11px; color: {T["ts"]}; line-height: 1.55; '
         f'white-space: pre-wrap;">{result}</div>')
    return (f'<div style="margin-left: 16px; background: {T["agq"] if ok else T["degq"]}; border-radius: 9px; '
            f'padding: 9px 12px;">{head}'
            f'<div style="margin-top: 8px; display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 5px 10px;">'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; '
            f'padding-top: 2px;">ASKED</span>'
            f'<span style="font-family: {MONO}; font-size: 11px; color: {T["tp"]}; line-height: 1.55;">{args}</span>'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]}; '
            f'padding-top: 2px;">GOT</span>{res}</div></div>')

def sessionpane(T,*,failed=False,w=None):
    wd=f"width: {w}px;" if w else "flex-grow: 1; min-width: 0;"
    layers=(f'<div style="margin-bottom: 16px;">'
            + layerrow(T,"DEFINITION","collator","")
            + layerrow(T,"TASK","morning brief",
                       "Read yesterday&rsquo;s journal and today&rsquo;s calendar. Write the brief as a table: "
                       "what is on, what moved, what needs me. Cite the file every line came from.",open_=True)
            + '</div>')
    calls=(toolcall(T,name="calendar.events",args='{ "day": "2026-09-22" }',
                    result='4 events · first at 09:15 "Standup" · last at 13:00 "Vendor review"',ms="0.4s",open_=False)
           + toolcall(T,name="knowledge.read",args='{ "path": "Journal/2026-09-21.md" }',
                      result='1,204 words · 3 open loops · mentions "lease comps" twice',ms="0.2s")
           + (toolcall(T,name="knowledge.read",args='{ "path": "Areas/Finance/runway.md" }',result="",ms="0.1s",
                       ok=False,error="Refused: <b>Areas/Finance</b> is not in this agent&rsquo;s read grant.")
              if failed else
              toolcall(T,name="work.list",args='{ "status": "open", "due_before": "2026-09-24" }',
                       result="7 tasks · 2 due tomorrow · #418 blocked",ms="0.3s",open_=False)))
    reply=(agentturn(T,"I could not read <b>Areas/Finance</b>, so the runway line is left out rather than guessed. "
                       "Everything else is in the brief. Want me to ask for access to that folder?","6:03:41")
           if failed else
           agentturn(T,"Four things on today. The lease comparables are the one that moved: they came back "
                       "<b>4% under</b> his number. #418 is still blocked on the vendor terms. Brief written to "
                       "<b>Journal/Brief/2026-09-22.md</b>.","6:03:12"))
    out=(f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 4px;">'
         + btn(T,"Open the Brief","secondary",I["note"]) + btn(T,"Continue in Chat","ghost",I["chat"])
         + f'<span style="flex-grow: 1;"></span>{thumbs(T)}</div>')
    return (f'<div style="{wd} padding: 16px 18px 18px;">{layers}'
            f'<div style="display: flex; flex-direction: column; gap: 12px;">'
            + ownturn(T,"TASK &middot; MORNING BRIEF","Write today&rsquo;s brief.","6:02:00")
            + calls + reply + '</div>' + out + '</div>')

# ---------- the side column: what it cost, what it called, what it taught -------
def factgrid(T):
    cell=lambda k,v,s=None:(f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; '
                            f'color: {T["tt"]};">{k}</div>'
                            f'<div style="font-size: 13.5px; color: {T["tp"]}; margin-top: 3px;">{v}</div>'
                            + (f'<div style="font-size: 11px; color: {T["ts"]}; margin-top: 1px;">{s}</div>' if s else '')
                            + '</div>')
    return (f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px;">'
            + cell("SERVED BY","sonnet","anthropic")
            + cell("TOOK","1m 12s","6:02:00 &ndash; 6:03:12")
            + cell("TOKENS","18.4k in &middot; 1.1k out","71% from cache")
            + cell("COST","2.1&cent;","") + '</div>')

def seqrow(T,name,ms,frac,*,ok=True,last=False):
    bar=T["ts"] if ok else T["deg"]
    return (f'<div style="display: grid; grid-template-columns: minmax(0,1fr) 92px 38px; gap: 9px; align-items: center; '
            f'padding: 6px 0; {bd_(T,last)}">'
            f'{mono(name,T["tp"] if ok else T["deg"],11.5)}'
            f'<span style="height: 5px; border-radius: 3px; background: {T["sunken"]}; position: relative; overflow: hidden;">'
            f'<span style="position: absolute; left: 0; top: 0; bottom: 0; width: {int(frac*100)}%; '
            f'background: {bar}; border-radius: 3px;"></span></span>'
            f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["ts"]}; text-align: right;">{ms}</span></div>')

def toolsequence(T,*,failed=False):
    rows=[("calendar.events","0.4s",1.0,True),("knowledge.read","0.2s",0.5,True)]
    rows.append(("knowledge.read","0.1s",0.25,False) if failed else ("work.list","0.3s",0.75,True))
    return sunk(T,"".join(seqrow(T,n,m,f,ok=o,last=i==len(rows)-1) for i,(n,m,f,o) in enumerate(rows)))

def learnrow(T,*,kind,target,text,status,last=False):
    tone={"waiting":(T["ts"],"In Needs You"),"accepted":(T["ok"],"Accepted"),"declined":(T["tt"],"Declined")}[status]
    g={"Preference":I["person"],"Profile":I["person"],"Lesson":I["spark"],"Knowledge":I["know"]}[kind]
    return (f'<div style="padding: 9px 0; {bd_(T,last)}">'
            f'<div style="display: flex; align-items: center; gap: 7px;">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(g,13,1.9)}</span>'
            f'<span style="font-size: 11.5px; font-weight: 600; color: {T["tp"]};">{kind}</span>'
            f'{mono(target,T["ts"],10.5)}<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11px; color: {tone[0]}; font-weight: 600;">{tone[1]}</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 12.5px; color: {T["tp"]}; line-height: 1.5; '
            f'margin-top: 5px; padding-left: 20px;">{text}</div></div>')

def learned(T,*,failed=False,chat=False):
    if chat:
        rows=(learnrow(T,kind="Preference",target="Me/Working Style.md",
                       text="&ldquo;Lead with the number, then the reason.&rdquo;",status="waiting")
              + learnrow(T,kind="Profile",target="Me/profile.md",text="standup_time: 09:15",status="accepted")
              + learnrow(T,kind="Knowledge",target="Areas/Fsl/vendors.md",
                         text="Kessler moved to net-45 and dropped the volume tier.",status="waiting",last=True))
    elif failed:
        rows=(learnrow(T,kind="Lesson",target="agents/collator",
                       text="Ask for Areas/Finance before the brief runs, not after it fails.",status="waiting",last=True))
    else:
        rows=(learnrow(T,kind="Lesson",target="routines/morning-brief",
                       text="You opened the brief and went straight to #418 &mdash; lead with what is blocked.",
                       status="waiting")
              + learnrow(T,kind="Knowledge",target="Areas/Ops/lease.md",
                         text="Comparables came back 4% under his number.",status="accepted",last=True))
    return sunk(T,rows)

def sidecol(T,*,failed=False,chat=False,w=340):
    lbl=lambda t:(f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
                  f'margin-bottom: 8px;">{t}</div>')
    return (f'<div style="width: {w}px; flex-shrink: 0; border-left: 1px solid {T["border"]}; '
            f'background: {T["surface"]}; padding: 16px 16px 18px; display: flex; flex-direction: column; gap: 18px;">'
            f'<div>{lbl(f"WHAT {AN} TOOK FROM THIS")}{learned(T,failed=failed,chat=chat)}</div>'
            f'<div>{lbl("THE RUN")}{factgrid(T)}</div>'
            + ('' if chat else f'<div>{lbl("TOOL CALLS &middot; 3")}{toolsequence(T,failed=failed)}</div>')
            + '</div>')

def rundetail(T,*,failed=False):
    why=("<b>knowledge.read</b> was refused: <b>Areas/Finance</b> is not in collator&rsquo;s read grant. The brief "
         "was written without the runway line.") if failed else None
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; background: {T["bg"]}; '
            f'flex-grow: 1; min-width: 0;">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Scheduled")}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column;">'
            + runheader(T,crumbs=["Scheduled","Morning Brief","Today, 6:02 AM"],title="Morning Brief",
                        when="Tuesday 22 September &middot; 6:02 AM",ok=not failed,why=why)
            + f'<div style="display: flex; align-items: stretch; flex-grow: 1;">'
            + sessionpane(T,failed=failed) + sidecol(T,failed=failed) + '</div></div></div></div>')

def chatsession(T,w=None):
    turns=(ownturn(T,"YOU","Lead with the number next time &mdash; I had to hunt for it.","2:14 PM")
           + agentturn(T,"Noted. The vendor terms: <b>net-45</b>, and Kessler dropped the volume tier, which is the "
                         "change that matters for March.","2:14 PM"))
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 14px; overflow: hidden; background: {T["bg"]}; '
            f'flex-grow: 1; min-width: 0;">'
            + runheader(T,crumbs=["Activity","Chat &middot; Tuesday 2:14 PM"],title="Chat",
                        when="Tuesday 22 September &middot; 2:14 PM")
            + f'<div style="display: flex; align-items: stretch;">'
            + f'<div style="flex-grow: 1; min-width: 0; padding: 16px 18px 18px; display: flex; flex-direction: column; '
              f'gap: 12px;">{turns}'
            + f'<div style="display: flex; gap: 9px; margin-top: 4px;">{btn(T,"Open in Chat","secondary",I["chat"])}</div></div>'
            + sidecol(T,chat=True) + '</div></div>')

def archivesettings(T,w=500,bare=False):
    sel=(f'<span style="font-size: 12px; color: {T["tp"]};">30 days &nbsp;'
         f'<span style="color: {T["ts"]};">&#9662;</span></span>')
    return (f'<div style="width: {"100%" if bare else str(w)+"px"}; box-sizing: border-box; background: {T["bg"]}; '
            + ('' if bare else f'border: 1px solid {T["bc"]}; border-radius: 12px; ')
            + 'overflow: hidden;">'
            f'<div style="padding: 13px 16px; border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">Sessions</span></div>'
            f'<div style="padding: 4px 16px 15px;">'
            + setrow(T,label="Keep sessions",control=sel)
            + setrow(T,label="Let Metis learn from them",note="What it learns comes to you as a proposal",
                     control=toggle(T,True),last=True)
            + f'<div style="display: flex; align-items: center; gap: 9px; margin-top: 12px;">'
            + btn(T,"Purge Now","dest",I["x"])
            + f'<span style="font-size: 11.5px; color: {T["ts"]};">38 sessions, oldest 29 days</span></div>'
            + '</div></div>')


# ============ NEEDS YOU, AS A QUEUE — round E (2026-09-22) =============
# Owner's ruling: access requests were far too verbose. Keep the card to what
# it asks and three answers; everything else behind a disclosure, and a help
# link for the rules. Seven request types (action added, C80). A meeting
# arrives as one grouped card (C81).

def disclose(T,label,inner,*,open_=False,meta=None):
    head=(f'<div style="display: flex; align-items: center; gap: 7px; padding: 7px 0;">'
          f'<span style="display: flex; color: {T["tt"]};">{ic(I["chevd"] if open_ else I["chevr"],12,2.2)}</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">{label}</span>'
          + (f'<span style="flex-grow: 1;"></span><span style="font-size: 11px; color: {T["tt"]};">{meta}</span>' if meta else '')
          + '</div>')
    return head + (f'<div style="padding: 0 0 8px 19px;">{inner}</div>' if open_ else '')

def beforeafter(T,now,after,*,lost=None):
    col=lambda k,v,c:(f'<div style="flex: 1; min-width: 0;">'
                      f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">{k}</div>'
                      f'<div style="font-size: 12px; color: {c}; margin-top: 4px; line-height: 1.5;">{v}</div></div>')
    return (f'<div style="display: flex; gap: 14px; background: {T["sunken"]}; border-radius: 9px; padding: 10px 12px;">'
            + col("NOW",now,T["ts"])
            + f'<span style="display: flex; align-items: center; color: {T["tt"]};">{ic(I["send"],14,1.9)}</span>'
            + col("AFTER",after,T["tp"]) + '</div>'
            + (f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 6px;">{lost}</div>' if lost else ''))

def helplink(T):
    return (f'<span title="How access works" style="display: inline-flex; align-items: center; justify-content: center; '
            f'width: 20px; height: 20px; border-radius: 50%; border: 1px solid {T["bc"]}; font-size: 11px; '
            f'font-weight: 600; color: {T["ts"]};">?</span>')

def reqhead(T,glyph,typ,agent,when,trust="internal",extra=""):
    return (f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(glyph,14,1.9)}</span>'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ts"]};">{typ}</span>'
            f'{extra}<span style="flex-grow: 1;"></span>'
            f'{agentchip(T,agent)}{trustmark(T,trust)}'
            f'<span style="font-size: 11px; color: {T["tt"]};">{when}</span></div>')

def accesscard2(T,*,state="pending",width=None,agent="drey-dev",trust="internal",when="12m",
                asked="Areas/Finance",open_=None):
    w=f"width: {width}px;" if width else ""
    again=(f'<span style="font-size: 10.5px; color: {T["ts"]}; border: 1px solid {T["bc"]}; border-radius: 999px; '
           f'padding: 1px 7px;">asked again</span>') if state=="escalated" else ""
    head=reqhead(T,I["key"],"ACCESS",agent,when,trust,again)
    title=(f'<div style="font-size: 14.5px; font-weight: 600; color: {T["tp"]}; margin-top: 9px;">'
           f'Read {mono(asked if state!="revising" else "Areas/Finance/Vendors",T["tp"],13.5)}</div>')
    acts=(f'<div style="display: flex; align-items: center; gap: 7px; row-gap: 8px; flex-wrap: wrap; margin-top: 12px;">'
          f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Revise","secondary",I["pencil"])}'
          f'{btn(T,"Decline","secondary",I["x"])}<span style="flex-grow: 1;"></span>'
          f'{btn(T,"","ghost",I["later"],icon_only=True,title="Later")}{helplink(T)}</div>')
    why=(f'<div style="background: {T["agq"]}; border-radius: 8px; padding: 8px 10px; font-size: 12px; '
         f'color: {T["tp"]}; line-height: 1.5;">To reconcile the vendor invoices against the March renewal.</div>')
    ba=beforeafter(T,"Titles in every folder","Reads <b>"+asked+"</b>",lost="Titles outside its folders stop.")
    body=head+title
    if state=="refused":
        body+=(f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 10px; background: {T["degq"]}; '
               f'border-radius: 8px; padding: 8px 10px;">'
               f'<span style="display: flex; color: {T["deg"]};">{ic(I["warn"],14,2)}</span>'
               f'<span style="font-size: 12px; color: {T["tp"]}; flex-grow: 1;">Set in its manifest, not grantable here.</span>'
               f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Edit &rarr;</span></div>')
        return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
                f'padding: 14px 15px; box-sizing: border-box;">{body}'
                f'<div style="display: flex; gap: 7px; margin-top: 11px;">{btn(T,"Decline","secondary",I["x"])}'
                f'<span style="flex-grow: 1;"></span>{helplink(T)}</div></div>')
    if state=="revising":
        tree="".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 4px 0 4px {8+d*14}px; '
                     f'border-radius: 6px; background: {T["accq"] if s else "transparent"};">'
                     f'<span style="width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid '
                     f'{T["acc"] if s else T["bc"]}; display: inline-flex; align-items: center; justify-content: center;">'
                     + (f'<span style="width: 6px; height: 6px; border-radius: 50%; background: {T["acc"]};"></span>' if s else '')
                     + f'</span>{mono(p,T["tp"] if s else T["ts"],11.5)}</div>'
                     for p,d,s in (("Areas/Finance",0,False),("Vendors",1,True),("Payroll",1,False)))
        body+=f'<div style="margin-top: 10px; background: {T["sunken"]}; border-radius: 9px; padding: 6px;">{tree}</div>'
        acts=(f'<div style="display: flex; align-items: center; gap: 7px; margin-top: 12px;">'
              f'{btn(T,"Approve Vendors","affirm",I["check"])}{btn(T,"Cancel","ghost")}'
              f'<span style="flex-grow: 1;"></span>{helplink(T)}</div>')
        return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
                f'padding: 14px 15px; box-sizing: border-box;">{body}{acts}</div>')
    op = open_ or ()
    body+=acts
    body+=(f'<div style="margin-top: 8px; border-top: 1px solid {T["border"]}; padding-top: 2px;">'
           + disclose(T,"Why it&rsquo;s asking",why,open_="why" in op)
           + disclose(T,"Before and after",ba,open_="ba" in op)
           + (disclose(T,"Declined before",f'<div style="font-size: 12px; color: {T["ts"]};">On the 18th, request #311.</div>',
                       open_="prior" in op) if state=="escalated" else "")
           + '</div>')
    return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 14px 15px; box-sizing: border-box;">{body}</div>')

# ---------- the meeting, as one grouped card ---------------------------------
def todoline(T,text,*,state=None,last=False):
    mark={"ok":(I["check"],T["ok"],"Accepted"),"answered":(I["clock"],T["ts"],"Answered on your phone")}.get(state)
    ctl=(f'<span style="display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: {mark[1]};">'
         f'{ic(mark[0],12,2.2)}{mark[2]}</span>' if mark else
         f'<span style="display: inline-flex; gap: 2px;">'
         + "".join(f'<span style="display: flex; padding: 3px; border-radius: 6px; color: {c};">{ic(g,14,2)}</span>'
                   for g,c in ((I["check"],T["ts"]),(I["pencil"],T["ts"]),(I["x"],T["ts"]))) + '</span>')
    return (f'<div style="display: flex; align-items: center; gap: 9px; padding: 6px 0; {bd_(T,last)}">'
            f'<span style="display: flex; color: {T["ag"]};">{ic(I["todo"],13,1.9)}</span>'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{text}</span>{ctl}</div>')

TODOS=["Send Kessler the revised volume numbers","Check whether net-45 applies to the Q4 order",
       "Put the March renewal decision on Friday&rsquo;s agenda","Ask Orlin for their updated terms"]

def meetingcard(T,*,expanded=True,result=False,width=None):
    w=f"width: {width}px;" if width else ""
    head=reqhead(T,I["mic"],"MEETING","metis","12m")
    title=(f'<div style="font-size: 14.5px; font-weight: 600; color: {T["tp"]}; margin-top: 9px;">Vendor review</div>'
           f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 2px;">Notes and 4 to-dos &middot; 42 min</div>')
    if not expanded:
        return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
                f'padding: 14px 15px; box-sizing: border-box;">{head}{title}'
                f'<div style="display: flex; gap: 7px; margin-top: 12px;">{btn(T,"Accept All","affirm",I["check"])}'
                f'{btn(T,"Open","secondary")}</div></div>')
    # C69: outside a transcript agent text takes the wash, not the rule
    note=(f'<div style="background: {T["agq"]}; border-radius: 8px; padding: 9px 11px; font-family: {SERIF}; font-size: 12.5px; '
          f'color: {T["tp"]}; line-height: 1.55;">Kessler confirmed net-45 and dropped the volume tier. The March '
          f'renewal is no longer the cheapest option; Orlin may undercut it.</div>'
          f'<div style="display: flex; align-items: center; gap: 7px; row-gap: 6px; flex-wrap: wrap; margin-top: 9px;">'
          + (f'<span style="display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: {T["ok"]};">'
             f'{ic(I["check"],12,2.2)}Approved</span>' if result else
             f'{btn(T,"Approve","affirm",I["check"])}{btn(T,"Revise","secondary",I["pencil"])}')
          + f'<span style="flex-grow: 1;"></span>{mono(F["meeting_note"],T["ts"],10.5)}</div>')
    states=(["ok","ok","answered","ok"] if result else [None]*4)
    todos="".join(todoline(T,t,state=s,last=i==3) for i,(t,s) in enumerate(zip(TODOS,states)))
    yours=(f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.6;">'
           f'<b style="color: {T["tp"]};">2 notes, 1 to-do</b> &mdash; already saved, and included in the notes.</div>')
    band=(f'<div style="background: {T["sunken"]}; border-radius: 9px; padding: 9px 11px; margin-bottom: 10px; '
          f'display: flex; align-items: center; gap: 9px;">'
          f'<span style="display: flex; color: {T["ok"]};">{ic(I["check"],14,2.2)}</span>'
          f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;"><b>4 of 5 accepted.</b> One was already '
          f'answered on your phone.</span></div>') if result else ""
    lbl=lambda t,extra="":(f'<div style="display: flex; align-items: center; gap: 8px; margin: 12px 0 6px;">'
                           f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{t}</span>'
                           f'<span style="flex-grow: 1;"></span>{extra}</div>')
    foot=("" if result else
          f'<div style="display: flex; gap: 7px; row-gap: 9px; flex-wrap: wrap; margin-top: 13px; padding-top: 12px; border-top: 1px solid {T["border"]};">'
          f'{btn(T,"Accept All","affirm",I["check"])}{btn(T,"Revise","secondary",I["pencil"])}'
          f'{btn(T,"Decline All","secondary",I["x"])}'
          f'<span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]}; align-self: center;">Open the Session &rarr;</span></div>')
    return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 14px 15px; box-sizing: border-box;">{head}{title}'
            f'<div style="margin-top: 12px;">{band}</div>'
            + lbl("NOTES") + note
            + lbl("TO-DOS &middot; 4") + sunk(T,todos)
            + lbl("YOURS") + yours
            + disclose(T,"Transcript",'',meta="42 min &middot; kept 30 days")
            + foot + '</div>')

# ---------- the panel, seven types --------------------------------------------
def panel3(T,w=400):
    chips=[("All",True),("Meetings",False),("Access",False),("Actions",False),("Notes",False)]
    head=(f'<div style="padding: 14px 16px; border-bottom: 1px solid {T["border"]};">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">4 waiting</span></div>'
          f'<div style="display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap;">'
          + "".join(f'<span style="padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; '
                    f'background: {T["accq"] if s else "transparent"}; color: {T["acc"] if s else T["ts"]}; '
                    f'border: 1px solid {"transparent" if s else T["bc"]};">{t}</span>' for t,s in chips)
          + '</div></div>')
    action=(f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 14px 15px;">{reqhead(T,I["work"],"ACTION","drey-dev","40m")}'
            f'<div style="font-size: 14.5px; font-weight: 600; color: {T["tp"]}; margin-top: 9px;">Comment on #418</div>'
            f'<div style="background: {T["agq"]}; border-radius: 8px; padding: 8px 10px; margin-top: 8px; font-family: {SERIF}; '
            f'font-size: 12.5px; color: {T["tp"]}; line-height: 1.5;">Invoices 0612 and 0804 are at net-45; the comparison '
            f'uses net-45 for those two only.</div>'
            f'<div style="display: flex; gap: 7px; margin-top: 12px;">{btn(T,"Approve","affirm",I["check"])}'
            f'{btn(T,"Revise","secondary",I["pencil"])}{btn(T,"Decline","secondary",I["x"])}</div></div>')
    body=(f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
          + grouplabel(T,"MEETINGS","1") + meetingcard(T,expanded=False)
          + grouplabel(T,"ACCESS","1") + accesscard2(T)
          + grouplabel(T,"ACTIONS","1") + action + '</div>')
    foot=(f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]};">'
          f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Open Needs You &rarr;</span></div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; display: flex; flex-direction: column; '
            f'flex-shrink: 0;">{head}{body}{foot}</div>')


# ============ PROJECTS — Work ▸ Projects (2026-09-22) =================
# Screen 13. Projects appear on first use (0011), so there is no New Project.
# The state that matters most is review mode, and why. Owner's ruling (D13):
# a project holds permissions, and every member inherits them by default.

def modechip(T,mode,why=None):
    if mode=="autonomous":
        return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; '
                f'border-radius: 999px; border: 1px solid {T["bc"]}; font-size: 11px; color: {T["ts"]};">Autonomous</span>')
    if why=="budget":
        return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; '
                f'border-radius: 999px; background: {T["degq"]}; font-size: 11px; font-weight: 600; color: {T["deg"]};">'
                f'{ic(I["warn"],11,2.2)}Review &middot; over budget</span>')
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; '
            f'border-radius: 999px; border: 1.5px solid {T["tp"]}; font-size: 11px; font-weight: 600; '
            f'color: {T["tp"]};">{ic(I["review"],11,2.2)}Review</span>')

def agentchip(T,name,remote=False):
    return (f'<span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 7px; '
            f'background: {T["agq"]}; font-family: {MONO}; font-size: 11px; color: {T["ag"]};">'
            + (f'<span style="display: flex; color: {T["ag"]};">{ic(I["relay"],10,2)}</span>' if remote else '')
            + f'{name}</span>')

def spendbar(T,spent,budget,over=False):
    frac=min(1.0,spent/budget) if budget else 0
    return (f'<div style="display: flex; align-items: center; gap: 8px;">'
            f'<span style="width: 70px; height: 5px; border-radius: 3px; background: {T["sunken"]}; position: relative; '
            f'overflow: hidden;"><span style="position: absolute; left: 0; top: 0; bottom: 0; width: {int(frac*100)}%; '
            f'background: {T["deg"] if over else T["ts"]}; border-radius: 3px;"></span></span>'
            f'<span style="font-family: {MONO}; font-size: 11px; color: {T["deg"] if over else T["ts"]};">'
            f'${spent:.2f} / ${budget:.0f}</span></div>')

PROJECTS=[
  dict(id="drey",title="Drey",mode="autonomous",why=None,members=[("drey-dev",False),("collator",False),("devin",True)],
       open=14,blocked=2,spent=0.72,budget=5,last="4m"),
  dict(id="metistry",title="Metistry",mode="review",why="owner",members=[("builder",False),("reviewer",False)],
       open=22,blocked=0,spent=0.18,budget=4,last="18m"),
  dict(id="fsl-ops",title="FSL ops",mode="review",why="budget",members=[("taskuary",True),("collator",False)],
       open=6,blocked=1,spent=0.58,budget=0.5,last="1h"),
  dict(id="home",title="Home",mode="autonomous",why=None,members=[("collator",False)],
       open=3,blocked=0,spent=0.04,budget=1,last="2d"),
]

def projrow(T,p,*,last=False):
    blocked=(f'<span style="color: {T["deg"]}; font-weight: 600;">{p["blocked"]} blocked</span>'
             if p["blocked"] else f'<span style="color: {T["tt"]};">none blocked</span>')
    return (f'<div style="display: grid; grid-template-columns: 170px 170px minmax(0,1fr) 150px 150px 50px; '
            f'gap: 14px; align-items: center; padding: 11px 16px; {bd_(T,last)}">'
            f'<div><div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{p["title"]}</div>'
            f'<div style="margin-top: 2px;">{mono(p["id"],T["ts"],10.5)}</div></div>'
            f'<div>{modechip(T,p["mode"],p["why"])}</div>'
            f'<div style="display: flex; gap: 5px; flex-wrap: wrap;">'
            + "".join(agentchip(T,n,r) for n,r in p["members"]) + '</div>'
            f'<div style="font-size: 12px; color: {T["tp"]};">{p["open"]} open &middot; {blocked}</div>'
            f'{spendbar(T,p["spent"],p["budget"],over=p["why"]=="budget")}'
            f'<div style="font-size: 11.5px; color: {T["tt"]}; text-align: right;">{p["last"]}</div></div>')

def projlist(T):
    head=(f'<div style="display: grid; grid-template-columns: 170px 170px minmax(0,1fr) 150px 150px 50px; gap: 14px; '
          f'padding: 7px 16px; background: {T["sunken"]}; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; '
          f'color: {T["tt"]};"><span>PROJECT</span><span>MODE</span><span>AGENTS</span><span>WORK</span>'
          f'<span>SPEND TODAY</span><span style="text-align: right;">LAST</span></div>')
    rows="".join(projrow(T,p,last=i==len(PROJECTS)-1) for i,p in enumerate(PROJECTS))
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Projects</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">4 projects</span></div>'
            f'<div style="margin: 0 16px 16px; border: 1px solid {T["border"]}; border-radius: 11px; overflow: hidden;">'
            f'{head}{rows}</div></div>')

def workwin(T,inner):
    return (f'<div style="flex-grow: 1; min-width: 0; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'overflow: hidden; background: {T["bg"]};">{toolbar(T)}'
            f'<div style="display: flex; align-items: stretch;">{sidebar8(T,"Work")}{inner}</div></div>')

# ---------- project detail ----------------------------------------------------
def stat(T,n,label,tone=None):
    return (f'<div><div style="font-size: 20px; font-weight: 600; color: {tone or T["tp"]};">{n}</div>'
            f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 1px;">{label}</div></div>')

def memberrow(T,name,kind,extra,*,remote=False,last=False):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 8px 0; {bd_(T,last)}">'
            f'{presdot(T,"working" if not remote else "idle")}{agentchip(T,name,remote)}'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{kind}</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">{extra}</span></div>')

def projpermissions(T):
    rows=(resrow(T,res="Knowledge",read=[("Areas/Fsl",True,False,None),("Journal",True,False,None)],
                 write=[("Areas/Fsl/drey/",True,False,None)])
          + resrow(T,res="Work",read=[("This project",False,False,None)],
                   write=[("Update",False,False,None),("Comment",False,False,None),("Dispatch",False,True,None)])
          + resrow(T,res="Jira",read=[("DREY",False,False,None)],write=[("Comment",False,True,None)],proxied=True,last=True))
    return (f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">PERMISSIONS</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">every member gets these</span>'
            f'<span style="flex-grow: 1;"></span>{btn(T,"Edit","secondary",I["pencil"])}</div>'
            + sunk(T,rows))

def projdetail(T,*,why=None):
    mode="autonomous" if why is None else "review"
    trip=(f'<div style="margin-top: 11px; background: {T["degq"]}; border-radius: 9px; padding: 9px 12px; display: flex; '
          f'align-items: center; gap: 9px;"><span style="display: flex; color: {T["deg"]};">{ic(I["warn"],14,2)}</span>'
          f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">Went over its <b>$3</b> budget at 2:40 PM. '
          f'Handoffs between agents now come to you.</span>'
          f'{btn(T,"Raise Budget","secondary")}</div>') if why=="budget" else ""
    toggle_lbl="Review mode"
    head=(f'<div style="padding: 14px 18px 13px; border-bottom: 1px solid {T["border"]};">'
          f'{crumb(T,["Work","Projects","Drey" if why is None else "FSL ops"])}'
          f'<div style="display: flex; align-items: center; gap: 11px; margin-top: 8px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">{"Drey" if why is None else "FSL ops"}</span>'
          f'{modechip(T,mode,why)}<span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">{toggle_lbl}</span>{toggle(T,mode=="review")}</div>'
          f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 6px;">'
          + ("$5 a day &middot; 20 handoffs at once" if why is None else
             "review since 2:40 PM (over budget) &middot; $0.50 a day &middot; 20 handoffs at once")
          + f'</div>{trip}</div>')
    stats=(f'<div style="display: flex; gap: 34px; padding: 16px 18px; border-bottom: 1px solid {T["border"]};">'
           + stat(T,"14","open tasks") + stat(T,"2","blocked",T["deg"]) + stat(T,"3","handoffs in flight")
           + stat(T,"1","queued") + stat(T,"4","open threads") + stat(T,"$0.72","spent today") + '</div>')
    members=(f'<div><div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">'
             f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">AGENTS &middot; 3</span>'
             f'<span style="flex-grow: 1;"></span>{btn(T,"Add Agent","secondary",I["plus"])}</div>'
             + sunk(T,memberrow(T,"drey-dev","local","+ Areas/Finance")
                    + memberrow(T,"collator","local","project access only")
                    + memberrow(T,"devin","connected","project access only",remote=True,last=True))
             + '</div>')
    runs=(f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
          f'margin-bottom: 8px;">RECENT RUNS</div>'
          + sunk(T,"".join(f'<div style="display: flex; align-items: center; gap: 10px; padding: 7px 0; {bd_(T,i==2)}">'
                           f'{agentchip(T,a)}<span style="font-size: 12px; color: {T["tp"]}; flex-grow: 1;">{d}</span>'
                           f'<span style="font-family: {MONO}; font-size: 11px; color: {T["ts"]};">{c}</span>'
                           f'<span style="font-size: 11px; color: {T["tt"]}; width: 30px; text-align: right;">{w}</span></div>'
                           for i,(a,d,c,w) in enumerate([("drey-dev","Fixed the sync retry, opened PR #212","41&cent;","4m"),
                                                         ("collator","Summarised the vendor thread","6&cent;","1h"),
                                                         ("devin","Reviewed PR #209","22&cent;","3h")])))
          + '</div>')
    body=(f'<div style="display: grid; grid-template-columns: minmax(0,1.15fr) minmax(0,1fr); gap: 22px; '
          f'padding: 16px 18px 18px;"><div style="display: flex; flex-direction: column; gap: 18px;">'
          f'{projpermissions(T)}{members}</div><div>{runs}</div></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">{head}{stats}{body}</div>')

def modeconfirm(T,*,to="autonomous",w=440):
    if to=="autonomous":
        title="Switch Drey back to autonomous?"
        text="Its agents will hand work to each other without you again."
        go=btn(T,"Switch to Autonomous","affirm")
    else:
        title="Put Drey in review?"
        text="3 handoffs in flight will wait for you."
        go=btn(T,"Put in Review","affirm")
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 13px; '
            f'box-shadow: 0 14px 40px rgba(0,0,0,0.22); padding: 18px 18px 15px;">'
            f'<div style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">{title}</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 6px; line-height: 1.5;">{text}</div>'
            f'<div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;">'
            f'{btn(T,"Cancel","ghost")}{go}</div></div>')

def addagent(T,w=440):
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 13px; '
            f'box-shadow: 0 14px 40px rgba(0,0,0,0.22); padding: 18px 18px 15px;">'
            f'<div style="font-size: 14.5px; font-weight: 600; color: {T["tp"]};">Add reviewer to Drey?</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 6px; line-height: 1.5;">'
            f'It gets Drey&rsquo;s access: reads <b>Areas/Fsl</b> and <b>Journal</b>, writes <b>Areas/Fsl/drey/</b>, '
            f'and comments in Jira <b>DREY</b>.</div>'
            f'<div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;">'
            f'{btn(T,"Cancel","ghost")}{btn(T,"Add","affirm",I["plus"])}</div></div>')


# ============ CARD DETAIL — one popover for both kinds of task (2026-09-22) =====
# Screen 14. Every card click opens this; a thread is a section inside it (ruled
# 2026-09-22). A markdown task and a work row share the layout and differ in
# their verbs, as on Today. Work rows gain a short description (ruled, C85).

def dsec(T,label,inner,*,meta=None,first=False):
    return (f'<div style="padding: 12px 16px; {"" if first else "border-top: 1px solid "+T["border"]+";"}">'
            f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 7px;">'
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{label}</span>'
            + (f'<span style="flex-grow: 1;"></span><span style="font-size: 11px; color: {T["ts"]};">{meta}</span>' if meta else '')
            + f'</div>{inner}</div>')

def histrow2(T,when,who,what,*,agent=True,last=False):
    return (f'<div style="display: grid; grid-template-columns: 52px 86px minmax(0,1fr); gap: 9px; padding: 5px 0; '
            f'align-items: baseline; {bd_(T,last)}">'
            f'<span style="font-family: {MONO}; font-size: 10.5px; color: {T["tt"]};">{when}</span>'
            f'{mono(who,T["ag"] if agent else T["tp"],11)}'
            f'<span style="font-size: 12px; color: {T["ts"]}; line-height: 1.45;">{what}</span></div>')

def detailpop(T,*,kind="work",w=460):
    close=f'<span style="display: flex; color: {T["tt"]};">{ic(I["x"],14,2)}</span>'
    if kind=="work":
        lead=f'<span style="display: flex; color: {T["ag"]}; margin-top: 2px;">{ic(I["board"],16,1.9)}</span>'
        title="Reconcile vendor invoices against the March renewal"
        bits=facets(T,p=1,d="Fri",e="45m",people=("Kessler",),
                    links=[("project","drey",I["board"])],states=[("blocked","deg",I["warn"])])
    else:
        lead=f'<span style="display: flex; margin-top: 2px;">{box(T,False)}</span>'
        title="Send Kessler the revised volume numbers"
        bits=facets(T,d="Thu",e="15m",people=("Kessler",))
    head=(f'<div style="padding: 14px 16px 12px;">'
          f'<div style="display: flex; align-items: flex-start; gap: 10px;">{lead}'
          f'<div style="flex-grow: 1; font-size: 15px; font-weight: 600; color: {T["tp"]}; line-height: 1.35;">{title}</div>'
          f'{close}</div>'
          f'<div style="display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin: 9px 0 0 26px;">'
          + "".join(bits) + '</div></div>')
    if kind=="work":
        desc=dsec(T,"DESCRIPTION",
                  f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.55;">Match each Kessler invoice since '
                  f'June to the renewal terms and flag anything billed at the old volume tier.</div>',first=True)
        held=dsec(T,"HELD BY",
                  f'<div style="display: flex; align-items: center; gap: 9px;">{presdot(T,"working")}'
                  f'{agentchip(T,"drey-dev")}<span style="font-size: 12px; color: {T["ts"]};">lease 38 min left</span>'
                  f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; color: {T["ts"]};">Assigned</span></div>')
        blocked=dsec(T,"BLOCKED BY",
                     f'<div style="display: flex; align-items: center; gap: 9px;">'
                     f'<span style="display: flex; color: {T["ag"]};">{ic(I["board"],13,1.9)}</span>'
                     f'<span style="font-size: 12.5px; color: {T["acc"]}; font-weight: 600;">#417 Vendor terms from Kessler</span>'
                     f'<span style="flex-grow: 1;"></span><span style="font-size: 11.5px; color: {T["ts"]};">open</span></div>')
        thread=dsec(T,"THREAD",
                    f'<div style="font-size: 12px; color: {T["ts"]}; line-height: 1.5;">'
                    f'{mono("collator",T["ag"],11)} &ldquo;Two invoices are already at net-45.&rdquo;</div>'
                    f'<div style="font-size: 11.5px; color: {T["acc"]}; font-weight: 600; margin-top: 6px;">Open room &rarr;</div>',
                    meta="4 comments")
        hist=dsec(T,"HISTORY",
                  histrow2(T,"2:41 PM","drey-dev","claimed it")
                  + histrow2(T,"2:10","drey-dev","blocked on #417 &mdash; waiting on terms")
                  + histrow2(T,"11:58 AM","you","set priority 1, due Friday",agent=False)
                  + histrow2(T,"11:30","metis","created from the Vendor review meeting",last=True))
        acts=(f'<div style="padding: 11px 16px 13px; border-top: 1px solid {T["border"]}; display: flex; gap: 7px;">'
              f'{btn(T,"Comment","secondary",I["chat"])}{btn(T,"Open on Board","ghost",I["board"])}'
              f'<span style="flex-grow: 1;"></span>'
              f'<span style="font-size: 11.5px; color: {T["ts"]}; align-self: center;">from vendor-summary v3</span></div>')
        body=desc+held+blocked+thread+hist+acts
    else:
        ctx=(f'<div style="background: {T["sunken"]}; border-radius: 9px; padding: 9px 11px; font-family: {MONO}; '
             f'font-size: 11.5px; line-height: 1.7; color: {T["ts"]};">'
             f'<div>## Vendor review</div>'
             f'<div>- Kessler confirmed net-45</div>'
             f'<div style="color: {T["tp"]}; background: {T["accq"]}; margin: 0 -11px; padding: 0 11px;">'
             f'- [ ] Send Kessler the revised volume numbers &#128197; 2026-09-24</div>'
             f'<div>- [ ] Ask Orlin for their updated terms</div></div>')
        body=(dsec(T,"IN THE MEETING NOTE",ctx,meta=mono(F["meeting_note"],T["ts"],10.5),first=True)
              + dsec(T,"HISTORY",histrow2(T,"1:51 PM",ASSISTANT_NAME.lower(),"added when you approved the Vendor review notes")
                     + histrow2(T,"2:05 PM","you","set due Thursday",agent=False,last=True))
              + f'<div style="padding: 11px 16px 13px; border-top: 1px solid {T["border"]}; display: flex; gap: 7px;">'
              f'{btn(T,"Complete","affirm",I["check"])}{btn(T,"Open in Obsidian","secondary",I["note"])}'
              f'{btn(T,"Delegate","ghost",I["spark"])}</div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 13px; '
            f'box-shadow: 0 14px 40px rgba(26,24,21,0.20); overflow: hidden; flex-shrink: 0;">{head}'
            f'<div style="border-top: 1px solid {T["border"]};">{body}</div></div>')

def anchorcard(T,*,kind="work",title="Reconcile vendor invoices against the March renewal",w=270):
    lead=(f'<span style="display: flex; color: {T["ag"]};">{ic(I["board"],14,1.9)}</span>' if kind=="work"
          else f'<span style="display: flex;">{box(T,False)}</span>')
    return (f'<div style="width: {w}px; background: {T["surface"]}; border: 1.5px solid {T["acc"]}; border-radius: 10px; '
            f'padding: 10px 12px; box-shadow: 0 0 0 3px {T["accq"]};">'
            f'<div style="display: flex; gap: 8px; align-items: flex-start;">{lead}'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.4;">{title}</span></div></div>')


# ============ SETTINGS, THE WINDOW — screen 15 (2026-09-22) =============
def panehead(T,title,action=""):
    return (f'<div style="display: flex; align-items: center; gap: 10px; padding: 16px 18px 6px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">{title}</span>{action}</div>')

def accountpane(T):
    signed=(f'<span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: {T["ts"]};">'
            f'<span style="width: 7px; height: 7px; border-radius: 50%; background: {T["ok"]};"></span>Signed in</span>')
    return (panehead(T,"Account")
            + f'<div style="padding: 0 18px 18px; display: flex; flex-direction: column; gap: 14px;">'
            + block(T,"CONSOLE SIGN-IN",sunk(T,setrow(T,label="This Mac",note="Owner",control=signed)
                                              + setrow(T,label="Sign Out Everywhere",control=btn(T,"Sign Out","dest"),last=True)))
            + block(T,"INSTANCE REPOSITORY",sunk(T,kv(T,"Status","clean &mdash; nothing waiting to sync")
                                                  + kv(T,"Last synced","4 minutes ago")
                                                  + kv(T,"Remote","github.com/mattcolf/metistry-home",mono_=True,last=True)))
            + '</div>')


# ============ ARTIFACTS AND ROOMS — screen 16 (2026-09-23) =============
# An artifact is a folder in git; every version is one commit. Comments sit on an
# exact version, pinned to a file and a line range, and are drawn in the margin
# beside those lines (ruled 2026-09-23). A room cannot address anyone; ten agent
# turns in a row is the cap; only the owner resolves.

def whochip(T,name):
    if name=="you":
        return (f'<span style="font-size: 11.5px; font-weight: 600; color: {T["tp"]};">you</span>')
    return agentchip(T,name)

ARTS=[("vendor-summary","Vendor terms, this quarter","drey","markdown","v3","collator","2h",2),
      ("march-renewal-model","March renewal model","drey","csv","v5","you","yesterday",0),
      ("sync-retry-design","Sync retry design","drey","markdown","v2","drey-dev","3d",1),
      ("brand-round-a","Brand round A","metistry","html","v14","you","last week",0)]

def artlist(T):
    cols="minmax(0,1.6fr) 96px 82px 118px 92px 70px"
    head=(f'<div style="display: grid; grid-template-columns: {cols}; gap: 12px; padding: 7px 16px; '
          f'background: {T["sunken"]}; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span>ARTIFACT</span><span>PROJECT</span><span>KIND</span><span>LATEST</span><span>THREADS</span>'
          f'<span style="text-align: right;">UPDATED</span></div>')
    rows=""
    for i,(slug,title,proj,kind,ver,who,when,th) in enumerate(ARTS):
        rows+=(f'<div style="display: grid; grid-template-columns: {cols}; gap: 12px; align-items: center; '
               f'padding: 10px 16px; {bd_(T,i==len(ARTS)-1)}">'
               f'<div><div style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{title}</div>'
               f'<div style="margin-top: 2px;">{mono(slug,T["ts"],10.5)}</div></div>'
               f'{mono(proj,T["ts"],11)}<span style="font-size: 12px; color: {T["ts"]};">{kind}</span>'
               f'<span style="display: inline-flex; align-items: center; gap: 7px;">{mono(ver,T["tp"],11.5)}{whochip(T,who)}</span>'
               + (f'<span style="font-size: 12px; font-weight: 600; color: {T["tp"]};">{th} open</span>' if th
                  else f'<span style="font-size: 12px; color: {T["tt"]};">none</span>')
               + f'<span style="font-size: 11.5px; color: {T["tt"]}; text-align: right;">{when}</span></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Artifacts</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">4 in 2 projects</span></div>'
            f'<div style="margin: 0 16px 16px; border: 1px solid {T["border"]}; border-radius: 11px; overflow: hidden;">'
            f'{head}{rows}</div></div>')

def verrail(T,*,sel="v3"):
    vs=[("v3","collator","Added Orlin&rsquo;s terms","2h"),("v2","you","Tightened the summary","yesterday"),
        ("v1","collator","First draft from 3 captures","2d")]
    out=""
    for v,who,msg,when in vs:
        on=v==sel
        out+=(f'<div style="padding: 8px 10px; border-radius: 8px; background: {T["accq"] if on else "transparent"};">'
              f'<div style="display: flex; align-items: center; gap: 7px;">{mono(v,T["tp"],11.5)}{whochip(T,who)}'
              f'<span style="flex-grow: 1;"></span><span style="font-size: 10.5px; color: {T["tt"]};">{when}</span></div>'
              f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 3px; line-height: 1.4;">{msg}</div></div>')
    return (f'<div style="width: 190px; flex-shrink: 0; padding: 14px 8px; border-right: 1px solid {T["border"]}; '
            f'background: {T["surface"]};">'
            f'<div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; '
            f'padding: 0 10px 8px;">VERSIONS</div>{out}</div>')

DOC=[("h","Vendor terms, this quarter"),
     ("p","Three vendors changed terms this quarter. Kessler is the one that matters for March."),
     ("hl","Kessler moved to net-45 and dropped the volume tier. Two invoices since June are already at net-45."),
     ("p","Baymark is unchanged. Orlin sent updated terms on the 20th."),
     ("hl2","Orlin may undercut the renewal if the volume tier stays gone."),
     ("p","The cheapest option is no longer the March renewal, on the terms as written.")]

def docbody(T,*,marks=True):
    out=""
    for k,t in DOC:
        if k=="h":
            out+=f'<div style="font-size: 19px; font-weight: 600; color: {T["tp"]}; margin-bottom: 12px;">{t}</div>'
        else:
            hl=(k in ("hl","hl2")) and marks
            out+=(f'<p style="margin: 0 0 11px; font-size: 13.5px; color: {T["tp"]}; line-height: 1.65; '
                  + (f'background: {T["accq"]}; box-shadow: -8px 0 0 {T["accq"]}, 8px 0 0 {T["accq"]}; border-radius: 3px;' if hl else '')
                  + f'">{t}</p>')
    return out

def marginthread(T,*,who,text,replies=(),top=0,resolved=False,folded=False):
    if folded and replies:
        rep=(f'<div style="font-size: 11px; color: {T["acc"]}; font-weight: 600; margin-top: 6px;">'
             f'{len(replies)} repl{"y" if len(replies)==1 else "ies"}</div>')
        replies=()
    else:
        rep=""
    rep+="".join(f'<div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid {T["border"]};">'
                f'<div>{whochip(T,w)}</div><div style="font-size: 12px; color: {T["tp"]}; line-height: 1.5; '
                f'margin-top: 3px;">{b}</div></div>' for w,b in replies)
    return (f'<div style="position: absolute; left: 0; right: 0; top: {top}px; background: {T["surface"]}; '
            f'border: 1px solid {T["border"]}; border-radius: 10px; padding: 10px 12px; '
            f'box-shadow: 0 2px 8px rgba(0,0,0,0.05);">'
            f'<div style="display: flex; align-items: center; gap: 7px;">{whochip(T,who)}'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11px; font-weight: 600; color: {T["acc"]};">Resolve</span></div>'
            f'<div style="font-size: 12px; color: {T["tp"]}; line-height: 1.5; margin-top: 4px;">{text}</div>{rep}'
            f'<div style="font-size: 11px; color: {T["ts"]}; margin-top: 8px;">Reply&hellip;</div></div>')

def artview(T):
    head=(f'<div style="padding: 14px 18px 12px; border-bottom: 1px solid {T["border"]};">'
          f'{crumb(T,["Work","Artifacts","vendor-summary"])}'
          f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Vendor terms, this quarter</span>'
          f'{mono("v3",T["ts"],12)}<span style="font-size: 12px; color: {T["ts"]};">by</span>{whochip(T,"collator")}'
          f'<span style="flex-grow: 1;"></span>{btn(T,"Compare","secondary")}{btn(T,"Comment","ghost",I["chat"])}</div></div>')
    doc=(f'<div style="flex-grow: 1; min-width: 0; padding: 22px 26px; background: {T["bg"]};">'
         f'<div style="max-width: 560px;">{docbody(T)}</div></div>')
    margin=(f'<div style="width: 260px; flex-shrink: 0; position: relative; padding: 0 14px; background: {T["bg"]};">'
            f'<div style="position: relative; height: 100%;">'
            + marginthread(T,who="collator",text="Two invoices are already billed at net-45 &mdash; see June and August.",
                           replies=[("you","Which two? Link them.")],top=89,folded=True)
            + marginthread(T,who="drey-dev",text="Is &ldquo;may undercut&rdquo; a guess or in their letter?",top=213)
            # pushed down 35px by the thread above it: a leader keeps it tied to its line
            + f'<span style="position: absolute; left: -16px; top: 188px; width: 12px; height: 34px; '
              f'border-left: 1.5px solid {T["acc"]}; border-bottom: 1.5px solid {T["acc"]}; '
              f'border-bottom-left-radius: 6px; opacity: 0.7;"></span>'
            + '</div></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; background: {T["bg"]};">'
            f'{head}<div style="display: flex; align-items: stretch; min-height: 440px;">{verrail(T)}{doc}{margin}</div></div>')

def artcompare(T):
    lines=[(" ","Three vendors changed terms this quarter."),
           ("-","Kessler moved to net-45 and dropped the volume tier."),
           ("+","Kessler moved to net-45 and dropped the volume tier. Two invoices since June are already at net-45."),
           (" ","Baymark is unchanged."),
           ("+","Orlin sent updated terms on the 20th."),
           ("+","Orlin may undercut the renewal if the volume tier stays gone.")]
    note=(f'<div style="display: flex; align-items: center; gap: 8px; background: {T["sunken"]}; border-radius: 9px; '
          f'padding: 9px 12px; margin-top: 12px;"><span style="display: flex; color: {T["ts"]};">{ic(I["chat"],13,1.9)}</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">1 thread on <b style="color: {T["tp"]};">v2</b> is about a line '
          f'v3 changed. It stays on v2.</span><span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Open on v2 &rarr;</span></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">'
            f'<div style="padding: 14px 18px 12px; border-bottom: 1px solid {T["border"]}; display: flex; align-items: center; gap: 10px;">'
            f'{crumb(T,["Work","Artifacts","vendor-summary","Compare"])}<span style="flex-grow: 1;"></span>'
            f'{mono("v2",T["ts"],12)}<span style="color: {T["tt"]};">&rarr;</span>{mono("v3",T["tp"],12)}</div>'
            f'<div style="padding: 16px 18px 18px;">{diff(T,summary="3 lines added, 1 changed",lines=lines,open_=True)}{note}</div></div>')

# ---------- rooms ------------------------------------------------------------
def tailmeter(T,n,cap=10):
    pips="".join(f'<span style="width: 6px; height: 6px; border-radius: 50%; '
                 f'background: {T["tp"] if i<n else "transparent"}; border: 1px solid {T["ts"] if i>=n else T["tp"]};"></span>'
                 for i in range(cap))
    return f'<span style="display: inline-flex; gap: 3px; align-items: center;">{pips}</span>'

ROOMS=[("work","#418 Reconcile vendor invoices",["drey-dev","collator"],14,10,True,
        "Ten agent turns went by without you. The next one was not stored."),
       ("art","vendor-summary v3 &middot; line 3",["collator","you"],3,0,False,None),
       ("work","#212 Sync retry",["drey-dev","devin"],9,7,False,None),
       ("art","sync-retry-design v2",["drey-dev"],1,1,False,None)]

def roomslist(T):
    rows=""
    for i,(anc,title,who,n,tail,esc,why) in enumerate(ROOMS):
        g=I["board"] if anc=="work" else I["note"]
        rows+=(f'<div style="padding: 11px 16px; {bd_(T,i==len(ROOMS)-1)}">'
               f'<div style="display: grid; grid-template-columns: 18px minmax(0,1fr) 170px 60px 120px; gap: 12px; align-items: center;">'
               f'<span style="display: flex; color: {T["ts"]};">{ic(g,14,1.9)}</span>'
               f'<span style="font-size: 13px; font-weight: {700 if esc else 500}; color: {T["tp"]};">{title}</span>'
               f'<span style="display: flex; gap: 5px; flex-wrap: wrap;">' + "".join(whochip(T,w) for w in who) + '</span>'
               f'<span style="font-size: 11.5px; color: {T["ts"]};">{n} msgs</span>'
               f'<span style="display: inline-flex; align-items: center; gap: 7px;">{tailmeter(T,tail)}</span></div>'
               + (f'<div style="margin: 6px 0 0 30px; font-size: 12px; color: {T["tp"]}; display: flex; gap: 7px; align-items: center;">'
                  f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"],12,2)}</span>'
                  f'<b>Came to you.</b> <span style="color: {T["ts"]};">{why}</span></div>' if esc else '')
               + '</div>')
    head=(f'<div style="display: grid; grid-template-columns: 18px minmax(0,1fr) 170px 60px 120px; gap: 12px; '
          f'padding: 7px 16px; background: {T["sunken"]}; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
          f'<span></span><span>ROOM</span><span>WHO HAS SPOKEN</span><span></span><span>AGENT TURNS IN A ROW</span></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">Rooms</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">4 open</span></div>'
            f'<div style="margin: 0 16px 16px; border: 1px solid {T["border"]}; border-radius: 11px; overflow: hidden;">'
            f'{head}{rows}</div></div>')

def roommsg(T,who,text,when):
    if who=="you":
        return (f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ts"]}; '
                f'margin-bottom: 4px;">YOU <span style="font-weight: 400; color: {T["tt"]};">{when}</span></div>'
                f'<div style="background: {T["accq"]}; border-radius: 10px; padding: 9px 12px; font-size: 12.5px; '
                f'color: {T["tp"]}; line-height: 1.5;">{text}</div></div>')
    return (f'<div style="border-left: 2px solid {T["ag"]}; padding-left: 12px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 4px;">{agentchip(T,who)}'
            f'<span style="font-size: 10.5px; color: {T["tt"]};">{when}</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.55;">{text}</div></div>')

def roomview(T):
    head=(f'<div style="padding: 14px 18px 12px; border-bottom: 1px solid {T["border"]};">'
          f'{crumb(T,["Work","Board","#418","Room"])}'
          f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">'
          f'<span style="display: flex; color: {T["ag"]};">{ic(I["board"],16,1.9)}</span>'
          f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">#418 Reconcile vendor invoices</span>'
          f'<span style="flex-grow: 1;"></span>{btn(T,"Resolve","secondary",I["check"])}</div></div>')
    band=(f'<div style="margin: 14px 18px 0; background: {T["sunken"]}; border-radius: 9px; padding: 10px 12px; '
          f'display: flex; align-items: center; gap: 9px;">'
          f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"],14,2)}</span>'
          f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;"><b>Came to you.</b> Ten agent turns went by '
          f'without you; the next one was not stored.</span></div>')
    msgs=(roommsg(T,"collator","Invoices 0612 and 0804 are at net-45. The rest are on the old terms.","2:02 PM")
          + roommsg(T,"drey-dev","Then the renewal comparison should use net-45 for those two only.","2:05 PM")
          + roommsg(T,"collator","Agreed, but the volume tier question is still open.","2:07 PM")
          + f'<div style="font-size: 11.5px; color: {T["tt"]}; text-align: center;">7 more agent turns</div>'
          + roommsg(T,"drey-dev","Still waiting on whether the tier is gone for Q4 too.","2:31 PM"))
    comp=(f'<div style="margin: 0 18px 16px; border-top: 1px solid {T["border"]}; padding-top: 12px;">'
          f'<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">'
          f'{tailmeter(T,10)}<span style="font-size: 11.5px; color: {T["ts"]};">10 of 10 agent turns &middot; '
          f'yours resets it</span></div>'
          f'<div style="display: flex; align-items: center; gap: 8px; background: {T["surface"]}; border: 1px solid {T["bc"]}; '
          f'border-radius: 10px; padding: 9px 11px;">'
          f'<span style="flex-grow: 1; font-size: 12.5px; color: {T["tt"]};">Add to the Room&hellip;</span>'
          f'<span style="display: flex; color: {T["ts"]};">{ic(I["send"],14,1.9)}</span></div></div>')
    return (f'<div style="flex-grow: 1; min-width: 0; background: {T["bg"]};">{head}{band}'
            f'<div style="padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; max-width: 640px;">{msgs}</div>'
            f'{comp}</div>')


# ============ USAGE — the gauge's popover (2026-09-23) =================
# Usage left the sidebar in round B (brand-kit.md): a gauge beside the bell,
# top-right, no badge. This is the popover it opens. One series, magnitude, so one
# hue off the sequential ramp and no legend (dataviz: single series, title names it).
I["gaugehi"]='<path d="M4 17a8 8 0 0116 0"/><path d="M12 17l5.4-2.2"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>'
USAGE_L="#1e7784"   # chart-3 (named apart from CHART_L, which it once shadowed and broke the day bar), light — the ramp's light steps all sit under the 0.10 chroma floor (C87)
USAGE_D="#2ca5b8"   # chart-2, dark — passes every check

def usagebar(T): return USAGE_L if T is L else USAGE_D

def toolcrop(T,*,state="normal",w=250):
    gtone={"normal":T["ts"],"near":T["tp"],"over":T["deg"]}[state]
    g=I["gaugehi"] if state!="normal" else I["gauge"]
    ring=(f'background: {T["accq"]}; border-radius: 7px;') if state=="open" else ""
    return (f'<div style="width: {w}px; display: flex; align-items: center; gap: 14px; justify-content: flex-end; '
            f'padding: 10px 14px; background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 10px;">'
            f'<span style="display: flex; color: {T["acc"]};">{ic(I["plus"],18)}</span>'
            f'<span style="display: flex; padding: 3px; color: {gtone}; {ring}">{ic(g,18)}</span></div>')

def daybars(T,vals,*,h=64,today_idx=None):
    mx=max(vals); col=usagebar(T)
    bars="".join(f'<span title="${v:.2f}" style="flex: 1; height: {max(2,int(h*v/mx))}px; background: {col}; '
                 f'border-radius: 2px 2px 0 0;"></span>' for v in vals)
    return (f'<div style="position: relative;">'
            f'<div style="display: flex; align-items: flex-end; gap: 2px; height: {h}px; border-bottom: 1px solid {T["border"]};">{bars}</div>'
            f'<div style="display: flex; justify-content: space-between; font-size: 10.5px; color: {T["tt"]}; margin-top: 4px;">'
            f'<span>Sep 1</span><span>today</span></div></div>')

def spendrow(T,name,v,mx,*,agent=True,sub=None,last=False):
    lab=(f'<span style="justify-self: start;">{agentchip(T,name)}</span>' if agent else f'<span style="font-size: 12px; color: {T["tp"]};">{name}</span>')
    return (f'<div style="display: grid; grid-template-columns: 116px minmax(0,1fr) 52px; gap: 10px; align-items: center; '
            f'padding: 6px 0; {bd_(T,last)}">{lab}'
            f'<span style="height: 6px; border-radius: 0 3px 3px 0; background: {usagebar(T)}; width: {int(100*v/mx)}%;"></span>'
            f'<span style="font-family: {MONO}; font-size: 11.5px; color: {T["tp"]}; text-align: right;">${v:.2f}</span></div>')

DAYS=[1.1,1.4,0.9,1.6,2.2,0.4,0.3,1.8,1.5,1.9,2.4,1.2,0.5,0.4,1.7,2.1,1.6,1.3,2.8,0.6,0.5,1.9,1.84]

def usagepop(T,*,state="normal",w=400):
    spent={"normal":41.20,"near":55.10,"over":60.00}[state]
    frac=min(1,spent/60)
    fill={"normal":usagebar(T),"near":usagebar(T),"over":T["deg"]}[state]
    head=(f'<div style="padding: 14px 16px 12px; border-bottom: 1px solid {T["border"]}; display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Usage</span>'
          f'<span style="font-size: 12px; color: {T["ts"]};">September</span></div>')
    hero=(f'<div style="padding: 14px 16px 12px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;">'
          f'<span style="font-size: 26px; font-weight: 600; color: {T["tp"]}; letter-spacing: -0.01em;">${spent:.2f}</span>'
          f'<span style="font-size: 12.5px; color: {T["ts"]};">of $60 this month</span></div>'
          f'<div style="height: 6px; border-radius: 3px; background: {T["sunken"]}; margin-top: 9px; overflow: hidden;">'
          f'<div style="height: 100%; width: {int(frac*100)}%; background: {fill}; border-radius: 3px;"></div></div>'
          f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 7px;">'
          + ("$1.84 today &middot; 8 days left" if state!="over" else "stopped on the 29th &middot; 1 day left")
          + '</div>')
    if state=="over":
        hero+=(f'<div style="margin-top: 10px; background: {T["degq"]}; border-radius: 9px; padding: 9px 11px; display: flex; '
               f'align-items: center; gap: 9px;"><span style="display: flex; color: {T["deg"]};">{ic(I["warn"],14,2)}</span>'
               f'<span style="font-size: 12px; color: {T["tp"]}; flex-grow: 1;">Compute stopped at the $60 budget.</span>'
               f'{btn(T,"Raise","secondary")}</div>')
    hero+='</div>'
    lbl=lambda t,m=None:(f'<div style="display: flex; align-items: baseline; margin-bottom: 8px;">'
                         f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]};">{t}</span>'
                         + (f'<span style="flex-grow: 1;"></span><span style="font-size: 11px; color: {T["ts"]};">{m}</span>' if m else '')
                         + '</div>')
    daily=f'<div style="padding: 4px 16px 14px;">{lbl("EACH DAY",f"${max(DAYS):.2f} peak")}{daybars(T,DAYS)}</div>'
    rows=[("collator",14.10,True),("drey-dev",11.60,True),("Morning Brief",6.30,False),("Chat",5.10,False),("Other",4.10,False)]
    where=(f'<div style="padding: 12px 16px; border-top: 1px solid {T["border"]};">{lbl("WHERE IT WENT")}'
           + "".join(spendrow(T,n,v,14.10,agent=a,last=i==4) for i,(n,v,a) in enumerate(rows)) + '</div>')
    facts=(f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]}; display: flex; flex-direction: column; gap: 5px; '
           f'font-size: 12px; color: {T["ts"]};">'
           f'<div><b style="color: {T["tp"]};">71%</b> of prompt tokens came from cache</div>'
           f'<div><b style="color: {T["tp"]};">$23.40</b> AWS this month &middot; not compute</div>'
           f'<div>3 calls had no price and count as $0</div></div>')
    foot=(f'<div style="padding: 10px 16px; border-top: 1px solid {T["border"]};">'
          f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Spending limits in Settings &rarr;</span></div>')
    return (f'<div style="width: {w}px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; flex-shrink: 0;">{head}{hero}{daily}{where}{facts}{foot}</div>')
