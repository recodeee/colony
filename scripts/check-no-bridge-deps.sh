#!/usr/bin/env bash
# Guard the hand-ported bridge patterns from becoming runtime dependencies.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

BRIDGE_RULE="Patterns are ported by hand; the upstream packages are off-limits at the import boundary."
BRIDGE_PACKAGES='agentic-flow|ruvector|@ruvector/[^'"'"'"]+'
STATUS=0

report_hit() {
  local hit="$1"
  local kind="$2"

  if [[ $STATUS -eq 0 ]]; then
    printf 'Bridge dependency guard failed.\n' >&2
    printf 'Rule: %s\n' "$BRIDGE_RULE" >&2
  fi
  printf '%s: %s\n' "$kind" "$hit" >&2
  STATUS=1
}

while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  report_hit "$hit" "workspace manifest"
done < <(
  rg -n --glob 'package.json' \
    --glob '!docs/**' \
    --glob '!openspec/**' \
    --glob '!examples/**' \
    --glob '!evals/**' \
    '"(agentic-flow|ruvector|@ruvector/[^"]+)"[[:space:]]*:' \
    package.json packages apps 2>/dev/null || true
)

while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  report_hit "$hit" "runtime import"
done < <(
  rg -n --type-add 'source:*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}' --type source \
    --glob '!**/dist/**' \
    --glob '!**/build/**' \
    --glob '!**/coverage/**' \
    --glob '!**/node_modules/**' \
    -e "^[[:space:]]*import[[:space:]]+(type[[:space:]]+)?([^'\";]+[[:space:]]+from[[:space:]]*)?['\"]($BRIDGE_PACKAGES)['\"]" \
    -e "^[[:space:]]*export[[:space:]]+[^'\";]+[[:space:]]+from[[:space:]]*['\"]($BRIDGE_PACKAGES)['\"]" \
    -e "(require|import)[[:space:]]*\\([[:space:]]*['\"]($BRIDGE_PACKAGES)['\"][[:space:]]*\\)" \
    -e "require\\.resolve[[:space:]]*\\([[:space:]]*['\"]($BRIDGE_PACKAGES)['\"][[:space:]]*\\)" \
    apps packages 2>/dev/null || true
)

if [[ $STATUS -ne 0 ]]; then
  printf '\nRemove the upstream bridge package from runtime imports/dependencies. Research references are allowed only under docs/, openspec/, examples/, and evals/.\n' >&2
fi

exit "$STATUS"
