import type { CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import type { ProjectionPort } from "../application/projection-port.js";
import { App } from "./app.js";
import type { Exit } from "./vendor/exit.js";
import { createLiveWorkspaceView } from "./workspace-view.js";

// Mounts the shell onto a renderer the composition root owns. The live view is
// built inside the render root (Solid owner) so its Projection subscription and
// cleanup are tied to the mounted tree. Drawing goes through OpenTUI's Solid
// `render` directly — the Renderer Port never carries it.

export interface MountOptions {
  readonly projectionPort: ProjectionPort;
  readonly exit: Exit;
  readonly onEpilogue?: (value?: string) => void;
}

export function mountTui(
  renderer: CliRenderer,
  options: MountOptions,
): Promise<void> {
  return render(
    () => (
      <App
        view={createLiveWorkspaceView(options.projectionPort)}
        exit={options.exit}
        onEpilogue={options.onEpilogue}
      />
    ),
    renderer,
  );
}
