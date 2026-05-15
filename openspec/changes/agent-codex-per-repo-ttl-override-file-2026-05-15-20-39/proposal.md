## Why

Repo teams need short, reviewable coordination TTL overrides without changing
global `settings.json` or expanding the existing settings schema. A checked-in
`.colony/ttl.yaml` lets a repo document claim stale windows and sweep cadence
next to project policy, while the CLI can show the effective values before a
human or daemon relies on them.

## What Changes

- Add `packages/config/src/ttl-override.ts` to discover and parse
  `.colony/ttl.yaml` from the nearest git repo root.
- Merge supported TTL override keys over existing settings for display only.
- Add `colony config ttl` with `--cwd` and `--json` to print effective TTL
  values and their override source.

## Impact

- No `SettingsSchema` changes.
- Supported override keys are `fileHeatHalfLifeMinutes`, `claimStaleMinutes`,
  and `coordinationSweepIntervalMinutes` with snake-case and kebab-case aliases.
- This change exposes effective TTL config; consumers can adopt the loader in a
  later behavior change.
