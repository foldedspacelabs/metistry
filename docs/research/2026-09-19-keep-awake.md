# Keeping the Mac awake while Metistry runs (2026-09-19)

Research for **Q1**, `docs/plan-refresh-2026-09-13.md` §4a. Nothing here is
built: this is the shape to build, what it costs, and the decisions that are
the owner's.

Revised the same day against the owner's notes, which moved the question in
four places — the setting is a **choice between two behaviours**, not a
boolean; **lid close must always sleep**; the mechanism must not disturb a
keep-awake app the user already has; and both the process root and the
multi-user shape are open. §2–§5 answer those four directly; §6–§8 follow from
them.

Sources are Apple's own and were read locally where a local copy exists — the
installed SDK's `IOPMLib.h`, `IOPM.h` and `IOPowerSources.h`, `caffeinate(8)`,
`pmset(1)`, `launchd.plist(5)`, `launchctl(1)`, `fdesetup(8)` — plus Apple's
*Daemons and Services Programming Guide* and TN2083 *Daemons and Agents*
fetched. Every command output below was taken **read-only on this Mac Studio
on 2026-09-19** (no `sudo`, no `pmset` writes, no change to the running
install) and is printed verbatim. Repo facts cite the file.

## The short version

1. **The mechanism is unchanged.** `caffeinate -i` and
   `IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep)` are the
   same assertion; the choice is which process holds it, not capability.
2. **Three values, two of which are the owner's choices**:
   `keep_awake: always | allow_sleep_on_battery | never`. The third is not
   decoration — an assertion *overrides* the user's own System Settings sleep
   timer (`pmset(1)`: "processes may dynamically override these power
   management settings by using I/O Kit power assertions"), and without `never`
   there is no way back to it (§2).
3. **Lid close sleeps, always, and it costs us zero lines.** The assertion
   type's own definition excludes it: "The system may still sleep for lid
   close, Apple menu, low battery, or other sleep reasons." There is nothing to
   implement and nothing to configure (§2).
4. **Coexistence is Apple's designed model, not a hazard.** `IOPMLib.h`,
   verbatim: "One process may have multiple assertions. Several processes may
   have asserted the same assertion to different levels." Proven live below:
   a stand-in third-party holder and ours listed side by side, each released
   independently, ours vanishing without touching theirs (§3).
5. **We invoke `/usr/bin/caffeinate`; we never ship it.** It is Apple's binary
   — `root:wheel`, `Identifier=com.apple.caffeinate`, `Authority=Software
   Signing` — on the **sealed read-only system volume**. Bundling is neither
   possible in any useful sense nor necessary (§3).
6. **New finding, and it is the real cost of `caffeinate`:** the `Metistry`
   symlink trick this repo already uses for the supervisor **does not rename
   the holder for power attribution**. Invoked through a symlink named
   `Metistry`, `caffeinate` takes that kernel process name (`pgrep -x Metistry`
   matches it) but `pmset -g` and `pmset -g assertions` both still say
   `caffeinate`. So under `caffeinate` the answer to "what is keeping my Mac
   awake?" can never be our name (§3, §4).
7. **The process root the owner is describing already exists — it is just
   written in TypeScript.** The one launchd agent is a file named `Metistry`,
   and every service is its child. Live: `pgrep -x Metistry` → pid 9007, the
   supervisor. A Swift root changes the language, not the shape (§4).
8. **Stay a per-user LaunchAgent.** The daemon's only real prize is "survives
   logout", and it is dearer than it looks: FileVault is on here, Apple
   requires credentials during boot, the one TCC-bound component cannot follow
   a daemon, and neither can the credential the reconciler pushes with (§5).

## 1. The two mechanisms, and who holds the assertion

### What the assertion promises, verbatim

`/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/IOKit.framework/Versions/A/Headers/pwr_mgt/IOPMLib.h`,
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

Three more facts from the same header. `IOPMAssertionCreateWithName` (l. 757)
needs **no privileges**: "No special privileges are necessary to make this
call - any process may activate a power assertion" — no prompt, no TCC grant,
no `sudo`, nothing for the owner's hand. `AssertionName` "may be no longer than
128 characters". And the spelling the plan item uses,
`kIOPMAssertionTypePreventUserIdleSystemSleep`, is an alias: "This assertion
type is identical to `kIOPMAssertPreventUserIdleSystemSleep`. Please use that
instead."

`kIOPMAssertionTypePreventSystemSleep` — the one `caffeinate -s` takes — is
"Deprecated in 10.9. This assertion is not supported in any OS X releases."
The plan's "never `-d`" should read "never `-d`, never `-s`".

### `caffeinate` is the same call

`caffeinate(8)`: "`caffeinate` creates assertions to alter system sleep
behavior… `-i` Create an assertion to prevent the system from idle sleeping."
`pmset(1)` points at it for exactly this: "processes may dynamically override
these power management settings by using I/O Kit power assertions. Whenever
processes override any system power settings, `pmset` will list those
processes and their power assertions in `-g` and `-g assertions`. See
`caffeinate(8)`."

`-w` is the safety story and the reason a spawned holder is as safe as an
in-process one: "`-w` Waits for the process with the specified pid to exit.
Once the process exits, the assertion is also released." Proven in §3. Without
it the realistic failure is mundane — the supervisor is killed, `KeepAlive`
starts a new one, the old `caffeinate` is still there, and now two are, one
with no owner at all.

### Which of our processes, given this repo's shapes

`apps/watchdog/src/main.ts` is one binary with two modes
(`docs/ops/deployment-shapes.md`):

- **`shape: launchd`** — it *is* `com.foldedspacelabs.metistry`, the single
  LaunchAgent, with Postgres, the console, the reconciler, the assistant and
  any enabled bridge as its children (`apps/watchdog/src/supervisor.ts`,
  `packages/core/src/supervisor.ts`).
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
vocabulary for something that is not a service. It should be a small module the
supervisor owns, not a child.

## 2. The setting: two choices, `never`, and what the lid does

### The two choices, and the value names

The owner's words are the labels. The YAML:

```yaml
shape: launchd
keep_awake: allow_sleep_on_battery   # always | allow_sleep_on_battery | never
```

| value | app label | behaviour |
| --- | --- | --- |
| `always` | **Always keep this Mac awake** | hold the assertion whenever the install is running |
| `allow_sleep_on_battery` | **Allow sleep on battery** | hold only while `pmset -g ps` reports `'AC Power'`; release on `Battery Power` and on `UPS Power` |
| `never` | the section switch, off | hold nothing; the Mac's own sleep settings decide |

**Why the values are strings and not `true`/`false`.** `keep_awake: true`
cannot express two behaviours, and the plan's current spelling would parse as a
boolean and be rejected by a string enum — which is the right failure, naming
the three valid values. Verified against the pinned parser (`yaml@2.9.0`, the
version resolved in this repo):

```
$ node --input-type=module -e "import YAML from 'yaml'; …"
a -> string "off"
b -> string "on"
c -> string "no"
d -> boolean true
e -> string "always"
f -> string "never"
g -> string "allow_sleep_on_battery"
```

So `off` would in fact parse safely under the YAML 1.2 core schema this package
uses. **`never` is still the better spelling**, and the reason is a reader not a
parser: `off` is a boolean in YAML 1.1 and in every reader's head, and a config
value that looks like a boolean beside two values that are plainly strings
invites exactly the edit that breaks. `never` is symmetric with `always` and
cannot be misread.

**Why `allow_sleep_on_battery` and not `on_ac_only`.** It is the owner's own
phrase, and one string then serves the YAML value, the CLI argument and the
radio label — a vocabulary with no translation layer is one fewer place to
drift. The apparent wrinkle is a desktop on a UPS: during an outage this
machine draws `'UPS Power'`, not `'Battery Power'`, and holding a desktop awake
then burns the runtime that exists to shut it down cleanly. That is not a
naming problem — **a UPS is a battery**, an external one, and releasing on it
is what the label says. `IOPowerSources.h` gives exactly three strings, so the
rule is a single comparison:

```
$ pmset -g ps
Now drawing from 'AC Power'
 -Back-UPS RS 1500G FW:865.L7 .D USB FW:L7  (id=38666240)	100%; AC attached; not charging present: true
```

`PreventUserIdleSystemSleep` **is honoured on battery** — nothing in the header
conditions it on wall power, and the only power-related escape it lists is "low
battery". The AC-only restriction belongs to `-s` (`caffeinate(8)`: "This
assertion is valid only when system is running on AC power"), whose assertion
type is documented deprecated. So `allow_sleep_on_battery` is **policy, not a
technical limit**, and that is the honest way to describe it to the user.

### Is `never` needed at all? Yes, and this is the argument

It would be tidier to ship the owner's two values and nothing else. Three
reasons not to:

1. **An assertion overrides the user's own setting, and nothing else undoes
   it.** `pmset(1)` is explicit that assertions override power management
   settings. A user who sets "Prevent automatic sleeping" off in System
   Settings and expects their Mac to idle-sleep has no route to that outcome
   while we hold the assertion — not through System Settings, not through
   `pmset`, only through us. A product that can take a machine-level behaviour
   and cannot give it back is the thing the owner's note is trying to avoid.
2. **On a desktop, `allow_sleep_on_battery` is `always`.** It never releases on
   a Mac Studio on wall power, so without `never` a desktop user has two values
   that mean one thing.
3. **It costs almost nothing** — one enum member, one doctor branch, one
   switch — and doctor already renders `absent` as "not configured"
   (`docs/product/app-ux-plan.md` §3.2), which is the row `never` wants.

So: `never` exists, but it is **not presented as a third peer**. In the app it
is the section's on/off switch and the two choices are a radio pair beneath it,
which is exactly the shape the owner described. Default in `seed/deployment.yaml`:
`allow_sleep_on_battery` — on a desktop it is the promise, on a laptop it is the
only defensible default, and doctor always says which it is doing and why.

### Lid close always sleeps, and we write no code for it

**It holds regardless of the assertion, by the assertion's own definition.**
`IOPMLib.h` again: "The system may still sleep for **lid close**, Apple menu,
low battery, or other sleep reasons." Lid close is not idle sleep; suppressing
idle sleep therefore says nothing about it. This is a guarantee we get from
*not* doing something, which is the strongest kind:

- We only ever create `kIOPMAssertPreventUserIdleSystemSleep`. Nothing in that
  type's contract reaches lid close.
- The state that governs lid behaviour is not an assertion at all. `IOPM.h`
  l. 209–217: `AppleClamshellCausesSleep` — "true == system will sleep when
  clamshell is closed / false == system will not sleep on clamshell close
  *(typically external display mode)* / not present == no clamshell on this
  hardware". It is an **IOPMrootDomain registry property**, and the only other
  lever is the root-domain message `kIOPMDisableClamshell = (1 << 6)` ("do not
  sleep on clamshell closure", `IOPM.h` l. 524) — a power-management message,
  not something a user-space process holding an assertion can reach, and
  nothing this project will ever send.
- Local check that the key is hardware-conditional, as documented:

```
$ ioreg -r -c IOPMrootDomain -d 1 | grep -i clamshell
(no AppleClamshellState / AppleClamshellCausesSleep keys present — a Mac Studio
 has no lid, and IOPM.h says "not present == no clamshell on this hardware")
```

**The one exception, and it is the user's configuration, not ours.** A
lid-closed Mac stays awake only in closed-display mode — Apple's header calls
it "typically external display mode" — which the user creates by attaching
external power, an external display and an external keyboard or pointing
device. macOS, not any process of ours, sets `AppleClamshellCausesSleep` false
in that state. If a user has arranged closed-display mode deliberately, their
Mac stays awake with the lid shut whether Metistry is installed or not, and
Metistry neither causes it nor can undo it.

**Sourcing caveat, carried over and still unresolved.** The external
power/display/input triple is well established but I could not retrieve a
quotable Apple URL for it in this session; three candidates
(`support.apple.com/en-us/102243`, `…/en-us/HT202351`,
`support.apple.com/guide/mac-help/use-your-mac-laptop-with-the-display-closed-mh11842/mac`)
all resolved to unrelated pages. The claim above rests on `IOPM.h`'s own
"typically external display mode"; the specific triple is flagged, not quoted.

**Consequence for the docs and the app copy.** On a MacBook with the lid shut,
`always` is a promise the OS will not keep. Doctor says so (§6); the app copy
says so; nobody discovers it as a bug report.

## 3. Coexistence, and the self-containment question

### `caffeinate` is an OS binary — we invoke it, we do not ship it

```
$ ls -l /usr/bin/caffeinate
-rwxr-xr-x  1 root  wheel  136000 Mar 20  2026 /usr/bin/caffeinate

$ codesign -dv --verbose=2 /usr/bin/caffeinate
Executable=/usr/bin/caffeinate
Identifier=com.apple.caffeinate
Format=Mach-O universal (x86_64 arm64e)
Authority=Software Signing
Authority=Apple Code Signing Certification Authority
Authority=Apple Root CA
TeamIdentifier=not set

$ mount | grep "on / ("
/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
```

**Bundling is neither necessary nor something this project should do.** It is
Apple's code, signed by Apple's Software Signing authority, living on the
sealed read-only system volume; it is present at a fixed absolute path on every
macOS (the man page dates from 2012); and a copy we shipped would have to be
re-signed under our Developer ID, which is the shape of pretending Apple's code
is ours. There is nothing to gain. `caffeinate` is not a dependency in the
sense `CLAUDE.md` asks us to debate — it is `/usr/bin/sh`, `/usr/bin/git`,
`/usr/bin/sandbox-exec`: an OS facility the repo already invokes by absolute
path (`ops/launchd/com.foldedspacelabs.metistry.assistant.plist` roots the
assistant at `/usr/bin/sandbox-exec`).

### Many holders is the designed model — Apple says so

`IOPMLib.h`, `IOPMCopyAssertionsByProcess` (l. 694): "One process may have
multiple assertions. Several processes may have asserted the same assertion to
different levels." And `IOPMCopyAssertionsStatus` (l. 714): "Returns a list of
available assertions and their **system-wide levels**… The system-wide level is
the **maximum** of all individual assertions' levels."

The release side is equally clear: `IOPMAssertionRelease` takes "The
assertion_id, **returned from IOPMAssertionCreate**". **There is no API to
release another process's assertion.** The only cross-process call is
`IOPMCopyAssertionsByProcess`, which is read-only enumeration. Self-containment
is not a discipline we have to keep here — it is enforced by the API surface.

Amphetamine, KeepingYouAwake, Caffeine and the "Caffeinated" app all hold their
own IOPM assertions; several of them hold `PreventUserIdleDisplaySleep` as
well, which is the one the user actually notices.

### The live proof: two independent holders on this Mac

A stand-in for the user's own app (`caffeinate -d -i -t 25` — display *and*
system idle sleep, self-expiring) and ours (`caffeinate -i -w <pid>`, watched
pid exiting at 8s), started together:

```
theirs(pid 16754)  watched(pid 16755)  ours(pid 16756)

--- T+2s: pmset -g assertions, both holders listed ---
   pid 16754(caffeinate): [0x0029cf7300019ae9] 00:00:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
   pid 16754(caffeinate): [0x0029cf7300059aeb] 00:00:02 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
   pid 16756(caffeinate): [0x0029cf7300019aea] 00:00:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"

--- T+2s: system-wide counters ---
   PreventUserIdleDisplaySleep    1
   PreventUserIdleSystemSleep     1

--- T+10s: watched pid gone. ours alive? ---
ours gone - -w released it
--- theirs alive? ---
theirs still alive - UNAFFECTED by ours exiting

--- T+10s: assertions now ---
   pid 16754(caffeinate): [0x0029cf7300019ae9] 00:00:10 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
   pid 16754(caffeinate): [0x0029cf7300059aeb] 00:00:10 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
   PreventUserIdleDisplaySleep    1
   PreventUserIdleSystemSleep     1

--- T+27s: theirs timed out (-t 25). any caffeinate left? ---
no caffeinate process remains
caffeinate lines in pmset -g assertions: 0
```

Four things this settles, in the owner's terms:

1. **Two instances of the binary run at once, fine.** Distinct pids, distinct
   assertion IDs (`0x…19ae9` vs `0x…19aea`), both listed, both counted.
2. **Ours dying does not touch theirs.** At T+10s ours is gone and their two
   assertions are still held, with their clocks still running.
3. **We do not undo their display assertion.** We never create
   `PreventUserIdleDisplaySleep` at all — that is the whole point of `-i` over
   `-d`. At T+10s, with ours gone, `PreventUserIdleDisplaySleep` is still 1,
   held by them. A user whose app keeps the screen on keeps the screen on.
4. **Nothing of ours persists.** The assertion dies with the holder, and `-w`
   makes that true even when the holder is `SIGKILL`ed, because `caffeinate`
   watches the pid rather than depending on being its child.

**A correction to how the summary block must be read.** At T+2s
`PreventUserIdleSystemSleep` reads **1** while *four* processes held it (two
`caffeinate`, `powerd`, `backupd`). It is a **level — the maximum**, per
`IOPMCopyAssertionsStatus` — not a count. Doctor must therefore parse the
"Listed by owning process" block and match **our recorded pid**; the summary
line can never tell us whether we are the one holding, and an earlier reading
of it as a count was wrong.

### The self-containment answer, stated directly

- **We never touch another app's assertion.** There is no API that would let
  us, even by accident (`IOPMAssertionRelease` is id-scoped to the creator).
- **We never change `pmset` settings.** Every `pmset` invocation in this design
  is a read — `-g`, `-g ps`, `-g custom`, `-g assertions`. A written setting
  persists in `/Library/Preferences/SystemConfiguration/com.apple.PowerManagement.plist`
  and needs `sudo`; we never go there, so there is nothing to restore on
  uninstall.
- **Nothing survives our process.** Proven above.
- **Doctor matches our pid, never "is any `caffeinate` running".** Uninstalling
  Metistry can never kill the user's holder, and doctor can never take credit
  for it.
- **A conflict is not even expressible.** The only way two keep-awake tools can
  fight is if one releases the other's assertion or rewrites `pmset`
  settings. We do neither.

**One honest note on the earlier observation.** A previous session recorded an
unrelated `caffeinate -i` with a 300-second timeout (pid 54429) on this
machine. Today it is not running: `pgrep -x caffeinate` returned nothing at
15:40, and a 72-sample sweep at 5-second intervals over six minutes (15:48 →
15:54) recorded **zero** hits. So "some other tool here spawns one every five
minutes" is not something today's evidence supports; what is established is
that one existed yesterday, which is enough to make the coexistence design
mandatory rather than theoretical.

### New finding: the `Metistry` symlink does not rename the holder

This repo already renames a process by invoking it through a symlink —
`ops/launchd/com.foldedspacelabs.metistry.plist`'s `__SUPERVISOR_BIN__` is "a
symlink named `Metistry`, pointing at this install's node — that name is what
System Settings shows". The obvious question is whether the same trick gives
`caffeinate` our name. **It does not, where it counts.**

Two runs of the same setup — `ln -sf /usr/bin/caffeinate <scratch>/bin/Metistry`,
then `<scratch>/bin/Metistry -i -t <n>` — the first asking `pmset`, the second
asking the kernel:

```
--- run 1 (pid 52402): what does pmset say? ---
$ pmset -g | grep '^ sleep'
 sleep                0 (sleep prevented by caffeinate, powerd, Claude, screensharingd, sharingd)
$ pmset -g assertions | grep 'pid 52402'
   pid 52402(caffeinate): [0x0029d19300019bc6] 00:00:02 PreventUserIdleSystemSleep named: "caffeinate command-line tool"

--- run 2 (pid 53342): what is the kernel process name? ---
$ pgrep -x Metistry
9007 36042 53342    <- pids named 'Metistry' (9007=supervisor symlink->node, 36042=Mac app)
is our pid 53342 among them? YES
does pgrep -x caffeinate match it?  NO

--- codesign, either run ---
Executable=/usr/bin/caffeinate
Identifier=com.apple.caffeinate
```

So the kernel process name *does* take the symlink's name — which is why the
supervisor trick succeeds — but `powerd` attributes the assertion from the
resolved binary and its signing identity, not from that name. Under
`caffeinate`, **`pmset -g` will say "sleep prevented by caffeinate" forever**,
and that is the line a person actually runs when they ask what is keeping their
Mac awake. That is a sharper cost than "`pmset -g assertions` shows the wrong
string", and it is the strongest argument for option B in §4. (Activity
Monitor's Energy tab surfaces the same attribution; I did not open it in this
session, so treat that sentence as unverified.)

### This Studio, read-only, 2026-09-19 15:40 EDT

```
$ pmset -g custom
UPS Power:
 Sleep On Power Button 1   lowpowermode 0   standby 0   ttyskeepawake 1
 powernap 1   displaysleep 2    womp 1   networkoversleep 0
 sleep 0   tcpkeepalive 1   autorestart 1   disksleep 0
AC Power:
 Sleep On Power Button 1   lowpowermode 0   standby 0   ttyskeepawake 1
 powernap 1   displaysleep 30   womp 1   networkoversleep 0
 sleep 0   tcpkeepalive 1   autorestart 1   disksleep 0

$ pmset -g | grep sleep
 sleep                0 (sleep prevented by powerd, Claude, screensharingd)
 displaysleep         30
 disksleep            0
 ttyskeepawake        1
```

Reading it:

- **`sleep 0` on both profiles** — idle sleep is already disabled by hand here,
  so `keep_awake` would be a no-op on this machine today. That is the single
  most important local finding: the setting is not for the Studio, it is for
  every other Mac an install lands on, and for turning a hand-set preference
  into a stated product guarantee.
- **`displaysleep 30` (AC) / `2` (UPS)** — the screen does sleep, which is the
  behaviour Q1 asks to preserve. `-i` preserves it; `-d` would destroy it.
- **`ttyskeepawake 1`** — any live tty (an open `ssh`) already prevents idle
  sleep, which makes this an easy setting to believe is holding when it is not.
- **`pmset -g` names the offending processes** in one line. That is the probe a
  human runs, and §3's finding is about which name appears in it.
- **A Mac Studio has no battery.** The second profile is the UPS; there is no
  `Battery Power` profile at all.

## 4. The process root: Swift or Node, and what "one process" buys

### What exists today, verified live

```
$ launchctl print gui/501 | grep foldedspacelabs
		    9007    -15 	com.foldedspacelabs.metistry
		   10247    -15 	com.foldedspacelabs.metistry.calendar
		   36042      - 	application.com.foldedspacelabs.metistry.191270564.191270826

$ ls ~/Library/LaunchAgents | grep metistry
com.foldedspacelabs.metistry.calendar.plist
com.foldedspacelabs.metistry.plist
```

**A launchd-shape install loads exactly two agents**, plus the Mac app's own
GUI application service when the app is open. `ops/launchd/` holds nine plist
templates, but that is the template set, not the loaded set: `loadPlistTemplates`
(`packages/cli/src/launchd.ts`) chooses from it by shape, and under `launchd`
the per-service templates (`…assistant`, `…console`, `…db`, `…reconciler`,
`…watchdog`, `…apple-fm`, `…eventkit`) are superseded by the supervisor. "Each
component has its own plist" describes the compose shape and the history, not
what a launchd install runs.

What supervises what:

| what | supervised by | how |
| --- | --- | --- |
| Postgres, console, reconciler, assistant, enabled bridges | `com.foldedspacelabs.metistry` (pid 9007) | `apps/watchdog/src/supervisor.ts` — ordered start with TCP readiness probes, per-child exponential backoff, crash-loop reporting, SIGTERM-then-SIGKILL in reverse order, per-child log files |
| the supervisor itself | `launchd` | `KeepAlive`, `ProcessType Background` |
| `ek-helper` (the Calendars/Reminders TCC helper) | `launchd`, as `com.foldedspacelabs.metistry.calendar` (pid 10247) | its own agent, because a TCC grant attaches to the binary that asks |
| `metistry restart\|stop\|start <service>` | the supervisor's unix socket | `apps/watchdog/src/control.ts` — 0600 socket, constant-time shared-token check; launchd does not know the children exist |

And the root is already named: `__SUPERVISOR_BIN__` is a symlink named
`Metistry` at this install's node, which is why `pgrep -x Metistry` answers
9007 and why System Settings › General › Login Items shows one row called
**Metistry** rather than "node".

**Correction to a premise worth flagging.** There *is* `SMAppService` and
login-item code in `apps/macos` today —
`apps/macos/sources/app/login-item-service.swift` implements both
`SMAppServiceLoginItem` (`SMAppService.mainApp`) and
`SMAppServiceBackgroundAgent` (`SMAppService.agent(plistName:)`), with kit-side
models in `sources/kit/login-item.swift` and `background-agent.swift`, tests in
`tests/kit/background-agent-tests.swift`, and the two-registrar rule documented
in `docs/ops/deployment-shapes.md` §"Two registrars". Option D below is
therefore not "build login-item support"; it is "re-point the existing
registration at a different root", which is a different and smaller-sounding
change with a much worse consequence.

### What the release pipeline already does for Swift, exactly

So the marginal cost of one more native binary is a measured number, not a
guess:

- **Build + sign**: `packages/mcp-eventkit/scripts/build-helper.sh` and
  `packages/mcp-apple-fm/scripts/build-helper.sh` each do
  `swiftc -O -target arm64-apple-macos14.0 …` into a **minimal `.app` bundle**
  (`Contents/Info.plist` + `Contents/MacOS/<name>`), `plutil`-normalise an
  entitlements file, then `codesign --force --options runtime --timestamp
  --identifier … --sign <Developer ID, auto-detected by hash, else ad-hoc>`.
- **In the release pipeline** (`.github/workflows/release.yml`, `runtime`):
  on a `macos-26` runner, `./.github/actions/apple-keychain` imports the
  Developer ID from `APPLE_CERTIFICATE_P12`, then a single step runs
  `pnpm -r --if-present run build:helper` — **a package that declares
  `build:helper` is picked up with no pipeline edit at all** — and
  `ops/release/pack-runtime.sh` packs the bundles into the darwin runtime
  pack.
- **Notarization** is not applied per-helper: `ops/release/notarize.sh`
  notarizes and staples `Metistry-<version>.dmg` after `build-app.sh` embeds
  the packs and re-signs. A helper inside the DMG is notarized with it; a
  helper reaching a machine via `metistry update` (pack only, no DMG) is signed
  but not separately notarized, which is the status quo for the two that exist.
- **CI** (`.github/workflows/ci.yml`) does **not** build the Swift helpers —
  only `swift build` / `swift test` of `apps/macos` on `macos-15`. A third
  helper would compile only at release time unless CI grew a step.

So: a tiny non-TCC Swift binary costs a package directory, a `build:helper`
script, ~40 lines of Swift, an `Info.plist`, **zero** pipeline edits, and a
runtime-path lookup of the kind `packages/cli/src/tcc-pin.ts` and
`apps/macos/sources/kit/runtime-locator.swift` already do. Not free — a third
thing to keep compiling as Xcode moves, and a third signed artefact in the
inventory — but genuinely small.

### The four options

| | A. `caffeinate` child of the watchdog | B. tiny Swift `metistry-power` helper | C. Swift supervisor as process root | D. the Mac app as root |
| --- | --- | --- | --- | --- |
| Mechanism | `caffeinate -i -w <watchdog pid>` | `IOPMAssertionCreateWithName`, held for its own lifetime, `-w`-equivalent by being a supervised child | as B, plus it replaces the Node supervisor | `SMAppService.mainApp`, app holds the assertion |
| Assertion name | fixed, Apple's; `pmset -g` says `caffeinate` (§3) | ours, templated from `identity.yaml` (≤128 chars); `pmset -g` says `Metistry` | same as B | same as B |
| New code | ~90 lines TS + tests | ~40 lines Swift + ~60 TS + tests | ~700 lines of Swift replacing ~707 lines of tested TS (`supervisor.ts` 297, `control.ts` 108, `main.ts` 132, `core/supervisor.ts` 170) plus its suite | re-point one registration |
| Release pipeline | nothing | one `build:helper`, no pipeline edit | a third signed target on the critical path of every release; CI would need a `swift build` for it | nothing |
| launchd shape | unchanged: 1 agent + TCC helper | unchanged | unchanged in *count*; the agent's program becomes a signed Swift binary instead of the `Metistry` symlink | **the supervisor agent goes away**; the install's lifetime becomes the app's |
| `metistry up` | +1 env var | +1 env var, + locate the helper binary | rewrites `supervisor.json` consumption; the writer is unchanged but the reader is a new language | must stop installing an agent |
| `metistry stop/start/restart <service>` | unchanged | unchanged | the control socket protocol must be reimplemented in Swift, byte-for-byte, with the same constant-time token check; the CLI client is unchanged | unchanged, if the app keeps a socket |
| `metistry doctor` | +1 row | +1 row | supervisor and child rows read the same socket — unchanged if C is faithful, broken if not | the supervisor row loses its subject |
| compose shape | unchanged — the watchdog is the holder under both | unchanged | **forks it**: there is no supervisor under compose and no Swift on Linux, so the Node supervisor survives anyway and there are two | irrelevant; no app on Linux |
| invariant 6 | satisfied | **violates it** — macOS does not require native for this | **violates it harder** — launchd is already the native supervisor | satisfied, but breaks the "no window open" promise |
| invariant 7 | satisfied | satisfied (macOS-only, no-op elsewhere) | at risk: the watchdog's probe loop is the invariant-3 exception and the only component that speaks to Postgres; it must stay Node for Linux, so Node stays in the tree regardless | n/a |
| Blast radius if wrong | one child process | one child process | the whole launchd shape | the whole install |

### What "looks like one process" actually buys — and it is already bought

The owner's question is the right one, and the answer is better than expected:
**the process root already exists and is already named `Metistry`.** Making it
Swift changes the implementation language, not the shape the user sees.
Concretely, of the four surfaces where "one process" is visible:

1. **System Settings › General › Login Items** — already one row, "Metistry",
   with the agent nested under the app when the app registered it
   (`docs/ops/deployment-shapes.md`). Swift changes nothing.
2. **`launchctl`** — already one label, `com.foldedspacelabs.metistry`, plus
   the TCC helper, which must stay separate in every option because a TCC grant
   attaches to the binary that asks. Swift changes nothing.
3. **Activity Monitor, hierarchical view** — already one tree under `Metistry`.
   Swift changes nothing.
4. **Activity Monitor's default flat list / `ps`** — children appear as `node`,
   `postgres`, `sandbox-exec`. **A Swift root does not rename its children
   either.** What *would* rename them is the same symlink trick the root
   already uses, per child, in `metistry up` — and §3 proved the mechanism
   holds for the kernel process name (`pgrep -x Metistry` matched a symlinked
   binary). Caveats: Postgres rewrites its own process title and will not take
   it; `sandbox-exec` is untested. That is ~10 lines in `metistry up`, in
   either language.

So the honest summary for the owner: **Swift buys a nicer answer to "what is
keeping my Mac awake" (option B) and nothing else that the user can see.** It
does not buy "one process", because one process is what there already is.

### Recommendation on the root

**A now; B as a small, well-scoped follow-on; not C; never D.**

- **A now** because it is ~90 lines, no new artefact, no invariant strain, and
  it is correct. Ship keep-awake on it.
- **B is the one upgrade worth wanting**, and §3's symlink finding is why: with
  `caffeinate`, `pmset -g` names `caffeinate` forever, and there is no trick
  that changes it. A ~40-line Swift binary whose assertion name is templated
  from `identity.yaml` makes the machine's own answer to "why is this Mac
  awake" be the assistant's name. Its cost is genuinely small (no pipeline
  edit), and it is a clean B-replaces-A swap behind the same module seam — so
  A's code should be written with that swap in mind (one `startHolder()` /
  `stopHolder()` interface, one process either way). It is still an invariant-6
  violation and needs the owner's ruling, not mine.
- **Not C, and not later either unless something else forces it.** It replaces
  ~707 lines of tested TypeScript and a hand-rolled supervisor `CLAUDE.md`
  names as deliberately hand-rolled, to solve a naming problem the `Metistry`
  symlink already solved; it does not remove Node from the tree, because the
  watchdog's probe loop is invariant 3's sole exception and needs `pg`, which
  has no Swift equivalent inside this repo's dependency budget; and it forks
  the lifecycle between the two shapes, because compose has no supervisor and
  Linux has no Swift. **My answer to "should C be done now instead" is no** —
  and I would want a different reason than aesthetics before doing it later.
- **Never D.** `login-item-service.swift`'s own comment states the problem:
  `SMAppService.mainApp` "registers THIS APP as a login item: it opens a window
  when you log in, and starts nothing." Rooting the install at the app makes
  quitting the window stop Postgres, and makes a Sparkle update restart the
  entire install. On macOS, `BackgroundTask` is an *assertion type*
  (`pmset -g assertions` lists it), not a scheduling framework; there is no
  `BGTaskScheduler` equivalent to lean on. The LaunchAgent is the right root
  and the app is the right window onto it.

## 5. Who is logged in: fast user switching, logout, and the daemon question

### Fast user switching is a non-event; logout is the boundary

Our plists set no `LimitLoadToSessionType`, and TN2083 is explicit about what
that means: "If you don't specify the `LimitLoadToSessionType` property,
`launchd` assumes a value of `Aqua`." `launchd.plist(5)` confirms the key's
domain: "This key only applies to [services] which are agents. There are no
distinct sessions in the privileged system context." Verified live — the domain
`metistry up` bootstraps into (`packages/cli/src/launchd.ts`, `gui/${uid}`) is
an Aqua login domain:

```
$ launchctl print gui/501 | head
gui/501 = {
	type = login
	creator = loginwindow[415]
	session = Aqua
	security context = { uid = 501, asid = 100023 }
```

**Fast user switching does not end that session.** TN2083, on the execution
context: "The first instance of `loginwindow`, the one associated with user A's
login session, is a child of the global `launchd`. The second instance, created
when user A fast user switched to user B, is a child of the window server."
Apple's own description of the feature is "when more than one user is logged in
at the same time". So A's login domain, A's agents and A's children all persist;
what A loses is the *console* — the foreground window server session.

What Aqua-session backgrounding actually does to the agent: **nothing, for
anything headless.** The agent is not terminated, not suspended and not
reparented; it simply stops being the console session. Anything that needs to
draw, capture the screen, or take the console blocks or fails for A while B is
in front. Every one of our children is headless — Postgres, an HTTP server on
loopback, the reconciler, the assistant, the bridges. The power assertion is
likewise unaffected: `pmset -g assertions` has one "Assertion status
system-wide" block with no per-session partition, and `IOPMCopyAssertionsStatus`
describes a single system-wide level. *(That last inference — that a
non-console session's assertion is still honoured — follows from the API's
system-wide framing rather than from a statement I could quote; I could not test
it without logging the owner out, and I did not.)*

**Actual logout stops us.** Apple's *Daemons and Services Programming Guide*:
"A user agent is essentially identical to a daemon, but is specific to a given
logged-in user and executes only while that user is logged in", and at logout
launchd "sends a `SIGTERM` signal to all of the user agents that it started."
Everything goes: the supervisor, Postgres, the console, the assistant, the TCC
helper, and the assertion with its holder.

| Registration | screen lock | fast user switch | real logout | reboot |
| --- | --- | --- | --- | --- |
| LaunchAgent in `gui/<uid>` (both registrars, today) | runs | **runs** — session persists | **stops** (`SIGTERM`) | stops; returns at login |
| LaunchDaemon in the system domain | runs | runs | runs | returns at boot — **but see FileVault** |

### The LaunchDaemon, evaluated properly

`launchd.plist(5)`: "`UserName` … This key is only applicable for services that
are loaded into the privileged system domain… Note that for agents, the
`UserName` key is ignored." So a daemon that runs **as the installing user**
rather than as root is expressible, and it is the only version of the idea
worth evaluating. Installing it needs root — `launchctl(1)`: "root privileges
are required to make modifications" to the system domain — and the repo has no
code for it (`SMAppService.daemon(plistName:)` appears nowhere; only `.mainApp`
and `.agent`).

Six checks, in the order they kill the idea:

**1. FileVault removes the headline prize.** The daemon's whole claim is
"survives reboot and logout". On this machine:

```
$ fdesetup status
FileVault is On.

$ df -h ~ | tail -1
/dev/disk3s5   926Gi   717Gi   151Gi    83%    /System/Volumes/Data

$ diskutil apfs list | grep -A3 "disk3s5 (Data)"
|   |   APFS Volume Disk (Role):   disk3s5 (Data)
|   |   Name:                      Data (Case-insensitive)
|   |   FileVault:                 Yes (Unlocked)
```

Apple: "After a user turns on FileVault on a Mac, their credentials are
required during the boot process." So after an unattended restart — the exact
scenario a daemon is for — **nothing runs, daemon or agent**, until a human
authenticates. The escape hatch is `fdesetup authrestart`, and `fdesetup(8)`
prices it honestly: "**WARNING: FileVault protections are reduced during
authenticated restarts.** In particular, `fdesetup` deliberately stores at
least one additional copy of a permanent FDE unlock key in both system memory
and (on supported systems) the System Management Controller (SMC)." That is
root-only, one-shot, and not something to build a product on.

**2. File access to the user's home is fine — and the classic objection is
obsolete.** POSIX-wise, a daemon with `UserName` set to the installing user
reads that user's home exactly as the user does. TN2083 warns that "If the user
has an AFP home directory, or their home directory is protected by FileVault,
the volume containing the home directory will only be mounted when the user is
logged in" — but that sentence is about **legacy per-user FileVault**, where
each home was an encrypted sparse bundle. Today the output above shows a single
volume-level `Data` role carrying every home, unlocked during boot. So once the
system is running at all, a daemon can read `~/Development/metistry-instance`.
This is the one check the daemon passes.

**3. TCC is where it breaks, and precisely one component is affected.**
TN2083: "A daemon cannot display any GUI; more specifically, it is not allowed
to connect to the window server." A TCC consent alert is drawn by the user's
session, so a daemon cannot cause one to appear. The dividing line:

| TCC class | where the grant lives | can a daemon get it? |
| --- | --- | --- |
| Full Disk Access, Accessibility, Screen Recording, Input Monitoring, Developer Tools | system database, `/Library/Application Support/com.apple.TCC/TCC.db` | **yes** — the user adds the binary in System Settings without the binary asking |
| Calendars, Reminders, Contacts, Photos, Microphone, Camera, Desktop/Documents/Downloads | the user's own database, `~/Library/Application Support/com.apple.TCC/TCC.db` | **no** — the pane lists a client only after it has asked, and a daemon cannot ask |

The second row is an inference from the database split plus TN2083's no-GUI
rule; the split itself is observable, and so is the enforcement:

```
$ ls -l ~/Library/Application\ Support/com.apple.TCC/
ls: …/com.apple.TCC/: Operation not permitted
$ ls -l /Library/Application\ Support/com.apple.TCC/
ls: /Library/Application Support/com.apple.TCC/: Operation not permitted
```

(That refusal is TCC enforcing itself against a shell without Full Disk Access —
a live demonstration that the boundary is real, not a configuration accident.)

**Which of our components this touches: exactly one.** `requires_tcc` is
non-empty in a single manifest —
`packages/mcp-eventkit/manifest.yaml`: `requires_tcc: [calendars, reminders]`.
`packages/mcp-apple-fm/manifest.yaml` is `requires_tcc: []` and is
`runs_on: host` for a different reason its own comment gives ("FoundationModels
is macOS-only; NO TCC grants needed"), and `…metistry.calendar` is the launchd
label of the EventKit *helper*, not a third bridge. So there is one TCC-bound
component, it is already its own agent so the grant attaches to it, and **it
would stay an agent under any daemon shape** — giving the worst of both: a
daemon supervisor running while nobody is logged in, and a calendar bridge that
is `absent` (`degrades: absent`, its own manifest) for exactly that window.

**4. The keychain splits the install's credentials.** `docs/ops/auth.md`: "the
login Keychain is its home (`metistry:METISTRY_LOCAL_OWNER_TOKEN`, under the
instance's `instance_id`), and `<instance>/.metistry/state/.env` — 0600,
generated from the Keychain — is how it reaches the console's environment."
The running install therefore reads `.env`, not the Keychain, and a daemon
could start from it. What a daemon could **not** do is anything that goes back
to the Keychain: `metistry secrets`, `metistry compute providers add`
(`packages/cli/src/compute.ts` looks the provider secret up by account), and —
the load-bearing one — **the reconciler's push**. `packages/cli/src/connect-repo.ts`
sets `credential.helper=osxkeychain` on the instance repo and notes "git and the
reconciler both read the login Keychain", and `packages/cli/src/keychain.ts`
records that the item "is still gated by the login keychain being unlocked".
The login keychain is unlocked by the user's login, and a daemon has no window
server to prompt with. D5's sole committer would fail to push, silently,
whenever nobody is logged in — which is precisely the window the daemon exists
to cover.

**5. No window server, so the app cannot be the daemon's face.** The Mac app
would still need its own registration; the daemon would gain nothing for the
UI and lose the one-row Login Items shape that `docs/ops/deployment-shapes.md`
was written to protect.

**6. Two users, two installs — which is supported today, and a shared daemon is
not.** Two people each installing Metistry get two agents, two instance
directories, two vaults, two consoles on different ports, two Keychain accounts
— and that is already supported (`--namespace`, `instances.yaml`,
`docs/ops/instances.md`). A *shared* daemon would need multi-instance semantics
the product does not have and should not acquire for this: whose vault does the
one supervisor hold, whose Keychain does it read, whose TCC grants does it
inherit (none, per check 3), and who owns the console's single port? That is a
design, not a setting.

### Recommendation on the multi-user shape: stay a per-user LaunchAgent

Decisively. The daemon buys one thing — running while its user is logged out —
and pays for it with the TCC-bound bridge, the reconciler's push credential, a
root install step the product has no code for, and multi-instance semantics
that do not exist. Meanwhile:

- **Fast user switching, the owner's actual scenario, is already handled.** A Mac
  with several accounts that people switch between keeps every logged-in user's
  agent running. Metistry keeps answering while someone else is at the screen.
- **Real logout is rare on an always-on Mac** and is, on any FileVault machine,
  in the same class as the reboot the daemon also cannot survive unattended.
- **The knowledge is in the user's home and the instance is theirs.** A per-user
  agent is the shape that matches where the data lives and who consented to
  what. A shared daemon inverts that.

The honest sentence for the docs is: *keep-awake, and the install, hold while
you are logged in; fast user switching is fine; logging out stops them.*

**One thing to test if the need ever appears, and only then.** `launchctl(1)`
says "A user domain **may exist independently of a logged-in user**", which is a
different thing from the `gui/<uid>` login domain we bootstrap into today. I
could not find an Apple statement on whether a service bootstrapped into
`user/<uid>` survives that user's logout, and I did not test it, because
testing means logging the owner out. If a concrete two-person-Mac need ever
lands, **that experiment is the first step, not a daemon.**

## 6. Where the setting lives, what doctor says, which surfaces

### `deployment.yaml`, and reusing the write path

`deployment.yaml` is the right file: `keep_awake` is about *where and how this
install runs on this machine*, which is what that file is for
(`packages/core/src/deployment.ts`), and it is already per-instance under the D4
overlay. One vocabulary in the file, the CLI argument and the environment
variable.

**Additive forward, breaking backward.** `deploymentSchema` is `.strict()` and
`parseDeployment` throws on an unknown key — "an unknown key or a misspelled
shape is an error, never a silent fall back to compose". A new CLI reading an
old file is fine (`.default("allow_sleep_on_battery")`); an **older CLI reading
a file that carries `keep_awake` fails outright**, with every verb that loads
deployment refusing. Cheapest mitigation: ship the schema key in one release and
let nothing write it until the next — the same additive-first discipline
`CLAUDE.md` requires of migrations. That is the recommendation, and it costs one
release of patience.

`deployment.yaml` is a §4.7 protected path (invariant 2), so
`metistry deployment set-keep-awake <always|allow_sleep_on_battery|never>` goes
through `writeProtected` (`packages/cli/src/protected-write.ts`) as the user,
exactly as `set-shape` does (`packages/cli/src/deployment-report.ts`): preview
without `--yes`, applied with it. `applyShapeToYaml` rewrites only the `shape:`
line and leaves comments and other keys alone
(`packages/cli/src/deployment.ts` l. 86), so a sibling `applyKeepAwakeToYaml` is
a short copy and neither verb clobbers the other's key.

`metistry up` renders `METISTRY_KEEP_AWAKE=<value>` into the holder's
environment under both shapes — into `supervisor.json`'s `env` dict under
`launchd` (which `main.ts` applies over `process.env` at startup) and into the
watchdog agent's environment under `compose`. **No change to
`supervisorConfigSchema`**, which keeps the two shapes on one code path. The
holder writes `<instance>/.metistry/state/keep-awake.json` (mode, holder pid,
since, last observed power source) so doctor can report under compose too, where
there is no control socket to ask.

### What `metistry doctor` should say

One row, `kind: "keep-awake"`, macOS only (off darwin it is not emitted —
invariant 7: `caffeinate` does not exist on Linux). It cross-checks the state
file's pid against the **"Listed by owning process"** block of
`pmset -g assertions` — never the summary block, which is a maximum not a count
(§3), and never a name match, because §3 showed the name belongs to the resolved
binary. Status vocabulary is `packages/core/src/check.ts`'s
`ok | degraded | failed | absent`.

| Situation | status | probe / remediation |
| --- | --- | --- |
| `keep_awake: never` | `absent` | "not configured — this Mac may idle-sleep and stop collecting until it wakes. `metistry deployment set-keep-awake allow_sleep_on_battery`" (`absent` renders as "not configured", `app-ux-plan.md` §3.2) |
| `always`, held | `ok` | "`pmset -g assertions` lists PreventUserIdleSystemSleep held by pid N, spawned by the supervisor"; meta `{assertion_id, pid, since, power_source, mode}` |
| `allow_sleep_on_battery`, on AC, held | `ok` | as above, plus "drawing from 'AC Power'" |
| `allow_sleep_on_battery`, not on AC | `ok` | "released on purpose — drawing from 'Battery Power'" (or `'UPS Power'`). **Never a finding**: this is the configured behaviour, and the row must read as success, not as a downgrade |
| configured on, nothing held | `degraded` | "`keep_awake: <value>` but nothing holds PreventUserIdleSystemSleep for pid N — the supervisor is not running, or the holder exited: `metistry logs supervisor`" |
| held, but `pmset -g` already says `sleep 0` | `ok`, with meta | "idle sleep is already disabled on this power source, so the assertion changes nothing" — this Studio's case today |
| portable, lid closed | `degraded` | "an idle-sleep assertion does not survive lid close (IOPMLib.h). A lid-closed Mac stays awake only in closed-display mode, which is your own display/power/input setup, not something Metistry can arrange" |
| someone else is holding one too | `ok`, with meta | "another process also holds PreventUserIdleSystemSleep (pid M) — independent of ours, and neither affects the other". Informational only; **never** a finding, and never an offer to stop it |

`degraded`, never `failed`: the install is running and correct; a promise is
unmet. Doctor's exit code stays clean, which matters because `metistry up`
calls doctor at the end.

### Which surfaces

- **Mac app: Settings → Services.** The Services pane already holds "Start at
  Login" and "Background" ("Run Metistry in the background") and renders the
  deployment shape read-only (`apps/macos/sources/kit/settings-view.swift`,
  `servicesPane`). A third section — **"Keep this Mac awake"**, a switch plus
  a two-item radio under it — belongs with its siblings, and the switch/radio
  shape is exactly the owner's "let the user choose".
  **Two real costs, stated rather than buried.** (a) Q1 says Status pane;
  Status is defined as "`metistry doctor --json` rendered"
  (`app-ux-plan.md` §3.2) — a read-only rendering, so the *row* goes to Status
  and the *control* to Services (§8). (b) Compute is today "the only pane that
  writes" (`app-ux-plan.md`); this makes Services the second, and unlike its
  two neighbours — which are `SMAppService` registrations macOS persists — this
  one writes a **protected file**. It must shell the CLI verb through the
  existing `process-command-runner` path and surface the preview and any
  refusal, never write YAML itself. That is the invariant-2 boundary and the
  single most likely thing to get wrong.
- **The app copy must name the lid.** One line under the radio: "A Mac laptop
  still sleeps when you close the lid."
- **The console / PWA: no.** Invariant 10 keeps the console's mutating surface
  a closed enumerated set, and this is a per-Mac host setting that means nothing
  on a phone. It arrives in Status for free as a doctor row; no action.
- **The assistant's name.** Under option A there is no name to template — the
  string is Apple's, and §3 showed no trick changes it. Under option B the
  `AssertionName` is the templated string from `identity.yaml` (≤128 chars) and
  is the only place the assistant's name appears; everything mechanical stays
  `keep-awake` / `assistant_*` / lowercase, per `CLAUDE.md`.

## 7. Edge cases, and the recommendation

### Edge cases

- **Already `sleep 0`** (this Studio). Harmless and redundant; assertions layer
  over `pmset` settings rather than conflicting. Doctor should say the
  assertion is a no-op here rather than claim credit for it.
- **Power Nap / Dark Wake.** `powernap 1` on this machine. The header is
  categorical: "This assertion has no effect if the system is in Dark Wake."
  A Mac that has genuinely slept and wakes darkly for Power Nap cannot be held
  awake by this assertion, and a collector that starts during dark wake can be
  cut off mid-run. The API for that is `kIOPMAssertNetworkClientActive` /
  `BackgroundTask` — a different question, flagged, out of Q1's scope.
- **Scheduled sleep** (`pmset -g sched`) and the Apple menu's Sleep item both
  bypass the assertion by design ("Apple menu […] or other sleep reasons").
  Nothing to do; say it once so it is not a bug report later.
- **Thermal.** A thermal emergency sleeps or shuts down the Mac regardless of
  any assertion. `pmset -g therm` is the read; nothing to build.
- **Low battery.** Explicitly listed as a sleep reason the assertion does not
  stop — so even a laptop set to `always` sleeps at low battery. Safe by
  default.
- **Compose shape.** Containers do not hold assertions and a Docker VM is
  suspended with the host, so a compose install needs the same holder in the
  same process — which is why the watchdog, not the supervisor, is the home.
  Whether Docker Desktop itself holds an assertion could not be observed here
  (not running on this Mac; nothing Docker-related in `pmset -g assertions`), so
  the design assumes it does not and does not depend on the answer.
- **Second instance on one Mac** (`--namespace`). Two holders, two assertions,
  one system-wide level — correct, per `IOPMCopyAssertionsStatus`'s maximum
  rule, and merely noisy. Optional refinement, not a blocker.
- **Someone else's `caffeinate`.** Covered in §3: match our recorded pid, never
  a name, never "is any `caffeinate` running".
- **`ttyskeepawake 1`.** An open `ssh` session already prevents idle sleep, so
  an owner debugging over `ssh` will never see idle sleep and may believe
  keep-awake is holding when it is not. Doctor's probe is the pid, which is
  immune to this.

### The shape to build

| Piece | Where | Size |
| --- | --- | --- |
| `keep_awake: always \| allow_sleep_on_battery \| never` in the schema (+ seed comment) | `packages/core/src/deployment.ts`, `seed/deployment.yaml` | ~25 lines |
| `metistry deployment set-keep-awake <value>` through `writeProtected`, `applyKeepAwakeToYaml` | `packages/cli/src/deployment.ts`, `deployment-report.ts`, `main.ts` | ~70 lines |
| `METISTRY_KEEP_AWAKE` rendered into the holder's environment under both shapes | `packages/cli/src/up.ts` | ~15 lines |
| The holder, behind a `startHolder()`/`stopHolder()` seam so option B is a swap: spawn `caffeinate -i -w <own pid>`, re-spawn if it exits, re-evaluate `pmset -g ps` on the existing 60s probe cycle for `allow_sleep_on_battery`, release on `SIGTERM`, write `state/keep-awake.json` | `apps/watchdog/src/keep-awake.ts` | ~90 lines + tests |
| Doctor row (darwin only), parsing the per-process block of `pmset -g assertions` | `packages/cli/src/doctor.ts` | ~50 lines + tests |
| Settings → Services section: switch + two-item radio, shelling the CLI verb | `apps/macos/sources/kit/settings-view.swift`, `settings-model.swift` | ~100 lines + a kit test |
| Docs | `docs/ops/deployment-shapes.md`, `docs/ops/cli.md`, a `docs/product/record/` fragment | ~70 lines |

**Effort: S/M — about one focused day**, most of it tests and the app section.
No new dependency. No native code. No migration. No change to
`supervisorConfigSchema`. No change to the launchd shape, the compose shape, or
`metistry up/stop/doctor` beyond one row and one variable.

**What needs the owner's hand: nothing operationally; two rulings.** Power
assertions need no privileges, no TCC grant and no `sudo` — unlike every other
macOS surface this product touches, there is no approval step and no System
Settings visit. The rulings are the default (§8 Q-a) and whether option B's
Swift helper is worth an invariant-6 exception (§8 Q-b).

**Deliberately not built:** a Swift supervisor; a LaunchDaemon; a console
action; any attempt to defeat lid-close sleep; any Dark Wake handling; any code
that reads, releases or reports on another process's assertion as if it were
ours to manage.

### Implemented as (2026-09-19)

Built to this shape, with the owner's rulings folded in: option A behind a
`PowerHolder` seam so option B stays a swap (`apps/watchdog/src/power.ts`);
`keep_awake` in `packages/core/src/deployment.ts` with the rule and the state
file in a new `packages/core/src/power.ts`; `metistry deployment
set-keep-awake` and the row in `packages/cli/src/{deployment-report,doctor}.ts`;
the model half only in `apps/macos/sources/kit/keep-awake.swift`. Four values,
not three: the owner added an "even with the lid closed" choice and ruled it
must exist but never be a default — it is accepted, behaves as `always`, and
every surface says the lid-closed half is *not available on this Mac without an
administrator change*, because it is not (this doc §2; `pmset(1)`: "pmset must
be run as root in order to modify any settings"). §8's open question (a) is
answered by a different mechanism than either alternative offered: the seed
sets nothing and `metistry init` **asks**, printing what each choice costs,
because an assertion overrides the user's own sleep timer and consent is the
point. That decides (c) too — the key is written in the same release it is
read, so the downgrade note in §6 is now documented in
`docs/ops/deployment-shapes.md` rather than avoided by a release of patience.
(d) is `degraded`, not a refusal. Ruling E is new work this doc did not scope:
the holder compares wall clocks between its own ticks and records a cutoff when
the Mac slept under it, and doctor reports it with the repair. §1's "the
watchdog under BOTH shapes" was narrowed on instruction to the supervisor only,
so a compose install holds nothing and doctor says so — see the PR's note.

## 8. Contradictions with the plan, and open questions

**Contradictions** (reported, not edited — `docs/plan-refresh-2026-09-13.md` is
untouched by this PR). The plan text at issue is §4a's Q1 row, l. 409, which
reads in relevant part: *"A setting (proposed: `deployment.yaml`
`keep_awake: true`, surfaced in the app's Settings → Status pane and a doctor
row) under which the supervisor holds a power assertion that prevents idle
system sleep only — `IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep)`
from the app's background item, or a `caffeinate -i` child of the supervisor
(never `-d`, which pins the display) … Default: on for an always-on instance,
off on battery — to confirm"*.

1. **`keep_awake: true` cannot express the owner's ask.** A boolean has no room
   for two behaviours, and `true` parses as a YAML boolean where the schema
   needs a string enum. The plan should read
   `keep_awake: always | allow_sleep_on_battery | never` (§2).
2. **"Default: on for an always-on instance, off on battery"** is now two named
   user choices, not a default with a caveat — and it is missing a third value.
   Without `never` a user cannot get their own System Settings sleep timer back
   while Metistry runs, because an assertion overrides it (§2).
3. **"surfaced in the app's Settings → Status pane"** conflicts with
   `app-ux-plan.md` §3.2/§3.13, where Status is a read-only rendering of
   `metistry doctor --json`. The *row* belongs in Status; the *control* belongs
   in Settings → Services beside the two lifecycle toggles (§6).
4. **"from the app's background item"** is not the Swift option it sounds like.
   The background item *is* the supervisor — the agent
   `SMAppService.agent(plistName:)` registers — and it is **Node**. So that
   option is really "a new signed Swift binary", which invariant 6 excludes
   while `caffeinate` exists (§4).
5. **"a `caffeinate -i` child of the supervisor"** — under `shape: compose`
   there is no supervisor at all. The holder must be the **watchdog**, which is
   the same process under `launchd`. The wording should say "of the watchdog"
   (§1).
6. **"never `-d`"** should read **"never `-d`, never `-s`"**. `-s` takes
   `kIOPMAssertionTypePreventSystemSleep`, which `IOPMLib.h` documents as
   "Deprecated in 10.9. This assertion is not supported in any OS X releases",
   and `caffeinate(8)` limits to AC power anyway (§1).
7. **Q1 does not mention lid close, and it is the promise most likely to be
   misread.** On a MacBook with the lid shut, no value of this setting keeps
   the Mac awake, and the plan should say so where the setting is defined (§2).
8. **Q1 asks for "behaviour on battery vs AC (`pmset`)" as if it were a
   capability question.** It is not: `PreventUserIdleSystemSleep` is honoured on
   battery. Releasing on battery is policy. The plan's instinct is right for a
   different reason than the one implied (§2).
9. **`deployment.yaml` parsing is strict**, so `keep_awake` is additive going
   forward but breaks an older CLI reading a newer file. Worth a line in the
   plan if config keys are going to keep arriving (§6).

**Open questions for the owner:**

- **(a) The default.** `allow_sleep_on_battery` in `seed/deployment.yaml` means
  the product changes idle-sleep behaviour on a desktop unless told not to. It
  is defensible — the whole promise is "it is running", it never touches a
  laptop on battery, and doctor always says so — but it is still a default that
  changes machine behaviour without being asked. Alternative: seed `never` and
  have the first-run wizard offer the choice as one step. **This is the ruling
  I most want** and it is not mine to make.
- **(b) Option B, and invariant 6.** §3's symlink finding means that under
  `caffeinate`, `pmset -g` answers "sleep prevented by caffeinate" forever, and
  no trick changes it. Is a ~40-line signed Swift binary — whose only purpose
  is that the machine's own answer to "why is this Mac awake" is the
  assistant's name — worth an explicit invariant-6 exception? My recommendation
  is A now with the seam for B, and B only on an explicit ruling.
- **(c) The strict-schema release gap.** Ship the schema key one release before
  anything writes it (recommended), or accept that a downgrade needs the line
  removed by hand?
- **(d) Laptop honesty.** On a MacBook, should `always` with the lid shut be a
  `degraded` doctor row (recommended) or should `set-keep-awake always` refuse
  outright on portable hardware? Refusing is more honest and more annoying.
- **(e) Dark Wake / Power Nap.** Out of Q1's scope, but "a routine started
  during a Power Nap can be cut off" is a real gap for any install whose Mac
  does sleep — i.e. every `allow_sleep_on_battery` laptop. Worth its own item?
- **(f) The `user/<uid>` experiment.** Worth scheduling now, or only when a
  two-person Mac actually appears? It is the only remaining unknown in §5, and
  it needs a logout to answer.

## Sources

Local, verbatim (installed SDK / man pages on this Mac, 2026-09-19):

- `/Applications/Xcode.app/…/MacOSX.sdk/…/IOKit.framework/…/pwr_mgt/IOPMLib.h` —
  `kIOPMAssertPreventUserIdleSystemSleep` (l. 274–292: the "lid close, Apple
  menu, low battery" and "no effect […] in Dark Wake" sentences),
  `IOPMAssertionCreateWithName` (l. 757–781: "No special privileges", the
  128-character `AssertionName` limit), `IOPMAssertionRelease` (l. 647–663: the
  id is "returned from IOPMAssertionCreate" — you may only release your own),
  `IOPMCopyAssertionsByProcess` (l. 694–710: "One process may have multiple
  assertions. Several processes may have asserted the same assertion to
  different levels"), `IOPMCopyAssertionsStatus` (l. 714–726: "The system-wide
  level is the maximum of all individual assertions' levels"),
  `kIOPMAssertionTypePreventSystemSleep` (deprecated),
  `kIOPMAssertionTypePreventUserIdleSystemSleep` (an alias).
- `…/pwr_mgt/IOPM.h` l. 200–217 — `AppleClamshellState`,
  `AppleClamshellCausesSleep` ("true == system will sleep when clamshell is
  closed"; "false == … (typically external display mode)"; "not present == no
  clamshell on this hardware"); l. 518–533 — `kIOPMDisableClamshell`.
- `…/ps/IOPowerSources.h` — `IOPSGetProvidingPowerSourceType` returns one of
  `"AC Power"`, `"Battery Power"`, `"UPS Power"`.
- `caffeinate(8)` — `-d`, `-i`, `-m`, `-s` ("valid only when system is running
  on AC power"), `-t`, `-w` ("Waits for the process with the specified pid to
  exit. Once the process exits, the assertion is also released").
- `pmset(1)` — "processes may dynamically override these power management
  settings by using I/O Kit power assertions… See `caffeinate(8)`"; `-g
  assertions`; `lidwake`; `ttyskeepawake`; `noidle` ("deprecated in favor of
  `caffeinate(8)`").
- `launchd.plist(5)` — `UserName` ("only applicable for services that are
  loaded into the privileged system domain… for agents, the `UserName` key is
  ignored"), `LimitLoadToSessionType` ("only applies to [services] which are
  agents. There are no distinct sessions in the privileged system context"),
  `ProcessType Background`.
- `launchctl(1)` — `system/` ("root privileges are required to make
  modifications"), `user/<uid>` ("may exist independently of a logged-in
  user"), `gui/<uid>` / `login/<asid>` ("created when the user logs in at the
  GUI").
- `fdesetup(8)` — the `authrestart` warning, quoted in §5.

Fetched:

- Apple, *Daemons and Services Programming Guide* → "Creating Launch Daemons
  and Agents" — "A user agent is essentially identical to a daemon, but is
  specific to a given logged-in user and executes only while that user is
  logged in"; at logout launchd "sends a `SIGTERM` signal to all of the user
  agents that it started".
  <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>
- Apple, **TN2083 *Daemons and Agents*** — the `LimitLoadToSessionType` session
  table (Aqua / StandardIO / Background / LoginWindow) and "If you don't specify
  the `LimitLoadToSessionType` property, `launchd` assumes a value of `Aqua`";
  "The first instance of `loginwindow` … is a child of the global `launchd`.
  The second instance, created when user A fast user switched to user B, is a
  child of the window server"; "A daemon cannot display any GUI; more
  specifically, it is not allowed to connect to the window server"; "An agent …
  can do things that daemons can't, like reliably access the user's home
  directory or connect to the window server"; the `UserName` note for daemons.
  <https://developer.apple.com/library/archive/technotes/tn2083/_index.html>
- Apple Platform Security, *Volume encryption with FileVault* — "After a user
  turns on FileVault on a Mac, their credentials are required during the boot
  process."
  <https://support.apple.com/guide/security/volume-encryption-with-filevault-sec4c6dc1b6e/web>
- Apple, *Switch quickly between users on Mac* — fast user switching "allows
  you to quickly switch between accounts when more than one user is logged in
  at the same time".
  <https://support.apple.com/guide/mac-help/switch-quickly-between-users-mchlp2439/mac>
- **Not retrieved:** Apple's closed-display-mode support article. Three
  candidates (`support.apple.com/en-us/102243`, `…/en-us/HT202351`,
  `…/guide/mac-help/use-your-mac-laptop-with-the-display-closed-mh11842/mac`)
  returned unrelated pages. The clamshell claim in §2 rests on `IOPM.h`; the
  external power/display/input triple is flagged there as unquoted.

Live, read-only, this Mac, 2026-09-19 (no `sudo`, no `pmset` writes, no change
to the running install): `pmset -g`, `pmset -g custom`, `pmset -g ps`,
`pmset -g assertions`, `ioreg -r -c IOPMrootDomain -d 1`, `fdesetup status`,
`diskutil apfs list`, `df`, `mount`, `codesign -d`, `launchctl print gui/501`,
`ls ~/Library/LaunchAgents`, `who`, `pgrep`, `ps`; plus three short-lived
`caffeinate` experiments, each bounded by `-t` or `-w` and each confirmed gone
afterwards (the coexistence pair in §3, the symlink-naming pair in §3), and a
72-sample `pgrep -x caffeinate` sweep over six minutes.

Repo: `packages/core/src/deployment.ts`, `packages/core/src/supervisor.ts`,
`packages/core/src/check.ts`, `packages/cli/src/doctor.ts`,
`packages/cli/src/deployment.ts`, `packages/cli/src/deployment-report.ts`,
`packages/cli/src/launchd.ts`, `packages/cli/src/protected-write.ts`,
`packages/cli/src/keychain.ts`, `packages/cli/src/connect-repo.ts`,
`packages/cli/src/compute.ts`, `apps/watchdog/src/main.ts`,
`apps/watchdog/src/supervisor.ts`, `apps/watchdog/src/control.ts`,
`apps/watchdog/manifest.yaml`, `packages/mcp-eventkit/manifest.yaml`,
`packages/mcp-apple-fm/manifest.yaml`,
`packages/mcp-eventkit/scripts/build-helper.sh`,
`packages/mcp-apple-fm/scripts/build-helper.sh`,
`apps/macos/sources/app/login-item-service.swift`,
`apps/macos/sources/kit/settings-view.swift`, `ops/launchd/*.plist`,
`.github/workflows/release.yml`, `.github/workflows/ci.yml`,
`docs/ops/apple-signing.md`, `docs/ops/auth.md`,
`docs/ops/deployment-shapes.md`, `docs/ops/instance-layout.md`,
`docs/ops/mac-app.md`, `docs/product/app-ux-plan.md`.
