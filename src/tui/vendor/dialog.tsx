import { Renderable, RGBA } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  createContext,
  Show,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useBindings } from "../keymap.js";
import { useTheme } from "./theme-context.js";

// Vendored from OpenCode packages/tui/src/ui/dialog.tsx at commit 1ead9e3d7f.
// Taken: the backdrop + centred panel, the dialog stack, focus save/restore, and
// Escape / Ctrl+C dismissal. Dropped (features Secant lacks, ADR 0018 "no dead
// UI"): the toast + clipboard copy-on-select handlers, the OPENCODE_EXPERIMENTAL
// flag branches, and the `useOpencodeModeStack("modal")` push — modal gating is
// the `enabled` accessor on the dismissal layer, so no mode stack is needed.

// Module-private: only `DialogProvider` below renders it (audit A12).
function Dialog(
  props: ParentProps<{
    onClose: () => void;
  }>,
) {
  const dimensions = useTerminalDimensions();
  const { theme } = useTheme();
  const renderer = useRenderer();

  let dismiss = false;

  return (
    <box
      onMouseDown={() => {
        dismiss = !!renderer.getSelection();
      }}
      onMouseUp={() => {
        if (dismiss) {
          dismiss = false;
          return;
        }
        props.onClose?.();
      }}
      width={dimensions().width}
      height={dimensions().height}
      alignItems="center"
      position="absolute"
      zIndex={3000}
      paddingTop={Math.floor(dimensions().height / 4)}
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={(e: { stopPropagation(): void }) => {
          dismiss = false;
          e.stopPropagation();
        }}
        width={60}
        maxWidth={dimensions().width - 2}
        backgroundColor={theme.backgroundPanel}
        paddingTop={1}
      >
        {props.children}
      </box>
    </box>
  );
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: () => JSX.Element;
      onClose?: () => void;
    }[],
  });

  const renderer = useRenderer();

  let focus: Renderable | null;
  function refocus() {
    setTimeout(() => {
      if (!focus) return;
      if (focus.isDestroyed) return;
      function find(item: Renderable): boolean {
        for (const child of item.getChildren()) {
          if (child === focus) return true;
          if (find(child)) return true;
        }
        return false;
      }
      const found = find(renderer.root);
      if (!found) return;
      focus.focus();
    }, 1);
  }

  const dismissTop = () => {
    if (renderer.getSelection()) renderer.clearSelection();
    const current = store.stack.at(-1);
    current?.onClose?.();
    setStore("stack", store.stack.slice(0, -1));
    refocus();
  };

  useBindings(() => ({
    enabled: store.stack.length > 0,
    bindings: [
      { key: "escape", desc: "Close dialog", group: "Dialog", cmd: dismissTop },
      { key: "ctrl+c", desc: "Close dialog", group: "Dialog", cmd: dismissTop },
    ],
  }));

  return {
    clear() {
      for (const item of store.stack) item.onClose?.();
      setStore("stack", []);
      refocus();
    },
    replace(element: () => JSX.Element, onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable;
        focus?.blur();
      }
      for (const item of store.stack) item.onClose?.();
      setStore("stack", [{ element, onClose }]);
    },
    get stack() {
      return store.stack;
    },
  };
}

export type DialogContext = ReturnType<typeof init>;

const ctx = createContext<DialogContext>();

export function DialogProvider(props: ParentProps) {
  const value = init();
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box position="absolute" zIndex={3000}>
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()}>
            {value.stack.at(-1)!.element()}
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  );
}

export function useDialog() {
  const value = useContext(ctx);
  if (!value) throw new Error("useDialog must be used within a DialogProvider");
  return value;
}
