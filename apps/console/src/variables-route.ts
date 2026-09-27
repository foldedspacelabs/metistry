// `GET /api/variables` — the Variables list (design-build-plan §2.14, T4-4):
// each variable's name, value, who reads it and where it is used. Owner
// reach, like the Secrets list; every write is `metistry variables` on the
// Mac (M14), because `.metistry/variables.yaml` is text agents read.
//
// A value here can never be a secret, and not by a promise: core's
// `parseVariablesFile` refuses a key-shaped value, a secret's name, a
// template and a schedule AT THE PARSE, so a hand-edited file that carries
// one does not load and the route answers 400 naming the variable and the
// reason — never the value.
//
// It degrades absent like the Secrets list: with no instance directory the
// console cannot see the file (the compose shape gives it no mount, by
// design), and the route answers 503 naming what is missing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describeVariables, parseVariablesFile, type VariableRow } from "@foldedspacelabs/metistry-core";
import { variableUsage } from "@foldedspacelabs/metistry-cli";

/** What the console reads variables through. Absent from `ConsoleConfig` = this deployment has no instance directory to read, and the route is 503. */
export interface VariablesView {
  /** the instance repo — `.metistry/` is walked for *used in* */
  instanceDir: string;
  /** `<instanceDir>/.metistry/variables.yaml` — absent file = no variables yet */
  file: string;
}

export const VARIABLES_NOT_AVAILABLE =
  "variables are not readable from this deployment — the console needs METISTRY_INSTANCE_DIR pointing at the instance repo whose `.metistry/variables.yaml` it lists " +
  "(the compose shape deliberately gives the console no instance mount — docs/ops/deployment-shapes.md). `metistry variables list` works either way.";

export type VariablesListing = { ok: true; variables: VariableRow[] } | { ok: false; message: string };

/** The listing, or the reason the file does not validate. */
export async function listVariables(view: VariablesView): Promise<VariablesListing> {
  let file;
  try {
    file = parseVariablesFile(existsSync(view.file) ? await readFile(view.file, "utf8") : "");
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, variables: describeVariables(file, await variableUsage(view.instanceDir)) };
}
