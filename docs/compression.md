# Compression spec

colony compresses prose deterministically and offline. The engine never invokes a model. Its contract is:

1. **Deterministic.** `compress(x)` always returns the same output for the same input and intensity.
2. **Technical tokens are preserved byte-for-byte.** The tokenizer identifies code, URLs, paths, commands, version numbers, dates, numeric literals, and identifier-like tokens. These segments are held out of every transformation.
3. **Round-trippable on substance.** `expand(compress(x))` preserves every technical token exactly. Prose content is lossy on filler and hedging words by design.

## Token-saving invariants

Compression is write-path infrastructure, not generation. These invariants lock the current token-saving behavior before any behavior changes:

- **Deterministic:** the same input and `compression_intensity` must always produce the same output.
- **Offline on writes:** the write path must not call an LLM. `MemoryStore` may redact, tokenize, compress, and persist; remote model calls do not belong in that path.
- **Technical-token safe:** protected tokens must survive compression and expansion byte-for-byte.
- **Prose-only loss:** loss is allowed only for prose filler, hedges, pleasantries, articles, and approved abbreviations.
- **Stable accounting:** token counts must use the same local estimator so savings remain comparable across runs.

Protected token categories:

| category | examples / notes |
|---|---|
| commands | shell commands and command-like snippets |
| paths | `/tmp/x`, `~/src`, `C:\\repo\\file` |
| URLs | HTTP(S) links, including PR URLs |
| dates | `2026-04-18`, `2026-04-18T09:00` |
| versions | `v1.2.3`, `22.1.0-rc.1` |
| code fences | triple-backtick and tilde fences |
| branch names | `main`, `feature/token-receipts`, `fix/compression-ids` |
| PR URLs | full pull request links must remain intact |
| OpenSpec row IDs | row identifiers used to track OpenSpec entries |

### Future token receipts

When token receipts are added, store the receipt as metadata next to the observation or summary without changing compressed content:

- `tokens_before`: local token estimate before compression
- `tokens_after`: local token estimate after compression
- `saved_tokens`: `tokens_before - tokens_after`
- `saved_ratio`: saved share of `tokens_before`
- `compression_intensity`: intensity used for the write

Receipts must be computed locally from the same stable counter used for comparisons.

## Pipeline

```
input → tokenize → [preserved | prose] → transform prose → join → output
```

### Tokenizer kinds

| kind | examples |
|---|---|
| `fence` | triple-backtick code blocks |
| `inline-code` | `` `x = 1` `` |
| `url` | `https://example.com/...` |
| `path` | `/etc/hosts`, `~/src`, `C:\a\b` |
| `version` | `v1.2.3`, `22.1.0-rc.1` |
| `date` | `2026-04-18`, `2026-04-18T09:00` |
| `number` | `401`, `3.14` |
| `identifier` | `snake_case`, `camelCase`, `kebab-name` |
| `heading` | `# ...`, `## ...` |
| `prose` | everything else |

### Prose transforms (in order)

1. Remove pleasantries, hedges, fillers, and articles (intensity-driven).
2. Apply the abbreviations map (intensity-driven).
3. Collapse whitespace.

### Intensity levels

| level | articles | fillers | hedges | abbreviations |
|---|---|---|---|---|
| `lite` | keep | minimal | keep | minimal |
| `full` | drop | broad | drop | broad |
| `ultra` | drop | aggressive | drop | aggressive (incl. `w/`, `b/c`, `&`) |

## Expansion

`expand` substitutes known abbreviations back to their long form using the `expansions` table in `lexicon.json`. It does not restore dropped words — this is intentional: the stored form has already committed to brevity.

## Guarantees verified by tests

- `compress(x) === compress(x)` for every fixture (determinism).
- Every code block, URL, path, command, date, and version in the input appears verbatim in both `compress(x)` and `expand(compress(x))`.
- Average token reduction on the benchmark corpus is at least 30% (target ≥ 40% at full, ≥ 55% at ultra).

## Extending the lexicon

1. Edit `packages/compress/src/lexicon.json`.
2. Add a fixture under `packages/compress/test/fixtures/` demonstrating the new rule and its round-trip.
3. Run `pnpm --filter @colony/compress test`.
4. Update benchmark numbers in `evals/` if the aggregate savings shifted.
