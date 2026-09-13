import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { ProjectionPort } from "../application/projection-port.js";
import { App } from "./app.js";
import { createLiveBundleCatalogView } from "./bundle-view.js";
import type { RendererPort } from "./renderer/renderer.js";
import { createLiveRunLaunchView } from "./run-launch-view.js";
import { createLiveRunWorkbenchView } from "./run-view.js";
import type { Exit } from "./vendor/exit.js";
import { createLiveWorkspaceView } from "./workspace-view.js";

// Mounts the shell onto a renderer the composition root owns. The live view is
// built inside the render root (Solid owner) so its Projection subscription and
// cleanup are tied to the mounted tree. Drawing goes through OpenTUI's Solid
// `render` directly — the Renderer Port never carries it.

export interface MountOptions {
  readonly projectionPort: ProjectionPort;
  /** The lifecycle Renderer Port the composition root owns; the Run Workbench is
   *  its first production caller of `size`/`onKey`/`onResize` (A13, #91). */
  readonly rendererPort: RendererPort;
  readonly exit: Exit;
}

export function mountTui(
  renderer: CliRenderer,
  options: MountOptions,
): Promise<void> {
  return render(
    () => (
      <App
        view={createLiveWorkspaceView(options.projectionPort)}
        bundles={createLiveBundleCatalogView(options.projectionPort)}
        launch={createLiveRunLaunchView(options.projectionPort)}
        run={createLiveRunWorkbenchView(options.projectionPort)}
        renderer={options.rendererPort}
        exit={options.exit}
      />
    ),
    renderer,
  );
}
