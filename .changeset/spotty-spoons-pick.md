---
'colonyq': patch
---

Surface hot-loop dominance and drop double-"saved" labels in `colony gain`.
Top spend now reports the operation's share of total tokens, and a `Hot loop:`
callout fires when one operation owns ≥70% of token spend across ≥100 calls.
The "Saved:" / "USD saved:" labels are renamed to "Net:" / "Net USD:" so the
phrase no longer reads "Saved: X saved", and the live sessions header drops the
trailing `, -` when cost isn't configured.
