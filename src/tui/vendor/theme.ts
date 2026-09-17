import { RGBA } from "@opentui/core";
import aura from "./themes/aura.js";
import ayu from "./themes/ayu.js";
import carbonfox from "./themes/carbonfox.js";
import catppuccin from "./themes/catppuccin.js";
import catppuccinFrappe from "./themes/catppuccin_frappe.js";
import catppuccinMacchiato from "./themes/catppuccin_macchiato.js";
import cobalt2 from "./themes/cobalt2.js";
import dracula from "./themes/dracula.js";
import everforest from "./themes/everforest.js";
import flexoki from "./themes/flexoki.js";
import gruvbox from "./themes/gruvbox.js";
import kanagawa from "./themes/kanagawa.js";
import matrix from "./themes/matrix.js";
import mercury from "./themes/mercury.js";
import nightowl from "./themes/nightowl.js";
import nord from "./themes/nord.js";
import onedark from "./themes/one_dark.js";
import osakaJade from "./themes/osaka_jade.js";
import palenight from "./themes/palenight.js";
import rosepine from "./themes/rosepine.js";
import solarized from "./themes/solarized.js";
import synthwave84 from "./themes/synthwave84.js";
import tokyonight from "./themes/tokyonight.js";
import vesper from "./themes/vesper.js";
import zenburn from "./themes/zenburn.js";

// Vendored from OpenCode packages/tui/src/theme/index.ts at commit 1ead9e3d7f.
// Local modifications: theme assets are imported as `.ts` modules instead of
// JSON with import attributes (attributes did not survive the Node build); the
// 33 upstream assets are pruned to 25 (five product-named and three
// OpenCode-branded themes dropped, recorded in UPSTREAM and ADR 0018); and
// OpenCode's runtime theme-management surface (plugin/custom themes,
// subscription, `allThemes`/`isTheme`/`addTheme`/…) is dropped because Secant
// ships a fixed default with no picker. The kept pure computation — the Theme
// type, the resolver, and ANSI-to-RGBA — is unchanged; the never-called
// `selectedForeground`, `terminalMode`, `generateSystem`, `tint`, and
// syntax-style generators are dropped too (audit A12 and #127 A37), since no
// picker or highlighter uses them yet.

export type Theme = {
  readonly primary: RGBA;
  readonly secondary: RGBA;
  readonly accent: RGBA;
  readonly error: RGBA;
  readonly warning: RGBA;
  readonly success: RGBA;
  readonly info: RGBA;
  readonly text: RGBA;
  readonly textMuted: RGBA;
  readonly selectedListItemText: RGBA;
  readonly background: RGBA;
  readonly backgroundPanel: RGBA;
  readonly backgroundElement: RGBA;
  readonly backgroundMenu: RGBA;
  readonly border: RGBA;
  readonly borderActive: RGBA;
  readonly borderSubtle: RGBA;
  readonly diffAdded: RGBA;
  readonly diffRemoved: RGBA;
  readonly diffContext: RGBA;
  readonly diffHunkHeader: RGBA;
  readonly diffHighlightAdded: RGBA;
  readonly diffHighlightRemoved: RGBA;
  readonly diffAddedBg: RGBA;
  readonly diffRemovedBg: RGBA;
  readonly diffContextBg: RGBA;
  readonly diffLineNumber: RGBA;
  readonly diffAddedLineNumberBg: RGBA;
  readonly diffRemovedLineNumberBg: RGBA;
  readonly markdownText: RGBA;
  readonly markdownHeading: RGBA;
  readonly markdownLink: RGBA;
  readonly markdownLinkText: RGBA;
  readonly markdownCode: RGBA;
  readonly markdownBlockQuote: RGBA;
  readonly markdownEmph: RGBA;
  readonly markdownStrong: RGBA;
  readonly markdownHorizontalRule: RGBA;
  readonly markdownListItem: RGBA;
  readonly markdownListEnumeration: RGBA;
  readonly markdownImage: RGBA;
  readonly markdownImageText: RGBA;
  readonly markdownCodeBlock: RGBA;
  readonly syntaxComment: RGBA;
  readonly syntaxKeyword: RGBA;
  readonly syntaxFunction: RGBA;
  readonly syntaxVariable: RGBA;
  readonly syntaxString: RGBA;
  readonly syntaxNumber: RGBA;
  readonly syntaxType: RGBA;
  readonly syntaxOperator: RGBA;
  readonly syntaxPunctuation: RGBA;
  readonly thinkingOpacity: number;
  _hasSelectedListItemText: boolean;
};
type ThemeColor = Exclude<
  keyof Theme,
  "thinkingOpacity" | "_hasSelectedListItemText"
>;

type HexColor = `#${string}`;
type RefName = string;
type Variant = {
  dark: HexColor | RefName;
  light: HexColor | RefName;
};
type ColorValue = HexColor | RefName | Variant | RGBA;
export type ThemeJson = {
  $schema?: string;
  defs?: Record<string, HexColor | RefName>;
  theme: Omit<
    Record<ThemeColor, ColorValue>,
    "selectedListItemText" | "backgroundMenu"
  > & {
    selectedListItemText?: ColorValue;
    backgroundMenu?: ColorValue;
    thinkingOpacity?: number;
  };
};

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  aura,
  ayu,
  catppuccin,
  ["catppuccin-frappe"]: catppuccinFrappe,
  ["catppuccin-macchiato"]: catppuccinMacchiato,
  cobalt2,
  dracula,
  everforest,
  flexoki,
  gruvbox,
  kanagawa,
  matrix,
  mercury,
  nightowl,
  nord,
  ["one-dark"]: onedark,
  ["osaka-jade"]: osakaJade,
  palenight,
  rosepine,
  solarized,
  synthwave84,
  tokyonight,
  vesper,
  zenburn,
  carbonfox,
};

export function resolveTheme(theme: ThemeJson, mode: "dark" | "light") {
  const defs = theme.defs ?? {};
  function resolveColor(c: ColorValue, chain: string[] = []): RGBA {
    if (c instanceof RGBA) return c;
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0);
      if (c.startsWith("#")) return RGBA.fromHex(c);
      if (chain.includes(c)) {
        throw new Error(
          `Circular color reference: ${[...chain, c].join(" -> ")}`,
        );
      }
      const next = defs[c] ?? theme.theme[c as ThemeColor];
      if (next === undefined) {
        throw new Error(`Color reference "${c}" not found in defs or theme`);
      }
      return resolveColor(next, [...chain, c]);
    }
    if (typeof c === "number") {
      return ansiToRgba(c);
    }
    return resolveColor(c[mode], chain);
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(
        ([key]) =>
          key !== "selectedListItemText" &&
          key !== "backgroundMenu" &&
          key !== "thinkingOpacity",
      )
      .map(([key, value]) => {
        return [key, resolveColor(value as ColorValue)];
      }),
  ) as Partial<Record<ThemeColor, RGBA>>;

  const hasSelectedListItemText =
    theme.theme.selectedListItemText !== undefined;
  if (hasSelectedListItemText) {
    resolved.selectedListItemText = resolveColor(
      theme.theme.selectedListItemText!,
    );
  } else {
    resolved.selectedListItemText = resolved.background;
  }

  if (theme.theme.backgroundMenu !== undefined) {
    resolved.backgroundMenu = resolveColor(theme.theme.backgroundMenu);
  } else {
    resolved.backgroundMenu = resolved.backgroundElement;
  }

  const thinkingOpacity = theme.theme.thinkingOpacity ?? 0.6;

  return {
    ...resolved,
    _hasSelectedListItemText: hasSelectedListItemText,
    thinkingOpacity,
  } as Theme;
}

function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const ansiColors = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ];
    return RGBA.fromHex(ansiColors[code] ?? "#000000");
  }
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    return RGBA.fromInts(val(r), val(g), val(b));
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8;
    return RGBA.fromInts(gray, gray, gray);
  }
  return RGBA.fromInts(0, 0, 0);
}
