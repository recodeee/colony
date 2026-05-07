# Pre-baked policy snippets

Drop-in `~/.colony/settings.json` patches for common stacks. Each file is a
fragment, not a full settings file — copy the fields you want into your
existing `~/.colony/settings.json` (or merge with `jq`).

| File                       | When to use                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`nextjs-monorepo.json`](nextjs-monorepo.json) | pnpm/npm workspaces with a Next.js app: ignores `.next/`, `node_modules/`, build output; protects `next.config.*` and lockfiles. |
| [`python-package.json`](python-package.json)   | Poetry / uv / pip-tools projects: ignores `__pycache__/`, `.venv/`, `dist/`; protects `pyproject.toml` and the lockfile. |
| [`rust-workspace.json`](rust-workspace.json)   | Cargo workspace: ignores `target/`, `.cargo/`, generated `bindings/`; protects `Cargo.toml` and `Cargo.lock` at every level. |

## How to apply

If `~/.colony/settings.json` doesn't exist yet, copy the snippet wholesale:

```bash
mkdir -p ~/.colony
cp examples/policies/rust-workspace.json ~/.colony/settings.json
```

If it already exists, merge with `jq`:

```bash
jq -s '.[0] * .[1]' ~/.colony/settings.json examples/policies/nextjs-monorepo.json \
  > ~/.colony/settings.json.next \
  && mv ~/.colony/settings.json.next ~/.colony/settings.json
```

The merge is shallow — `privacy.excludePatterns` and `protected_files` are
arrays and `*` will replace them, not concatenate. If you want to preserve
existing entries, hand-merge those two fields.

## What the fields mean

- **`privacy.excludePatterns`** — glob patterns. Files whose path matches any
  pattern are never read or stored by colony. Use this for build output,
  caches, `.env`, and anything you wouldn't paste into a shared chat.
- **`protected_files`** — repo-relative high-risk files. When two live
  sessions contend for one of these, colony escalates from a normal claim
  conflict to `PROTECTED_FILE_CONTENTION`, which surfaces in `colony health`
  and `attention_inbox`. Lockfiles and root config files are the usual
  candidates.

Run `colony config show` after merging to confirm the settings parsed
cleanly, and `colony doctor` to see the resolved values.
