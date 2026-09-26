"""Board: States — empty, absent, failed, stale.

The assembly that built this board in round C was never ported; `states_panel` and
`copy` in lib.py are the whole of it, so this module is the thin shell they were
always missing.
"""
from lib import *

body=(heading("ROUND C · COMPONENTS, BACK-PATCHED","Empty, absent, failed, stale",
   "Four states, four different jobs. Three of them replace the content because nothing true can be shown in "
   "its place; <b>stale</b> annotates instead, because the number is still the last true number and hiding it "
   "would be the lie. State is reported and never inferred (P5), so each one names what it knows and how it "
   "knows it.",L)
  + row(states_panel(L,"LIGHT")+states_panel(D,"DARK"),18)
  + row(copy,18))
(PROJ/"States.dc.html").write_text(page("States",wrap(body,SW,SH,"#ece7dd",L["tp"],40),SW,SH,"#ece7dd"),encoding="utf-8")
print(f"wrote States.dc.html ({SW}x{SH})")
