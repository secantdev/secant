import {
  createApplication as createApplicationWithProcess,
  type ApplicationDependencies,
} from "../../src/application/application.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import {
  openRunGroup as openRunGroupWithProcess,
  type RunGroup,
} from "../../src/run/store/store.js";

function refuseProcess(): never {
  throw new Error(
    "test helper: constructed an Application or Run group without an injected `process`; " +
      "inject a fake Process (createFakeProcess from tests/process/fake-adapter.ts) — " +
      "the real Process is never reachable from the test runner",
  );
}

// A Process whose every method throws. The compatibility helpers inject it when a
// suite omits `process`, so a test that reaches child-process behavior through the
// helper fails loudly here instead of silently reaching the real Process (M5 audit
// #199 A21). No default wires the real Process implementation into the test runner.
const missingProcess: ProcessAdapter = {
  resolveExecutable: refuseProcess,
  spawnCommand: refuseProcess,
  spawnCommandSync: refuseProcess,
  spawnOwnedProcess: refuseProcess,
};

type TestApplicationDependencies = Omit<ApplicationDependencies, "process"> & {
  readonly process?: ApplicationDependencies["process"];
};

type TestRunGroupOptions = Omit<
  Parameters<typeof openRunGroupWithProcess>[2],
  "process"
> & {
  readonly process?: Parameters<typeof openRunGroupWithProcess>[2]["process"];
};

/** Compatibility wiring for suites migrated by the following evidence slices. */
export function createApplication(deps: TestApplicationDependencies) {
  return createApplicationWithProcess({
    ...deps,
    process: deps.process ?? missingProcess,
  });
}

export function openRunGroup(
  home: string,
  workspace: string,
  options: TestRunGroupOptions = {},
): RunGroup {
  return openRunGroupWithProcess(home, workspace, {
    ...options,
    process: options.process ?? missingProcess,
  });
}
