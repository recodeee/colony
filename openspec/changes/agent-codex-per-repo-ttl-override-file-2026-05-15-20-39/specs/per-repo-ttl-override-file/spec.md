## ADDED Requirements

### Requirement: Per-repo TTL override discovery and display
The system SHALL discover a checked-in `.colony/ttl.yaml` file from the nearest
git repo root and expose effective TTL values without modifying the global
settings schema.

#### Scenario: Effective TTL config merges repo overrides over settings
- **WHEN** `.colony/ttl.yaml` contains supported TTL keys
- **THEN** the loader returns the repo override path and parsed values
- **AND** effective TTL config uses repo values for overridden keys and settings values for all others.

#### Scenario: CLI displays effective TTL config
- **WHEN** `colony config ttl --cwd <repo> --json` runs for a repo with `.colony/ttl.yaml`
- **THEN** the JSON payload includes effective TTL values
- **AND** the payload identifies the override file and overridden keys.

#### Scenario: Settings schema remains unchanged
- **WHEN** per-repo TTL overrides are added
- **THEN** `SettingsSchema` is not extended with TTL override-file fields.
