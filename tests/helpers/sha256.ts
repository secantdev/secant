import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Fixture-only digest helper; production release files use streaming I/O. */
export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
