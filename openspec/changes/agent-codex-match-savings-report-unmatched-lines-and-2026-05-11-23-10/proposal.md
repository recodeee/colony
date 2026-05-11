## Why

- `colony gain` left `savings_report` and `task_list` in unmatched live operations even though both are Colony MCP coordination surfaces with existing reference-model equivalents.
- Generated reflexion summaries could throw when a plan/branch/path-derived summary exceeded the 240-character metadata limit, creating avoidable future MCP errors.

## What Changes

- Map `task_list` live calls into the existing Ready-work selection reference row.
- Map `savings_report` live calls into the existing Health/adoption diagnosis reference row.
- Clamp generated reflexion short-text fields to their configured maximum instead of throwing for overlong generated text.
- Add focused regressions for the alias mapping and long generated reflexion summary handling.

## Impact

- Affected surfaces: `@colony/core` savings reference model and reflexion metadata builder, plus CLI gain tests.
- Risk is narrow: alias-only savings totals change for those operations, and overlong reflexion fields are truncated with `...`.
