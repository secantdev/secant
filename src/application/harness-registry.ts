import type { HarnessChoice } from "./projection-port.js";
import type { HarnessFailure } from "../harness/harness.js";

/** A selected Harness's discovery result, normalized before it reaches
 * Application. Native discovery targets and Adapter objects remain in the
 * Harness/composition Modules. */
export type THarnessDiscovery =
  | { readonly kind: "found" }
  | {
      readonly kind: "unsupported-shim";
      readonly name: string;
      readonly path: string;
      readonly executableEnvironmentVariable: string;
    }
  | {
      readonly kind: "not-found";
      readonly searched: readonly string[];
      readonly executableEnvironmentVariable: string;
    };

/** The normalized half of one closed registry entry Application consumes. */
export interface ApplicationHarnessRegistration {
  readonly choice: HarnessChoice;
  readonly servedCapabilities: readonly string[];
  discover(): THarnessDiscovery;
}

/** A selected Adapter's preparation failure after native details have been
 * normalized away by composition. */
export interface RunHarnessPreparationFailure {
  readonly selectedHarness: HarnessChoice["id"];
  readonly harnessName: string;
  readonly phase: HarnessFailure["phase"];
  readonly category: string;
  readonly possibleEffects: HarnessFailure["possibleEffects"];
  readonly partialOutput?: string;
  readonly nativeCode?: string;
  readonly retryEvidence?: string;
  readonly diagnostics?: string;
  readonly cause?: HarnessFailure["cause"];
}
