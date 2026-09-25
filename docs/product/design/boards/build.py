#!/usr/bin/env python3
"""Build every board. Set METISTRY_CANVAS to the canvas project directory.

    METISTRY_CANVAS=~/canvas/metistry-brand-a python3 build.py          # all
    METISTRY_CANVAS=~/canvas/metistry-brand-a python3 build.py board    # one
"""
import sys, importlib, pathlib
BOARDS = ["states", "request", "chat", "activity", "needsyou", "agents", "routines", "resources", "today_vocab", "knowledge", "capturebar", "rundetail", "projects", "carddetail", "settings", "artifacts", "usage", "today", "board", "pwa_today", "pwa_shell", "pwa_needs", "pwa_work", "pwa_more", "needs_v4", "needs_v5"]          # add a module here when a board is ported
sys.path.insert(0, str(pathlib.Path(__file__).parent))
want = sys.argv[1:] or BOARDS
for m in want:
    if m not in BOARDS:
        raise SystemExit(f"unknown board {m!r}; known: {', '.join(BOARDS)}")
    importlib.import_module(m)
