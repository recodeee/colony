# Compression spec

colony compresses prose deterministically and offline. The engine never invokes a model. Its contract is:

1. **Deterministic.** `compress(x)` always returns the same output for the same input and intensity.
2. **Technical tokens are preserved byte-for-byte.** The tokenizer identifies code, URLs, paths, commands, version numbers, dates, numeric literals, and identifier-like tokens. These segments are held out of every transformation.
3. **Round-trippable on substance.** `expand(compress(x))` preserves every technical token exactly. Prose content is lossy on filler and hedging words by design.

## Token-saving invariants

Compression is write-path infrastructure, not generation.

- Compression must be deterministic for the same input and `compression_intensity`.
- The write path must not call an LLM. `MemoryStore` may redact, tokenize, compress, and persist; remote model calls do not belong in that path.
- Technical tokens must survive byte-for-byte through compression and expansion.
- Loss is allowed only in prose filler, hedges, pleasantries, articles, and approved abbreviations.
- Token counts must use stable local estimation so savings are comparable across runs.

Protected token categories:

- commands
- paths
- URLs
- dates
- versions
- code fences
- branch names
- PR URLs
- OpenSpec row IDs

### Future token receipts

When compression receipts are added, record them as metadata next to the observation or summary without changing the compressed content:

- `tokens_before`
- `tokens_after`
- `saved_tokens`
- `saved_ratio`
- `compression_intensity`

Receipts must be computed locally from the same stable counter used for comparisons. `saved_tokens` is `tokens_before - tokens_after`; `saved_ratio` is the saved share of `tokens_before`.

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
