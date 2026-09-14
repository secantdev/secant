# Secant

> In development. Nothing is published yet. The shell already carries `workspace`, `bundle`, and `run` command groups (approve a Workspace; build,
> install, list, and inspect Bundles; launch, watch, answer, resume, cancel, and delete Runs) plus the interactive TUI. Everything here will change.

Secant reaches an outcome by routing between Steps: it drives an external coding Harness through a Workflow Bundle against a Workspace. The
implementation is being built from an empty, green baseline — see the migration decisions in [docs/adr](./docs/adr/) and the domain model in
[CONTEXT.md](./CONTEXT.md).

The package is `@secantdev/secant` and the command is `secant`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Agents working in this repository start from [AGENTS.md](./AGENTS.md).
