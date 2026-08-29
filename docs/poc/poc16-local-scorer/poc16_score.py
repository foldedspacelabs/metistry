#!/usr/bin/env python3
"""PoC-16 local complexity-tier scorer via Ollama's OpenAI-compatible API.

Bare HTTP POST to /v1/chat/completions. No agent harness, no tools, no session
reuse -- one independent call per fixture, exactly like the router would make it.
This also removes PoC-15's Haiku-side harness contamination on the local arm:
the latency measured here is model time plus loopback HTTP, nothing else.

Rubric text is byte-identical to run_haiku.py's SYSTEM string so the two are
comparable.

Structured output: prefers OpenAI-style response_format=json_schema; falls back
to json_object, then to free-text + regex extraction. Parse failures get exactly
one retry, then fail open to the default tier ("standard") -- same contract as
the AFM and Haiku scorers.
"""
import json, os, re, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
POC15 = os.path.join(os.path.dirname(HERE), "poc15-complexity")
BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")

# ---- byte-identical rubric from poc15/run_haiku.py -------------------------
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

SCHEMA = {
    "type": "object",
    "properties": {
        "tier": {"type": "string", "enum": ["cheap", "standard", "deep"]},
        "reason": {"type": "string"},
    },
    "required": ["tier", "reason"],
    "additionalProperties": False,
}


def post(path, payload, timeout=600):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer ollama"},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def extract_json(s):
    """Same permissive extraction as PoC-15, plus <think> stripping."""
    if not s:
        return None
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.S)
    s = re.sub(r"<thinking>.*?</thinking>", "", s, flags=re.S)
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s).strip()
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def build(model, text, mode, think):
    p = {
        "model": model,
        "temperature": 0,
        "top_p": 1,
        "seed": 42,
        "max_tokens": 4096 if think else 300,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Message from the user:\n" + text},
        ],
    }
    if mode == "schema":
        p["response_format"] = {"type": "json_schema", "json_schema": {
            "name": "tier_verdict", "strict": True, "schema": SCHEMA}}
    elif mode == "json_object":
        p["response_format"] = {"type": "json_object"}
    # Thinking control. Ollama's /v1 endpoint IGNORES the native `think` field but
    # DOES honour OpenAI-style `reasoning_effort` (verified empirically on 0.33).
    # "none" suppresses the reasoning channel entirely -- the right default for a
    # router scorer, where a 30s deliberation fails on latency regardless of accuracy.
    if not think:
        p["reasoning_effort"] = "none"
    return p


def probe_mode(model, think):
    """Find the strongest structured-output mode this model/server accepts."""
    for mode in ("schema", "json_object", "text"):
        try:
            r = post("/v1/chat/completions",
                     build(model, "ping, are we still on for lunch?", mode, think),
                     timeout=900)
            c = r["choices"][0]["message"].get("content") or ""
            if extract_json(c) is not None:
                return mode
        except Exception:
            continue
    return "text"


def main():
    model = sys.argv[1]
    run_label = sys.argv[2]
    out_path = sys.argv[3]
    think = len(sys.argv) > 4 and sys.argv[4] == "think"

    fx = json.load(open(os.path.join(POC15, "fixtures.json")))["fixtures"]
    print(f"=== PoC-16 local tier scorer  model={model} run={run_label} think={think} ===")

    # cold-start / model-load measurement: time the very first call separately
    t_load0 = time.time()
    mode = probe_mode(model, think)
    load_ms = (time.time() - t_load0) * 1000
    print(f"structured-output mode: {mode}   first-call(load+probe): {load_ms:.0f}ms")

    recs, lats, retries, fails, parse_fail_first = [], [], 0, 0, 0
    tok_in = tok_out = 0
    t0 = time.time()
    for i, f in enumerate(fx):
        rec = {"id": f["id"], "run": run_label, "model": model, "input": f["text"]}
        parsed, dt, attempt = None, 0.0, 0
        while attempt < 2 and parsed is None:
            attempt += 1
            if attempt > 1:
                retries += 1
            ti = time.time()
            try:
                r = post("/v1/chat/completions", build(model, f["text"], mode, think))
                dt = (time.time() - ti) * 1000
                c = r["choices"][0]["message"].get("content") or ""
                u = r.get("usage") or {}
                tok_in += u.get("prompt_tokens", 0) or 0
                tok_out += u.get("completion_tokens", 0) or 0
                parsed = extract_json(c)
                if parsed is None:
                    if attempt == 1:
                        parse_fail_first += 1
                    rec["raw"] = c[:300]
            except Exception as e:
                dt = (time.time() - ti) * 1000
                rec["raw"] = f"EXC {e}"[:300]
                if attempt == 1:
                    parse_fail_first += 1
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
        print(f"[{i+1:02d}] {rec['id']:<4} {dt:7.0f}ms {rec['tier']:<8} | {rec['reason'][:70]}",
              flush=True)

    total = time.time() - t0
    with open(out_path, "w") as fh:
        for r in recs:
            fh.write(json.dumps(r, sort_keys=True) + "\n")
    s = sorted(lats)

    def pct(p):
        return s[min(len(s) - 1, int(p / 100 * len(s)))]

    # resident footprint while still warm
    ram, proc = "-", "-"
    try:
        import subprocess
        out = subprocess.run(["ollama", "ps"], capture_output=True, text=True, timeout=20).stdout
        for line in out.splitlines()[1:]:
            if line.split() and model.split(":")[0] in line:
                parts = line.split()
                ram = " ".join(parts[2:4])
                proc = " ".join(parts[4:6])
                break
    except Exception:
        pass
    print(f"ollama ps footprint: {ram}  processor: {proc}")

    meta = {"model": model, "run": run_label, "think": think, "mode": mode,
            "ram": ram, "processor": proc,
            "load_ms": round(load_ms, 1), "n": len(fx),
            "parse_fail_first_attempt": parse_fail_first, "retries": retries,
            "parse_fail_after_retry": fails, "wall_s": round(total, 1),
            "tok_in": tok_in, "tok_out": tok_out,
            "lat": {"mean": sum(lats) / len(lats), "p50": pct(50), "p90": pct(90),
                    "p95": pct(95), "min": s[0], "max": s[-1]}}
    with open(out_path.replace(".jsonl", ".meta.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print("---- SUMMARY ----")
    print(f"mode {mode}  wall {total:.1f}s  retries {retries}  "
          f"parse-fail(1st) {parse_fail_first}  parse-fail(after retry) {fails}")
    print(f"latency ms: mean {meta['lat']['mean']:.0f}  p50 {pct(50):.0f}  "
          f"p90 {pct(90):.0f}  p95 {pct(95):.0f}  min {s[0]:.0f}  max {s[-1]:.0f}")
    print(f"tokens: in {tok_in} out {tok_out}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
