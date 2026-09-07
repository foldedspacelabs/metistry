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
export { parseArgs, parseAuth, syncDirection, main } from "./main.js";
export {
  connectRepo,
  deviceFlow,
  parseRemote,
  readStdin,
  tokenLogin,
  AUTH_MODES,
  DEVICE_CODE_URL,
  DEVICE_TOKEN_URL,
  DEVICE_GRANT_TYPE,
  type AuthMode,
  type ConnectRepoOptions,
  type ConnectRepoResult,
  type ParsedRemote,
} from "./connect-repo.js";
export {
  syncSecrets,
  mintSecret,
  listSecrets,
  renderSecretList,
  isSecretVar,
  declaredVars,
  rewriteEnv,
  appendEnv,
  quoteEnvValue,
  SECRET_SUFFIXES,
  SECRET_NAMES,
  type SecretsOptions,
  type SyncDirection,
  type SyncResult,
  type SecretListing,
} from "./secrets.js";
export { Keychain, serviceFor, keychainAccount, promptStdin, SERVICE_PREFIX } from "./keychain.js";
export { type Exec, type ExecOptions, type ExecResult, realExec, formatCommand } from "./exec.js";
export { up, productSource, composeUp, installLaunchd, type UpOptions, type UpResult } from "./up.js";
export { update, gitHead, hashHostJobs, trackedPathFor, writeLock, publishedPackages, type UpdateOptions, type UpdateResult } from "./update.js";
export { runMigrations, listMigrationFiles, openMigrationSession, MIGRATION_LOCK_KEY, type MigrationSession, type MigrateResult } from "./migrate.js";
export { parseLock, serializeLock, readLock, instanceLockPath, LOCK_FILENAME, type LockFile, type LockSource } from "./lock.js";
export { renderPlist, parsePlistTemplate, loadPlistTemplates, launchdCommands, renderSystemdUnit, type PlistTemplate } from "./launchd.js";
export { StepRunner, StepFailed } from "./steps.js";
