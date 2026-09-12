// The tui Module's public entrypoint. The composition root renders `App` onto
// the renderer it owns, building the view over the Projection Port with
// `createLiveWorkspaceView`.

export { App } from "./app.js";
export { mountTui, type MountOptions } from "./mount.js";
export {
  createLiveWorkspaceView,
  type WorkspaceView,
} from "./workspace-view.js";
export {
  createLiveBundleCatalogView,
  type BundleCatalogView,
} from "./bundle-view.js";
