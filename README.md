# DevFlow

> Early and experimental: DevFlow is usable for local development trials, but its workflows and storage formats may still change. Expect rough edges and keep normal review discipline around any generated changes.

DevFlow is a CLI orchestrator for AI-assisted software work. You give it a development task, it drives a supported coding provider through project context, planning, issue decomposition, and execution, then leaves you with repository changes to review.

Supported providers today:

- Claude
- Codex

DevFlow is published as the `devflow-cli` package, but the command you run is `devflow`.

## Install From Source

```sh
git clone https://github.com/DevFlow-HQ/devflow-cli.git
cd devflow-cli
npm install
npm run build
npm link
```

The package is intended to install globally this way once published, but it is not yet on npm:

```sh
npm install -g devflow-cli
```

## First Run

Make sure your chosen provider CLI is installed and authenticated, then run DevFlow from the repository you want it to work on:

```sh
devflow "add dark mode"
```

DevFlow writes run artifacts under the target repository's `.devflow/` directory and prints progress in the terminal.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Agents working in this repository start from `AGENTS.md`.

## Architecture

For the deeper architecture model, provider terminology, and current design decisions, read [CONTEXT.md](./CONTEXT.md).
