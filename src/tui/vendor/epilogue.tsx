import { createSimpleContext } from "./context-helper.js";

// Vendored from OpenCode packages/tui/src/context/epilogue.tsx at commit
// 1ead9e3d7f (unmodified). A screen can set a line to print to the restored
// terminal after teardown; the composition root reads it on the way out.

export const { use: useEpilogue, provider: EpilogueProvider } =
  createSimpleContext({
    name: "Epilogue",
    init: (props: { set(value?: string): void }) => props.set,
  });
