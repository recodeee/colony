## Why

Colony is the primary coordination store, but transition-era OMX resume flows still read `.omx/notepad.md`. Working notes should keep their full body in Colony and leave only a compact pointer in OMX when the bridge is explicitly enabled.

## What Changes

- Preserve the optional `bridge.writeOmxNotepadPointer` setting and verify it can be enabled.
- Keep `task_note_working` as the primary Colony write path.
- Write only pointer fields to `.omx/notepad.md` when configured or when explicit no-active-task fallback is requested.
- Cap pointer values so long logs or proof bodies cannot be copied into OMX notepad.

## Impact

OMX remains useful for resume breadcrumbs without becoming a second full working-note store.
