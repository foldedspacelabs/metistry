#!/usr/bin/env python3
"""PoC-16 scoring. Imports PoC-15's analyze.py and reuses its `evaluate()` so the
metric definitions are identical by construction, not by re-implementation."""
import json, os, sys, glob, importlib.util, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
POC15 = os.path.join(os.path.dirname(HERE), "poc15-complexity")

spec = importlib.util.spec_from_file_location("p15", os.path.join(POC15, "analyze.py"))
p15 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p15)

evaluate, ORDER, GT, TIERS = p15.evaluate, p15.ORDER, p15.GT, p15.TIERS
PASS = {"deep_miss": 1, "long_cheap": 5, "short_deep": 5, "acc": 0.85,
        "p95_ms": 3000, "determinism": 1.0, "parse_fail": 0}


def load_jsonl(p):
    out = {}
    for line in open(p):
        line = line.strip()
        if line:
            r = json.loads(line)
            out[r["id"]] = r
    return out


def hr(c="-", n=100):
    return c * n


def main():
    # discover <label>-runA.jsonl / <label>-runB.jsonl pairs
    arms = []
    for lab in sorted({os.path.basename(p)[:-len("-runA.jsonl")]
                       for p in glob.glob(os.path.join(HERE, "*-runA.jsonl"))}):
        a = os.path.join(HERE, f"{lab}-runA.jsonl")
        b = os.path.join(HERE, f"{lab}-runB.jsonl")
        ma = os.path.join(HERE, f"{lab}-runA.meta.json")
        if not os.path.exists(b):
            continue
        ra, rb = load_jsonl(a), load_jsonl(b)
        meta = json.load(open(ma)) if os.path.exists(ma) else {}
        metb_p = os.path.join(HERE, f"{lab}-runB.meta.json")
        metb = json.load(open(metb_p)) if os.path.exists(metb_p) else {}
        arms.append((lab, ra, rb, meta, metb))

    results = []
    for lab, ra, rb, meta, metb in arms:
        r = evaluate(lab, {i: ra[i]["tier"] for i in ra}, ra)
        pa = {i: ra[i]["tier"] for i in ra}
        pb = {i: rb[i]["tier"] for i in rb}
        ids = [i for i in ORDER if i in pa and i in pb]
        dis = [i for i in ids if pa[i] != pb[i]]
        r["det"] = (len(ids) - len(dis)) / len(ids)
        r["det_dis"] = dis
        r["meta"] = meta
        r["metb"] = metb
        r["recs"] = ra
        # run B metrics too (report the WORSE of the two runs honestly)
        rB = evaluate(lab + " (B)", pb, rb)
        r["B"] = rB
        results.append(r)

    # PoC-15 reference arms
    ref = []
    for label, path in [("Haiku (PoC-15)", "haiku-run.jsonl"),
                        ("AFM v1 (PoC-15)", "afm-run-A.jsonl"),
                        ("AFM v2 (PoC-15)", "afm-run-C-v2.jsonl")]:
        p = os.path.join(POC15, path)
        if os.path.exists(p):
            rr = load_jsonl(p)
            ref.append(evaluate(label, {i: rr[i]["tier"] for i in rr}, rr))
    ref.append(evaluate("BASELINE always-standard", p15.always_standard()))
    ref.append(evaluate("BASELINE always-deep", p15.always_deep()))
    ref.append(evaluate("BASELINE length-heuristic", p15.length_heuristic()))
    ref.append(evaluate("ORACLE (perfect)", p15.oracle()))

    print(hr("="))
    print("PoC-16  LOCAL (Ollama) COMPLEXITY-TIER SCORER EVALUATION   n=48 fixtures")
    print("fixtures / rubric / metrics all reused verbatim from PoC-15")
    print(hr("="))

    print("\n" + hr("="))
    print("METRIC TABLE  (run A; determinism vs run B)")
    print(hr("="))
    h = (f"{'scorer':<30} {'acc':>6} {'deep-miss':>10} {'overspend':>10} "
         f"{'longC':>6} {'shortD':>7} {'det':>7} {'pf':>4} {'p95ms':>8} {'RAM':>7}")
    print(h)
    print(hr("-", len(h)))
    for r in results:
        lc, sd = r["traps"]["long_cheap"], r["traps"]["short_deep"]
        m = r["meta"]
        p95 = m.get("lat", {}).get("p95", float("nan"))
        print(f"{r['name']:<30} {r['acc']*100:5.1f}% "
              f"{len(r['deep_miss'])}/{r['deep_n']:<7} {len(r['overspend'])}/{r['cheap_n']:<7} "
              f"{lc[0]}/{lc[1]:<4} {sd[0]}/{sd[1]:<5} "
              f"{r['det']*100:6.1f}% {m.get('parse_fail_after_retry','?'):>4} "
              f"{p95:8.0f} {m.get('ram','-'):>7}")
    print(hr("-", len(h)))
    for r in ref:
        lc, sd = r["traps"]["long_cheap"], r["traps"]["short_deep"]
        lat = r["lat"]
        p95s = f"{lat[2]:8.0f}" if lat else f"{'-':>8}"
        if r["name"].startswith("Haiku"):
            p95s = f"{'n/a*':>8}"
        print(f"{r['name']:<30} {r['acc']*100:5.1f}% "
              f"{len(r['deep_miss'])}/{r['deep_n']:<7} {len(r['overspend'])}/{r['cheap_n']:<7} "
              f"{lc[0]}/{lc[1]:<4} {sd[0]}/{sd[1]:<5} "
              f"{'-':>7} {'-':>4} {p95s} {'-':>7}")
    print("\n  * Haiku p95 from PoC-15 was measured through the `claude -p` agent harness")
    print("    (process spawn + session setup per call) and is NOT a model-latency number.")
    print("  det = tier agreement between two identical temp-0 runs; pf = parse failures after retry")

    print("\n" + hr("="))
    print("PASS BAR  (pre-registered: deep-miss<=1/16, longC>=5/6, shortD>=5/6,")
    print("           acc>=85%, p95<=3000ms warm, determinism=100%, parse-fail=0)")
    print(hr("="))
    for r in results:
        m = r["meta"]
        lc, sd = r["traps"]["long_cheap"], r["traps"]["short_deep"]
        p95 = m.get("lat", {}).get("p95", 1e9)
        checks = [
            ("deep-miss<=1", len(r["deep_miss"]) <= 1, f"{len(r['deep_miss'])}/16"),
            ("longC>=5/6", lc[0] >= 5, f"{lc[0]}/6"),
            ("shortD>=5/6", sd[0] >= 5, f"{sd[0]}/6"),
            ("acc>=85%", r["acc"] >= 0.85, f"{r['acc']*100:.1f}%"),
            ("p95<=3000ms", p95 <= 3000, f"{p95:.0f}ms"),
            ("determinism=100%", r["det"] >= 1.0, f"{r['det']*100:.1f}%"),
            ("parse-fail=0", m.get("parse_fail_after_retry", 1) == 0,
             str(m.get("parse_fail_after_retry", "?"))),
        ]
        ok = all(c[1] for c in checks)
        print(f"\n  {r['name']}: {'PASS' if ok else 'FAIL'}")
        for nm, good, val in checks:
            print(f"      [{'x' if good else ' '}] {nm:<20} {val}")

    print("\n" + hr("="))
    print("PREDICTION DISTRIBUTION  (truth is 16 cheap / 16 standard / 16 deep)")
    print(hr("="))
    for r in results + ref:
        d = r["dist"]
        print(f"  {r['name']:<30} cheap={d['cheap']:2d}  standard={d['standard']:2d}  deep={d['deep']:2d}")

    print("\n" + hr("="))
    print("CONFUSION MATRICES  (local arms)")
    print(hr("="))
    for r in results:
        print(f"\n  {r['name']}  (acc {r['acc']*100:.1f}%)")
        p15.print_conf(r)

    print("\n" + hr("="))
    print("LATENCY  (ms, warm; model-load first call reported separately)")
    print(hr("="))
    print(f"  {'scorer':<30} {'load':>9} {'mean':>8} {'p50':>8} {'p90':>8} {'p95':>8} {'max':>8} {'wall48':>8}")
    for r in results:
        m = r["meta"]
        L = m.get("lat", {})
        print(f"  {r['name']:<30} {m.get('load_ms',0):9.0f} {L.get('mean',0):8.0f} "
              f"{L.get('p50',0):8.0f} {L.get('p90',0):8.0f} {L.get('p95',0):8.0f} "
              f"{L.get('max',0):8.0f} {m.get('wall_s',0):7.1f}s")

    print("\n" + hr("="))
    print("DETERMINISM DETAIL (two identical temp-0 runs)")
    print(hr("="))
    for r in results:
        print(f"  {r['name']:<30} {r['det']*100:6.1f}%  "
              f"({len(r['det_dis'])} disagreement(s))")
        for i in r["det_dis"]:
            print(f"      {i}: runA={r['pred'][i]:<9} runB={r['B']['pred'][i]:<9} "
                  f"truth={GT[i]['tier']:<9} | {GT[i]['text'][:55]}")

    print("\n" + hr("="))
    print("PARSE FAILURES / RETRIES")
    print(hr("="))
    print(f"  {'scorer':<30} {'mode':<13} {'1st-attempt fails':>18} {'retries':>9} {'after retry':>13}")
    for r in results:
        m = r["meta"]
        print(f"  {r['name']:<30} {m.get('mode','?'):<13} "
              f"{m.get('parse_fail_first_attempt','?'):>18} {m.get('retries','?'):>9} "
              f"{m.get('parse_fail_after_retry','?'):>13}")

    print("\n" + hr("="))
    print("EVERY DEEP-MISS, VERBATIM, WITH THE MODEL'S STATED REASON")
    print(hr("="))
    for r in results:
        if not r["deep_miss"]:
            print(f"\n  {r['name']}: NO deep-misses")
            continue
        print(f"\n  {r['name']}: {len(r['deep_miss'])} deep-miss(es)")
        for i in r["deep_miss"]:
            g = GT[i]
            print(f"    [{i}] truth=deep  predicted={r['pred'][i]}  trap={g['trap_class']}")
            print(f"        INPUT : {g['text'][:300]}")
            print(f"        REASON: {r['recs'][i].get('reason','(n/a)')}")

    print("\n" + hr("="))
    print("TRAP DETAIL (12 trap items, all local arms + Haiku)")
    print(hr("="))
    allr = results + [x for x in ref if x["name"].startswith("Haiku")]
    trap_ids = [i for i in ORDER if GT[i]["trap_class"] != "none"]
    print(f"  {'id':<5} {'truth':<9} " + " ".join(f"{r['name'][:13]:<13}" for r in allr))
    for i in trap_ids:
        row = " ".join(f"{r['pred'][i][:13]:<13}" for r in allr)
        mark = "" if all(r["pred"][i] in GT[i]["accept"] for r in allr) else ""
        print(f"  {i:<5} {GT[i]['tier']:<9} {row}  | {GT[i]['text'][:44]}")

    print("\n" + hr("="))
    print("COST / 1000 TURNS under PoC-15's realistic priors")
    print(hr("="))
    COST = p15.COST
    for pname, prior in [("cheap-heavy 60/30/10", {"cheap": .60, "standard": .30, "deep": .10}),
                         ("balanced-ish 45/40/15", {"cheap": .45, "standard": .40, "deep": .15})]:
        print(f"\n  prior = {pname}")
        print(f"  {'scorer':<30} {'routed $/1k':>12} {'scorer $/1k':>12} {'net $/1k':>10} {'vs always-deep':>15}")
        print(hr("-", 84))
        for r in results + ref:
            per_turn = 0.0
            for t in TIERS:
                row = r["conf"][t]
                tot = sum(row.values())
                if tot:
                    per_turn += prior[t] * sum(row[c] * COST[c] for c in TIERS) / tot
            scorer_cost = 0.001 if r["name"].startswith("Haiku") else 0.0
            net = per_turn + scorer_cost
            print(f"  {r['name']:<30} {per_turn*1000:12.2f} {scorer_cost*1000:12.2f} "
                  f"{net*1000:10.2f} {(net-0.08)/0.08*100:+14.1f}%")


if __name__ == "__main__":
    main()
