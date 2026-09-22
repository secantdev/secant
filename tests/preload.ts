// Runs before every test file (bunfig `[test].preload`). Only the `.tsx`
// presentation tests need OpenTUI's Solid universal transform and its native FFI
// renderer; loading them in the ~70 non-TUI workers is pure per-worker startup
// cost, which dominates `bun test` on the Windows runner (native-module load ×
// one worker per file). Each isolated worker runs a single file, exposed as
// `Bun.main`, so scope the OpenTUI preload to it: skip only a plain `.test.ts`
// target (never a `.tsx`), and load it for anything else so an unexpected entry
// still gets the transform.
if (!Bun.main.endsWith(".test.ts")) {
  // @opentui/solid/preload is a native preload script that ships no type
  // declarations; the previous bunfig string reference was never typechecked.
  // @ts-expect-error -- untyped native preload module
  await import("@opentui/solid/preload");
}

export {};
