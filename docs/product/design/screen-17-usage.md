# Screen 17 — Usage, the gauge's popover

New, 2026-09-23. Usage left the sidebar in round B (`brand-kit.md`): a **gauge
beside the bell**, top-right, with capture's "+" — three global controls, no badge.
This is the popover the gauge opens, 400px, `elevated`, like Needs You's.

## 1. Contents, top to bottom

1. **This month against the budget** — the amount, *of $60 this month*, a meter,
   then *$1.84 today · 8 days left*. No projection: a "on pace for" figure is an
   inference, and P5 reports state.
2. **Each day** — a single-series bar chart of daily spend this month; the peak on
   the section heading, *Sep 1* and *today* under the axis. Hover shows the day's
   amount.
3. **Where it went** — agents, routines and chat ranked by spend this month.
4. **One line each:** the cache rate, AWS this month (*not compute*), and calls
   with no price (*count as $0*, from `spend`'s `cost_source`).
5. **Spending limits in Settings →** — limits are set in Settings › Compute (C130) and enforced there (C133); this is where they are read.

## 2. The gauge — no badge

| State | Gauge |
| --- | --- |
| Within budget | `gauge.medium`, secondary ink |
| Over 90% | needle moves (`gauge.high`), primary ink |
| Budget reached | `gauge.high`, warning tint; the popover says *Compute stopped at the $60 budget* with **Raise** |

Needs You keeps the only badge (P2).

## 3. Charts

One series, magnitude → one hue off the sequential ramp, no legend, values in text
ink. **chart-3 in light, chart-2 in dark.** Validated against `elevated`: contrast
passes in both modes; in light every ramp step sits under the validator's 0.10
chroma floor (C87), acceptable for a single series and worth fixing in the tokens.

## 4. Data

`spend` (month, today, by crew and model, unpriced calls), `cache_report` or
`claude_usage_daily` (cache rate), `aws_costs_daily`, and the compute budgets. All
served today.

*Note (W2 housekeeping):* "the budget" on this screen is C130's **spending limit**, read from `GET /api/compute` (the limits and their action) — the popover's copy says *spending limit*, per C130.
