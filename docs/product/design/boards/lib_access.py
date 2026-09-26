"""Keyboard (Mac only) and VoiceOver (2026-09-25; C119–C122).

Owner: no keyboard layer for the PWA; Start and Stop Recording are two shortcuts;
shortcuts that work in any app are OFF until the owner turns them on, and a
conflict is caught when one is set. In-app shortcuts live in the menu bar, where a
Mac user looks for them.
"""
from lib import *
from lib_connect import ref

def kc(T,k,*,dim=False):
    return (f'<span style="display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; '
            f'padding: 0 5px; box-sizing: border-box; border-radius: 5px; border: 1px solid {T["bc"]}; '
            f'box-shadow: 0 1px 0 {T["bc"]}; background: {T["surface"]}; font-family: {MONO}; font-size: 11px; '
            f'color: {T["ts"] if dim else T["tp"]};">{k}</span>')
def combo(T,keys,*,dim=False): return '<span style="display: inline-flex; gap: 3px;">'+"".join(kc(T,k,dim=dim) for k in keys)+'</span>'

# ---- macOS menus -----------------------------------------------------------------------
def menubar(T,open_="Go"):
    items=["Metistry","File","Edit","View","Go","Capture","Item","Window","Help"]
    return (f'<div style="display: flex; align-items: center; gap: 2px; height: 26px; padding: 0 10px; background: {rgba(T["elevated"],0.92)}; '
            f'border-bottom: 1px solid {T["border"]}; font-size: 13px; color: {T["tp"]};">'
            f'<span style="display: flex; margin-right: 8px;">{mark(T,size=13)}</span>'
            + "".join(f'<span style="padding: 2px 9px; border-radius: 5px; font-weight: {700 if i==0 else 400}; '
                      f'background: {T["acc"] if n==open_ else "transparent"}; color: {T["onacc"] if n==open_ else T["tp"]};">{n}</span>'
                      for i,n in enumerate(items)) + '</div>')

def macmenu(T,items,*,w=280):
    rows=""
    for it in items:
        if it=="-": rows+=f'<div style="height: 1px; background: {T["border"]}; margin: 5px 10px;"></div>'; continue
        label,keys=it[0],it[1]; dis=len(it)>2 and it[2]=="dis"; hl=len(it)>2 and it[2]=="hl"
        col=T["tt"] if dis else (T["onacc"] if hl else T["tp"])
        rows+=(f'<div style="display: flex; align-items: center; gap: 10px; padding: 3px 12px; margin: 0 5px; border-radius: 5px; '
               f'background: {T["acc"] if hl else "transparent"};">'
               f'<span style="flex-grow: 1; font-size: 13px; color: {col};">{label}</span>'
               f'<span style="font-size: 12.5px; color: {T["onacc"] if hl else (T["tt"] if dis else T["ts"])}; letter-spacing: 1px;">{keys}</span></div>')
    return (f'<div style="width: {w}px; box-sizing: border-box; padding: 5px 0; border-radius: 9px; background: {T["elevated"]}; '
            f'border: 1px solid {T["bc"]}; box-shadow: 0 12px 32px rgba(26,24,21,0.2);">{rows}</div>')

GO=[("Needs You","⌘0"),("Today","⌘1","hl"),("Chat","⌘2"),("Activity","⌘3"),("Work","⌘4"),("Knowledge","⌘5"),("Agents","⌘6"),("Scheduled","⌘7"),"-",
    ("Back","⌘["),("Forward","⌘]"),"-",("Command Palette…","⌘K"),("Filter","⌘F")]
CAPTURE=[("New Capture…","⌘N"),"-",("Ask Metis","⌃⌥⌘A"),("Note","⌃⌥⌘N"),("To-do","⌃⌥⌘T"),"-",("Start Recording","⌃⌥⌘R"),("Stop Recording","⌃⌥⌘S","dis"),"-",
         ("Hide Capture Bar",""),("Shortcuts in Any App…","")]
ITEM=[("Open","↩"),("Open in Obsidian","⌘O"),"-",("Approve","A"),("Revise","R"),("Decline","D"),("Later","L"),"-",("Complete","Space"),("Move…","M"),
      ("Hand to an Agent…","⇧⌘P"),"-",("Run Now","⌘R","dis"),("Pause","⌥⌘P","dis")]
VIEW=[("Today / All","⌥⌘T"),("Show Sidebar","⌃⌘S"),"-",("Actual Size","⌘0","dis")]

def menushow(T):
    col=lambda title,m,w=260:(f'<div><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; margin-bottom: 7px;">{title}</div>{macmenu(T,m,w=w)}</div>')
    return (f'<div style="border: 1px solid {T["bc"]}; border-radius: 12px; overflow: hidden; background: {rgba(T["sunken"],0.6)};">{menubar(T,"Go")}'
            f'<div style="display: flex; gap: 26px; padding: 18px 20px 22px; align-items: flex-start;">'
            + col("GO",GO) + col("CAPTURE &mdash; SHORTCUTS IN ANY APP ON",CAPTURE,w=270) + col("ITEM &mdash; FOLLOWS THE SELECTION",ITEM)
            + '</div></div>')

# ---- Help ▸ Keyboard Shortcuts --------------------------------------------------------------
SHEET=[("EVERYWHERE",[("Command palette",["⌘","K"]),("New capture",["⌘","N"]),("Filter this view",["⌘","F"]),("Go to Needs You · Today…Scheduled",["⌘","0–7"]),
                      ("Back · Forward",["⌘","[ ]"]),("Settings",["⌘",","]),("Close, then step back",["esc"])]),
       ("ANY LIST",[("Move",["↑","↓"]),("Open",["↩"]),("Select",["Space"]),("Select all",["⌘","A"]),("Move to…",["M"])]),
       ("NEEDS YOU",[("Approve · Revise · Decline",["A","R","D"]),("Later",["L"]),("Pick an answer",["1–9"]),("Send answers",["⌘","↩"])]),
       ("TODAY",[("Complete",["Space"]),("Undo",["⌘","Z"]),("Today / All",["⌥","⌘","T"]),("Hand to an agent",["⇧","⌘","P"]),("Copy standup",["⌘","C"])]),
       ("CHAT",[("Send",["⌘","↩"]),("Edit last message",["↑"]),("New conversation",["⇧","⌘","N"])]),
       ("SCHEDULED",[("Run now · Sync now",["⌘","R"]),("Pause",["⌥","⌘","P"])]),
       ("ACTIVITY",[("Take pending rows",["⌘","R"])]),
       ("AGENTS",[("Save definition",["⌘","S"]),("Revoke",["⌘","⌫"])])]
def kbsheet(T,*,w=980):
    def grp(title,rows):
        return (f'<div style="break-inside: avoid; margin-bottom: 16px;"><div style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; margin-bottom: 6px;">{title}</div>'
                + "".join(f'<div style="display: flex; align-items: center; gap: 10px; padding: 4px 0; border-bottom: 1px solid {T["border"]};">'
                          f'<span style="flex-grow: 1; font-size: 12.5px; color: {T["tp"]};">{a}</span>{combo(T,k)}</div>' for a,k in rows) + '</div>')
    anyapp=(f'<div style="break-inside: avoid; border: 1px dashed {T["bc"]}; border-radius: 9px; padding: 10px 12px;">'
            f'<div style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: {T["tt"]}; flex-grow: 1;">IN ANY APP</span>'
            f'<span style="font-size: 11.5px; color: {T["ts"]};">Off</span><span style="font-size: 11.5px; font-weight: 600; color: {T["acc"]};">Turn On&hellip;</span></div>'
            f'<div style="font-size: 12px; color: {T["ts"]}; margin-top: 5px;">Ask, Note, To-do, Start and Stop Recording from anywhere.</div></div>')
    return (f'<div style="width: {w}px; box-sizing: border-box; border: 1px solid {T["bc"]}; border-radius: 12px; background: {T["bg"]}; overflow: hidden; '
            f'box-shadow: 0 14px 40px rgba(26,24,21,0.14);">'
            f'<div style="display: flex; align-items: center; height: 38px; padding: 0 14px; background: {T["elevated"]}; border-bottom: 1px solid {T["border"]};">'
            f'<span style="display: inline-flex; gap: 6px;">' + "".join(f'<span style="width: 10px; height: 10px; border-radius: 50%; background: {T["bs"]};"></span>' for _ in range(3)) + '</span>'
            f'<span style="flex-grow: 1; text-align: center; font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Keyboard Shortcuts</span><span style="width: 46px;"></span></div>'
            f'<div style="padding: 18px 20px; column-count: 3; column-gap: 26px;">' + "".join(grp(t,r) for t,r in SHEET) + anyapp + '</div></div>')

# ---- Settings ▸ Live Capture ▸ Shortcuts in any app -----------------------------------------
def recorder(T,keys,*,state="set",note=None):
    """A shortcut field. set · empty · recording · taken (another app holds it) · system (macOS uses it)."""
    if state=="recording":
        inner=f'<span style="font-size: 12px; color: {T["acc"]};">Press a shortcut&hellip;</span>'; bd=T["acc"]; ring=f'box-shadow: 0 0 0 3px {rgba(T["acc"],0.18)};'
    elif state=="empty":
        inner=f'<span style="font-size: 12px; color: {T["ts"]};">Record Shortcut</span>'; bd=T["bc"]; ring=""
    else:
        inner=combo(T,keys); bd=T["fail"] if state=="taken" else (T["deg"] if state=="system" else T["bc"]); ring=""
    x=(f'<span style="display: flex; color: {T["tt"]};">{ic(I["x"],11,2.2)}</span>' if state in ("set","taken","system") else "")
    return (f'<span style="display: inline-flex; align-items: center; gap: 8px; width: 150px; box-sizing: border-box; justify-content: space-between; '
            f'padding: 4px 8px; border-radius: 7px; border: 1px solid {bd}; background: {T["surface"]}; {ring}">{inner}{x}</span>')

def hkrow(T,label,keys,state="set",note=None,*,last=False,off=False):
    line=""
    if note:
        k,t=note; col={"taken":T["fail"],"system":T["deg"],"ok":T["ok"]}[k]; g={"taken":I["failed"],"system":I["warn"],"ok":I["check"]}[k]
        line=(f'<div style="display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11.5px; color: {col if k=="taken" else T["ts"]};">'
              f'<span style="display: flex; color: {col};">{ic(g,12,2.1)}</span>{t}</div>')
    return (f'<div style="padding: 8px 0; {bd_(T,last)} opacity: {0.45 if off else 1};"><div style="display: flex; align-items: center; gap: 12px;">'
            f'<span style="font-size: 12.5px; color: {T["tp"]}; flex-grow: 1;">{label}</span>{recorder(T,keys,state=state)}</div>'
            f'<div style="padding-left: 0;">{line}</div></div>')

def hotkeys(T,*,on=False,conflicts=False):
    head=(f'<div style="display: flex; align-items: center; gap: 10px;">'
          f'<div style="flex-grow: 1;"><div style="font-size: 12.5px; font-weight: 600; color: {T["tp"]};">Shortcuts in any app</div>'
          f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 2px;">'
          + ("Work while another app is in front." if on else "Off. Metistry registers nothing outside its own windows.") + '</div></div>' + toggle(T,on) + '</div>')
    if conflicts:
        rows=(hkrow(T,"Ask Metis",["⌃","⌥","⌘","A"])
              + hkrow(T,"Note",[],"recording")
              + hkrow(T,"To-do",["⌃","⌥","⌘","T"],"taken",("taken","Another app already uses this. Pick another."))
              + hkrow(T,"Start Recording",["⌃","⌥","⌘","R"])
              + hkrow(T,"Stop Recording",["⌥","⌘","Space"],"system",("system","macOS uses this to open a Finder search window."),last=True))
    else:
        rows="".join(hkrow(T,a,k,off=not on,last=(i==4)) for i,(a,k) in enumerate(
            (("Ask Metis",["⌃","⌥","⌘","A"]),("Note",["⌃","⌥","⌘","N"]),("To-do",["⌃","⌥","⌘","T"]),
             ("Start Recording",["⌃","⌥","⌘","R"]),("Stop Recording",["⌃","⌥","⌘","S"]))))
    foot=(f'<div style="font-size: 11.5px; color: {T["ts"]}; margin-top: 10px;">'
          + ("Suggested keys. Metistry checks each one with macOS when you set it." if not conflicts else
             "Nothing is registered until every shortcut is clear.") + '</div>')
    return sunk(T,head+f'<div style="margin-top: 10px; border-top: 1px solid {T["border"]};">{rows}</div>'+foot)

def hkpane(T,*,on=False,conflicts=False):
    return (panehead(T,"Live Capture")
            + f'<div style="padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 14px;">'
            + block(T,"SHORTCUTS",hotkeys(T,on=on,conflicts=conflicts)) + '</div>')

# ---- focus -----------------------------------------------------------------------------------
def focusring(T,inner,*,r=8):
    return f'<span style="display: inline-flex; border-radius: {r}px; box-shadow: 0 0 0 3px {rgba(T["acc"],0.5)};">{inner}</span>'

# ---- VoiceOver: what each thing says ---------------------------------------------------------
def spoken(T,rows,*,w=None):
    wd=f"width: {w}px;" if w else ""
    return (f'<div style="{wd}"><table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">'
            f'<tr style="text-align: left; font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; color: {T["tt"]};">'
            f'<th style="padding: 0 12px 7px 0;">ELEMENT</th><th style="padding: 0 12px 7px 0;">VOICEOVER SAYS</th><th style="padding: 0 0 7px;">IS A</th></tr>'
            + "".join(f'<tr style="border-top: 1px solid {T["border"]}; vertical-align: top;">'
                      f'<td style="padding: 8px 12px 8px 0; color: {T["ts"]}; width: 150px;">{a}</td>'
                      f'<td style="padding: 8px 12px 8px 0; color: {T["tp"]};">&ldquo;{b}&rdquo;</td>'
                      f'<td style="padding: 8px 0; color: {T["ts"]}; width: 110px;">{c}</td></tr>' for a,b,c in rows)
            + '</table></div>')

def raildemo(T):
    return (f'<div style="position: relative; width: 250px; height: 250px; border-radius: 12px; '
            f'background: linear-gradient(135deg, {T["sunken"]}, {T["bg"]}); border: 1px solid {T["border"]}; overflow: hidden;">'
            + railtool(T,top=18,hot="note") + tip(T,"Note","⌃⌥⌘N",top=100) + '</div>')

def gaugepill(T):
    return (f'<span style="align-self: flex-start; display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px; border-radius: 999px; border: 1px solid {T["bc"]}; background: {T["surface"]};">'
            f'<span style="display: flex; color: {T["ts"]};">{ic(I["gauge"],14,1.9)}</span>'
            f'<span style="font-size: 12px; color: {T["tp"]}; font-variant-numeric: tabular-nums;">$1.84</span></span>')
