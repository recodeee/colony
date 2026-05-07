---
base_root_hash: 3bfe1540
slug: bump-colony-cli-patch-release-for-npm-pu
---

# CHANGE · bump-colony-cli-patch-release-for-npm-pu

## §P  proposal
# Bump Colony CLI release for npm publish

## Problem

Prepare @imdeadpool/colony-cli for the next unpublished npm release with matching release notes so the maintainer can publish.

## Acceptance criteria

- @imdeadpool/colony-cli version is bumped to the next Changesets-computed version above npm latest.
- Release notes/changelog describe the publishable package change for that version.
- Package artifacts are dry-run verified for npm publish readiness.
- Changes are committed on an agent branch with PR-ready evidence.

## Sub-tasks

### Sub-task 0: Update release metadata

Update workspace release manifests, changelogs, and public release notes for Bump Colony CLI release for npm publish.

File scope: apps/cli/package.json, apps/cli/CHANGELOG.md, workspace package manifests/changelogs, README.md, .changeset

### Sub-task 1: Verify publish readiness (depends on: 0)

Verify the release metadata and public CLI dry-run package for Bump Colony CLI release for npm publish.

File scope: apps/cli/package.json, apps/cli/CHANGELOG.md, workspace package manifests/changelogs, README.md, .changeset


## §S  delta
op|target|row
-|-|-

## §T  tasks
id|status|task|cites
-|-|-|-

## §B  bugs
id|status|task|cites
-|-|-|-
