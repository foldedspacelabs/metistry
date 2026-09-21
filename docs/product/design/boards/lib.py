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
      + card(panel_state(T,I["warn"],T["fail"],"Could not read spend","The collector answered, and the answer was an error.",
             reason="over_cap · aws-costs · run 4f21",action="Try again"),T),14)
    stale=(f'<div style="background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; padding: 18px;">'
           f'<div style="display: flex; align-items: center; gap: 10px;">'
           f'<span style="font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: {T["tt"]};">AWS SPEND · 30D</span>'
           f'{pill(T,"3d old",T["stale"],T["staleq"],I["clock"])}</div>'
           f'<div style="font-size: 30px; font-weight: 600; color: {T["tp"]}; margin-top: 10px;">$128.44</div>'
           f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 4px;">last collected 16 Sep, 04:10</div></div>')
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
    if kind=="affirm": st=f'border: 0; background: {T["aff"]}; color: {T["onaff"]};'
    elif kind=="dest": st=f'border: 0; background: {T["dest"]}; color: {T["ondest"]};'
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

def actions(T,icons=True):
    g=lambda k: (I[k] if icons else None)
    return (f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">'
            f'{btn(T,"Approve","affirm",g("check"))}{btn(T,"Decline","dest",g("x"))}'
            f'{btn(T,"Revise","secondary",g("pencil"))}'
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
    dim='opacity: .55;' if state=="deciding" else ''
    a=(f'<div style="{dim}">{actions(T,icons)}</div>') if acts else ""
    return (f'<div style="{w} background: {T["surface"]}; border: 1px solid {T["border"]}; border-radius: 12px; '
            f'padding: 16px; box-sizing: border-box;">{head_row(T,glyph,typ,agent,when)}{ttl}{prev}{a}</div>')

def bellpanel(T):
    cards=(reqcard(T,glyph=I["key"],typ="ACCESS",title='Read <span style="font-family: '+MONO+'; font-size: 13px;">Areas/Finance</span>',
             agent="drey-dev",when="12m",prev=scope_preview(T))
           + reqcard(T,glyph=I["book"],typ="NOTE",title="Keep the note on lease renewal",agent="assistant",when="1h",
             prev=note_preview(T)))
    return (f'<div style="width: 400px; background: {T["elevated"]}; border: 1px solid {T["bs"]}; border-radius: 14px; '
            f'box-shadow: 0 10px 34px rgba(26,24,21,0.16); overflow: hidden; display: flex; flex-direction: column;">'
            f'<div style="padding: 14px 16px; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: baseline; gap: 8px;">'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">Needs You</span>'
            f'<span style="font-size: 12px; color: {T["ts"]};">4 waiting · 1 snoozed</span></div>'
            f'<div style="display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap;">'
            + "".join(f'<span style="padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; '
                      f'background: {T["accq"] if s else "transparent"}; color: {T["acc"] if s else T["ts"]}; '
                      f'border: 1px solid {"transparent" if s else T["border"]};">{t}</span>'
                      for t,s in [("All",True),("Access",False),("Notes",False),("Reviews",False)])
            + '</div></div>'
            f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">{cards}</div>'
            f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]};">'
            f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Show all 12 →</span></div></div>')


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
    fg,bg,txt = ((T["deg"],T["degq"],"external") if kind=="external" else (T["ts"],T["absq"],"you"))
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
        b=reqcard(T,glyph=I["book"],typ="NOTE",title="Keep the note on lease renewal",agent="assistant",when="1h",
                  prev=note_preview(T))
        body=(f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: {T["bg"]};">'
              + grouplabel(T,"ACCESS","2") + a + grouplabel(T,"NOTES","1") + b + '</div>')
        foot=(f'<div style="padding: 11px 16px; border-top: 1px solid {T["border"]};">'
              f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]};">Show all 12 →</span></div>')
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
      (I["book"],"NOTE","Keep the note on lease renewal","assistant","1h","internal"),
      (I["book"],"NOTE","Keep the note on Q4 compute pricing","assistant","2h","internal"),
      (I["key"],"ACCESS","Enrol a new agent on the Studio","—","3h","external")]

def fulllist(T,mode="select",w=760):
    n=3 if mode!="plain" else 0
    bar=""
    if mode=="select":
        bar=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: {T["accq"]}; '
             f'border-bottom: 1px solid {T["border"]};">'
             f'<span style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">{n} selected</span>'
             f'<span style="flex-grow: 1;"></span>'
             f'{btn(T,"Later","secondary",I["later"])}{btn(T,"Skip","secondary")}{btn(T,"Decline","dest",I["x"])}'
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
             f'{btn(T,"Retry 1","secondary")}</div>')
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
          f'<span style="font-size: 12.5px; color: {T["ts"]}; flex-grow: 1;">12 waiting</span>'
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
            f'<span style="font-size: 13px; font-weight: 600; color: {T["acc"]};">Show all 12</span></div></div>')

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
        g,c,txt=(ic(I["warn"],13,2.2),T["fail"],"couldn’t reach the instance — <b>connection refused</b>")
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
          f'border: 0; background: {T["acc"]}; color: {T["onacc"]}; opacity: {0.55 if disabled else 1};">Capture</button>')
    rmode={"empty":"none","typing":"none","attaching":"none","sending":"pending",
           "captured":"done","queued":"queued","failed":"failed"}[state]
    extra=""
    if state=="failed":
        extra=(f'<div style="display: flex; gap: 8px; margin-top: 10px;">{btn(T,"Retry","secondary")}'
               f'{btn(T,"Copy the text","ghost")}</div>')
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
            + (f'<span style="display: flex; flex-shrink: 0; color: {T["tt"]}; opacity: 0.55; margin-top: 1px;">'
               f'{ic(I["grip"],15,2.6)}</span>' if drag else "")
            + f'<span style="margin-top: 1px; display: flex;">{lead}</span>'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">'
            f'<span style="font-size: 14px; color: {T["tp"]}; '
            + ("text-decoration: line-through; opacity: 0.55;" if done else "") + f'">{title}</span>'
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
            f'<span style="font-size: 11.5px; color: {T["tt"]};">09:15</span>'
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
            f'<span style="font-size: 12.5px; color: {T["ts"]};">Sunday 20 September</span>'
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
            f'{bell(T,"4",18)}'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["gauge"],18)}</span></div>')

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

def nowline(T,at="8:52"):
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
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">ASSISTANT</span>'
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
            + (btn(T,"Open notes","secondary",I["note"]) if actions_ else "") + '</div>'
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
    tint={"working":(T["ag"],T["agq"]),"waiting":(T["deg"],T["degq"]),"done":(T["ok"],T["okq"])}[state]
    return (f'<div style="display: flex; align-items: flex-start; gap: 9px; padding: 8px 0;'
            + ("" if last else f' border-bottom: 1px solid {T["border"]};') + '">'
            f'<span style="width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; '
            f'background: {tint[0]};"></span>'
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
    changes=(changerow(T,"<b>Design review</b> moved to 13:00","20m ago")
             + changerow(T,"Jim replied about the SOW","41m ago")
             + changerow(T,"<b>work #418</b> went to in_review","1h ago",last=True))
    return (f'<div style="width: {w}px; flex-shrink: 0; border-left: 1px solid {T["border"]}; padding: 16px 16px 16px 18px; '
            f'background: {T["bg"]};">'
            + railsec(T,"NEEDS YOU",
                f'<div style="display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: {T["ts"]};">'
                f'<span style="display: flex; color: {T["acc"]};">{ic(I["bell"],15)}</span>'
                f'<span><b style="color: {T["tp"]};">4 waiting</b> — one is about today</span></div>',"Open")
            + railsec(T,"AGENTS",agents)
            + railsec(T,"SINCE YOU LAST LOOKED",changes,"9:04") + '</div>')

def slimrow(T,title,bits,carried=0,last=False):
    return trow(T,kind="md",title=title,bits=bits,carried=carried,drag=True,last=last)

def spine(T):
    g1=(slimrow(T,"Sign the SOW",["due today","P1","~15m","Jim asks at 09:30"],carried=2)
        + slimrow(T,"Call the dentist",["overdue by 2 days","P2","~15m"],carried=5,last=True))
    g2=(slimrow(T,"Write the design brief for the settings pane",
                ["due Wed","P1","~45m","blocking <b>work #418</b>"])
        + slimrow(T,"Review the lease comparables",["due Fri","P2","~90m"],last=True))
    return (earlier(T)
      + nowline(T)
      + meeting(T,time="09:15",title="Standup draft",sub="ready to copy",preps=[],actions_=False,
                pred=("Copy","— posting is yours; Metistry never sends it",I["copy"]))
      + meeting(T,time="09:30–10:00",title="1:1 with Jim Fallon",sub="2 people",
          preps=[(I["person"],'<b>People/Jim Fallon</b> — 3 open tasks assigned to him, last met 6 September'),
                 (I["check"],'you owe him: <b>Sign the SOW</b> — P1, on today’s list'),
                 (I["note"],'last time: <b>Journal/Meetings/2026-09-06-jim.md</b> — “revisit the Q4 scope once the lease lands”')],
          gen="The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
              "He has been waiting on the SOW since Tuesday.",
          pred=("Draft the agenda","— you have 3 open items with Jim",I["pencil"]))
      + gap(T,"1h 30m",g1,"2 tasks fit · 30m to spare")
      + meeting(T,time="13:00–14:00",title="Design review",sub="4 people · moved from 11:00",
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
            f'<span style="font-size: 12.5px; color: {T["ts"]};">Sunday 20 September</span>'
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
            f'<span style="display: flex; color: {T["tt"]}; opacity: 0.5; margin-top: 2px;">{ic(I["grip"],15,2.6)}</span>'
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

def agentprose(T,text,*,who="Metis",when="08:47",state=None,note=False,w=None):
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
               when="09:02",state="down",note=True)
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
  f'{btn(L,"Draft the agenda","secondary",I["spark"])}'
  f'{btn(L,"Ask for changes","ghost",I["spark"])}'
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
    rows=[("Due","due …",I["cal"],True),("Scheduled","do …",I["clock"],False),
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
        fresh=(f'<div style="padding: 0 13px 11px;">{st(T,changed)}</div>')
    acts=(f'<div style="display: flex; align-items: center; gap: 8px; padding: 11px 13px; '
          f'border-top: 1px solid {T["border"]}; flex-wrap: wrap;">'
          f'{btn(T,"Open","secondary")}{btn(T,"Copy","ghost",I["copy"])}'
          f'{btn(T,"Ask for changes","ghost",I["pencil"])}'
          f'<span style="flex-grow: 1;"></span>'
          f'<span style="font-size: 11.5px; color: {T["ts"]};">for <b style="color: {T["tp"]};">{forwhat}</b></span></div>')
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'border: 1px solid {T["border"]}; border-radius: 11px; '
            f'background: {T["surface"]}; overflow: hidden;">{head}{prev}{fresh}{acts}</div>')

def revision(T,w=None):
    return (f'<div style="' + (f'width: {w}px; ' if w else "") + f'background: {T["agq"]}; border-radius: 11px; '
            f'padding: 12px 14px;">'
            f'<div style="display: flex; align-items: center; gap: 7px; margin-bottom: 6px;">'
            f'<span style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">ASSISTANT</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">changed your day · 08:47</span></div>'
            f'<div style="font-size: 12.5px; color: {T["tp"]}; line-height: 1.55;">'
            f'You asked to push the lease review to tomorrow and put the brief first. '
            f'<b>3 items moved</b> — the brief is now in the 09:45 gap, and the review is on tomorrow’s plan.</div>'
            f'<div style="display: flex; gap: 8px; margin-top: 11px;">{btn(T,"Undo","secondary",I["undo"])}'
            f'{btn(T,"Show me what moved","ghost")}</div></div>')

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
            f'<span style="flex-grow: 1;"></span>{btn(T,"Open notes","secondary",I["note"])}</div>'
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
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">ASSISTANT</span>'
            f'<span style="font-size: 10.5px; color: {T["ts"]};">{when}</span>'
            f'<span style="flex-grow: 1;"></span>{thumbs(T,state)}</div>'
            f'<div style="font-family: {SERIF}; font-size: 14.5px; line-height: 1.55; color: {T["tp"]};">{text}</div>'
            + (f'<div style="margin-top: 11px;">{diffblock}</div>' if diffblock else "")
            + (f'<div style="display: flex; gap: 8px; margin-top: 11px; flex-wrap: wrap;">'
               + "".join(acts) + '</div>' if acts else "") + '</div>')

# ============ THE DAY BAR — five segments, travel included ===============
SEGS=[("Meetings",130,0),("Travel",50,1),("Focus Blocked",90,2),("Tasks That Fit",55,3),("Doesn’t Fit",45,"deg")]
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
            f'<span style="font-size: 12px; color: {T["ts"]};">6h 10m committed against a 9-hour day · '
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
      acts=[btn(T,"Block The Focus Time","secondary",I["spark"]),
            btn(T,"Draft The Move To Vendor","ghost",I["spark"]),
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
def sidebar8(T,sel="Today"):
    out=[]
    for n,g,kids in [("Today",I["cal"],None),("Chat",I["chat"],None),("Activity",I["activity"],None),
                     ("Work",I["work"],True),("Knowledge",I["know"],None),("Agents",I["agents"],None)]:
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
            f'<span style="display: flex; color: {T["tt"]}; opacity: 0.5; margin-top: 2px;">{ic(I["grip"],15,2.6)}</span>'
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
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["ag"]};">ASSISTANT</span>'
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
BEFORE=[("9:30","1:1 Jim","m",14),("11:00","Design review","m",20),("","",  "g",10),
        ("1:00","Vendor sync","m",14),("","","g",8),("2:30","Open","g",20)]
AFTER =[("9:30","1:1 Jim","m",14),("11:00","Design review","m",20),("11:45","Vendor sync","mv",14),
        ("12:30","Focus — settings brief","f",30),("","","g",22)]
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
                          (T["acc"],"new focus block")]) + '</div></div>')

def calblock2(T,dark=False,w=None):
    return prose(T,"Your afternoon is four gaps of half an hour. Moving the <b>vendor sync</b> up by an hour and "
                   "fifteen clears <b>12:30 to 2:00</b> for the settings brief — the only thing today that needs a "
                   "long run at it.",
      when="8:41 AM",
      diffblock=calplan(T,dark),
      acts=[btn(T,"Block The Focus Time","secondary",I["spark"]),
            btn(T,"Move The Vendor Sync","secondary",I["spark"]),
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
      "the whole feature safe, so it is first and it defaults to the narrow answer.")
  + policyrow(L,"Least notice",f'{opt(L,"2 hours",True)} {opt(L,"1 day")}',
      "Below this, Metis proposes and never moves — a meeting starting in twenty minutes is not a scheduling "
      "problem, it is a phone call.")
  + policyrow(L,"Protect",f'{opt(L,"Before 10 AM",True)} {opt(L,"After 4 PM",True)}',
      "Hours Metis may move things <i>out of</i> but never <i>into</i>. Most people have a shape to their day that "
      "no calendar knows about.")
  + policyrow(L,"Other people’s calendars",f'{opt(L,"Avoid conflicts",True)} {opt(L,"Ignore")}',
      "Free/busy only, and only for attendees whose calendars you can already see. Metis does not learn anything "
      "about their day beyond whether a slot is taken.")
  + policyrow(L,"Tell them",f'{opt(L,"Draft for me",True)}',
      "Metistry never sends. The move happens on the calendar; the note to the attendees is written for you and you "
      "press send.",last=True)
  + '</div>'
  + nt(L,"<b>Rescheduling is opt-in and per-user, because the rules are personal.</b> A manager moving their own "
         "1:1s is a different risk from someone shuffling a customer call, and no default can tell them apart. So "
         "the policy is a small set of questions asked once, and every offer says which rule let it through: "
         "<i>“you own this meeting, and your policy allows moving it with 2 hours’ notice.”</i>",16)
  + nt(L,"<b>Per-meeting opt-out sits on the event itself</b> — <i>never move this one</i> — because there is always "
         "one recurring meeting that looks movable and is not. A policy without an escape hatch gets turned off "
         "entirely the first time it is wrong.",12))

CALP2=pan(L,"A CALENDAR CHANGE IS A SHAPE, NOT A DIFF",
  calblock2(L)
  + nt(L,"<b>You were right that the diff was wrong here.</b> A diff is a <i>text</i> grammar: it reads top to "
         "bottom, every line is equal, and it says nothing about duration or adjacency. A calendar change is about "
         "<b>shape</b> — how long the blocks are, what sits next to what, how big the hole in the middle is. Two "
         "strips, now and after, answer that in one glance and a diff cannot answer it at all.",16)
  + nt(L,"<b>The diff keeps everything textual</b> — a revision to your plan, a task line about to be written, a "
         "template change. One grammar per kind of change, rather than one grammar stretched over both.",12))

# ============ PLUGIN — overlay hint, editable chips ======================
OB_L=dict(bg="#ffffff",text="#2e3338",faint="#6e7683",rule="#e3e5e8",sel="#e8eaed")
OB_D=dict(bg="#1e1e1e",text="#dcddde",faint="#8f9094",rule="#33363a",sel="#2c2f33")

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
def sidebar8(T,sel="Today"):
    out=[]
    for n,g,kids in [("Today",I["cal"],None),("Chat",I["chat"],None),("Activity",I["activity"],None),
                     ("Work",I["work"],True),("Knowledge",I["know"],None),("Agents",I["agents"],None)]:
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
        + trow3(T,title="Review the lease comparables",p=2,d="Fri",e="90m",
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
      + meeting5(T,time="9:30–10:00 AM",title="1:1 with Jim Fallon",sub="every other Friday",
          preps=[(I["person"],"3 open tasks assigned to",(("person","Jim Fallon",I["person"]),)),
                 (I["check"],"you owe him",(("plain","Sign the SOW",I["check"]),))],
          series=True,
          gen="The lease comparables came back 4% under his number, which is the thing you did not have on the 6th. "
              "He has been waiting on the SOW since Tuesday.",
          pred=("Draft The Agenda","— 3 open items, and one carried from last time"))
      + gap(T,"1h 30m",g1,"2 tasks fit · 30m to spare")
      + focusblock(T,"12:30 PM","Focus — the settings brief","90m")
      + travel(T,"25m","to the Ann Arbor office")
      + meeting5(T,time="1:00–2:00 PM",title="Design review",sub="4 people · in person",
          preps=[(I["board"],"in review, and what this is about",(("agent","Work #418",I["agents"]),)),
                 (I["note"],"written in the block above",(("project","Settings Pane",I["board"]),))],
          pred=("Open Work #418","— the review is about it"))
      + travel(T,"25m","back")
      + gap(T,"2h 10m",g2,"1 of 2 fits"))

def hub6(T,dark=False,w=1280):
    return (f'<div style="width: {w}px; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; '
            f'background: {T["bg"]}; flex-shrink: 0;">{toolbar(T)}<div style="display: flex;">{sidebar8(T)}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex;">'
            f'<div style="flex-grow: 1; min-width: 0;">'
            f'<div style="padding: 14px 16px 13px; background: {T["surface"]}; border-bottom: 1px solid {T["border"]};">'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">'
            f'<span style="font-size: 17px; font-weight: 600; color: {T["tp"]};">Today</span>'
            f'<span style="font-size: 12.5px; color: {T["ts"]};">Sunday 20 September</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11.5px; color: {T["tt"]};">as of 2 min ago</span>{seg(T)}</div>'
            f'{daybar(T,dark)}</div>'
            f'<div style="padding: 12px 14px 0;">'
            + prose(T,"You asked to push the lease review to tomorrow and put the brief first. <b>3 items moved.</b>",
                    when="8:47 AM",
                    diffblock=diff(T,summary="3 items moved on today’s plan",lines=[
                        (" ","9:30 AM  1:1 with Jim Fallon"),
                        ("-","Review the lease comparables   due Fri"),
                        ("+","Review the lease comparables   due Mon"),
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

I["repeat"]='<path d="M4 12a8 8 0 0113.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 01-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>'

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
          f'{btn(T,"Decline","dest",I["x"])}'
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
            f'<span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["ag"]};">METIS WROTE THIS</span>'
            f'<span style="flex-grow: 1;"></span>'
            f'<span style="font-size: 11px; color: {T["ts"]};">{when}</span></div>'
            f'<div style="font-family: {SERIF}; font-size: 13px; color: {T["tp"]}; line-height: 1.6; margin-top: 9px;">{text}</div>'
            f'<div style="display: flex; align-items: center; gap: 10px; margin-top: 11px;">'
            f'{btn(T,"Open the file","secondary",I["note"])}'
            f'<span style="flex-grow: 1;"></span>'
            + thumbs(T) + '</div></div>')

PLAN_PROSE=("Tomorrow is thin before 11 and full after it. I have put the two lease items in the morning because "
            "the 11:00 review is the thing they feed, and left the 45 minutes after lunch empty rather than "
            "filling it — you have moved that block three days running.")
STANDUP_PROSE=("Yesterday: closed the vendor comparison and the Q4 pricing note. Today: the lease renewal reply "
               "and the 11:00 design review. Nothing is blocked.")

def routinerows(T,*,last_absent=False):
    """The two rows this back-patch adds, plus the honest third. `plan-tomorrow` writes
    one file and records a `routine_run`; a `too_early` tick writes NOTHING and gets no
    row at all — the schedule working is not an event."""
    rows=(feedrow(T,glyph=I["cal"],actor="plan-tomorrow",subject="Tomorrow's Plan",
            detail='<span style="font-family: '+MONO+'; font-size: 11.5px;">Journal/Plan/2026-09-21.md</span> · 9 tasks, 2 meetings, 45m left empty',
            when="6m",kind="system",spark=True,expand="what it wrote")
          + routineprose(T,PLAN_PROSE,when="6:02 AM")
          + feedrow(T,glyph=I["repeat"],actor="standup-draft",subject="Standup Draft",
            detail='<span style="font-family: '+MONO+'; font-size: 11.5px;">Journal/Standup/2026-09-20.md</span> · covers yesterday · 2 closed',
            when="1h",kind="system",spark=True,expand="what it wrote")
          + routineprose(T,STANDUP_PROSE,when="9:02 AM"))
    if last_absent:
        rows+=feedrow(T,glyph=I["plug"],actor="knowledge-fold",subject="Knowledge Fold",
            detail="did not run — no reconciler bridge, so there was nothing to read and nowhere to write",
            when="2h",kind="system",tint=T["abs"],last=True)
    return rows
