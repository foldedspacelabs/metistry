# Moving a live install from `compose` to `launchd`

The production runbook for open decision 15. One verb, reversible, and
every step printed before it runs:

```sh
metistry migrate-shape launchd
```

`docs/ops/deployment-shapes.md` is what the two shapes ARE; this is how an
install that is already running in one gets to the other without losing
its database. The shape was proven end to end on a scratch instance in
PR #117; this verb is that trial turned into something you can run on the
install you actually use.

## What it does, in order

Every step goes through the same StepRunner `up` and `update` use, so
`--dry-run` prints the plan and runs nothing.

| | |
|---|---|
| **preflight** | four refusals, all of them while the old shape is still up — below |
| **quiesce the writers** | `docker compose stop console assistant`. The database stays up. |
| **dump** | the table list and one exact `count(*)` per table, then `pg_dump --format=custom` **inside the running db container** (the container's own binary, so client and server versions match), copied out to `<instance>/.metistry/state/migrate/<ts>.dump`, then verified with `pg_restore --list` |
| **stop the database** | `docker compose stop db`. **`stop`, never `down -v`** — the containers and the named volume stay, and that is what makes the rollback real. |
| **deployment.yaml** | `shape: launchd`, written through the reconciler as the `user` principal — the same protected-write path `metistry deployment set-shape` uses (invariant 2, D5). The reconciler commits it. |
| **up** | `initdb` under `<instance>/.metistry/state/pg`, every host plist re-rendered against `current/`, the bundled node and `<instance>/.metistry/state/.env`, then bootstrapped |
| **restore** | `pg_restore` over the new server's unix socket, **before any migration runs** |
| **check** | the same generated count query against the restored database; a table that lost rows fails the migration by name |
| **tcc helpers** | the eventkit and apple-fm jobs are pinned at the signed bundles that hold the TCC grant — below |
| **doctor** | after waiting for the console and the reconciler to answer, so the verdict is not a race |

### Why the restore comes before the migrations

The dump carries `schema_migrations`, so the restored database arrives
with every applied migration already recorded. `db/migrations` is
idempotent by that table (`packages/cli/src/migrate.ts`, and
`ops/scripts/migrate.sh` under the same advisory lock), so the next
`metistry update` finds nothing to do. Proven in the rehearsal:

```
$ ops/scripts/migrate.sh          # against the freshly restored launchd database
migrations: 0 applied, 13 total
```

Running migrations first and restoring over them would work too, and it
would mean a restore into a non-empty schema for no benefit. This way the
database is only ever written once.

## Prerequisites

1. **A release whose pack carries `ops/sandbox/`.** That profile is the
   assistant's only confinement once the container boundary is given up,
   and `pack-runtime.sh` grew the copy 14 seconds after the **v0.5.0** tag
   was cut — so every pack up to and including v0.5.0 produces a launchd
   shape whose assistant job cannot start at all. **v0.6.0 is the first
   release that carries it.** `migrate-shape` refuses without it, by
   looking for the file rather than comparing versions.

   ```sh
   ls "$(metistry version --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["product_dir"])')/current/ops/sandbox/assistant.sb"
   ```

2. **The bundled runtime installed** — `<product>/runtime/` with node,
   Postgres 17 + pgvector and git (`docs/ops/bundled-runtime.md`).
   `metistry update --channel release` puts it there. `migrate-shape`
   refuses without it rather than downloading one mid-migration with the
   old shape already stopped.

3. **`metistry secrets sync --to env` done**, so `<instance>/.metistry/state/.env`
   is the install's environment. The launchd jobs read that file (or have
   it rendered into their plists); the product checkout's `.env` is a
   deprecated fallback.

4. **Docker running**, because the dump comes out of the live container.
   Docker is not needed again afterwards — for Metistry. Other projects'
   containers on the same Mac are untouched.

5. **A quiet moment.** The console and the assistant are down from the
   quiesce until the end; on the Studio that is well under two minutes.

## The commands

```sh
# 1. read the plan. This executes NOTHING.
metistry migrate-shape launchd --dry-run

# 2. run it. Under two minutes on the Studio.
metistry migrate-shape launchd

# 3. it ends with doctor; the exit code is doctor's verdict.
#    Expect: every check ok, plus `absent` for any bridge this install
#    does not configure.
```

That is the whole cutover. Everything below is what to watch and what to
do if it does not go that way.

### The `.stale` data directory — a second forward run after a rollback

`up` skips `initdb` whenever `<instance>/.metistry/state/pg/PG_VERSION` already
exists — the normal case is a restart, where that is exactly right. After a
`metistry migrate-shape compose` rollback it is not: `.metistry/state/pg` still holds
the restored copy from the cutover plus whatever launchd wrote afterwards,
and `pg_restore --exit-on-error` into a database that already has every
table fails immediately.

So a second `metistry migrate-shape launchd` run checks for that leftover
data directory itself, before calling `up`, and **moves it aside** —
`.metistry/state/pg.<timestamp>.stale` — rather than deleting it or reusing it. `up`
then `initdb`s a fresh one and the restore lands in an empty schema, same
as the first cutover. You will see:

```
.metistry/state/pg is already initialised — a previous migration's data, left over from a rollback. Moving it aside so `up` initdbs fresh …
kept at .metistry/state/pg.20260910T160403Z.stale — never deleted by this verb
```

**Nothing prunes `.stale` directories.** They are exactly as much a copy of
the database as the dump in `.metistry/state/migrate/` is, just less convenient to
restore from (no `pg_dump`/`pg_restore`, a directory copy over the socket
is not how you get data out of it while another Postgres is using the same
data directory name pattern). Once the *dump* for that same cutover
(`.metistry/state/migrate/<ts>.dump`) has been kept for the usual week and the
launchd shape has proven itself, the corresponding `.stale` directory is
safe to `rm -rf` by hand — it is redundant with the dump by then, just
bulkier.

### What to watch

- **`counts: … — every count identical`** near the end. That line is the
  restore checked, not assumed: one exact `count(*)` per table, on both
  sides, generated from the same list.
- **`dump verified: …, N TOC entries`** BEFORE `== stop the database`. The
  migration refuses to stop a healthy install behind a dump `pg_restore`
  cannot read.
- **`deployment.yaml written through the reconciler as user`**, and then
  `git -C <instance> log -1` showing the commit. That is also the proof
  that the reconciler still commits after the move — its git identity and
  credential helper live in the instance repo and the Keychain, neither of
  which this touches.
- **doctor's shape row** should read `shape launchd`.
- **the dump is kept.** `<instance>/.metistry/state/migrate/<ts>.dump` is the only
  copy of the compose database outside the Docker volume. Nothing prunes
  it.

### The four refusals

Each of these stops the migration with the old shape still running and
nothing changed:

| refusal | what to do |
|---|---|
| `ops/sandbox/assistant.sb is missing — this product tree predates the launchd-shape fixes (PR #117)` | `metistry update --channel release` to v0.6.0 or later |
| `runtime/ has no node — this install has no bundled runtime` | same |
| `no Postgres … toolchain` / `has no pg_dump, pg_restore` / `pgvector is not installed` | install the bundled runtime, or set `METISTRY_PG_BIN` |
| `this instance is namespaced … but its docker compose project is not` | set `COMPOSE_PROJECT_NAME` in `<instance>/.metistry/state/.env` — see below |
| `no running compose db container` | `docker compose up -d db`, or use `deployment set-shape launchd` + `up` if there is no data to keep |

### Two installs on one Mac

`--namespace` namespaces launchd labels and ports. It does **not**
namespace the docker compose project: `docker-compose.yml` carries
`name: metistry`, so a second install's `docker compose stop` would stop
the first install's containers. `migrate-shape` refuses that combination
outright, and `COMPOSE_PROJECT_NAME` in the instance's `.env` is the way
out — it is then passed as an explicit `-p` so the project is visible in
the printed plan.

## Rollback

```sh
metistry migrate-shape compose
```

Boots out the launchd `db`/`console`/`assistant` jobs — **waiting for each
one to actually be gone**, and for the bundled Postgres to stop answering
on its port, before touching compose at all — writes the shape back
through the reconciler, and `docker compose up -d`. The compose volume was
never touched, so the database comes back **exactly as it was at the
cutover**.

The waits exist because of a real outage (2026-09-10): `launchctl bootout`
returns before launchd has finished tearing the job down, and the bundled
Postgres can still be holding `127.0.0.1:5432` for a moment after its job's
label is gone. `docker compose up` binding the same port a heartbeat too
soon failed immediately with `ports are not available … address already in
use` — see the next section for what that looked like and how it was fixed
by hand that day, and how it now fixes itself.

**Anything written under launchd since the cutover is NOT copied back.**
It stays in `<instance>/.metistry/state/pg`. If you want it, dump it first — the
command is printed by the rollback itself:

```sh
<product>/runtime/postgres/bin/pg_dump -h <instance>/.metistry/state/run \
  -U metistry -d metistry -Fc -f <somewhere>
```

and restore it into the compose database afterwards.

The rollback ends with doctor too. Under the compose shape doctor may
report the console `degraded` with a 401 on the owner token — that is the
container-NAT wrinkle `METISTRY_TRUSTED_LOOPBACK_PROXY` exists for
(`docs/ops/auth.md`), not something the migration did.

## What a failed rollback looks like, and how to recover

**Do not treat the rollback as a smoke test.** It is for real trouble —
the launchd shape is broken and you need the install back the way it was.
Running it "just to check the rollback still works" throws away everything
written under launchd since the cutover (see above): the console and
assistant's activity, any rows the reconciler committed, all of it. Prove
the rollback once, in the PR-#117 rehearsal or a scratch instance — not
against production for a spot check.

That said, both directions of this verb now protect themselves: if
`docker compose up` fails after the launchd jobs are booted out, the
rollback bootstraps and kickstarts the three plists it just tore down (they
are still on disk — nothing about them was rewritten) and sets
`deployment.yaml` back to `launchd`, then exits non-zero. Same the other
way: if `up (launchd)` or the restore fails after `docker compose stop db`,
the forward migration brings the compose stack straight back
(`docker compose up -d`) and sets the shape back to `compose`. **Either
direction failing should now leave the install exactly as it was before
you ran the command that failed** — never with nothing running. This is
the fix for the 2026-09-10 outage: a rollback run as a rehearsal hit the
port race described above, `docker compose up` failed, and the migration
exited 1 with launchd down and compose refusing to start — production was
down until brought up by hand.

If you ever do see both shapes down anyway (an older build, or a failure
this compensation itself could not recover from — read whatever message
`migrate-shape` printed first), the manual recovery is one command, run
against the instance's own environment file:

```sh
cd current && docker compose --env-file <instance>/.metistry/state/.env up -d --no-build
```

`--no-build` matters: the images from the last cutover are still there,
and rebuilding is both unnecessary and slower than the outage needs to
last. Confirm with `docker compose ps` and `metistry doctor` once it is
up, and only then work out what broke the automatic recovery.

## Cleanup — not before a week

The old compose containers and the `metistry_db-data` volume are still
sitting there, which is the point: they are the rollback. Leave them.

**After a week of the launchd shape behaving**, and not before:

```sh
docker compose down -v          # removes the containers AND the volume
```

That is the irreversible step. After it, the only copy of the pre-cutover
database is `<instance>/.metistry/state/migrate/<ts>.dump` — keep that file, or
take a fresh `ops/scripts/backup.sh` first.

Docker itself stays installed on the Studio for unrelated projects
(caddy, tailscale, route53-ddns). Only Metistry leaves it.

## The TCC helper bundles — settled 2026-09-10

**The runtime pack ships no built helpers.** `pack-runtime.sh` copies
`packages/mcp-eventkit/helper` and `packages/mcp-apple-fm/helper`, but the
`.app` bundles inside them are gitignored build output that no release
runner builds, so a release carries the Swift sources, `Info.plist` and
`ek-helper.entitlements` — and nothing executable. Verified against the
installed v0.5.0 and v0.6.0 packs.

Under the compose shape this never showed: both bridge jobs were rendered
with `__REPO__` = the git checkout, which is exactly where the hand-built,
Developer-ID-signed bundles live. Re-rendering them against `current/`
would point both at a path that does not exist.

Three options were on the table:

1. the pack ships prebuilt signed helpers, built in the `macos-app` job
   (which holds the certificate);
2. `up` builds them on the host when `swiftc` exists;
3. the migration keeps pointing those two jobs at the bundles that already
   hold the grant.

**This cutover does (3), and (1) is the recorded follow-up.** The reason
is TCC, not convenience: a grant is keyed on the bundle identifier plus
the signature's designated requirement, which for a Developer ID identity
is *identifier + certificate chain, no cdhash*
(`docs/ops/apple-signing.md` §3). The bundles on the Studio already hold
the Calendars and Reminders grant under
`Developer ID Application: Folded Space Labs LLC (QWWHT4S27V)`. Pointing
the jobs at those same bundles changes nothing TCC can see, so **the
cutover needs no re-grant and no consent dialog**. Option (2) would
rebuild them — same identity, so still no re-grant, but it puts a Swift
toolchain on the critical path of a database migration for no benefit
today. Option (1) is right, and is a release-pipeline change that should
not ride along with a cutover.

The pin is two different mechanisms, because the two bridges find their
helper two different ways:

| | how the helper is found | what the migration does |
|---|---|---|
| `calendar` (the EventKit helper) | the signed helper IS the agent's root process (that is what the grant attaches to — PoC-1), so the path is in `ProgramArguments` | substitutes that one path back to the install root's bundle |
| `apple-fm` | a node bridge that spawns its helper from a path relative to its own `dist/`, overridable by `METISTRY_AFM_HELPER` | adds that variable to its **child spec** in `<instance>/.metistry/state/supervisor.json` and kickstarts the supervisor — under the supervisor that bridge has no plist of its own |

Both **patch what `up` just wrote** — the plist, or the config — rather than
re-rendering it from the template: a re-render dropped this instance's
namespaced ports during the rehearsal, and the scratch apple-fm bridge went
looking for the default 7810, which is the production install's.

A bundle that is not there is a note, not a failure: an install with no
calendar bridge is a healthy install, and doctor reports it `absent`.

**Follow-up (option 1).** Build and sign `ek-helper.app` and
`afm-helper.app` in the `macos-app` release job — it already has the
certificate and already re-signs every Mach-O it embeds
(`ops/release/build-app.sh`) — and copy them into the runtime pack. Then
`pack-runtime.sh` can assert their presence the way it now asserts
`ops/sandbox/assistant.sb`, and this pin can go away. Until it lands, a
release install's TCC bridges depend on a git checkout on the same Mac
having built them.

**`up` re-pins on every run, not just `migrate-shape` — settled 2026-09-10.**
The pin moved to its own module, `packages/cli/src/tcc-pin.ts` (it was
`migrate-shape.ts` local code originally; `migrate-shape.ts` imports
`up.ts`, so `up.ts` cannot import it back). The reason: `metistry up`
re-renders the calendar plist and rewrites `supervisor.json` from scratch
on EVERY run — a plain `up`, the release-channel `update`, and the
eight-agents-to-one-supervisor conversion all go through it — and a
version that only `migrate-shape` pinned meant the very next `up` silently
un-pinned both bridges again, pointing them back at the release's missing
bundles. `up` now calls `pinTccHelpers` itself, right after it writes the
calendar plist and `supervisor.json` and before it bootstraps or
kickstarts either one, so the values launchd actually loads are already
correct and no extra kickstart is needed. `migrate-shape` still calls it
too, after its own restore — a no-op when `up (launchd)` already applied
it moments before, and the thing that makes the correction take when
called on its own (`bootstrapPinned`, the pin's own flag, defaults to
`true` there and is passed `false` by `up`, whose own bootstrap loop is
about to load the pinned jobs a few lines later anyway).

## What the rehearsal proved (2026-09-10)

Run on the Studio against a locally built release pack with the same
layout as production's, with **production's own database restored into
it**, under a namespace, with the live compose install running beside it
the whole time and never touched.

| | |
|---|---|
| product | a runtime pack built from this branch, unpacked as `releases/<v>` with `current` -> it, `runtime/` beside it |
| instance | `metistry init --channel release`, `--namespace` (labels `…645c213e.*`, ports 8740-8744), its own `COMPOSE_PROJECT_NAME=metistry-rehearsal` |
| data | `pg_dump` of the production database (6 730 `runs`, 66 `work`, 13 `schema_migrations`, 22 tables) restored into the scratch compose db |
| cutover | `metistry migrate-shape launchd` → **exit 0** |
| counts | `22 tables — every count identical` |
| migrations | `ops/scripts/migrate.sh` afterwards: **`0 applied, 13 total`** |
| doctor | **23 ok, 0 degraded, 0 failed, 1 absent — healthy, shape launchd** (the one absent is the eventkit bridge, deliberately not configured) |
| console | `GET /api/q/open_work` on the launchd console returned the restored rows, matching the database exactly |
| reconciler | committed the shape flip: `bea0d53 metistry deployment set-shape → launchd` |
| tcc | the apple-fm bridge came back `ok`, having spawned the Developer-ID-signed helper from the install root's bundle |
| rollback | `metistry migrate-shape compose` → containers back, `db ok`, `migrations ok`, shape compose |
| production | 5 launchd jobs with unchanged PIDs, `metistry-db-1` up 10 days, doctor **28 ok, 0 failed** throughout |

Five defects were found by running it, all fixed in the same PR with
tests — see that commit's message. Every one of them passed a green test
suite first.
