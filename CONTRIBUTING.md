# Contributing

This page is for people. Agents read `AGENTS.md`, and every engineering rule lives there or in the files it names; nothing is repeated here.

## Set up

Use the Node version declared in `package.json` under `engines`, then run a clean install:

```sh
npm ci
```

## Run

```sh
npm run dev -- --help
```

## Verify

One command is the canonical gate. CI runs the same command after a clean install, and a change is done when it passes:

```sh
npm run check
```

It covers type checking, formatting, lint, the recursively discovered deterministic tests, the production build, and installed-package smoke tests.
Checks that need an installed Harness, network access, or a real terminal are opt-in and not part of it.

## Find your way

- Vocabulary: `CONTEXT.md` and the glossary cluster it points you to.
- Durable decisions and their reasons: `docs/adr/`.
- Engineering policy: the line in `AGENTS.md` that matches your change, then the file it names.
- Work in progress: GitHub issues. Both wayfinding decisions and implementation tickets carry a "Starting context" comment. Read it before the code.

## Pull requests

- Reference the issue the change implements. Keep the change small enough to review in one sitting.
- Say how you verified it beyond `npm run check`, especially for anything touching a real Harness or terminal.
- Short imperative titles, optionally prefixed `type(#issue):`, for example `docs(#18): record in-place legacy replacement as ADR 0026`.
- No Co-author trailers in commit messages.
