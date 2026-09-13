// The tui Module's public entrypoint. The composition root mounts `App` onto the
// renderer it owns via `mountTui`. The per-screen view types are the App prop
// contract; the read-only workspace/bundle live views are built only inside
// `mount.tsx`. The one exception is the launch seam (`createLiveRunLaunchView`):
// it is exported here so #90's renderer tests can drive the genuinely-new write
// path over fake `operation`/`run` snapshots across the Module boundary (which the
// boundary suite requires to go through this entrypoint), as the ticket ratchets.

export { App } from "./app.js";
export { mountTui, type MountOptions } from "./mount.js";
export type { WorkspaceView } from "./workspace-view.js";
export type { BundleCatalogView } from "./bundle-view.js";
export type { RunLaunchView, LaunchOutcome } from "./run-launch-view.js";
export { createLiveRunLaunchView } from "./run-launch-view.js";
// The Run Workbench read seam crosses the Module boundary for #91's renderer
// tests, the way createLiveRunLaunchView does for #90 — the boundary suite
// requires cross-Module test imports to go through this entrypoint. (The lifecycle
// Renderer Port belongs to the sibling `renderer` Module; tests take its type from
// that Module's own entrypoint, not re-exported here.)
export type { RunWorkbenchView, AnswerOutcome } from "./run-view.js";
export { createLiveRunWorkbenchView } from "./run-view.js";
// The Previous Runs read seam and the Run Actions submit seam (#92 ticket) cross
// the Module boundary for the list/Workbench renderer tests, the same way — the
// boundary suite requires cross-Module test imports to go through this entrypoint.
export type {
  RunListView,
  RunListController,
  RunListState,
} from "./run-list-view.js";
export { createLiveRunListView } from "./run-list-view.js";
export type { RunActionsView, RunActionOutcome } from "./run-actions-view.js";
export { createLiveRunActionsView } from "./run-actions-view.js";
// The Workbench's pure timeline model, exposed for #91's unit tests across the
// boundary, for the same reason.
export {
  AT_LIVE,
  scrollTimeline,
  timelineWindow,
  TIMELINE_PAGE,
} from "./run-timeline.js";
export type { TimelineScroll } from "./run-timeline.js";
