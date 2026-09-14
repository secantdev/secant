// Single-line truncation with an ellipsis affordance, shared by the screens that
// want to *show* a row was cut. It is not the overflow guard: a screen's container
// already sets `overflow="hidden"`, which clips horizontally on its own (verified
// at 30 and 40 columns), so `clip`'s real job is the trailing "…" marking the cut,
// not preventing overflow. Only the rows that should advertise truncation call it —
// one implementation so that ellipsis behaviour stays identical across screens.

/** Truncate `text` to `width` columns, marking a cut with a trailing ellipsis. */
export function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
