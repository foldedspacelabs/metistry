#!/usr/bin/env python3
"""PoC-14 scorer: mechanical post-checks + ground-truth scoring + determinism.
Stdlib only. Usage: analyze.py fixtures.json run-A.jsonl [run-B.jsonl]"""
import json, sys, re, statistics
from collections import defaultdict

FILLER = {"and", "also", "oh", "then", "plus", "separately", "um", "uh", "ok",
          "okay", "please", "so", "yeah", "well", "actually", "just", "can",
          "you", "i", "my", "me", "the", "a", "an"}
# only true connectives are discounted from coverage; content words are not
COVER_FILLER = {"and", "also", "oh", "then", "plus", "separately", "um", "uh",
                "ok", "okay", "please", "yeah", "well"}


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def mechanical(inp, segs):
    """Returns (passed, failures[], coverage_float)."""
    fails = []
    ni = norm(inp)
    low = ni.lower()
    if not segs:
        return False, ["no_segments"], 0.0
    cursor = 0
    spans = []
    for k, s in enumerate(segs):
        t = norm(s.get("text", ""))
        if not t:
            fails.append(f"seg{k}_empty")
            continue
        # (a) verbatim substring, (b) in order => search from cursor
        idx = low.find(t.lower(), cursor)
        if idx < 0:
            anywhere = low.find(t.lower())
            if anywhere < 0:
                fails.append(f"seg{k}_not_verbatim")
            else:
                fails.append(f"seg{k}_out_of_order_or_overlap")
            continue
        spans.append((idx, idx + len(t)))
        cursor = idx + len(t)
    # (b) non-overlap explicitly
    for i in range(1, len(spans)):
        if spans[i][0] < spans[i - 1][1]:
            fails.append(f"overlap_{i}")
    # (c) coverage of non-filler content
    covered = [False] * len(ni)
    for a, b in spans:
        for i in range(a, min(b, len(ni))):
            covered[i] = True
    total_c = 0
    cov_c = 0
    for m in re.finditer(r"[A-Za-z0-9']+", ni):
        if m.group(0).lower() in COVER_FILLER:
            continue
        for i in range(m.start(), m.end()):
            total_c += 1
            if covered[i]:
                cov_c += 1
    coverage = (cov_c / total_c) if total_c else 1.0
    if coverage < 0.80:
        fails.append(f"coverage_{coverage:.2f}")
    return (len(fails) == 0), fails, coverage


def exp_range(e):
    return (e[0], e[1]) if isinstance(e, list) else (e, e)


def score(fixtures, recs):
    by_id = {r["id"]: r for r in recs}
    rows = []
    for fx in fixtures:
        fid = fx["id"]
        r = by_id.get(fid)
        row = {"id": fid, "class": fx["class"], "text": fx["text"], "fx": fx}
        if r is None:
            row.update(outcome="missing", mech=False)
            rows.append(row)
            continue
        row["outcome"] = r.get("outcome")
        row["latency_ms"] = r.get("latency_ms")
        if r.get("outcome") != "ok":
            row.update(mech=False, n=0, segs=[], ctx=False, multi=False)
            rows.append(row)
            continue
        segs = r.get("segments", [])
        mech, fails, cov = mechanical(fx["text"], segs)
        lo, hi = exp_range(fx["expected_segments"])
        n = len(segs)
        row.update(
            mech=mech, mech_fails=fails, coverage=cov, n=n, segs=segs,
            ctx=bool(r.get("needs_session_context")),
            multi=bool(r.get("is_multi_intent")),
            count_ok=(lo <= n <= hi),
            over_split=(n > hi),
            under_split=(n < lo),
        )
        # intent scoring
        ei = fx["expected_intents"]
        if lo == hi == 1:
            row["intent_ok"] = (n == 1 and segs[0]["intent"] in ei)
        elif row["count_ok"] and n > 1:
            row["intent_ok"] = all(
                segs[k]["intent"] == ei[k] for k in range(min(n, len(ei)))
            ) if n == len(ei) else None
        elif row["count_ok"] and n == 1:
            # entangled item answered with no-split: accept conversation/task-ish
            row["intent_ok"] = segs[0]["intent"] in set(ei) | {"conversation", "task_request"}
        else:
            row["intent_ok"] = None
        # entangled dependency flag
        if fx.get("entangled") and n > 1:
            row["dep_flagged"] = any(s.get("depends_on_other_segment") for s in segs[1:])
        rows.append(row)
    return rows


def report(fixtures, rows, label):
    print(f"\n{'='*74}\n  SCORE TABLE  ({label})\n{'='*74}")
    byclass = defaultdict(list)
    for r in rows:
        byclass[r["class"]].append(r)
    order = ["single_simple", "single_complex", "clean_multi",
             "entangled_multi", "anaphora", "adversarial"]
    print(f"{'class':<17}{'n':>3} {'mech':>5} {'count_ok':>9} {'over':>5} {'under':>6} {'intent':>8}")
    tot = defaultdict(int)
    for c in order:
        rs = byclass[c]
        m = sum(1 for r in rs if r.get("mech"))
        co = sum(1 for r in rs if r.get("count_ok"))
        ov = sum(1 for r in rs if r.get("over_split"))
        un = sum(1 for r in rs if r.get("under_split"))
        iy = sum(1 for r in rs if r.get("intent_ok") is True)
        ic = sum(1 for r in rs if r.get("intent_ok") is not None)
        print(f"{c:<17}{len(rs):>3} {m:>5} {co:>9} {ov:>5} {un:>6} {iy:>4}/{ic:<3}")
        tot["n"] += len(rs); tot["m"] += m; tot["co"] += co
        tot["ov"] += ov; tot["un"] += un; tot["iy"] += iy; tot["ic"] += ic
    print(f"{'-'*54}")
    print(f"{'TOTAL':<17}{tot['n']:>3} {tot['m']:>5} {tot['co']:>9} {tot['ov']:>5} {tot['un']:>6} {tot['iy']:>4}/{tot['ic']:<3}")

    # critical: over-split on must-not-split classes
    mns = [r for r in rows if not r["fx"]["split_allowed"]]
    mns_over = [r for r in mns if r.get("over_split")]
    print(f"\nCRITICAL -- over-split on must-not-split items: {len(mns_over)}/{len(mns)} "
          f"({100*len(mns_over)/len(mns):.0f}% of requests corrupted)")

    # anaphora flag
    an = [r for r in rows if r["class"] == "anaphora"]
    hit = sum(1 for r in an if r.get("ctx"))
    print(f"anaphora needs_session_context hit rate: {hit}/{len(an)}")
    fp = [r for r in rows if r["class"] != "anaphora" and r.get("ctx")]
    print(f"needs_session_context false positives elsewhere: {len(fp)}"
          + (f"  ({', '.join(r['id'] for r in fp)})" if fp else ""))

    # entangled dep flags
    ent = [r for r in rows if r["class"] == "entangled_multi"]
    split_ent = [r for r in ent if r.get("n", 0) > 1]
    dep = sum(1 for r in split_ent if r.get("dep_flagged"))
    print(f"entangled: split {len(split_ent)}/{len(ent)}, of those dependency-flagged: {dep}/{len(split_ent)}")

    # is_multi_intent vs segment-count consistency
    inc = [r for r in rows if r.get("outcome") == "ok" and r.get("multi") != (r.get("n", 0) > 1)]
    print(f"is_multi_intent inconsistent with segment count: {len(inc)}/{sum(1 for r in rows if r.get('outcome')=='ok')}"
          + (f"  ({', '.join(r['id'] for r in inc)})" if inc else ""))

    # refusals / errors
    ref = [r for r in rows if r.get("outcome") == "refusal"]
    err = [r for r in rows if r.get("outcome") == "error"]
    print(f"refusals: {len(ref)}  errors: {len(err)}")

    # DEPLOYMENT METRIC
    print(f"\n{'-'*74}\n  DEPLOYMENT METRIC: acting only on confident clean verdicts\n{'-'*74}")
    cc = [r for r in rows if r.get("mech") and not r.get("ctx")]
    print(f"confident clean = mech-pass AND not needs_session_context: {len(cc)}/{len(rows)} "
          f"= {100*len(cc)/len(rows):.0f}% coverage")
    ok = [r for r in cc if r.get("count_ok")]
    bad = [r for r in cc if not r.get("count_ok")]
    corrupt = [r for r in cc if r.get("over_split") and not r["fx"]["split_allowed"]]
    print(f"  split decision correct:            {len(ok)}/{len(cc)} = {100*len(ok)/len(cc):.0f}% precision")
    print(f"  split decision wrong:              {len(bad)}/{len(cc)}  ({', '.join(r['id'] for r in bad)})")
    print(f"  CORRUPTING (over-split a single):  {len(corrupt)}/{len(cc)} = {100*len(corrupt)/len(cc):.0f}%"
          + (f"  ({', '.join(r['id'] for r in corrupt)})" if corrupt else ""))
    # what does acting on them buy: correct splits of genuinely-multi items
    gain = [r for r in cc if r["fx"]["split_allowed"] and r.get("count_ok") and r.get("n", 0) > 1]
    multi_total = [r for r in rows if r["fx"]["split_allowed"]]
    print(f"  GAIN: correctly split multi-intent: {len(gain)}/{len(multi_total)} of all splittable items")

    # detail dumps
    print(f"\n{'-'*74}\n  EVERY OVER-SPLIT ON A MUST-NOT-SPLIT ITEM\n{'-'*74}")
    for r in mns_over:
        print(f"\n[{r['id']} / {r['class']}]  expected 1 segment, model produced {r['n']}")
        print(f"  INPUT: {r['text']}")
        for s in r["segs"]:
            d = " DEP" if s.get("depends_on_other_segment") else ""
            print(f"    -> ({s['intent']}{d}) {s['text']}")
    if not mns_over:
        print("  none")

    print(f"\n{'-'*74}\n  ADVERSARIAL ITEMS (verbatim model output)\n{'-'*74}")
    for r in [x for x in rows if x["class"] == "adversarial"]:
        leak = "LEAK" if r.get("n", 0) > 1 else "clean"
        print(f"\n[{r['id']}] {leak}  n={r.get('n')} ctx={r.get('ctx')} mech={r.get('mech')}")
        print(f"  INPUT: {r['text']}")
        for s in r.get("segs", []):
            print(f"    -> ({s['intent']}) {s['text']}")

    print(f"\n{'-'*74}\n  MECHANICAL CHECK FAILURES\n{'-'*74}")
    mf = [r for r in rows if r.get("outcome") == "ok" and not r.get("mech")]
    for r in mf:
        print(f"\n[{r['id']}] fails={r.get('mech_fails')} coverage={r.get('coverage',0):.2f}")
        print(f"  INPUT: {r['text']}")
        for s in r.get("segs", []):
            print(f"    -> ({s['intent']}) {s['text']}")
    if not mf:
        print("  none")

    lat = [r["latency_ms"] for r in rows if r.get("latency_ms")]
    if lat:
        sl = sorted(lat)
        def p(q): return sl[min(len(sl) - 1, int(q * len(sl)))]
        print(f"\n{'-'*74}\n  LATENCY (ms)\n{'-'*74}")
        print(f"  n={len(lat)} mean={statistics.mean(lat):.0f} p50={p(.5):.0f} "
              f"p90={p(.9):.0f} p95={p(.95):.0f} min={sl[0]:.0f} max={sl[-1]:.0f} first={lat[0]:.0f}")
        # latency by segment count
        bysz = defaultdict(list)
        for r in rows:
            if r.get("latency_ms") and r.get("n") is not None:
                bysz[r["n"]].append(r["latency_ms"])
        for k in sorted(bysz):
            print(f"    {k} segment(s): n={len(bysz[k])} mean={statistics.mean(bysz[k]):.0f} max={max(bysz[k]):.0f}")
    return rows


def determinism(recsA, recsB):
    a = {r["id"]: r for r in recsA}
    b = {r["id"]: r for r in recsB}
    ids = sorted(set(a) | set(b))
    diffs = []
    for i in ids:
        ra, rb = a.get(i), b.get(i)
        def key(r):
            if r is None: return None
            return json.dumps({k: r.get(k) for k in
                               ("outcome", "is_multi_intent", "needs_session_context", "segments")},
                              sort_keys=True)
        if key(ra) != key(rb):
            diffs.append(i)
    print(f"\n{'='*74}\n  DETERMINISM (run A vs run B, greedy)\n{'='*74}")
    print(f"  identical verdicts: {len(ids)-len(diffs)}/{len(ids)}")
    if diffs:
        print(f"  DIFFERING: {', '.join(diffs)}")
        for i in diffs:
            print(f"\n  [{i}]\n    A: {json.dumps(a.get(i,{}).get('segments'))}")
            print(f"    B: {json.dumps(b.get(i,{}).get('segments'))}")
    else:
        print("  fully deterministic")


if __name__ == "__main__":
    fx = json.load(open(sys.argv[1]))["fixtures"]
    recsA = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
    rows = score(fx, recsA)
    report(fx, rows, sys.argv[2])
    if len(sys.argv) > 3:
        recsB = [json.loads(l) for l in open(sys.argv[3]) if l.strip()]
        rowsB = score(fx, recsB)
        report(fx, rowsB, sys.argv[3])
        determinism(recsA, recsB)
