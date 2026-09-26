# Screen 15 — Settings, the window

New, 2026-09-23. Settings is its own window on Mac, never a pane in the main one.

**Owner's rulings:** a sidebar, grouped; **Connections is renamed Account**; and
the window is **not resizable** — it is a fixed size chosen for its content.

## 1. Sections

```
Instance · Services · Compute · Updates
ACCESS    Account · Connections · Secrets · Variables
CAPTURE   Live Capture · Sessions
Keyboard · Advanced
```

The app today has seven sections as toolbar tabs (`SettingsModel.Section`).
Round E added three — Resources (screen 9), Live Capture (screen 11), Sessions
(screen 12) — and ten do not fit as tabs. **Account** is the old *Connections*:
console sign-in and the instance repository. The old name read as a sibling of
Resources, which holds external servers.

> **2026-09-25 (C114, C116, C117):** Resources is now **Connections**; **Secrets**
> and **Variables** are panes of their own (screen 19).

The Resources board first drew an invented section list (General, Compute,
Knowledge, Resources, Notifications, Advanced). It now draws this one.

## 2. Size — fixed, and set by the widest pane

**840 × 600**: a 200px sidebar and a 640px pane, up from 640 × 520. The widest
pane is the Resources list; as first drawn it needed ~720px before its *granted
to* column had room. Its fixed columns were tightened (server 140, kind 124, tools
80, gap 12) so it fits 640 with 180px for *granted to*. Measured at 520–720px; at
640 no pane overflows sideways.

## 3. Larger text (C62, closed)

**Every pane scrolls vertically.** Larger text lengthens a pane and never clips it;
columns that cannot shrink wrap their text rather than pushing the pane sideways.
That is how a fixed window stays accessible without being resizable.

## 4. What this asks of the build

1. `SettingsView`: `TabView` → a sidebar `NavigationSplitView` at a fixed
   840 × 600, with each pane in a vertical `ScrollView`.
2. `SettingsModel.Section`: rename `connections` → `account` (title *Account*),
   add `resources`, `liveCapture`, `sessions`, and group them.

## 5. The panes (2026-09-25, board `Settings-Panes`, C123–C127)

### 5.1 Instance
The Assistant (Name, Mention, Mark, Instance ID; a protected write shown in
Activity) · This instance (path, Choose…, Open in Finder, namespace and ports) ·
Recent (up to 8, Forget) · Linked instances (origin, capabilities, last seen;
Link an Instance…, Refresh, Remove).

### 5.2 Services
Doctor (Run Doctor; each problem with its fix; checks passed) · the supervisor
(launchd or compose; Restart All, Stop All) and one row per service — state,
uptime or reason, port, Restart · Stop · Log · When it runs (Start at Login, Run
in the Background, Keep this Mac Awake — and under it, disabled while it is off,
Allow sleep on battery and Allow sleep when the lid is closed, both on, each with
a warning tip; C129).

### 5.3 Compute (C130, C132)

One column, in this order:

1. **Metis uses** — one model dropdown and effort. No fallback.
2. **Providers** — one line each: switch (off = not searched, not offered),
   name, one tag (*Local* · *Cloud* · *Subscription*), an issue only when there
   is one (*Not running*, *Key not set*), then **Test**, the **gear** and
   **Remove**. The gear opens the provider's settings: base URL, key as a secret,
   headers (secrets and variables allowed), data policy (ZDR only · Any), Test,
   Save. *Add Provider…* below.
3. **Your Models** — Memory and Disk bars; the search field with **Refresh**
   beside it (re-reads every switched-on provider's catalogue); by default *On
   this Mac* then *Cloud*, one line each: **name** maker · provider · tag ·
   loaded state and size, or price / *In your plan* · Load, Unload or Remove.
4. **Spending limits** — per day, per month, then Allow · Stop · Critical only;
   a subscription's window is its limit. **Enforced** before every call (C133).

**A model is written one way everywhere**: **name** maker · provider · tag. The
dropdown that picks one (Metis, an agent's definition) shows all of it in the
field and in its menu, grouped *On this Mac*, *Cloud*, with price on the right.
Tags: *Local* (free), *Cloud* (by the token), *Subscription*. There is no
*By token* tag.

#### 5.3.1 One model, several places (C131)

Search results group by **model**: name, maker, context, capabilities, *N
places*. Under it, one line per place:

| Place | Shows | Action |
| --- | --- | --- |
| Cloud | provider, ZDR, price per M tokens in / out; **Cheapest** marked | Add |
| Cloud, subscription | provider, *Included in <plan>* | Add |
| Local | provider, quantisation, size, memory needed; *Fits* · *Tight fit* · *Too large* | Install (disabled when too large) |

Filters: Local · Cloud · Subscription · Fits this Mac · Tools.
Sort: Best match · Cheapest · Largest context. A collapsed result reads *Local or
cloud · from $0.10 per M*. An agent's definition picks a model, then where it
runs (screen 7 §3.4).

### 5.4 Updates
This app (version and channel, Check Now, automatic) · Metistry runtime (running
version, available version with What's New and Update Runtime, previous kept
with Roll Back).

### 5.5 Keyboard
One switch, *Shortcuts in any app*, off by default; the five shortcuts under it.
In-app shortcuts are always on — *Show All* ⌘/.

### 5.6 Advanced
Runtime from (Releases · Git checkout), command, product folder · Developer
override · Versions · Diagnostics (Logs, Passkeys). Doctor moved to Services.
