import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { HarnessFailure } from "./harness.js";

/** Validate `PrepareOptions.writableDirectory` identically for every Adapter
 *  (#214): absent is no grant; anything but an existing absolute directory is a
 *  typed prepare failure, so no Adapter ever widens a grant it cannot name. */
export function writableDirectoryFailure(
  directory: string | undefined,
): HarnessFailure | undefined {
  if (directory === undefined) return undefined;
  let reason: string | undefined;
  if (!isAbsolute(directory)) {
    reason = "is not an absolute path";
  } else {
    try {
      if (!statSync(directory).isDirectory()) reason = "is not a directory";
    } catch (cause) {
      return {
        phase: "prepare",
        category: "writable-directory-unavailable",
        possibleEffects: "none",
        diagnostics: `The additional writable directory '${directory}' cannot be read.`,
        cause,
      };
    }
  }
  return reason === undefined
    ? undefined
    : {
        phase: "prepare",
        category: "writable-directory-unavailable",
        possibleEffects: "none",
        diagnostics: `The additional writable directory '${directory}' ${reason}.`,
      };
}
