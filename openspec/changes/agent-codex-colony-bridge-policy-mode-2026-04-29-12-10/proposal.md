# Add configurable Colony bridge policy modes

Colony's claim-before-edit bridge is currently advisory in one hardcoded way.
Repos need a local policy choice so the same hook can warn, block only real
active claim conflicts, or run silently as audit telemetry.

## Scope

- Add a settings schema field for bridge policy mode with default `warn`.
- Let hook/runtime bridge code read repo-local `.colony/settings.json` over local defaults.
- Keep PreToolUse non-blocking unless policy is `block-on-conflict` and a strong active claim is owned by another session.
- Preserve audit telemetry for all modes.

## Out of scope

- MCP availability as a blocking dependency.
- PostToolUse late claims counting as true claim-before-edit coverage.
- New external dependencies.
