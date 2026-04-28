# Development

## Prereqs

- Node ≥ 20
- pnpm ≥ 9

## Setup

```bash
pnpm install
pnpm build
```

Link the CLI for local use:

```bash
cd apps/cli && pnpm link --global
colony --help
```

When the linked `colony` binary runs from a source checkout, it rebuilds stale CLI
dist automatically before loading `dist/index.js`. Set `COLONY_SKIP_AUTO_BUILD=1`
to use the current dist without this freshness check.

## Run against a scratch data dir

```bash
export COLONY_HOME=$PWD/.colony-dev
pnpm dev
```

## Gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All four must pass before merging.

## Adding a changeset

```bash
pnpm changeset
```

Commit the generated file with your PR.
