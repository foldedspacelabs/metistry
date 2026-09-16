// The supervisor's contract: what `metistry up` writes, what the supervisor
// runs, and what `metistry restart|stop|start|logs` says to it over a local
// socket.
//
// WHY there is a supervisor at all. macOS shows ONE "background item" per
// launchd agent, named after the executable it runs — so the five-agent
// launchd shape produced System Settings entries called "postgres", "node",
// "node", "node", "sandbox-exec". That is not a product. Under the launchd
// shape there is now exactly one agent for the core,
// `com.foldedspacelabs.metistry`, whose program is a file named `Metistry`;
// Postgres, the console, the reconciler, the assistant (still under
// sandbox-exec) and any enabled bridges are its CHILDREN. The TCC helpers
// keep their own agents, because a TCC grant attaches to the binary that
// asks (invariant 6).
//
// Core owns the types and the constants so both sides — the supervisor in
// apps/watchdog and the CLI that writes its config and talks to it — parse
// the same thing (the dependency arrow points apps → packages, never back).

import { z } from "zod";

/** The one launchd agent for the core. A namespaced install appends `.<suffix>` (never a per-child label). */
export const SUPERVISOR_LABEL = "com.foldedspacelabs.metistry";

/** What the supervisor is called in `metistry restart|logs <service>` and in doctor's rows. */
export const SUPERVISOR_SERVICE = "supervisor";

/** `<instance>/state/supervisor.json` — written by `up` (0600: it carries the same secrets the plists used to). */
export const SUPERVISOR_CONFIG_FILENAME = "supervisor.json";

/** The control socket's file name, inside the instance's `state/run/` (beside Postgres' socket, for the same 103-byte reason). */
export const SUPERVISOR_SOCKET_FILENAME = "supervisor.sock";

/** A child is restarted with exponential backoff from this floor… */
export const RESTART_BACKOFF_MS = 1_000;  // limit: fixed — the restart schedule is one decision and the supervisor's own tests pin it
/** …up to this ceiling. */
export const RESTART_BACKOFF_MAX_MS = 60_000;  // limit: fixed — same schedule
/** A child that stays up this long is healthy again and its backoff resets. */
export const RESTART_HEALTHY_MS = 60_000;
/** More than this many restarts inside CRASH_LOOP_WINDOW_MS and the child is reported as crash-looping. */
export const CRASH_LOOP_RESTARTS = 5;
export const CRASH_LOOP_WINDOW_MS = 120_000;
/** SIGTERM, then this long, then SIGKILL. */
export const STOP_GRACE_MS = 10_000;
/** How long an ordered start waits for a child's readiness probe before starting the next one anyway. */
export const READY_TIMEOUT_MS = 60_000;  // limit: fixed — same schedule; a probe that has not answered in a minute is not slow, it is down

export const readyProbeSchema = z
  .object({
    /** the only probe there is: connect to a loopback port (Postgres, the console) */
    kind: z.literal("tcp"),
    port: z.number().int().positive(),
    host: z.string().default("127.0.0.1"),
    timeoutMs: z.number().int().positive().default(READY_TIMEOUT_MS),
  })
  .strict();

export const childSpecSchema = z
  .object({
    /** `db`, `console`, `reconciler`, `assistant`, `eventkit`, `apple-fm` — the name every verb uses */
    name: z.string().min(1),
    /** argv[0] is the executable; never a shell string the supervisor builds */
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.string().optional(),
    /**
     * The child's COMPLETE environment — the supervisor's own is never
     * inherited. That is what keeps `assistantEnv`'s allowlist an allowlist:
     * a provider key in the operator's shell that this install's
     * compute.yaml does not name reaches the engine through neither the
     * plist dict before nor this now.
     */
    env: z.record(z.string(), z.string()).default({}),
    /** StandardOut+StandardError, appended — the same path `metistry logs <service>` tails */
    log: z.string().min(1),
    /** when set, the next child starts only once this port answers (or the timeout passes) */
    ready: readyProbeSchema.optional(),
    stopTimeoutMs: z.number().int().positive().default(STOP_GRACE_MS),
  })
  .strict();

export const supervisorConfigSchema = z
  .object({
    schema: z.literal(1),
    /** the supervisor's own launchd label, for its log lines and doctor's rows */
    label: z.string().min(1),
    socket: z.string().min(1),
    /** shared secret for the control socket; the file is 0600 and so is the socket (invariant 8: authenticate anyway) */
    token: z.string().min(16),
    /**
     * The supervisor's OWN environment — the watchdog half of it needs the
     * db credentials and the console URL. The plist `metistry up` installs
     * carries the same dict, but the plist the Mac app embeds in its bundle
     * is signed and immutable and can carry nothing install-specific, so
     * this is where an app-registered supervisor gets it. Applied over the
     * process environment at startup.
     */
    env: z.record(z.string(), z.string()).default({}),
    /** started in order, stopped in reverse */
    children: z.array(childSpecSchema),
  })
  .strict();

export type ReadyProbe = z.infer<typeof readyProbeSchema>;
export type ChildSpec = z.infer<typeof childSpecSchema>;
export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;
/** What `up` writes, before zod fills the defaults in. */
export type ChildSpecInput = z.input<typeof childSpecSchema>;
export type SupervisorConfigInput = z.input<typeof supervisorConfigSchema>;

export function parseSupervisorConfig(raw: unknown, source = SUPERVISOR_CONFIG_FILENAME): SupervisorConfig {
  const parsed = supervisorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

// ---- the control protocol ---------------------------------------------------
//
// One JSON object per line, request and response, over a unix socket. It is
// deliberately tiny: `metistry restart console` must not need launchctl for a
// process launchd does not know about, and nothing else needs a protocol.

export const CONTROL_OPS = ["status", "restart", "stop", "start"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export const controlRequestSchema = z
  .object({
    op: z.enum(CONTROL_OPS),
    token: z.string(),
    /** omitted on `status`; required on the three actions — the supervisor never guesses "all" */
    service: z.string().optional(),
  })
  .strict();

export type ControlRequest = z.infer<typeof controlRequestSchema>;

export type ChildState =
  /** running now */
  | "running"
  /** exited, waiting out its backoff before the next attempt */
  | "backoff"
  /** restarting too often to be healthy — still retried, but reported */
  | "crash-looping"
  /** stopped on purpose (`metistry stop <service>`) and not restarted */
  | "stopped"
  /** in the config, not started yet */
  | "pending";

export interface ChildStatus {
  name: string;
  state: ChildState;
  pid?: number;
  /** how long the current process has been up, ms */
  uptimeMs?: number;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: string };
  log: string;
}

export interface ControlResponse {
  ok: boolean;
  /** present on every response, so `metistry restart console` prints the state it produced */
  children?: ChildStatus[];
  detail?: string;
  error?: string;
}

/** A fixed string on purpose: it tells a caller nothing about the token. */
export const CONTROL_UNAUTHORIZED = "unauthorized";
