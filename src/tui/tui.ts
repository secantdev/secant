// The tui Module's public entrypoint. The composition root mounts `App` onto the
// renderer it owns via `mountTui`. The per-screen view types are the App prop
// contract; the live views are built inside `mount.tsx`, not through this entry.

export { App } from "./app.js";
export { mountTui, type MountOptions } from "./mount.js";
export type { WorkspaceView } from "./workspace-view.js";
export type { BundleCatalogView } from "./bundle-view.js";
