import stringWidth from "string-width";

// Single-line truncation with an ellipsis affordance, shared by the screens that
// want to *show* a row was cut. It is not the overflow guard: a screen's container
// already sets `overflow="hidden"`, which clips horizontally on its own (verified
// at 30 and 40 columns), so `clip`'s real job is the trailing "…" marking the cut,
// not preventing overflow. Only the rows that should advertise truncation call it —
// one implementation so that ellipsis behaviour stays identical across screens.
//
// Width is measured in *display columns*, not UTF-16 code units (D5): a wide glyph
// (CJK, some emoji) occupies two columns and a zero-width combining mark none, so
// slicing by `.length` miscounts and an overflowing row is corrupted, not clipped
// (tui/AGENTS.md). `string-width` is the runtime-neutral column measure OpenCode
// uses for the same alignment work.

/** Truncate `text` to `width` display columns, marking a cut with a trailing
 *  ellipsis. The result never exceeds `width` columns. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  // Reserve one column for the "…" marker; fill the rest with as many leading
  // characters as fit, measured by column, so a trailing wide glyph never spills
  // past the budget.
  const budget = width - 1;
  let out = "";
  let used = 0;
  for (const char of text) {
    const columns = stringWidth(char);
    if (used + columns > budget) break;
    out += char;
    used += columns;
  }
  return `${out}…`;
}
