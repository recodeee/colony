# Proposal

## Why

PreToolUse is the claim-before-edit gate, but Bash and apply_patch can mutate
files without the direct file_path metadata that Edit/Write provide. Without
early extracted paths, the bridge cannot reliably claim those files before the
tool runs.

## What

- Extract claimable Bash write paths before execution for redirects, sed/perl
  in-place edits, and tee outputs.
- Extract apply_patch target paths from patch headers and sanitized lifecycle
  path arrays.
- Filter pseudo paths and command/code fragments before claims.
- Surface extracted_paths on PreToolUse hook results and lifecycle audit
  metadata.
- Add focused parser, hook, lifecycle, and contract tests.

## Impact

Bash and apply_patch PreToolUse events now expose the same claimable path
surface as direct edit tools, while existing file_path compatibility behavior
remains intact.
