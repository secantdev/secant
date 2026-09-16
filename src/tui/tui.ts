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
// The Run Workbench, Previous Runs, and Run Actions view types are the App prop
// contract and cross the Module boundary for renderer tests. The Workbench's live
// factory is also exported so its durable/live/preview join is tested through the
// Module Interface rather than bypassed with independent signals. (The lifecycle
// Renderer Port belongs to the sibling `renderer` Module; tests take its type from
// that Module's own entrypoint, not re-exported here.)
export {
  createLiveRunWorkbenchView,
  type RunWorkbenchView,
  type RunWorkbenchProjection,
  type AnswerOutcome,
} from "./run-view.js";
export type {
  RunListView,
  RunListController,
  RunListState,
} from "./run-list-view.js";
export type { RunActionsView, RunActionOutcome } from "./run-actions-view.js";
// The Workbench's pure timeline model, exposed for #91's unit tests across the
// boundary, for the same reason.
export {
  AT_LIVE,
  scrollTimeline,
  timelineWindow,
  TIMELINE_PAGE,
} from "./run-timeline.js";
export type { TimelineScroll } from "./run-timeline.js";
// The display-column truncation helper, exposed for its unit test across the
// boundary (D5), like the timeline model above.
export { clip } from "./clip.js";
