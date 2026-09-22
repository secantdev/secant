import type {
  HarnessDiscoveryView,
  HarnessQualificationView,
  HarnessSummary,
} from "../application/projection-port.js";

// Worded, colour-independent Harness status for the Start a Run Harness step (and,
// later, the Harness catalog screen): every state reads as words, never a raw enum
// (#191). Kept beside `bundle-format.ts` so both surfaces say the same thing about
// the same fact; the words match `headless/render.ts` up to capitalisation.

/** A capitalised qualification chip: `Qualified`, `Qualified with limits`,
 *  `Not ready`, or `Not checked`. */
export function qualificationWord(
  qualification: HarnessQualificationView,
): string {
  switch (qualification.state) {
    case "qualified":
      return "Qualified";
    case "qualified-with-limits":
      return "Qualified with limits";
    case "not-ready":
      return "Not ready";
    case "not-checked":
      return "Not checked";
  }
}

/** A one-line worded discovery summary: how the executable was found, or that it
 *  was not, without any raw enum. */
export function discoveryWord(discovery: HarnessDiscoveryView): string {
  switch (discovery.state) {
    case "found":
      return `Found via ${discovery.description}`;
    case "unsupported-shim":
      return `Unsupported shim ${discovery.path}`;
    case "not-found":
      return `Not found; searched ${discovery.searched.join(", ")}`;
  }
}

/** The row summary a Harness list entry shows beside its name: the qualification
 *  chip, and — when the executable was not found — that it is unavailable, so the
 *  user reads availability at a glance before focusing it (#191, story 17). */
export function harnessRowStatus(harness: HarnessSummary): string {
  if (harness.discovery.state === "not-found") {
    return `Unavailable · not found on PATH`;
  }
  if (harness.discovery.state === "unsupported-shim") {
    return `Unavailable · unsupported shim`;
  }
  return qualificationWord(harness.qualification);
}
