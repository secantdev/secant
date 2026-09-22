import type { HarnessChoice } from "./projection-port.js";
import type {
  EffectScope,
  FailurePhase,
  HarnessFailure,
  HarnessProfile,
} from "../harness/harness.js";

/** A selected Harness's discovery result, normalized before it reaches
 * Application. Native discovery targets and Adapter objects remain in the
 * Harness/composition Modules. */
export type THarnessDiscovery =
  | {
      readonly kind: "found";
      readonly source: "configured" | "path";
      readonly description: string;
    }
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
  qualify(): Promise<ApplicationHarnessQualification>;
}

/** Operational qualification failure after composition strips Adapter and
 * native process values. */
export interface ApplicationHarnessQualificationFailure {
  readonly phase: FailurePhase;
  readonly category: string;
  readonly possibleEffects: EffectScope;
  readonly retryEvidence?: string;
  readonly diagnostics?: string;
  /** Retained inside Application/composition; the client Projection omits it. */
  readonly cause?: HarnessFailure["cause"];
}

/** The normalized result Application caches for one registered Harness. */
export type ApplicationHarnessQualification =
  | { readonly ok: true; readonly profile: HarnessProfile }
  | {
      readonly ok: false;
      readonly failure: ApplicationHarnessQualificationFailure;
    };

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
