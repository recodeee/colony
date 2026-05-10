#!/usr/bin/env bash
# Publish the public Colony CLI package from the private monorepo root.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export npm_config_cache="${COLONY_NPM_CACHE:-${TMPDIR:-/tmp}/colony-npm-cache}"

cd "$REPO"
pnpm build
pnpm --filter colonyq stage-publish

cd "$REPO/apps/cli"
npm publish --access public "$@"
