// @foldedspacelabs/metistry-connections — plan §2.6, T4-8a.
//
// Connection files read against the connection-type registry (`load.ts`,
// `catalog.ts`), the listing every surface renders (`describe.ts`), the
// pooled MCP client (`pool.ts`, `plan.ts`) and its check (`check.ts`).
// docs/ops/connections.md is the same contract in words.

export { CONNECTION_REFUSAL_CODES, ConnectionRefused, type ConnectionRefusalCode } from "./errors.js";
export {
  CONNECTION_FILE_RE,
  CONNECTION_STATUSES,
  connectionFileRules,
  judgeConnection,
  parseConnectionText,
  readConnections,
  typedValues,
  type ConnectionEntry,
  type ConnectionStatus,
} from "./load.js";
export {
  connectionFileFor,
  connectionsDirFor,
  loadInstanceCatalog,
  type CatalogRoots,
  type ConnectionCatalog,
  type InstanceCatalog,
  type Parsed,
} from "./catalog.js";
export { planDial, planFingerprint, type CommandDial, type DialPlan, type HttpDial } from "./plan.js";
export {
  ConnectionPool,
  DEFAULT_CONNECTION_CALL_TIMEOUT_MS,
  DEFAULT_CONNECTION_CONNECT_TIMEOUT_MS,
  DEFAULT_CONNECTION_IDLE_MS,
  connectionGrantee,
  type CallOutcome,
  type CallRequest,
  type ConnectionPoolOptions,
  type ListedTool,
  type PoolEvent,
  type UpstreamTool,
} from "./pool.js";
export { checkConnection, type ConnectionCheckMeta } from "./check.js";
export {
  describeConnection,
  describeConnectionDetail,
  describeConnections,
  type ConnectionDetail,
  type ConnectionRow,
  type ConnectionToolRow,
  type ConnectionUser,
  type DescribeOptions,
  type ReachSummary,
} from "./describe.js";
