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
