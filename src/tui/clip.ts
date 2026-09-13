// Single-line truncation shared by the TUI screens: OpenTUI's `<text>` never wraps
// a one-line row, so every row clips its concatenated string to the inner width
// itself, marking a cut with a trailing ellipsis. One implementation so the
// truncation behaviour stays identical across screens.

/** Truncate `text` to `width` columns, marking a cut with a trailing ellipsis. */
export function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
