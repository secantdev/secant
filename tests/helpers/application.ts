import {
  createApplication as createApplicationWithProcess,
  type ApplicationDependencies,
} from "../../src/application/application.js";
import { createProcessAdapter } from "../../src/process/process.js";
import {
  openRunGroup as openRunGroupWithProcess,
  type RunGroup,
} from "../../src/run/store/store.js";

const realProcess = createProcessAdapter();

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
    process: deps.process ?? realProcess,
  });
}

export function openRunGroup(
  home: string,
  workspace: string,
  options: TestRunGroupOptions = {},
): RunGroup {
  return openRunGroupWithProcess(home, workspace, {
    ...options,
    process: options.process ?? realProcess,
  });
}
