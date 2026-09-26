// Type-level tests for the actor model (plan §2.4, F-2). Compiled — never run —
// by test/actor.test.ts, which fails when `tsc` reports anything. Two kinds of
// assertion:
//
//   * `Expect<Equal<…>>` — a type is exactly what the model says. A wrong
//     one is a compile error on that line.
//   * `// @ts-expect-error` — a value the model must REFUSE. If it ever
//     compiles, the directive is unused and THAT is the error.
//
// Imported from the package root, so the exports are pinned too.

import type {
  ACTOR_OF_AGENT_KIND,
  ActionAutonomy,
  Actor,
  ActorCompute,
  ActorDefinition,
  ActorSources,
  AgentRowKind,
  AssistantActor,
  CrewActor,
  CrewActorDefinition,
  CrewPermissionRow,
  CrewToolGroup,
  Effort,
  ExternalActor,
  ExternalPermissionRow,
  PermissionEntry,
  PermissionRow,
  ResolveActor,
  Role,
  Scope,
} from "../../src/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

// ---- conformance: every actor IS the plan's §2.4 interface -------------------
//
// Spelled as the plan spells it, with two recorded differences: arrays are
// readonly (core's convention — ScopeView's are too), and `tools.groups`
// admits `null`, because an allowlist that is absent (the assistant, an
// external agent) and one that is empty (a crew holding no tools) must never
// be the same value (`allowedTools`).
interface PlanActor {
  id: string;
  kind: "assistant" | "crew" | "external";
  displayName: string;
  definition: ActorDefinition | null;
  permissions: { role: Role; scope: Scope; autonomy: ActionAutonomy; lines: readonly PermissionRow[] };
  tools: { groups: readonly CrewToolGroup[] | null; connections: readonly string[] };
  compute: { kind: "router" } | { kind: "model"; ref: `${string}/${string}`; effort: Effort } | { kind: "same_as_assistant" } | null;
  limits: { maxTurns: number; budgetUsdPerRun: number } | null;
}
export type Conforms = [
  Expect<Extends<AssistantActor, PlanActor>>,
  Expect<Extends<CrewActor, PlanActor>>,
  Expect<Extends<ExternalActor, PlanActor>>,
  Expect<Equal<Actor["kind"], "assistant" | "crew" | "external">>,
];

// ---- the mapping table covers internal, crew and external ---------------------

type Table = typeof ACTOR_OF_AGENT_KIND;
export type MappingTable = [
  Expect<Equal<keyof Table, AgentRowKind>>,
  Expect<Equal<AgentRowKind, "internal" | "crew" | "external">>,
  Expect<Equal<Table["internal"]["kind"], "assistant">>,
  Expect<Equal<Table["crew"]["kind"], "crew">>,
  Expect<Equal<Table["external"]["kind"], "external">>,
  // …and the role the table names is the role the actor of that kind carries.
  Expect<Equal<Extract<Actor, { kind: Table["internal"]["kind"] }>["permissions"]["role"], Table["internal"]["role"]>>,
  Expect<Equal<Extract<Actor, { kind: Table["crew"]["kind"] }>["permissions"]["role"], Table["crew"]["role"]>>,
  Expect<Equal<Extract<Actor, { kind: Table["external"]["kind"] }>["permissions"]["role"], Table["external"]["role"]>>,
];

// ---- what each kind is made of (the §2.4 table's columns) ---------------------

export type Kinds = [
  // definition: identity.yaml + CLAUDE.md + assistant-prompt.md · the manifest · none
  Expect<Equal<AssistantActor["definition"]["kind"], "assistant">>,
  Expect<Equal<CrewActor["definition"], CrewActorDefinition>>,
  Expect<Equal<ExternalActor["definition"], null>>,
  // compute: the router · a model or same_as_assistant · none
  Expect<Equal<AssistantActor["compute"], { readonly kind: "router" }>>,
  Expect<Equal<CrewActor["compute"]["kind"], "model" | "same_as_assistant">>,
  Expect<Equal<ExternalActor["compute"], null>>,
  // limits are a definition's; only a crew has one
  Expect<Equal<AssistantActor["limits"], null>>,
  Expect<Equal<ExternalActor["limits"], null>>,
  // an allowlist exists on a crew alone; null is "none", never []
  Expect<Equal<AssistantActor["tools"]["groups"], null>>,
  Expect<Equal<ExternalActor["tools"]["groups"], null>>,
  Expect<Equal<CrewActor["tools"]["groups"], readonly CrewToolGroup[]>>,
];

// ---- the signature T4-6 implements --------------------------------------------

export type Signature = [
  Expect<Equal<Parameters<ResolveActor>, [id: string, sources: ActorSources]>>,
  Expect<Equal<ReturnType<ResolveActor>, Actor | null>>,
];

// ---- refusals: what must not compile -------------------------------------------

declare const entry: PermissionEntry;
declare const anyRow: PermissionRow;
declare const crew: CrewActor;
declare const external: ExternalActor;
declare const assistant: AssistantActor;

// Knowledge Write never appears for a non-assistant role (T4-6's first test,
// made a type): the write cell of a crew's or an external agent's Knowledge
// row is the empty tuple.
export const crewKnowledgeRead: CrewPermissionRow = { resource: { kind: "knowledge" }, label: "Knowledge", read: [entry], write: [] };
// @ts-expect-error — a crew never writes knowledge
export const crewKnowledgeWrite: CrewPermissionRow = { resource: { kind: "knowledge" }, label: "Knowledge", read: [], write: [entry] };
// @ts-expect-error — nor does an external agent
export const externalKnowledgeWrite: ExternalPermissionRow = { resource: { kind: "knowledge" }, label: "Knowledge", read: [], write: [entry] };
// The assistant is the one writer.
export const assistantKnowledgeWrite: AssistantActor["permissions"]["lines"][number] = { resource: { kind: "knowledge" }, label: "Knowledge", read: [entry], write: [entry] };

// Delegation is the assistant's alone (`agents_delegate`).
// @ts-expect-error — a crew never dispatches crews
export const crewDelegates: CrewPermissionRow = { resource: { kind: "agents" }, label: "Agents", read: [], write: [entry] };
// @ts-expect-error — nor does an external agent
export const externalDelegates: ExternalPermissionRow = { resource: { kind: "agents" }, label: "Agents", read: [], write: [entry] };

// Named queries: an external agent may hold them by grant; a crew never (CREW_NEVER_TOOLS).
export const externalQueries: ExternalPermissionRow = { resource: { kind: "queries" }, label: "Queries", read: [entry], write: [] };
// @ts-expect-error — a crew never runs a named query
export const crewQueries: CrewPermissionRow = { resource: { kind: "queries" }, label: "Queries", read: [entry], write: [] };

// A row nobody narrowed is not a crew's: the decision must be made where the row is built.
// @ts-expect-error — PermissionRow is wider than CrewPermissionRow
export const unnarrowed: CrewPermissionRow = anyRow;
// …while every narrower row is still a PermissionRow, so one renderer takes them all.
export const widened: readonly PermissionRow[] = [...crew.permissions.lines, ...external.permissions.lines, ...assistant.permissions.lines];

// An external agent is someone else's code: no definition, no compute.
// @ts-expect-error — no definition
export const externalWithDefinition: ExternalActor = { ...external, definition: crew.definition };
// @ts-expect-error — no compute
export const externalWithCompute: ExternalActor = { ...external, compute: { kind: "same_as_assistant" } };

// A crew is never on the router (§4 Q14: "same as" is the default tier), and a model is a pinned reference.
// @ts-expect-error — the router is the assistant's
export const crewOnRouter: CrewActor = { ...crew, compute: { kind: "router" } };
// @ts-expect-error — a legacy alias is not a `<provider>/<model>` reference
export const legacyAlias: ActorCompute = { kind: "model", ref: "haiku", effort: "low" };
export const pinned: ActorCompute = { kind: "model", ref: "openrouter/anthropic/claude-sonnet-5", effort: "low" };
// @ts-expect-error — "same as" carries no effort of its own: it is the default tier's pair
export const sameWithEffort: ActorCompute = { kind: "same_as_assistant", effort: "high" };

// The assistant is never drawn as an external agent's role, and vice versa.
// @ts-expect-error — the assistant's role is `assistant`
export const assistantAsAgent: AssistantActor = { ...assistant, permissions: { ...assistant.permissions, role: "agent" } };
// @ts-expect-error — an external agent's role is `agent`
export const externalAsAssistant: ExternalActor = { ...external, permissions: { ...external.permissions, role: "assistant" } };

// null and [] are different allowlists.
// @ts-expect-error — the assistant has no allowlist; [] would say it holds no tools
export const assistantEmptyAllowlist: AssistantActor = { ...assistant, tools: { groups: [], connections: [] } };
// @ts-expect-error — a crew always has one, even if it is empty
export const crewNoAllowlist: CrewActor = { ...crew, tools: { groups: null, connections: [] } };

// A crew's definition is exactly one file.
// @ts-expect-error — two files is not a crew manifest
export const crewTwoFiles: CrewActorDefinition = { ...crew.definition, files: [crew.definition.files[0], crew.definition.files[0]] };
