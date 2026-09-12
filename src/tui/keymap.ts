import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { useRenderer } from "@opentui/solid";
import type { CliRenderer } from "@opentui/core";

// Secant's keymap layer is a thin cap over @opentui/keymap, the pinned upstream
// that already owns the mode/layer/leader/sequence mechanics OpenCode's
// keymap.tsx merely adapts. Rather than vendor that ~760-line adapter (ADR 0018:
// don't reinvent what upstream solved, delete what Crucible lacks), the shell
// uses the upstream Solid integration directly and gates its one modal dialog
// with a binding-layer `enabled` accessor instead of a mode stack.

export { KeymapProvider, useBindings } from "@opentui/keymap/solid";

/** Builds the default OpenTUI keymap bound to the mounted renderer. */
export function createTuiKeymap() {
  const renderer = useRenderer() as unknown as CliRenderer;
  return createDefaultOpenTuiKeymap(renderer);
}
