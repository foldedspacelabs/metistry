# Keeping the Mac awake while Metistry runs (2026-09-19)

Research for **Q1**, `docs/plan-refresh-2026-09-13.md` §4a. Nothing here is
built: this is the shape to build, what it costs, and the decisions that are
the owner's.

Sources are Apple's own and were read locally where a local copy exists — the
installed SDK's `IOPMLib.h` and `IOPowerSources.h`, `caffeinate(8)`,
`pmset(1)`, `launchd.plist(5)`, `launchctl(1)` — plus this Studio's live power
state (read-only `pmset`, no writes, no `sudo`) and one six-second
`caffeinate` experiment whose real output is below. Repo facts cite the file.

## The short version

1. **`caffeinate -i` and `IOPMAssertionCreateWithName(PreventUserIdleSystemSleep)`
   are the same assertion.** `caffeinate` is a thin wrapper over the same
   IOKit call, so the choice is about which process holds it, not about
   capability. Invariant 6 — native only where macOS requires it — settles it:
   macOS does not require native here, so **`caffeinate -i`, no Swift**.
2. **The holder is `apps/watchdog`.** It is the one component of ours that is
   `runs_on: host` and always up under *both* shapes: the supervisor under
   `launchd`, the plain watchdog under `compose`. One implementation covers
   both shapes and no-ops off macOS.
3. **The display is unaffected**, which is exactly the ask. The header is
   explicit: "The display may dim and idle sleep […] but the system may not
   idle sleep."
4. **On battery it is honoured, and we should still release it.** Nothing
   restricts `PreventUserIdleSystemSleep` to wall power (unlike
   `caffeinate -s`, which the man page says is "valid only when system is
   running on AC power"). `auto` = hold on `AC Power`, release on
   `Battery Power` *and* `UPS Power` — the Studio has a UPS, so the second
   case is real here even with no battery.
5. **On lid close it is not honoured, ever.** IOPMLib.h: "The system may still
   sleep for lid close, Apple menu, low battery, or other sleep reasons."
6. **On this Studio the setting would change nothing today**: idle sleep is
   already disabled (`sleep 0` on both profiles) and three unrelated processes
   are already holding assertions. Its value is the *guarantee* — and every
   other Mac an install lands on.

## 1. The two mechanisms, and who holds the assertion

### What the assertion promises, verbatim

`/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk/System/Library/Frameworks/IOKit.framework/Versions/A/Headers/pwr_mgt/IOPMLib.h`,
lines 274–292:

```
 * @define          kIOPMAssertPreventUserIdleSystemSleep
 * @abstract        Prevents the system from sleeping automatically due to a lack of user activity.
 * @discussion      When asserted and set to level kIOPMAssertionLevelOn,
 *                  will prevent the system from sleeping due to a period of idle user activity.
 *                  …
 *                  The display may dim and idle sleep while kIOPMAssertPreventUserIdleSystemSleep is
 *                  enabled, but the system may not idle sleep. The system may still sleep for lid close,
 *                  Apple menu, low battery, or other sleep reasons.
 *
 *                  This assertion has no effect if the system is in Dark Wake.
```

Two more facts from the same header. `IOPMAssertionCreateWithName` needs **no
privileges**: "No special privileges are necessary to make this call - any
process may activate a power assertion" — so there is no approval prompt, no
TCC grant, no `sudo`, and nothing for the owner's hand. And the spelling the
plan item uses, `kIOPMAssertionTypePreventUserIdleSystemSleep`, is an alias:
"This assertion type is identical to `kIOPMAssertPreventUserIdleSystemSleep`.
Please use that instead." (line 1004 is `#define … kIOPMAssertPreventUserIdleSystemSleep`).

`kIOPMAssertionTypePreventSystemSleep` — the one `caffeinate -s` takes — is
"Deprecated in 10.9. This assertion is not supported in any OS X releases."
Another reason the plan's "never `-d`" should read "never `-d`, never `-s`".

### Swift vs `caffeinate`, decided on invariant 6

| | Swift `IOPMAssertionCreateWithName` | `caffeinate -i` child |
| --- | --- | --- |
| Mechanism | the IOKit call | the same IOKit call, via `/usr/bin/caffeinate` |
| Who can hold it | a Swift process — the supervisor is **Node**, so this means a *new signed binary* | any process that can spawn |
| If the holder dies | released automatically — an assertion belongs to the process that made it and goes when that process goes | the `caffeinate` child *survives* its parent and would hold the Mac awake across a supervisor restart; `-w <pid>` fixes exactly that — proven below |
| Assertion name | ours, templated from `identity.yaml` (≤128 chars, per the header) | fixed: `"caffeinate command-line tool"` — **not settable** |
| Cost | a new Swift target, Developer ID signing (D3), release packing, conformance | ~90 lines in `apps/watchdog`, no new dependency |
| Invariant 6 | violates it: macOS does not require native here | satisfies it |

**Recommendation: `caffeinate -i -w <holder pid>`.** The one real loss is the
assertion's name: `pmset -g assertions` will attribute it to `caffeinate`, not
to the assistant. That is the cost of the cheap mechanism, and it is paid
where almost nobody looks; the *product's* name for this state lives in the
doctor row and the app, which are the surfaces a person actually reads (§5).

Rejected, and worth naming: a Swift helper purely to get a pretty string into
`pmset` output. It would be the first native binary in this repo that macOS
does not force us into — a precedent that costs more than it buys.

### Real output: the mechanism, and `-w` releasing it

```
$ sh -c 'sleep 5 & W=$!; /usr/bin/caffeinate -i -w $W & C=$!; sleep 1; …'
watched pid=75701  caffeinate pid=75702
--- pmset -g assertions, ours only:
   pid 75702(caffeinate): [0x0028ed56000187a5] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
--- summary line:
   PreventUserIdleSystemSleep     1
--- after the watched pid exited, is our caffeinate still alive?
gone - assertion released by -w
--- our pid still in assertions?
0
```

`-w` is the whole safety story, and it is the one flag that makes the
cheap mechanism as safe as the native one. **The assertion cannot outlive
its holder**, even when the holder is `SIGKILL`ed, because `caffeinate`
watches the pid rather than depending on being its child. Without `-w` the
realistic failure is mundane: the supervisor is killed, `KeepAlive` starts a
new one, the old `caffeinate` is still there — and now two of them are, one
with no owner at all. The run above also shows the general rule the native
option gets for free: when the owning process exits, the assertion is gone
from `pmset -g assertions` immediately.

### Which process, given this repo's shapes

`apps/watchdog/src/main.ts` is one binary with two modes
(`docs/ops/deployment-shapes.md`):

- **`shape: launchd`** — it *is* `com.foldedspacelabs.metistry`, the single
  LaunchAgent, with Postgres, the console, the reconciler, the assistant and
  any bridge as its children (`packages/core/src/supervisor.ts`).
- **`shape: compose`** — there is no supervisor at all
  (`packages/cli/src/launchd.ts`, `loadPlistTemplates`); the watchdog is its
  own LaunchAgent from `ops/launchd/com.foldedspacelabs.metistry.watchdog.plist`.

Either way it is a host process (`apps/watchdog/manifest.yaml`:
`runs_on: host`), it is `KeepAlive`, and it outlives everything it watches.
That is the correct holder. The Mac app is **not**: it is a window, and the
promise is "running with no window open".

Rejected: modelling the holder as an entry in `supervisor.json`'s `children`.
It would inherit restart/backoff/logging for free, but the argv would have to
carry the supervisor's own pid, which is not known when `metistry up` writes
that file — and `metistry restart keep-awake` would enter the service
vocabulary for something that is not a service. It should be a small module
the supervisor owns, not a child.

### Does the agent hold it with no window open? Yes. Logged out? No.

No window is required: an assertion belongs to a **process**, not to an app or
a window, and needs no privileges (header, above). A LaunchAgent with
`KeepAlive` holds it for as long as it runs.

Logout is the boundary. Apple's *Daemons and Services Programming Guide*
("Creating Launch Daemons and Agents"): "A user agent is essentially identical
to a daemon, but is specific to a given logged-in user and executes only while
that user is logged in", and at logout launchd "sends a `SIGTERM` signal to all
of the user agents that it started." `launchctl(1)` draws the same line: a
`gui/<uid>` domain "is created when the user logs in at the GUI".

`packages/cli/src/launchd.ts` bootstraps into `gui/<uid>` (lines 416–419), and
`SMAppService.agent(plistName:)` registers a per-user agent too. So:

| Registration | Assertion survives screen lock | … fast user switch | … logout | … reboot |
| --- | --- | --- | --- | --- |
| LaunchAgent (both registrars, today) | yes | yes (session stays) | **no** — agent gets `SIGTERM` | no, until login |
| LaunchDaemon (not built, not proposed) | yes | yes | yes | yes, from boot |

**Do not convert to a LaunchDaemon for this.** It needs root to install,
changes the entire security posture, breaks the "one background item called
Metistry" design (`docs/ops/deployment-shapes.md`) and would run Postgres and
the assistant as root. The honest statement for the docs is: *keep-awake holds
while you are logged in.* A Mac that is always on is also always logged in.

### Lid close: it does not hold, and cannot be made to

IOPMLib.h says it plainly: "The system may still sleep for lid close". Closing
the lid is not idle sleep, and no assertion of this type suppresses it. The
governing state is `AppleClamshellCausesSleep` in `IOPM.h` ("true == system
will sleep when clamshell is closed"), which macOS — not the process holding
an assertion — sets to false only in closed-display mode, i.e. with external
power, an external display and an external input device attached. **Caveat on
sourcing:** the IOPM.h and IOPMLib.h statements are verbatim from the
installed SDK; the specific external-power/display/input triple is Apple
support material I could not retrieve through a fetchable URL in this session
(three Apple URLs returned unrelated pages), so treat that sentence as
well-established but not quoted here.

Practical consequence for a MacBook install: **`keep_awake: true` on a laptop
with the lid shut is a promise the OS will not keep.** The doctor row and the
app copy must say so rather than implying otherwise.

## 2. Battery vs AC

`PreventUserIdleSystemSleep` **is honoured on battery.** Nothing in the header
conditions it on wall power; the only power-related escape it lists is "low
battery". The contrast is deliberate and documented — `caffeinate(8)`:

```
-s  Create an assertion to prevent the system from sleeping. This
    assertion is valid only when system is running on AC power.
```

That AC-only restriction belongs to `-s` (`PreventSystemSleep`, deprecated),
not to `-i`. So "off on battery" is **policy, not a technical limit**, and the
plan's instinct is right for the right reason: a background process silently
holding a laptop awake in a bag is the kind of thing that earns an app a
reputation. Confirmed, with the reason corrected.

The power source is one of exactly three documented strings
(`IOPowerSources.h`, `IOPSGetProvidingPowerSourceType`): `"AC Power"`,
`"Battery Power"`, `"UPS Power"` — and `pmset -g ps` prints that same string:

```
$ pmset -g ps
Now drawing from 'AC Power'
 -Back-UPS RS 1500G FW:865.L7 .D USB FW:L7  (id=38666240)	100%; AC attached; not charging present: true
```

So `auto` needs no new dependency and no native code: parse the first line of
`pmset -g ps` for `'AC Power'`. **`UPS Power` must count as "not AC"** — during
an outage, holding a desktop awake burns the UPS runtime that exists to shut it
down cleanly. `pmset -g custom` already keeps a separate profile for it (§3).

**Default: `auto`.** For a desktop that is always on wall power, `auto` and
`true` are the same thing; for a laptop, `auto` is the only defensible default.
`true` stays available for someone who means it.

## 3. This Studio, as it stands (read-only, 2026-09-18 23:28 EDT)

```
$ pmset -g custom
UPS Power:
 sleep 0   displaysleep 2   disksleep 0   standby 0   powernap 1
 tcpkeepalive 1   womp 1   autorestart 1   ttyskeepawake 1   lowpowermode 0
AC Power:
 sleep 0   displaysleep 30  disksleep 0   standby 0   powernap 1
 tcpkeepalive 1   womp 1   autorestart 1   ttyskeepawake 1   lowpowermode 0
```

(Abridged; both profiles printed every key shown.) Reading it:

- **`sleep 0` on both profiles** — idle sleep is already disabled, by hand, on
  this machine. `keep_awake` would be a no-op here today. That is the single
  most important local finding: this setting is not for the Studio, it is for
  every other Mac an install lands on, and for making a hand-set preference
  into a stated product guarantee.
- **`displaysleep 30` (AC) / `2` (UPS)** — the screen does sleep, which is the
  behaviour Q1 asks to preserve. `-i` preserves it; `-d` would destroy it.
- **No `hibernatemode`, no `standbydelay` keys** in this machine's output;
  `standby 0`. Apple silicon desktops do not expose the portable hibernation
  settings, so there is nothing here for keep-awake to interact with.
- **`powernap 1`** — see §6.
- **`tcpkeepalive 1`, `womp 1`** — the Mac maintains network presence across
  sleep and wakes for a magic packet. Neither substitutes for staying awake:
  the console does not answer and no routine fires during sleep.
- **`ttyskeepawake 1`** — *any* live tty (an open `ssh`) already prevents idle
  sleep. An owner debugging over `ssh` will never see idle sleep, which makes
  this an easy setting to believe is holding when it is not.
- **A Mac Studio has no battery.** `system_profiler SPPowerDataType` confirms
  the second profile is a UPS, not a battery: `UPS Installed: Yes`, and the
  profiles are named `AC Power` and `UPS Power` with no `Battery Power`.

```
$ pmset -g assertions      (abridged: the holders)
   pid 54429(caffeinate):     PreventUserIdleSystemSleep  "caffeinate command-line tool" (300s timeout)
   pid 353(powerd):           PreventUserIdleSystemSleep  "Powerd - Prevent sleep while display is on"
   pid 84127(screensharingd): PreventSystemSleep          "Remote user is connected"  378:54:22
   pid 67905(Claude):         NoIdleSleepAssertion        "Electron"
   pid 687(nsurlsessiond):    PreventUserIdleSystemSleep  NSURLSessionTask …
```

**No Metistry process holds any assertion** — correct, since none of this is
built. Note `powerd`'s own "Prevent sleep while display is on": while the
display is awake the system cannot idle-sleep anyway, so the assertion only
begins to matter after `displaysleep` fires. And `screensharingd` has held
`PreventSystemSleep` for 378 hours, which is a fair warning about how long an
assertion can quietly persist.

## 4. Where the setting lives

### `deployment.yaml`, three values

```yaml
shape: launchd
keep_awake: auto     # auto | true | false  (auto = hold only on AC Power)
```

`deployment.yaml` is the right file: `keep_awake` is about *where and how this
install runs on this machine*, which is precisely what that file is for
(`packages/core/src/deployment.ts`), and it is already per-instance with the D4
overlay. One vocabulary everywhere — `true`, `false`, `auto` — in the file, in
the CLI verb and in the environment variable. (`keep_awake: on` parses as the
string `"on"` under the `yaml` package's YAML 1.2 core schema, so the strict
schema rejects it with the three valid values named, which is the right
failure.)

**Is the key additive? Forward yes, backward no.** `deploymentSchema` is
`.strict()` and `parseDeployment` *throws* on an unknown key — "an unknown key
or a misspelled shape is an error, never a silent fall back to compose". So a
new CLI reading an old file is fine (`.default("auto")`), but an **older CLI
reading a file that carries `keep_awake` fails outright**, with every verb that
loads deployment refusing. Mitigations, cheapest first: (a) ship the schema key
in one release and let nothing write it until the next — the same additive-first
discipline `CLAUDE.md` requires of migrations; (b) accept it and note in the
release that downgrading past that version needs the line removed by hand.
**(a) is the recommendation**, and it costs one release of patience.

The write path already exists and must be reused: `deployment.yaml` is a §4.7
protected path (invariant 2), so a `metistry deployment set-keep-awake
<true|false|auto>` verb goes through `writeProtected` as the user exactly as
`set-shape` does (`packages/cli/src/deployment-report.ts`), preview without
`--yes`, applied with it. `applyShapeToYaml` rewrites only the `shape:` line
and leaves comments and other keys untouched (`packages/cli/src/deployment.ts`),
so a sibling `applyKeepAwakeToYaml` is a five-line copy and neither verb
clobbers the other's key.

### How the value reaches the holder

`metistry up` renders `METISTRY_KEEP_AWAKE=true|false|auto` into the holder's
environment under both shapes: into `supervisor.json`'s `env` dict under
`launchd` (which `main.ts` applies over `process.env` at startup), and into the
watchdog agent's environment under `compose`. **No change to
`supervisorConfigSchema`** — which keeps the two shapes on one code path.

The holder writes `<instance>/.metistry/state/keep-awake.json` (mode, caffeinate
pid, since, last observed power source) so doctor can report it under the
compose shape too, where there is no control socket to ask.

`metistry update` needs nothing beyond re-running `up`, which it already does.
`metistry set-shape`/`migrate-shape` need nothing: the key is shape-independent
and survives the `shape:` line rewrite.

### What `metistry doctor` should say

One row, `kind: "keep-awake"`, macOS only (off darwin it is not emitted at all —
invariant 7: `caffeinate` does not exist on Linux). It cross-checks the state
file's pid against `pmset -g assertions`, which is the only honest probe
(Phase 0 hard requirement 3: attempt and inspect, do not ask a permission API).

| Situation | status | probe / remediation |
| --- | --- | --- |
| `keep_awake: false` | `absent` | "not configured — this Mac may idle-sleep and stop collecting until it wakes. `metistry deployment set-keep-awake auto`" (`absent` is already rendered as "not configured", `app-ux-plan.md` §3.2) |
| Held | `ok` | probe: "`pmset -g assertions` lists PreventUserIdleSystemSleep held by pid 75702 (caffeinate), spawned by the supervisor"; meta: `{assertion_id, pid, since, power_source, system_sleep_minutes}` |
| `auto`, not on AC | `ok` | probe: "released on purpose — drawing from 'UPS Power'"; never a finding, this is the configured behaviour |
| Configured on, no assertion found | `degraded` | "`keep_awake: auto` but nothing holds PreventUserIdleSystemSleep — the supervisor is not running, or `caffeinate` exited: `metistry logs supervisor`" |
| Held, but `pmset -g` says `sleep 0` | `ok`, with meta | probe adds "idle sleep is already disabled on this power source, so the assertion changes nothing" — the Studio's case today |
| Lid-closed portable | `degraded` | "an idle-sleep assertion does not survive lid close (IOPMLib.h) — closed-display mode needs external power, display and input" |

`degraded`, never `failed`: the install is running and correct; a promise is
unmet. Doctor's exit code stays clean, which matters because `metistry up`
calls doctor at the end.

## 5. Which surfaces

- **Mac app.** Settings → **Services**, not Status. The Services pane already
  holds the two lifecycle toggles ("Start at Login", "Run Metistry in the
  background") and already renders the deployment shape read-only
  (`apps/macos/sources/kit/settings-view.swift`, `servicesPane`). A third
  section, "Keep this Mac awake", belongs with its siblings. **Contradiction
  with Q1 noted in §8:** Q1 says Status pane, but Status is defined as
  "`metistry doctor --json` rendered" (`app-ux-plan.md` §3.2) — a read-only
  rendering. Putting a control there breaks that contract; the doctor row
  appears in Status, the toggle lives in Services.
- **The toggle is not an `SMAppService` registration.** Unlike its two
  neighbours, it writes a protected file, so it must shell the CLI verb through
  the existing `process-command-runner` path and surface the preview/refusal,
  not write YAML itself. That is the invariant-2 boundary, and it is the single
  most likely thing to get wrong.
- **The console / PWA: no.** Invariant 10 keeps the console's mutating surface
  a closed enumerated set, and this is a per-Mac host setting that means
  nothing on a phone. Report it in Status (it is a doctor row, so it arrives
  free); do not add an action.
- **The assertion's human-readable name.** With `caffeinate` there is none to
  template — the string is Apple's. Wherever the product *does* name this
  state, the name comes from `identity.yaml` through the CLI, never a literal
  (`CLAUDE.md`): doctor's row title stays `keep-awake` (machinery is
  `assistant_*`/lowercase), and any app copy that names the assistant reads it
  from the instance identity the way every other surface does. If a Swift
  holder is ever built, its `AssertionName` is the templated string and the
  128-character limit in `IOPMAssertionCreateWithName` is the constraint to
  respect.

## 6. Edge cases

- **Already `sleep 0`** (this Studio). Harmless and redundant; assertions layer
  over `pmset` settings rather than conflicting — `pmset(1)`: "processes may
  dynamically override these power management settings by using I/O Kit power
  assertions." Doctor should say the assertion is a no-op here rather than
  claim credit for it.
- **Power Nap / Dark Wake.** `powernap 1` on this machine. The header is
  categorical: "This assertion has no effect if the system is in Dark Wake." A
  Mac that has genuinely slept and wakes darkly for Power Nap cannot be held
  awake by this assertion, and a collector that starts during dark wake can be
  cut off mid-run. The API for that is `kIOPMAssertNetworkClientActive` /
  `BackgroundTask`, which is a different question — flagged, out of Q1's scope.
- **Scheduled sleep** (`pmset schedule`, `pmset -g sched`) and the Apple menu's
  Sleep item both bypass the assertion by design ("Apple menu […] or other
  sleep reasons"). Nothing to do; say it once in the docs so it is not a bug
  report later.
- **Thermal.** A thermal emergency sleeps or shuts down the Mac regardless of
  any assertion. `pmset -g therm` is the read; nothing to build.
- **Low battery.** Explicitly listed as a sleep reason the assertion does not
  stop — so even a laptop set to `keep_awake: true` sleeps at low battery. The
  behaviour is safe by default.
- **Compose shape.** Containers do not hold assertions and a Docker VM is
  suspended with the host, so a compose install needs exactly the same holder
  in the same process — which is why the watchdog, not the supervisor, is the
  home. Whether Docker Desktop itself holds an assertion could not be observed
  here (it is not running on this Mac; nothing Docker-related appears in
  `pmset -g assertions`), so the design assumes it does not and does not depend
  on the answer.
- **Second instance on one Mac** (`--namespace`). Two holders would each spawn a
  `caffeinate`; assertions are reference-counted by the system, so this is
  correct but noisy. Optional refinement, not a blocker.
- **Someone else's `caffeinate`.** There was already an unrelated one on this
  machine during the experiment (pid 54429, 300-second timeout). Doctor must
  match **our recorded pid**, never "is any `caffeinate` running".

## 7. Recommendation

**One shape to build.**

| Piece | Where | Size |
| --- | --- | --- |
| `keep_awake: true\|false\|auto` in the schema (+ seed comment) | `packages/core/src/deployment.ts`, `seed/deployment.yaml` | ~25 lines |
| `metistry deployment set-keep-awake <true\|false\|auto>` through `writeProtected`, `applyKeepAwakeToYaml` | `packages/cli/src/deployment.ts`, `deployment-report.ts`, `main.ts` | ~70 lines |
| `METISTRY_KEEP_AWAKE` rendered into the holder's env under both shapes | `packages/cli/src/up.ts` | ~15 lines |
| The holder: spawn `caffeinate -i -w <own pid>`, re-spawn if it exits, poll `pmset -g ps` on the existing 60s probe cycle for `auto`, release on `SIGTERM`, write `state/keep-awake.json` | `apps/watchdog/src/keep-awake.ts` | ~90 lines + tests |
| Doctor row (darwin only), parsing `pmset -g assertions` | `packages/cli/src/doctor.ts` | ~50 lines + tests |
| Settings → Services section, toggle shelling the CLI verb | `apps/macos/sources/kit/settings-view.swift`, `settings-model.swift` | ~80 lines + a kit test |
| Docs | `docs/ops/deployment-shapes.md`, `docs/ops/cli.md`, a `docs/product/record/` fragment | ~60 lines |

**Effort: S/M — about one focused day**, most of it tests and the app section.
No new dependency. No native code. No migration. No change to
`supervisor.json`'s schema.

**What needs the owner's hand: nothing operationally, one ruling.** Power
assertions need no privileges, no TCC grant and no `sudo`, so there is no
approval step and no System Settings visit — unlike every other macOS surface
this product touches. The only thing required is the ruling on the default
(§8, Q-a). After that, `metistry up` picks it up on the next run.

**Deliberately not built:** a Swift assertion holder; a LaunchDaemon; a
console action; any attempt to defeat lid-close sleep; any Dark Wake handling.

## 8. Contradictions with the plan, and open questions

**Contradictions** (reported, not edited — `docs/plan-refresh-2026-09-13.md`
is untouched by this PR):

1. **Q1 says "surfaced in the app's Settings → Status pane".** Status is
   defined elsewhere as a read-only rendering of `metistry doctor --json`
   (`app-ux-plan.md` §3.2, §3.13). The *row* belongs in Status; the *toggle*
   belongs in Settings → Services beside the two existing lifecycle toggles.
2. **Q1 offers "from the app's background item" as the Swift option.** The
   background item is the supervisor, which is Node, not Swift — so that option
   is really "a new signed Swift binary in the agent", which invariant 6
   excludes while `caffeinate` exists.
3. **Q1 says "a `caffeinate -i` child of the supervisor".** Under
   `shape: compose` there is no supervisor at all; the holder has to be the
   watchdog, which is the same process under `launchd`. The wording should be
   "of the watchdog".
4. **`deployment.yaml` parsing is strict**, so `keep_awake` is additive going
   forward but breaks an older CLI reading a newer file. Worth a line in the
   plan if config keys are going to keep arriving.

**Open questions for the owner:**

- **(a) The default.** Seed `keep_awake: auto` — the product changes the Mac's
  idle-sleep behaviour unless told not to. It is defensible (the whole promise
  is "it is running"), it never touches a laptop on battery, and doctor always
  says so. It is still a default that changes machine behaviour without being
  asked, which is the owner's call, not mine. Alternative: seed `false` and
  have the Mac app's first-run wizard offer it as one line.
- **(b) The unnamed assertion.** Accept `"caffeinate command-line tool"` in
  `pmset -g assertions` forever, or is attribution worth a signed Swift binary
  later? Recommendation: accept; revisit only if a user actually asks "what is
  keeping my Mac awake".
- **(c) The strict-schema release gap.** Ship the schema key one release before
  anything writes it, or accept that a downgrade needs the line removed by hand?
- **(d) Laptop honesty.** On a MacBook, should `keep_awake: true` with the lid
  shut be a `degraded` doctor row (recommended) or refused outright at
  `set-keep-awake` time on portable hardware?
- **(e) Dark Wake / Power Nap.** Out of Q1's scope, but "a routine started
  during a Power Nap can be cut off" is a real gap for any install whose Mac
  does sleep. Worth its own item?

## Sources

Local, verbatim (installed SDK / man pages on the Studio, 2026-09-18):

- `…/MacOSX26.5.sdk/…/IOKit.framework/…/pwr_mgt/IOPMLib.h` —
  `kIOPMAssertPreventUserIdleSystemSleep` (l. 274–292, the "lid close, Apple
  menu, low battery" and "no effect […] in Dark Wake" sentences),
  `IOPMAssertionCreateWithName` (l. 756–781, "No special privileges", the
  128-character `AssertionName` limit), `kIOPMAssertionTypePreventSystemSleep`
  (l. 1014–1023, deprecated), `kIOPMAssertionTypePreventUserIdleSystemSleep`
  (l. 999–1004, an alias).
- `…/pwr_mgt/IOPM.h` l. 200–217 — `AppleClamshellState`,
  `AppleClamshellCausesSleep`.
- `…/ps/IOPowerSources.h` l. 194–216, 307–317 —
  `IOPSGetProvidingPowerSourceType` returns one of `"AC Power"`,
  `"Battery Power"`, `"UPS Power"`.
- `caffeinate(8)` — `-i`, `-d`, `-s` ("valid only when system is running on AC
  power"), `-t`, `-w`.
- `pmset(1)` — the `-g` sub-options, the settings list (`womp`, `powernap`,
  `ttyskeepawake`, `hibernatemode`, `standby`, `tcpkeepalive`), and
  "processes may dynamically override these power management settings by using
  I/O Kit power assertions".
- `launchd.plist(5)` — `LimitLoadToSessionType` (applies to agents only;
  "There are no distinct sessions in the privileged system context"),
  `ProcessType` `Background`.
- `launchctl(1)` — `gui/<uid>` "is created when the user logs in at the GUI";
  `user/<uid>` "may exist independently of a logged-in user".

Fetched:

- Apple, *Daemons and Services Programming Guide* → "Creating Launch Daemons
  and Agents" — "A user agent is essentially identical to a daemon, but is
  specific to a given logged-in user and executes only while that user is
  logged in"; at logout launchd "sends a `SIGTERM` signal to all of the user
  agents that it started".
  <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>
- `apple-oss-distributions/IOKitUser` `pwr_mgt.subproj/IOPMLib.h` — the blocks
  quoted above match the local SDK copy word for word (the whole file was not
  diffed).
  <https://raw.githubusercontent.com/apple-oss-distributions/IOKitUser/main/pwr_mgt.subproj/IOPMLib.h>
- **Not retrieved:** Apple's closed-display-mode support article. Three
  candidate URLs returned unrelated pages; the clamshell claim in §1 rests on
  the SDK headers instead, and the external-power/display/input requirement is
  flagged there as unquoted.

Local observation (read-only, no `sudo`, no `pmset` writes): `pmset -g`,
`pmset -g custom`, `pmset -g assertions`, `pmset -g ps`,
`system_profiler SPPowerDataType`, and one six-second `caffeinate -i -w`
experiment that released itself (output in §1).

Repo: `packages/core/src/deployment.ts`, `packages/core/src/supervisor.ts`,
`packages/core/src/check.ts`, `packages/cli/src/doctor.ts`,
`packages/cli/src/deployment.ts`, `packages/cli/src/deployment-report.ts`,
`packages/cli/src/launchd.ts`, `apps/watchdog/src/main.ts`,
`apps/watchdog/manifest.yaml`, `apps/macos/sources/kit/settings-view.swift`,
`apps/macos/sources/kit/background-agent.swift`,
`ops/launchd/com.foldedspacelabs.metistry.plist`,
`docs/ops/deployment-shapes.md`, `docs/ops/instance-layout.md`,
`docs/product/app-ux-plan.md`.
