import { RGBA, SyntaxStyle, type TerminalColors } from "@opentui/core";
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
// ships a fixed default with no picker. The pure computation — type, resolver,
// ANSI-to-RGBA, system-theme generation, and syntax styles — is unchanged.

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
export type SyntaxStyleOverrides = Record<string, { italic?: boolean }>;

export function selectedForeground(theme: Theme, bg?: RGBA): RGBA {
  if (theme._hasSelectedListItemText) {
    return theme.selectedListItemText;
  }
  if (theme.background.a === 0) {
    const targetColor = bg ?? theme.primary;
    const { r, g, b } = targetColor;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 0.5
      ? RGBA.fromInts(0, 0, 0)
      : RGBA.fromInts(255, 255, 255);
  }
  return theme.background;
}

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

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const r = base.r + (overlay.r - base.r) * alpha;
  const g = base.g + (overlay.g - base.g) * alpha;
  const b = base.b + (overlay.b - base.b) * alpha;
  return RGBA.fromInts(
    Math.round(r * 255),
    Math.round(g * 255),
    Math.round(b * 255),
  );
}

export function terminalMode(
  colors: TerminalColors,
): "dark" | "light" | undefined {
  const bg = colors.defaultBackground;
  if (!bg) return;
  const { r, g, b } = RGBA.fromHex(bg);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark";
}

export function generateSystem(
  colors: TerminalColors,
  mode: "dark" | "light",
): ThemeJson {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!);
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!);
  const transparent = RGBA.fromValues(bg.r, bg.g, bg.b, 0);
  const isDark = mode == "dark";

  const col = (i: number) => {
    const value = colors.palette[i];
    if (value) return RGBA.fromHex(value);
    return ansiToRgba(i);
  };

  const grays = generateGrayScale(bg, isDark);
  const textMuted = generateMutedTextColor(bg, isDark);

  const ansiColors = {
    black: col(0),
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    white: col(7),
    redBright: col(9),
    greenBright: col(10),
  };

  const diffAlpha = isDark ? 0.22 : 0.14;
  const diffAddedBg = tint(bg, ansiColors.green, diffAlpha);
  const diffRemovedBg = tint(bg, ansiColors.red, diffAlpha);
  const diffContextBg = grays[2]!;
  const diffAddedLineNumberBg = tint(
    diffContextBg,
    ansiColors.green,
    diffAlpha,
  );
  const diffRemovedLineNumberBg = tint(
    diffContextBg,
    ansiColors.red,
    diffAlpha,
  );
  const diffLineNumber = textMuted;

  return {
    theme: {
      primary: ansiColors.cyan,
      secondary: ansiColors.magenta,
      accent: ansiColors.cyan,
      error: ansiColors.red,
      warning: ansiColors.yellow,
      success: ansiColors.green,
      info: ansiColors.cyan,
      text: fg,
      textMuted,
      selectedListItemText: bg,
      background: transparent,
      backgroundPanel: grays[2]!,
      backgroundElement: grays[3]!,
      backgroundMenu: grays[3]!,
      borderSubtle: grays[6]!,
      border: grays[7]!,
      borderActive: grays[8]!,
      diffAdded: ansiColors.green,
      diffRemoved: ansiColors.red,
      diffContext: grays[7]!,
      diffHunkHeader: grays[7]!,
      diffHighlightAdded: ansiColors.greenBright,
      diffHighlightRemoved: ansiColors.redBright,
      diffAddedBg,
      diffRemovedBg,
      diffContextBg,
      diffLineNumber,
      diffAddedLineNumberBg,
      diffRemovedLineNumberBg,
      markdownText: fg,
      markdownHeading: fg,
      markdownLink: ansiColors.blue,
      markdownLinkText: ansiColors.cyan,
      markdownCode: ansiColors.green,
      markdownBlockQuote: ansiColors.yellow,
      markdownEmph: ansiColors.yellow,
      markdownStrong: fg,
      markdownHorizontalRule: grays[7]!,
      markdownListItem: ansiColors.blue,
      markdownListEnumeration: ansiColors.cyan,
      markdownImage: ansiColors.blue,
      markdownImageText: ansiColors.cyan,
      markdownCodeBlock: fg,
      syntaxComment: textMuted,
      syntaxKeyword: ansiColors.magenta,
      syntaxFunction: ansiColors.blue,
      syntaxVariable: fg,
      syntaxString: ansiColors.green,
      syntaxNumber: ansiColors.yellow,
      syntaxType: ansiColors.cyan,
      syntaxOperator: ansiColors.cyan,
      syntaxPunctuation: fg,
    },
  };
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {};
  const bgR = bg.r * 255;
  const bgG = bg.g * 255;
  const bgB = bg.b * 255;
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12.0;
    let grayValue: number;
    let newR: number;
    let newG: number;
    let newB: number;

    if (isDark) {
      if (luminance < 10) {
        grayValue = Math.floor(factor * 0.4 * 255);
        newR = grayValue;
        newG = grayValue;
        newB = grayValue;
      } else {
        const newLum = luminance + (255 - luminance) * factor * 0.4;
        const ratio = newLum / luminance;
        newR = Math.min(bgR * ratio, 255);
        newG = Math.min(bgG * ratio, 255);
        newB = Math.min(bgB * ratio, 255);
      }
    } else {
      if (luminance > 245) {
        grayValue = Math.floor(255 - factor * 0.4 * 255);
        newR = grayValue;
        newG = grayValue;
        newB = grayValue;
      } else {
        const newLum = luminance * (1 - factor * 0.4);
        const ratio = newLum / luminance;
        newR = Math.max(bgR * ratio, 0);
        newG = Math.max(bgG * ratio, 0);
        newB = Math.max(bgB * ratio, 0);
      }
    }

    grays[i] = RGBA.fromInts(
      Math.floor(newR),
      Math.floor(newG),
      Math.floor(newB),
    );
  }

  return grays;
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const bgR = bg.r * 255;
  const bgG = bg.g * 255;
  const bgB = bg.b * 255;
  const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  let grayValue: number;

  if (isDark) {
    if (bgLum < 10) {
      grayValue = 180;
    } else {
      grayValue = Math.min(Math.floor(160 + bgLum * 0.3), 200);
    }
  } else {
    if (bgLum > 245) {
      grayValue = 75;
    } else {
      grayValue = Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60);
    }
  }

  return RGBA.fromInts(grayValue, grayValue, grayValue);
}

export function generateSyntax(theme: Theme) {
  return SyntaxStyle.fromTheme(getSyntaxRules(theme));
}

export function generateSubtleSyntax(
  theme: Theme,
  overrides?: SyntaxStyleOverrides,
) {
  const rules = getSyntaxRules(theme);
  return SyntaxStyle.fromTheme(
    rules.map((rule) => {
      const override = rule.scope.reduce(
        (acc, scope) => ({ ...acc, ...overrides?.[scope] }),
        {},
      );
      if (rule.style.foreground) {
        const fg = rule.style.foreground;
        return {
          ...rule,
          style: {
            ...rule.style,
            ...override,
            foreground: RGBA.fromInts(
              Math.round(fg.r * 255),
              Math.round(fg.g * 255),
              Math.round(fg.b * 255),
              Math.round(theme.thinkingOpacity * 255),
            ),
          },
        };
      }
      return rule;
    }),
  );
}

function getSyntaxRules(theme: Theme) {
  return [
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["prompt"], style: { foreground: theme.accent } },
    {
      scope: ["comment"],
      style: { foreground: theme.syntaxComment, italic: true },
    },
    { scope: ["string", "symbol"], style: { foreground: theme.syntaxString } },
    {
      scope: ["number", "boolean"],
      style: { foreground: theme.syntaxNumber },
    },
    { scope: ["keyword"], style: { foreground: theme.syntaxKeyword } },
    {
      scope: ["keyword.function", "function.method"],
      style: { foreground: theme.syntaxFunction },
    },
    {
      scope: ["operator", "keyword.operator", "punctuation.delimiter"],
      style: { foreground: theme.syntaxOperator },
    },
    {
      scope: ["variable", "variable.parameter", "function.call"],
      style: { foreground: theme.syntaxVariable },
    },
    { scope: ["type", "module"], style: { foreground: theme.syntaxType } },
    { scope: ["constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["property"], style: { foreground: theme.syntaxVariable } },
    { scope: ["class"], style: { foreground: theme.syntaxType } },
    {
      scope: ["punctuation", "punctuation.bracket"],
      style: { foreground: theme.syntaxPunctuation },
    },
    {
      scope: ["markup.heading"],
      style: { foreground: theme.markdownHeading, bold: true },
    },
    {
      scope: ["markup.bold", "markup.strong"],
      style: { foreground: theme.markdownStrong, bold: true },
    },
    {
      scope: ["markup.italic"],
      style: { foreground: theme.markdownEmph, italic: true },
    },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    {
      scope: ["markup.quote"],
      style: { foreground: theme.markdownBlockQuote, italic: true },
    },
    {
      scope: ["markup.raw", "markup.raw.block"],
      style: { foreground: theme.markdownCode },
    },
    {
      scope: ["markup.link"],
      style: { foreground: theme.markdownLink, underline: true },
    },
    {
      scope: ["diff.plus"],
      style: { foreground: theme.diffAdded, background: theme.diffAddedBg },
    },
    {
      scope: ["diff.minus"],
      style: { foreground: theme.diffRemoved, background: theme.diffRemovedBg },
    },
    { scope: ["error"], style: { foreground: theme.error, bold: true } },
    { scope: ["warning"], style: { foreground: theme.warning, bold: true } },
    { scope: ["info"], style: { foreground: theme.info } },
  ];
}
