# Third-Party Notices

This product includes third-party software. The components below are either
vendored (a reduced copy lives in this repository under `src/tui/vendor/`) or
depended upon at their pinned versions. Provenance for the vendored subset is
recorded in the top-level [`UPSTREAM`](./UPSTREAM) file. This notices file and
`UPSTREAM` are mandated by [ADR 0018](./docs/adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md).

---

## OpenCode

A reduced subset of OpenCode's presentation layer is vendored into
`src/tui/vendor/` (see `UPSTREAM` for the per-file inventory), copied from the
OpenCode project at commit `1ead9e3d7f`.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## OpenTUI (`@opentui/core`, `@opentui/keymap`, `@opentui/solid`)

OpenTUI is **not** vendored. It is a real npm dependency pinned at `0.4.5`
(unpatched, unforked). It is listed here because the vendored presentation code
renders through it.

```
MIT License

Copyright (c) 2025 opentui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The copyright line above is reproduced from the `LICENSE` file shipped in the
`@opentui/core@0.4.5` package (the `anomalyco/opentui` project). All three
`@opentui/*` packages are published at `0.4.5` under the MIT licence.

---

## commander

`commander` is **not** vendored. It is a real npm dependency pinned at `14.0.2`
(zero transitive dependencies). It is listed here because the CLI's command
parsing is bundled into the shipped single-file executable.

```
(The MIT License)

Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## semver

`semver` is **not** vendored. It is a real npm dependency pinned at `7.7.4`
(the OpenCode precedent for host-version ranges). It is listed here because the
Bundle version and engine-range comparisons are bundled into the shipped
single-file executable.

```
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## zod

`zod` is **not** vendored. It is a real npm dependency pinned at `4.1.8` (the
version OpenCode carries). It is listed here because the Bundle manifest and
Catalog row validation is bundled into the shipped single-file executable.

```
MIT License

Copyright (c) 2020 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## solid-js

`solid-js` is **not** vendored. It is a real npm dependency pinned at `1.9.12`
(the version OpenCode carries, and the reactive runtime `@opentui/solid` renders
through). It is listed here because the vendored presentation code and the shell's
screens are built as Solid components bundled into the shipped single-file
executable.

```
MIT License

Copyright (c) 2016-2025 Ryan Carniato

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Shipped Themes

The 25 themes below are vendored from OpenCode's theme set (see `UPSTREAM` for
the upstream asset mapping). Verified against the OpenCode tree, the theme
assets carry no in-file attribution; per ADR 0018 most are well-known
MIT-licensed community themes and one notice line each satisfies the
obligation.

- Aura — MIT licensed community theme, from the OpenCode theme set.
- Ayu — MIT licensed community theme, from the OpenCode theme set.
- Carbonfox — MIT licensed community theme, from the OpenCode theme set.
- Catppuccin — MIT licensed community theme, from the OpenCode theme set.
- Catppuccin Frappe — MIT licensed community theme, from the OpenCode theme set.
- Catppuccin Macchiato — MIT licensed community theme, from the OpenCode theme set.
- Cobalt2 — MIT licensed community theme, from the OpenCode theme set.
- Dracula — MIT licensed community theme, from the OpenCode theme set.
- Everforest — MIT licensed community theme, from the OpenCode theme set.
- Flexoki — MIT licensed community theme, from the OpenCode theme set.
- Gruvbox — MIT licensed community theme, from the OpenCode theme set.
- Kanagawa — MIT licensed community theme, from the OpenCode theme set.
- Matrix — MIT licensed community theme, from the OpenCode theme set.
- Mercury — MIT licensed community theme, from the OpenCode theme set.
- Night Owl — MIT licensed community theme, from the OpenCode theme set.
- Nord — MIT licensed community theme, from the OpenCode theme set.
- One Dark — MIT licensed community theme, from the OpenCode theme set.
- Osaka Jade — MIT licensed community theme, from the OpenCode theme set.
- Palenight — MIT licensed community theme, from the OpenCode theme set.
- Rose Pine — MIT licensed community theme, from the OpenCode theme set.
- Solarized — MIT licensed community theme, from the OpenCode theme set.
- Synthwave84 — MIT licensed community theme, from the OpenCode theme set.
- Tokyo Night — MIT licensed community theme, from the OpenCode theme set.
- Vesper — MIT licensed community theme, from the OpenCode theme set.
- Zenburn — MIT licensed community theme, from the OpenCode theme set.
