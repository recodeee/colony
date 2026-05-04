---
"@colony/hooks": patch
---

Update three `runner.test.ts` post-tool-use assertions that drifted out of sync with the new metadata shape from the lifecycle-mutation work — `MemoryStore.addObservation` enriches every metadata blob with compression telemetry (`compression_intensity`, `tokens_*`, `saved_*`) and the post-tool-use handler attaches `path_extraction_*` warnings when no claimable path is found, so the original `toEqual` assertions failed even though handler behavior was correct. Tests now use `toMatchObject` for the contract under test, with explicit `not.toHaveProperty` guards on `file_path`/`file_paths`/`extracted_paths` to preserve the "skips pseudo file paths" intent.
