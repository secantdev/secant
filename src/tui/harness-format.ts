import type {
  HarnessCapabilityState,
  HarnessDiscoveryView,
  HarnessObservationView,
  HarnessQualificationState,
  HarnessQualificationView,
  HarnessSummary,
} from "../application/projection-port.js";

// Worded, colour-independent Harness status shared by Start a Run and the
// Harness catalog. The words mirror headless rendering up to capitalisation.

export function isQualified(
  qualification: HarnessQualificationView,
): qualification is Extract<
  HarnessQualificationView,
  { state: "qualified" | "qualified-with-limits" }
> {
  return (
    qualification.state === "qualified" ||
    qualification.state === "qualified-with-limits"
  );
}

export function qualificationObservation(
  qualification: HarnessQualificationView,
): HarnessObservationView | undefined {
  return isQualified(qualification) ? qualification.observation : undefined;
}

export function qualificationWord(
  qualification: HarnessQualificationView,
): string {
  return qualificationLabel(qualification.state);
}

export function qualificationLabel(state: HarnessQualificationState): string {
  return titleCase(state);
}

export function capabilityLabel(state: HarnessCapabilityState): string {
  return titleCase(state);
}

export function discoveryWord(discovery: HarnessDiscoveryView): string {
  const words = discoveryLabel(discovery);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function discoveryLabel(discovery: HarnessDiscoveryView): string {
  if (discovery.state === "found") {
    return `found via ${discovery.description}`;
  }
  if (discovery.state === "unsupported-shim") {
    return `unsupported shim ${discovery.path}`;
  }
  return `not found; searched ${discovery.searched.join(", ")}`;
}

export function harnessRowStatus(harness: HarnessSummary): string {
  if (harness.discovery.state === "not-found") {
    return "Unavailable · not found on PATH";
  }
  if (harness.discovery.state === "unsupported-shim") {
    return "Unavailable · unsupported shim";
  }
  return qualificationWord(harness.qualification);
}

function titleCase(value: string): string {
  const words = value.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
