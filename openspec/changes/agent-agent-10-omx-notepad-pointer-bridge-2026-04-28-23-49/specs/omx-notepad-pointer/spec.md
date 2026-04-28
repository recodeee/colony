## ADDED Requirements

### Requirement: Working Notes May Write Tiny OMX Resume Pointers

Colony SHALL keep `task_note_working` as the primary working-note write path and MAY append a compact pointer to `.omx/notepad.md` only when the bridge is enabled or explicit fallback is requested.

#### Scenario: Enabled successful Colony note

- **GIVEN** `bridge.writeOmxNotepadPointer` is enabled
- **AND** `task_note_working` resolves exactly one active Colony task
- **WHEN** the note is posted
- **THEN** Colony stores the full working note as a task note
- **AND** appends only `branch`, `task`, `blocker`, `next`, `evidence`, and `colony_observation_id` to `.omx/notepad.md`

#### Scenario: No active task fallback

- **GIVEN** no active Colony task matches the caller
- **AND** `allow_omx_notepad_fallback` is true
- **AND** `repo_root` is supplied
- **WHEN** `task_note_working` runs
- **THEN** it writes a compact OMX pointer
- **AND** reports `status: omx_notepad_fallback`

#### Scenario: Pointer stays compact

- **WHEN** pointer fields contain long text, semicolons, or newlines
- **THEN** the `.omx/notepad.md` pointer normalizes them to one-line fields
- **AND** caps each field so full logs or proof bodies are not duplicated
