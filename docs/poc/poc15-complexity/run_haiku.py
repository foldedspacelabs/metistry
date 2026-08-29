#!/usr/bin/env python3
"""PoC-15 Haiku complexity-tier scorer via `claude -p --model haiku`.

One call per fixture, no session reuse (matches the AFM recipe: each router
decision is independent). Fail-open on any parse/exec failure to the configured
default tier ("standard"), same contract as the AFM scorer.
"""
import json, subprocess, sys, time, os, re

HERE = os.path.dirname(os.path.abspath(__file__))

# Same rubric as the AFM v1 prompt, adapted for a text-in/JSON-out CLI scorer.
SYSTEM = """You are a router for a personal assistant. You do NOT answer the user's message. You only decide how much model capability is needed to answer it well.

Choose exactly one tier:
- cheap: a conversational reply, an acknowledgment, a simple lookup, or a single straightforward action. A small model handles it fine.
- standard: routine multi-step work that needs competence but not depth. Drafting, summarizing, triaging, scheduling around constraints, reorganizing notes.
- deep: genuine reasoning or real stakes. Multi-constraint planning, consequential decisions, money, health, legal, career, family, or hard analysis where a wrong answer costs the user something.

Rules that matter more than they look:
- Judge the ASK, not the amount of text. A long rambling message whose actual request is "add this to my calendar" is cheap. Venting, backstory, and thinking out loud are not the request.
- A very short message can be deep. "should i sell the house" is far more consequential than a packing list.
- If the user has already resolved a dilemma themselves and is only asking for a small action, that is cheap.
- When genuinely torn between two tiers, choose the higher one. Under-serving a high-stakes question is worse than spending too much on a trivial one.

Reply with ONLY a JSON object, no prose, no code fence:
{"tier": "cheap|standard|deep", "reason": "<one short sentence, max 20 words>"}"""


def extract_json(s):
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s).strip()
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def main():
    fixtures_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "fixtures.json")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "haiku-run.jsonl")
    run_label = sys.argv[3] if len(sys.argv) > 3 else "H"

    fx = json.load(open(fixtures_path))["fixtures"]
    print(f"=== PoC-15 Haiku tier scorer (claude -p --model haiku) run={run_label} ===")
    print(f"items: {len(fx)}")

    recs, lats, calls, retries, fails = [], [], 0, 0, 0
    t0 = time.time()
    for i, f in enumerate(fx):
        prompt = f"{SYSTEM}\n\nMessage from the user:\n{f['text']}"
        rec = {"id": f["id"], "run": run_label, "input": f["text"]}
        parsed, dt, attempt = None, 0.0, 0
        while attempt < 2 and parsed is None:
            attempt += 1
            if attempt > 1:
                retries += 1
            ti = time.time()
            try:
                p = subprocess.run(
                    ["claude", "-p", "--model", "haiku", prompt],
                    capture_output=True, text=True, timeout=120, cwd=HERE)
                calls += 1
                dt = (time.time() - ti) * 1000
                parsed = extract_json(p.stdout)
                if parsed is None:
                    rec["raw"] = (p.stdout or p.stderr)[:300]
            except Exception as e:
                calls += 1
                dt = (time.time() - ti) * 1000
                rec["raw"] = f"EXC {e}"[:300]
        lats.append(dt)
        rec["latency_ms"] = round(dt, 2)
        rec["attempts"] = attempt
        tier = (parsed or {}).get("tier", "")
        if tier not in ("cheap", "standard", "deep"):
            fails += 1
            rec["outcome"] = "fail_open"
            rec["tier"] = "standard"
            rec["reason"] = "(unparseable - fail-open to default tier)"
        else:
            rec["outcome"] = "ok"
            rec["tier"] = tier
            rec["reason"] = str((parsed or {}).get("reason", ""))[:300]
        recs.append(rec)
        print(f"[{i+1:02d}] {rec['id']:<4} {dt:6.0f}ms {rec['tier']:<8} | {rec['reason']}", flush=True)

    total = time.time() - t0
    with open(out_path, "w") as fh:
        for r in recs:
            fh.write(json.dumps(r, sort_keys=True) + "\n")
    s = sorted(lats)
    def pct(p): return s[min(len(s) - 1, int(p / 100 * len(s)))]
    print("---- SUMMARY ----")
    print(f"total wall: {total:.1f}s  calls: {calls}  retries: {retries}  fail-open: {fails}")
    print(f"latency ms: mean {sum(lats)/len(lats):.0f}  p50 {pct(50):.0f}  p90 {pct(90):.0f}  "
          f"p95 {pct(95):.0f}  min {s[0]:.0f}  max {s[-1]:.0f}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
