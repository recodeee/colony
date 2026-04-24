#!/usr/bin/env bash
# Portable stub for the SessionStart hook. Pipes the JSON event into the CLI.
exec colony hook run session-start
