#!/usr/bin/env python3
"""PoC-15 scoring: routing-relevant metrics for complexity-tier scorers."""
import json, os, sys, statistics
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = ["cheap", "standard", "deep"]
RANK = {t: i for i, t in enumerate(TIERS)}
COST = {"cheap": 0.002, "standard": 0.01, "deep": 0.08}

fx = json.load(open(os.path.join(HERE, "fixtures.json")))["fixtures"]
GT = {f["id"]: f for f in fx}
ORDER = [f["id"] for f in fx]


def load_jsonl(p):
    out = {}
    if not os.path.exists(p):
        return None
    for line in open(p):
        line = line.strip()
        if line:
            r = json.loads(line)
            out[r["id"]] = r
    return out


def predictions_from(recs):
    return {i: recs[i]["tier"] for i in recs}


def always_standard():
    return {i: "standard" for i in ORDER}


def always_deep():
    return {i: "deep" for i in ORDER}


def length_heuristic():
    out = {}
    for i in ORDER:
        n = len(GT[i]["text"])
        out[i] = "cheap" if n < 60 else ("deep" if n > 400 else "standard")
    return out


def oracle():
    # oracle spends the minimum acceptable tier for each item
    return {i: min(GT[i]["accept"], key=lambda t: RANK[t]) for i in ORDER}


def hr(c="-", n=78):
    return c * n


def evaluate(name, pred, recs=None):
    ids = [i for i in ORDER if i in pred]
    n = len(ids)
    correct = [i for i in ids if pred[i] in GT[i]["accept"]]
    acc = len(correct) / n

    # confusion: rows = ground truth primary tier, cols = predicted
    conf = {t: Counter() for t in TIERS}
    for i in ids:
        conf[GT[i]["tier"]][pred[i]] += 1

    # deep-miss: true-deep items routed BELOW deep (accept-aware: a deep item whose
    # accept list includes standard is not a miss if standard was chosen)
    deep_items = [i for i in ids if GT[i]["tier"] == "deep"]
    deep_miss = [i for i in deep_items if pred[i] not in GT[i]["accept"]
                 and RANK[pred[i]] < RANK["deep"]]
    # strict variant: any true-deep item not routed to deep, ambiguity ignored
    deep_miss_strict = [i for i in deep_items if pred[i] != "deep"]

    # overspend: true-cheap routed to deep
    cheap_items = [i for i in ids if GT[i]["tier"] == "cheap"]
    overspend = [i for i in cheap_items if pred[i] == "deep"]
    # any upward error at all on cheap items
    cheap_up = [i for i in cheap_items if pred[i] not in GT[i]["accept"]]

    # traps
    traps = {}
    for tc in ["long_cheap", "short_deep"]:
        t_ids = [i for i in ids if GT[i]["trap_class"] == tc]
        hits = [i for i in t_ids if pred[i] in GT[i]["accept"]]
        traps[tc] = (len(hits), len(t_ids), [i for i in t_ids if i not in hits])

    # cost
    routed_cost = sum(COST[pred[i]] for i in ids)

    # latency
    lat = None
    if recs:
        L = sorted(r["latency_ms"] for r in recs.values() if "latency_ms" in r)
        if L:
            def pct(p): return L[min(len(L) - 1, int(p / 100 * len(L)))]
            lat = (statistics.mean(L), pct(50), pct(95), L[0], L[-1])

    return {
        "name": name, "n": n, "acc": acc, "conf": conf,
        "deep_miss": deep_miss, "deep_miss_strict": deep_miss_strict,
        "deep_n": len(deep_items), "overspend": overspend, "cheap_up": cheap_up,
        "cheap_n": len(cheap_items), "traps": traps, "cost": routed_cost,
        "lat": lat, "pred": pred, "dist": Counter(pred[i] for i in ids),
    }


def print_conf(r):
    print(f"    confusion (rows=truth, cols=predicted)")
    print(f"    {'':>10} " + " ".join(f"{c:>9}" for c in TIERS))
    for t in TIERS:
        print(f"    {t:>10} " + " ".join(f"{r['conf'][t][c]:>9}" for c in TIERS))


def main():
    runs = OrderedDict()
    for label, path in [
        ("AFM v1 (run A)", "afm-run-A.jsonl"),
        ("AFM v1 (run B)", "afm-run-B.jsonl"),
        ("AFM v2 (run C)", "afm-run-C-v2.jsonl"),
        ("AFM v2 (run D)", "afm-run-D-v2.jsonl"),
        ("Haiku (run H)", "haiku-run.jsonl"),
    ]:
        recs = load_jsonl(os.path.join(HERE, path))
        if recs:
            runs[label] = recs

    results = []
    for label, recs in runs.items():
        results.append(evaluate(label, predictions_from(recs), recs))
    results.append(evaluate("BASELINE always-standard", always_standard()))
    results.append(evaluate("BASELINE always-deep", always_deep()))
    results.append(evaluate("BASELINE length-heuristic", length_heuristic()))
    results.append(evaluate("ORACLE (perfect)", oracle()))

    print(hr("="))
    print("PoC-15  COMPLEXITY-TIER SCORER EVALUATION   n=48 fixtures")
    print(hr("="))

    # fixture design summary
    lens = [len(f["text"]) for f in fx]
    rank_ = [RANK[f["tier"]] for f in fx]
    mx, my = statistics.mean(lens), statistics.mean(rank_)
    num = sum((a - mx) * (b - my) for a, b in zip(lens, rank_))
    den = (sum((a - mx) ** 2 for a in lens) * sum((b - my) ** 2 for b in rank_)) ** 0.5
    print(f"\nFIXTURES: {Counter(f['tier'] for f in fx)}  ambiguous={sum(1 for f in fx if len(f['accept'])==2)}")
    print(f"  traps: {Counter(f['trap_class'] for f in fx)}")
    print(f"  pearson r(chars, tier-rank) = {num/den:+.4f}   <- length does NOT predict tier")
    for t in TIERS:
        L = [len(f["text"]) for f in fx if f["tier"] == t]
        print(f"  {t:<9} n={len(L):2d} chars mean={statistics.mean(L):5.0f} median={statistics.median(L):5.0f} min={min(L):3d} max={max(L):3d}")

    print("\n" + hr("="))
    print("METRIC TABLE")
    print(hr("="))
    hdr = (f"{'scorer':<26} {'acc':>6} {'deep-miss':>10} {'strict-dm':>10} "
           f"{'overspend':>10} {'longC':>6} {'shortD':>7} {'$/48':>7}")
    print(hdr)
    print(hr("-", len(hdr)))
    for r in results:
        lc = r["traps"]["long_cheap"]; sd = r["traps"]["short_deep"]
        print(f"{r['name']:<26} {r['acc']*100:5.1f}% "
              f"{len(r['deep_miss'])}/{r['deep_n']} {len(r['deep_miss'])/r['deep_n']*100:5.1f}% "
              f"{len(r['deep_miss_strict'])/r['deep_n']*100:9.1f}% "
              f"{len(r['overspend'])}/{r['cheap_n']} {len(r['overspend'])/r['cheap_n']*100:5.1f}% "
              f"{lc[0]}/{lc[1]:<4} {sd[0]}/{sd[1]:<5} "
              f"${r['cost']:6.3f}")

    print("\n  acc        = predicted tier in the accepted-label set (ambiguous items: either counts)")
    print("  deep-miss  = true-deep items routed BELOW deep, accept-aware (THE costly error)")
    print("  strict-dm  = same but ignoring the one ambiguous deep item's standard allowance")
    print("  overspend  = true-cheap items routed to deep (wasted money, harmless)")
    print("  longC      = LONG-but-cheap traps hit;  shortD = SHORT-but-deep traps hit")

    print("\n" + hr("="))
    print("PREDICTION DISTRIBUTION  (truth is 16/16/16)")
    print(hr("="))
    for r in results:
        d = r["dist"]
        print(f"  {r['name']:<26} cheap={d['cheap']:2d}  standard={d['standard']:2d}  deep={d['deep']:2d}")

    print("\n" + hr("="))
    print("CONFUSION MATRICES")
    print(hr("="))
    for r in results:
        print(f"\n  {r['name']}  (acc {r['acc']*100:.1f}%)")
        print_conf(r)

    print("\n" + hr("="))
    print("LATENCY  (ms) - sits in front of a 5-10s model turn, never the 24ms fast path")
    print(hr("="))
    for r in results:
        if r["lat"]:
            m, p50, p95, lo, hi = r["lat"]
            print(f"  {r['name']:<26} mean {m:7.0f}  p50 {p50:7.0f}  p95 {p95:7.0f}  min {lo:7.0f}  max {hi:7.0f}")
        else:
            print(f"  {r['name']:<26} 0 (pure arithmetic, sub-millisecond)")

    print("\n" + hr("="))
    print("DETERMINISM (greedy, two identical runs)")
    print(hr("="))
    for a, b in [("AFM v1 (run A)", "AFM v1 (run B)"), ("AFM v2 (run C)", "AFM v2 (run D)")]:
        if a in runs and b in runs:
            pa, pb = predictions_from(runs[a]), predictions_from(runs[b])
            ids = [i for i in ORDER if i in pa and i in pb]
            agree = [i for i in ids if pa[i] == pb[i]]
            dis = [i for i in ids if pa[i] != pb[i]]
            print(f"  {a} vs {b}: {len(agree)}/{len(ids)} = {len(agree)/len(ids)*100:.1f}% tier agreement")
            for i in dis:
                print(f"      DISAGREE {i}: {pa[i]} vs {pb[i]}   | {GT[i]['text'][:70]}")
    # cross-prompt
    if "AFM v1 (run A)" in runs and "AFM v2 (run C)" in runs:
        pa, pc = predictions_from(runs["AFM v1 (run A)"]), predictions_from(runs["AFM v2 (run C)"])
        ids = [i for i in ORDER if i in pa and i in pc]
        ag = sum(1 for i in ids if pa[i] == pc[i])
        print(f"  AFM v1 vs AFM v2 (prompt sensitivity): {ag}/{len(ids)} = {ag/len(ids)*100:.1f}% agreement")

    print("\n" + hr("="))
    print("COST SIMULATION  (48 turns; cheap=$0.002 standard=$0.010 deep=$0.080)")
    print(hr("="))
    base = next(r for r in results if r["name"] == "BASELINE always-standard")["cost"]
    orc = next(r for r in results if r["name"] == "ORACLE (perfect)")["cost"]
    print(f"  {'scorer':<26} {'routed $':>9} {'vs always-std':>14} {'+scoring $':>11} {'net $':>9} {'net vs std':>11}")
    print(hr("-", 86))
    for r in results:
        # scoring overhead: AFM local = $0, Haiku scorer call ~ $0.001/turn
        per = 0.001 if r["name"].startswith("Haiku") else 0.0
        sc = per * r["n"]
        net = r["cost"] + sc
        print(f"  {r['name']:<26} ${r['cost']:8.3f} {(r['cost']-base)/base*100:+13.1f}% "
              f"${sc:10.3f} ${net:8.3f} {(net-base)/base*100:+10.1f}%")
    deepbase = next(r for r in results if r["name"] == "BASELINE always-deep")["cost"]
    print(f"\n  always-standard: ${base:.3f}   always-deep: ${deepbase:.3f}   oracle: ${orc:.3f}")
    print("  NOTE: with deep at 8x standard, ANY scorer that correctly finds the 16 deep")
    print("  items necessarily spends MORE than always-standard. The oracle itself is")
    print(f"  {(orc-base)/base*100:+.0f}% vs always-standard. always-standard is not a cost")
    print("  baseline a router can beat -- it is a QUALITY floor that happens to be cheap.")
    print("  The quality-matched comparison is vs always-deep.")
    print(f"\n  {'scorer':<26} {'net $':>9} {'vs always-deep':>15}")
    print(hr("-", 55))
    for r in results:
        per = 0.001 if r["name"].startswith("Haiku") else 0.0
        net = r["cost"] + per * r["n"]
        print(f"  {r['name']:<26} ${net:8.3f} {(net-deepbase)/deepbase*100:+14.1f}%")

    print("\n" + hr("="))
    print("COST UNDER A REALISTIC MESSAGE MIX")
    print(hr("="))
    print("  The 48 fixtures are deliberately balanced 16/16/16 and trap-loaded. A real")
    print("  personal-assistant stream that has ALREADY lost commands and fast-path regex")
    print("  hits is still cheap-heavy. Reweighting each scorer's per-true-tier routing")
    print("  behaviour (from its confusion matrix) by two illustrative priors:")
    for pname, prior in [("cheap-heavy 60/30/10", {"cheap": .60, "standard": .30, "deep": .10}),
                         ("balanced-ish 45/40/15", {"cheap": .45, "standard": .40, "deep": .15})]:
        print(f"\n  prior = {pname}")
        print(f"  {'scorer':<26} {'$/turn':>9} {'$/1000 turns':>13} {'vs always-deep':>15} {'deep-miss/1000':>15}")
        print(hr("-", 84))
        for r in results:
            per_turn = 0.0
            dm_rate_per_true_deep = len(r["deep_miss"]) / r["deep_n"]
            for t in TIERS:
                row = r["conf"][t]
                tot = sum(row.values())
                if not tot:
                    continue
                exp = sum(row[c] * COST[c] for c in TIERS) / tot
                per_turn += prior[t] * exp
            if r["name"].startswith("Haiku"):
                per_turn += 0.001
            adeep = 0.08 + (0.0)
            print(f"  {r['name']:<26} ${per_turn:8.4f} ${per_turn*1000:12.2f} "
                  f"{(per_turn-adeep)/adeep*100:+14.1f}% "
                  f"{prior['deep']*dm_rate_per_true_deep*1000:14.1f}")

    print("\n" + hr("="))
    print("EVERY DEEP-MISS, VERBATIM, WITH THE SCORER'S STATED REASON")
    print(hr("="))
    for r in results:
        recs = runs.get(r["name"])
        if not r["deep_miss"] and not (r["name"].startswith("BASELINE") and r["deep_miss"]):
            if not r["deep_miss"]:
                print(f"\n  {r['name']}: NO deep-misses")
                continue
        print(f"\n  {r['name']}: {len(r['deep_miss'])} deep-miss(es)")
        for i in r["deep_miss"]:
            g = GT[i]
            print(f"    [{i}] truth=deep  predicted={r['pred'][i]}  trap={g['trap_class']}")
            print(f"        INPUT : {g['text'][:200]}")
            if recs and i in recs:
                print(f"        REASON: {recs[i].get('reason','(n/a)')}")

    print("\n" + hr("="))
    print("TRAP DETAIL  (per-item, all scorers)")
    print(hr("="))
    trap_ids = [i for i in ORDER if GT[i]["trap_class"] != "none"]
    names = [r["name"] for r in results]
    print(f"  {'id':<5} {'truth':<9} " + " ".join(f"{n[:11]:<11}" for n in names))
    for i in trap_ids:
        row = " ".join(f"{r['pred'][i][:11]:<11}" for r in results)
        print(f"  {i:<5} {GT[i]['tier']:<9} {row}   | {GT[i]['text'][:48]}")


if __name__ == "__main__":
    main()
