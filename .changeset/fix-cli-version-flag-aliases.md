---
"@imdeadpool/colony-cli": patch
---

Fix `colony --version` (and `-V`) regression introduced by PR #372.

Commander's `.version(str, flags)` accepts only one short + one long flag in the spec; the original `'-v, -V, --version'` triple silently dropped the trailing entries, so `colony --version` was rejected as an unknown option (caught by `scripts/e2e-publish.sh` check #6). The flag is now registered as the canonical `-V, --version`, and `-v` is canonicalized to `-V` in argv at the bin entrypoint so the lowercase shorthand still works.
