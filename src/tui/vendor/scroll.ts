import type { ScrollBoxRenderable } from "@opentui/core";

// Reduced from the scrollbox keyboard paths in OpenCode's diff-viewer.tsx at
// 1ead9e3d7f (see UPSTREAM). OpenCode delegates clamping to scrollBy; Secant
// computes the bounded destination explicitly because the Bundle inspector's
// first/last-line behavior is part of its Interface and renderer tests.
export function scrollVertically(
  scroll: ScrollBoxRenderable | undefined,
  delta: number,
): void {
  if (scroll === undefined) return;
  const maximum = Math.max(0, scroll.scrollHeight - scroll.viewport.height);
  scroll.scrollTo(Math.max(0, Math.min(scroll.scrollTop + delta, maximum)));
}
