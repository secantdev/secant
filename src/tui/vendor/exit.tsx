import { createSimpleContext } from "./context-helper.js";

// Vendored from OpenCode packages/tui/src/context/exit.tsx at commit 1ead9e3d7f
// (unmodified). The view components call `useExit()` to request shutdown; the
// composition root supplies the real teardown behind it.

export type Exit = (reason?: unknown) => void;

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
});
