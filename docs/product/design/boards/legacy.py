"""Archived boards, frozen (2026-09-25).

Theme (round-B nav) and Item-Model (the ladder Facets replaced) are superseded and
kept for the record. They should NOT pick up later changes — an archive that
re-renders with today's components stops being a record — so their published HTML
is stored in boards/legacy/ and copied out unchanged.
"""
from lib import PROJ
import pathlib
SRC=pathlib.Path(__file__).parent/"legacy"
for f in sorted(SRC.glob("*.dc.html")):
    (PROJ/f.name).write_bytes(f.read_bytes())
    print(f"copied {f.name} (frozen)")
