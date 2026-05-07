# CLI And Skill Install Onboarding

## Problem

The README exposed `npm install -g @imdeadpool/colony-cli` and
`colony install --ide codex`, but did not give users the Higgsfield-style path
for CLI install, MCP wiring, and agent skill installation in one short flow.

## Change

- Add a `skills/colony-mcp` Codex skill for the Colony MCP coordination loop.
- Document `npx skills add recodeee/colony/skills/colony-mcp` beside the CLI
  and MCP install commands.
- Print the skill install command after `colony install` so CLI users discover
  the skill path without rereading the README.

## Acceptance

- A user can see the three install surfaces: CLI, MCP, and Skill.
- The skill contains no template TODOs and tells agents when to use Colony MCP.
- CLI tests pin the install commands so the public quickstart does not drift.

## Verification

- `pnpm --filter @imdeadpool/colony-cli test -- program.test.ts`: 15 passed.
- `pnpm --filter @imdeadpool/colony-cli typecheck`: passed.
- `pnpm exec biome check README.md apps/cli/src/commands/install.ts apps/cli/test/program.test.ts skills/colony-mcp/SKILL.md skills/colony-mcp/agents/openai.yaml openspec/changes/agent-codex-colony-cli-skill-install-onboarding-2026-05-07-20-34/colony-spec.md`: passed for recognized files.
- `openspec validate --specs`: 2 passed, 0 failed.
- `git diff --check`: passed.
- `awk` frontmatter smoke check on `skills/colony-mcp/SKILL.md`: passed.
- `quick_validate.py skills/colony-mcp`: blocked because this Python environment lacks `yaml` / PyYAML.
