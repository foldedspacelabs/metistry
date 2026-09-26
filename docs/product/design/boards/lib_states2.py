"""States and flows, round F (2026-09-25; C135–C138).

First paint shows what Metistry last had, marked stale when old; placeholder rows
only on the very first load; any wait over a second says what it waits for (C135).
Reversible actions get Undo; only irreversible ones confirm, naming what they cost
(C136). Recording runs up to a working day with a reminder every two hours and a
watch on disk (C137). Buttons that led nowhere now lead somewhere (C138).
"""
from lib import *
import lib_pwa  # wifioff glyph
I.setdefault("trash",'<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2a1.5 1.5 0 001.5 1.3h6.4a1.5 1.5 0 001.5-1.3L17.5 7"/>')
I.setdefault("moon",'<path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z"/>')
I.setdefault("disk",'<rect x="3.5" y="6" width="17" height="12" rx="2.2"/><path d="M7 14.5h.01M10.5 14.5h6"/>')

def frame(T,title,body,*,w=600,h=None,right=""):
    hh=f"height: {h}px;" if h else ""
    return (f'<div style="width: {w}px; {hh} box-sizing: border-box; border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; background: {T["bg"]}; '
            f'display: flex; flex-direction: column;">'
            f'<div style="display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 15px; font-weight: 600; color: {T["tp"]}; flex-grow: 1;">{title}</span>{right}</div>'
            f'<div style="flex-grow: 1; position: relative;">{body}</div></div>')

def empty(T,glyph,title,body,action=None,*,secondary=None):
    acts=""
    if action or secondary:
        acts=('<div style="display: flex; gap: 8px; justify-content: center; margin-top: 14px;">'
              + (btn(T,action,"secondary",I["plus"] if action.startswith(("New","Add","Capture")) else None) if action else "")
              + (btn(T,secondary,"ghost") if secondary else "") + '</div>')
    return (f'<div style="display: flex; flex-direction: column; align-items: center; text-align: center; padding: 42px 24px;">'
            f'<span style="display: flex; color: {T["tt"]};">{ic(I[glyph],28,1.6)}</span>'
            f'<div style="font-size: 14px; font-weight: 600; color: {T["tp"]}; margin-top: 12px;">{title}</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 5px; max-width: 330px; line-height: 1.5;">{body}</div>{acts}</div>')

def band(T,kind,text,action=None):
    g,c={"fail":(I["failed"],T["fail"]),"stale":(I["clock"],T["stale"]),"off":(I["wifioff"],T["ts"]),"wait":(I["clock"],T["ts"])}[kind]
    return (f'<div style="margin: 10px 14px 0; display: flex; align-items: center; gap: 9px; background: {T["sunken"]}; border-radius: 9px; padding: 8px 11px;">'
            f'<span style="display: flex; color: {c};">{ic(g,14,2)}</span><span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1; line-height: 1.4;">{text}</span>'
            + (f'<span style="font-size: 12px; font-weight: 600; color: {T["acc"]}; white-space: nowrap;">{action}</span>' if action else "") + '</div>')

def skel(T,n=4,*,w=(0.62,0.44,0.7,0.5)):
    return ('<div style="padding: 12px 16px;">' + "".join(
        f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid {T["border"]};">'
        f'<span style="width: 14px; height: 14px; border-radius: 4px; background: {T["sunken"]};"></span>'
        f'<span style="height: 10px; width: {int(w[i%len(w)]*100)}%; border-radius: 5px; background: {T["sunken"]};"></span></div>' for i in range(n)) + '</div>')

def waitline(T,text,frac=None):
    bar=(f'<div style="height: 4px; border-radius: 2px; background: {T["border"]}; margin-top: 7px; overflow: hidden;"><div style="width: {int(frac*100)}%; height: 100%; background: {T["acc"]};"></div></div>' if frac is not None else "")
    return (f'<div style="margin: 10px 14px 0; padding: 9px 12px; border-radius: 9px; border: 1px solid {T["border"]};">'
            f'<div style="font-size: 12.5px; color: {T["tp"]};">{text}</div>{bar}</div>')

def fakerows(T,rows):
    return ('<div style="padding: 4px 16px 10px;">' + "".join(
        f'<div style="display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid {T["border"]};">'
        f'<span style="display: flex; color: {T["ts"]};">{ic(I[g],14,1.9)}</span><span style="font-size: 13px; color: {T["tp"]}; flex-grow: 1;">{t}</span>'
        f'<span style="font-size: 11.5px; color: {T["ts"]};">{r}</span></div>' for g,t,r in rows) + '</div>')

def toast(T,text,action="Undo",*,w=None):
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd} display: inline-flex; align-items: center; gap: 12px; padding: 9px 14px; border-radius: 10px; background: {T["tp"]}; '
            f'box-shadow: 0 8px 24px rgba(26,24,21,0.25);"><span style="font-size: 12.5px; color: {T["bg"]};">{text}</span>'
            + (f'<span style="font-size: 12.5px; font-weight: 700; color: {T["bg"]}; text-decoration: underline;">{action}</span>' if action else "") + '</div>')

def confirm(T,title,body,items,primary,*,secondary="Cancel",alt=None,w=420,dest=True):
    lst=("" if not items else
         f'<div style="margin-top: 10px; border-radius: 9px; background: {T["sunken"]}; padding: 8px 11px;">'
         + "".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; color: {T["tp"]};">'
                   f'<span style="display: flex; color: {T["ts"]};">{ic(I[g],13,1.9)}</span>{t}</div>' for g,t in items) + '</div>')
    return (f'<div style="width: {w}px; box-sizing: border-box; padding: 16px; border-radius: 13px; background: {T["elevated"]}; border: 1px solid {T["bc"]}; '
            f'box-shadow: 0 16px 40px rgba(26,24,21,0.2);">'
            f'<div style="font-size: 14px; font-weight: 600; color: {T["tp"]};">{title}</div>'
            f'<div style="font-size: 12.5px; color: {T["ts"]}; margin-top: 5px; line-height: 1.5;">{body}</div>{lst}'
            f'<div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px;">'
            + (btn(T,alt,"secondary") if alt else "") + btn(T,secondary,"ghost") + btn(T,primary,"dest" if dest else "affirm") + '</div></div>')

def progressrow(T,name,sub_,frac,right,act):
    return (f'<div style="padding: 9px 0; border-bottom: 1px solid {T["border"]};"><div style="display: flex; align-items: center; gap: 9px;">'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;"><b style="font-weight: 600;">{name}</b> <span style="color: {T["ts"]};">{sub_}</span></span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]}; font-variant-numeric: tabular-nums;">{right}</span>{act}</div>'
            f'<div style="height: 4px; border-radius: 2px; background: {T["border"]}; margin-top: 7px; overflow: hidden;"><div style="width: {int(frac*100)}%; height: 100%; background: {T["acc"]};"></div></div></div>')

def issuerow(T,name,tagt,msg,act,*,kind="fail"):
    c={"fail":T["fail"],"ok":T["ts"]}.get(kind,T["ts"])
    g={"fail":I["failed"],"ok":I["check"]}.get(kind,I["clock"])
    return (f'<div style="display: flex; align-items: center; gap: 9px; padding: 9px 0; border-bottom: 1px solid {T["border"]};">'
            f'<span style="font-size: 13px; font-weight: 600; color: {T["tp"]};">{name}</span>'
            f'<span style="font-size: 10.5px; font-weight: 600; color: {T["ts"]}; border: 1px solid {T["bc"]}; border-radius: 999px; padding: 0 7px; line-height: 17px;">{tagt}</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: {c}; flex-grow: 1;"><span style="display: flex; color: {T["ok"] if kind=="ok" else c};">{ic(g,12,2.2)}</span>{msg}</span>{act}</div>')

def tile(T,label,inner):
    return f'<div><div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; margin-bottom: 8px;">{label}</div>{inner}</div>'
