import { createContext, Show, useContext, type ParentProps } from "solid-js";

// Vendored from OpenCode packages/tui/src/context/helper.tsx at commit
// 1ead9e3d7f (unmodified). A tiny provider/hook factory the exit and epilogue
// contexts build on.

export function createSimpleContext<
  T,
  Props extends Record<string, unknown>,
>(input: { name: string; init: ((input: Props) => T) | (() => T) }) {
  const ctx = createContext<T>();

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props);
      return (
        // @ts-expect-error ready is an optional convention on some contexts
        <Show when={init.ready === undefined || init.ready === true}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      );
    },
    use() {
      const value = useContext(ctx);
      if (!value)
        throw new Error(
          `${input.name} context must be used within a context provider`,
        );
      return value;
    },
  };
}
