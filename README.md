# gitwe

**Configurable Git branching-workflow engine.**

[![npm version](https://img.shields.io/npm/v/gitwe-ts)](https://www.npmjs.com/package/gitwe-ts)
[![npm version](https://img.shields.io/npm/v/@idmdakhi/gitwe)](https://www.npmjs.com/package/@idmdakhi/gitwe)
[![Node.js CI](https://github.com/idmdakhi/gitwe/actions/workflows/ci.yaml/badge.svg)](https://github.com/idmdakhi/gitwe/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

gitwe is a modern, configurable Git branching workflow engine. Define your workflow once — base branches, topic types, merge rules, tagging, hooks — and gitwe generates a consistent CLI and library API around it.

Inspired by the original [`nvie/gitflow`](https://github.com/nvie/gitflow), [`gitflow-avh`](https://github.com/petervanderdoes/gitflow-avh), and [`git-flow-next`](https://github.com/gittower/git-flow-next), but designed with extensibility and modern DX at its core.

---

## Key Features

- **Workflow-Agnostic** – Ships with `classic`, `github`, and `gitlab` presets, but you can fully customize `.gitwe/gitwe.yaml`.
- **Resumable Operations** – `gitwe finish` pauses on conflicts; resolve and resume with `--continue` or abort with `--abort`.
- **Hooks** – Run custom scripts at lifecycle events (`pre-start`, `post-finish`, etc.).
- **Versioning & Changelog** – Automatic semantic version bumps and changelog generation.
- **Clean Architecture** – Domain, Application, Infrastructure layers strictly enforced.
- **Multi-Format Output** – Supports `json`, `yaml`, and `table` output formats.
- **GitHub Action** – Use gitwe seamlessly in CI/CD pipelines.

---

## Quick Start

### Installation

```bash
npm install -g gitwe-ts
# OR
npm install -g @idmdakhi/gitwe
```

Or run it without installing via `npx`:

```bash
npx gitwe --help
```

### Initialize a Workflow

```bash
gitwe init --preset classic
```

### Start a Feature Branch

```bash
gitwe start feature login-page
```

### Finish and Push

```bash
gitwe finish feature/login-page --push
```

If conflicts arise, resolve them and run:

```bash
gitwe finish --continue
```

---

## Documentation

Full documentation is available in the [`docs/`](./docs) folder.

- **[Quickstart](./docs/getting-started/quickstart.md)** – Get started in 5 minutes.
- **[Installation](./docs/getting-started/installation.md)** – Install via npm, npx, or build from source.
- **[Commands Reference](./docs/user-guide/commands.md)** – All CLI commands, flags, and exit codes.
- **[Workflow Definition](./docs/user-guide/workflow-definition.md)** – Full schema for `.gitwe/gitwe.yaml`.
- **[Hooks Guide](./docs/user-guide/hooks.md)** – Scripts and environment variables for automation.
- **[Troubleshooting](./docs/user-guide/troubleshooting.md)** – Common errors and solutions.
- **[Branching Models](./docs/concepts/branching-models.md)** – Classic, GitHub Flow, GitLab Flow, and custom models.
- **[Merge Strategies](./docs/concepts/merge-strategies.md)** – Merge, squash, rebase, cherry-pick, and rebase-merge.
- **[State Machine](./docs/concepts/state-machine.md)** – The resumable finish operation (diagram).
- **[Architecture Overview](./docs/architecture/overview.md)** – Clean Architecture and boundary enforcement.
- **[Migration Guide](./docs/reference/migration-guide.md)** – From nvie/gitflow, AVH, and git-flow-next.

You can also browse the **[Wiki](https://github.com/idmdakhi/gitwe/wiki)** for a quick overview.

---

## Contributing

We welcome contributions! Please read our [Contributing Guide](./docs/development/contributing.md) and [Roadmap](./docs/development/roadmap.md) to get started.

### Development Setup

```bash
git clone https://github.com/idmdakhi/gitwe.git
cd gitwe
npm install
npm run build
npm link
```

### Run Tests

```bash
npm test          # Unit tests
npm run test:e2e  # End-to-end tests
```

---

## License

MIT © [idmdakhi](https://github.com/idmdakhi)
