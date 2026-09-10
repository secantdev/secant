import { createContext, useContext, type ParentProps } from "solid-js";
import { DEFAULT_THEMES, resolveTheme, type Theme } from "./theme.js";

// Rebuilt against OpenCode packages/tui/src/context/theme.tsx at commit
// 1ead9e3d7f. Taken: the context shape (`useTheme().theme`) and that the active
// theme is resolved from the vendored theme module. Deliberately changed:
// OpenCode's provider carries a store with light/dark toggling, terminal-palette
// system-theme detection, a KV-persisted choice, custom-theme discovery, and a
// reactive proxy. Secant ships a fixed default with no picker and no persisted
// preference (ADR 0018's colourblind fix lives in the command/projection layer,
// not here), so the provider resolves one theme once and hands it down.

// The default theme. A neutral, widely known MIT community palette; no picker
// exists yet to change it (a later slice earns one).
const DEFAULT_THEME = "nord";

export interface ThemeContext {
  readonly theme: Theme;
  readonly selected: string;
}

const ctx = createContext<ThemeContext>();

export function ThemeProvider(props: ParentProps<{ name?: string }>) {
  const name = props.name ?? DEFAULT_THEME;
  const json = DEFAULT_THEMES[name] ?? DEFAULT_THEMES[DEFAULT_THEME]!;
  const value: ThemeContext = {
    theme: resolveTheme(json, "dark"),
    selected: name,
  };
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}

export function useTheme(): ThemeContext {
  const value = useContext(ctx);
  if (!value) throw new Error("useTheme must be used within a ThemeProvider");
  return value;
}
