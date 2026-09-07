// Library surface, for anyone embedding the commands (the console's status
// tab may one day render a doctor report). The bin is dist/main.js.
export { init, applyName, mentionFor, lockFile, INSTANCE_DIRS, type InitOptions, type InitResult } from "./init.js";
export {
  doctor,
  renderTable,
  walkManifests,
  dbRows,
  launchdRows,
  composeRows,
  parseComposePs,
  parseLaunchctlPrint,
  probeTargetFor,
  hostLocal,
  type DoctorDeps,
  type DoctorReport,
  type DoctorRow,
  type Db,
} from "./doctor.js";
export { parseDotEnv, loadDotEnv, resolveProductDir, resolveSeedDir, productVersion } from "./env.js";
export { parseArgs, main } from "./main.js";
export { type Exec, type ExecResult, realExec } from "./exec.js";
