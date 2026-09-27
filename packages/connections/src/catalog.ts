// Everything a connection is read against, loaded once from one instance:
// its connection files, the connection-type registry (the product's
// `seed/connection-types/` and the owner's `.metistry/extensions/`), the
// variables it fills, the secrets policy it is checked against, and
// `scheduled.yaml` for the syncs that read it.
//
// Every path is the caller's (invariant 7): an instance directory and,
// optionally, the product's seed. Nothing here reads a value from the
// Keychain — the listing asks presence of the caller's probe, and the pool
// fills at egress from the caller's `SecretSource`.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SCHEDULED_FILENAME,
  extensionsDirFor,
  loadKind,
  parseScheduled,
  parseSecretsFile,
  parseVariablesFile,
  resolveInstanceLayout,
  type ConnectionTypeManifest,
  type Registry,
  type Scheduled,
  type SecretsFile,
  type VariablesFile,
} from "@foldedspacelabs/metistry-core";
import { readConnections, type ConnectionEntry } from "./load.js";

/** A file every connection reads through, parsed — or why it does not load (named, never a value). */
export type Parsed<T> = { ok: true; file: T } | { ok: false; message: string };

/** What the pool and the listing need, and nothing about where it came from — so a test can build one by hand. */
export interface ConnectionCatalog {
  entries: readonly ConnectionEntry[];
  variables: Parsed<VariablesFile>;
  secrets: Parsed<SecretsFile>;
  /** a relative `cwd` in a command reach is resolved against this — the instance directory */
  baseDir?: string | undefined;
  /** `scheduled.yaml`, for *used by*; null when it does not validate (the syncs that name a connection are then unknown) */
  scheduled?: Scheduled | null | undefined;
}

/** The whole instance's view: the catalog plus the registry and the syncs. */
export interface InstanceCatalog extends ConnectionCatalog {
  instanceDir: string;
  /** `.metistry/connections/` as this instance spells it */
  dir: string;
  types: Registry<ConnectionTypeManifest>;
  scheduled: Scheduled | null;
}

export interface CatalogRoots {
  /** the instance repo */
  instanceDir: string;
  /** the product's `seed/` — where the shipped connection types are. Absent: only the owner's own */
  seedDir?: string | undefined;
  /** read the owner's `.metistry/extensions/` (default true) */
  extensions?: boolean | undefined;
}

/** `<instance>/.metistry/connections`, spelled the way that instance spells it. */
export function connectionsDirFor(instanceDir: string): string {
  return resolveInstanceLayout(instanceDir).path("connectionsDir");
}

/** `<instance>/.metistry/connections/<name>.yaml`. */
export function connectionFileFor(instanceDir: string, name: string): string {
  return join(connectionsDirFor(instanceDir), `${name}.yaml`);
}

async function readParsed<T>(path: string, parse: (text: string) => T): Promise<Parsed<T>> {
  try {
    return { ok: true, file: parse(existsSync(path) ? await readFile(path, "utf8") : "") };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Load one instance's connections and everything they are read against. Never throws for a bad file — each is reported where it is used. */
export async function loadInstanceCatalog(roots: CatalogRoots): Promise<InstanceCatalog> {
  const instanceDir = roots.instanceDir.replace(/\/+$/, "");
  const layout = resolveInstanceLayout(instanceDir);
  const types = await loadKind("connection-type", {
    ...(roots.seedDir !== undefined ? { seedDir: roots.seedDir } : {}),
    ...(roots.extensions === false ? {} : { extensionsDir: extensionsDirFor(instanceDir) }),
  });
  const dir = layout.path("connectionsDir");
  const scheduledPath = join(layout.path("metistryDir"), SCHEDULED_FILENAME);
  const [entries, variables, secrets, scheduledText] = await Promise.all([
    readConnections(dir, types),
    readParsed(layout.path("variables"), parseVariablesFile),
    readParsed(layout.path("secrets"), parseSecretsFile),
    existsSync(scheduledPath) ? readFile(scheduledPath, "utf8").catch(() => null) : Promise.resolve(""),
  ]);
  const scheduled = scheduledText === null ? null : parseScheduled(scheduledText).value;
  return { instanceDir, dir, types, entries, variables, secrets, scheduled, baseDir: instanceDir };
}
