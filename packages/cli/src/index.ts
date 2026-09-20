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
  createUi,
  configureUi,
  defaultUi,
  colorLevel,
  supportsUnicode,
  terminalWidth,
  statusName,
  strip,
  padTo,
  visibleWidth,
  ICONS,
  MIN_WIDTH,
  MAX_WIDTH,
  type Ui,
  type Spinner,
  type StatusName,
  type ColorLevel,
  type IconName,
} from "./ui.js";
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
  connect,
  connectList,
  renderConnect,
  renderConnectList,
  cursorConfigFile,
  cursorServerEntry,
  writeCursorConfig,
  readCursorServer,
  agentTokenVar,
  serverKey,
  parseTool,
  CONNECT_TOOLS,
  DEFAULT_GRANTS,
  TOOL_SPECS,
  type ConnectTool,
  type ConnectOptions,
  type ConnectResult,
  type ConnectListRow,
  type Grants,
} from "./connect.js";
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
export { cliShimPath, cliShimLinkHint, renderCliShim, writeCliShim } from "./cli-shim.js";
export { runMigrations, listMigrationFiles, openMigrationSession, MIGRATION_LOCK_KEY, type MigrationSession, type MigrateResult } from "./migrate.js";
export { parseLock, serializeLock, readLock, instanceLockPath, LOCK_FILENAME, type LockFile, type LockSource } from "./lock.js";
export { renderPlist, parsePlistTemplate, loadPlistTemplates, launchdCommands, renderSystemdUnit, labelFor, logPathFor, serviceOf, withNamespace, LABEL_PREFIX, type PlistTemplate } from "./launchd.js";
export {
  allocateBase,
  applyPorts,
  loadNamespace,
  parseNamespace,
  portsFile,
  portsOf,
  preferredBase,
  serializeNamespace,
  suffixFor,
  BLOCK_SIZE,
  DEFAULT_PORTS,
  PORTED_SERVICES,
  PORT_VARS,
  type Namespace,
} from "./namespace.js";
export {
  installRuntime,
  describeSeed,
  defaultProductDir,
  readReceipt,
  receiptPath,
  seedDirOf,
  upToDate,
  BUNDLE_SEED_REL,
  INSTALL_RECEIPT,
  type InstallReceipt,
  type RuntimeInstallOptions,
  type RuntimeInstallResult,
  type SeedDescription,
} from "./runtime-install.js";
export { StepRunner, StepFailed } from "./steps.js";
// The `metistry compute` verbs (docs/ops/compute.md). Exported because the
// CONSOLE drives the same ones over HTTP (`/api/compute*`,
// docs/ops/console-api.md): `compute.yaml` is edited as a YAML document,
// validated against core's schema, and written through the reconciler as
// `user` in exactly one place, so the CLI verb and the app's Compute pane
// cannot drift into two behaviours. `providers add`/`remove` are
// deliberately NOT on this list — they take a secret, and secrets never
// cross the console (apps/console/src/compute-routes.ts).
export {
  assign,
  computeFiles,
  computeReport,
  instanceComputeFile,
  modelsList,
  parseAssignmentTarget,
  parseBudgetAction,
  parseBudgetTarget,
  parseEffort,
  providerTest,
  renderComputeReport,
  setBudget,
  type AssignResult,
  type AssignmentTarget,
  type BudgetResult,
  type BudgetTarget,
  type ComputeOptions,
  type ComputeReport,
  type ModelsListResult,
  type ProviderTestResult,
} from "./compute.js";
