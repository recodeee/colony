import { z } from 'zod';

export const CompressionIntensity = z.enum(['lite', 'full', 'ultra']);
export type CompressionIntensity = z.infer<typeof CompressionIntensity>;

export const EmbeddingProvider = z.enum(['local', 'ollama', 'openai', 'none']);
export type EmbeddingProvider = z.infer<typeof EmbeddingProvider>;

export const NotifyProvider = z.enum(['desktop', 'none']);
export type NotifyProvider = z.infer<typeof NotifyProvider>;

export const NotifyLevel = z.enum(['info', 'warn', 'error']);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

export const BridgePolicyMode = z.enum(['warn', 'block-on-conflict', 'audit-only']);
export type BridgePolicyMode = z.infer<typeof BridgePolicyMode>;

export const DEFAULT_PROTECTED_FILES = [
  'packages/storage/src/storage.ts',
  'packages/storage/src/schema.ts',
  'packages/storage/src/types.ts',
  'apps/cli/src/commands/health.ts',
  'apps/cli/test/health.test.ts',
  'packages/hooks/src/auto-claim.ts',
] as const;

export const SettingsSchema = z
  .object({
    dataDir: z
      .string()
      .default('~/.colony')
      .describe('Where colony stores its SQLite database, models, pidfile, and logs.'),
    workerPort: z
      .number()
      .int()
      .positive()
      .default(37777)
      .describe('Port the local worker binds to on 127.0.0.1.'),
    logLevel: z
      .enum(['debug', 'info', 'warn', 'error'])
      .default('info')
      .describe('Minimum log level emitted by the worker and hook handlers.'),
    fileHeatHalfLifeMinutes: z
      .number()
      .int()
      .positive()
      .default(30)
      .describe('Minutes for file activity heat to decay by half on read-side context surfaces.'),
    claimStaleMinutes: z
      .number()
      .int()
      .positive()
      .default(240)
      .describe('Minutes before a file claim is downgraded from active ownership to stale/weak.'),
    coordinationSweepIntervalMinutes: z
      .number()
      .int()
      .nonnegative()
      .default(60)
      .describe(
        'Minutes between automatic coordination-sweep passes in the worker. Each pass downgrades stale claims and releases expired quota-pending claims so health metrics self-heal without manual intervention. Set to 0 to disable.',
      ),
    runtime: z
      .object({
        activeSessionReconcileMinIntervalMs: z
          .number()
          .int()
          .nonnegative()
          .default(5_000)
          .describe(
            'Minimum milliseconds between active-session reconciliation scans inside one MCP server process. Set to 0 to reconcile on every tool call.',
          ),
      })
      .default({ activeSessionReconcileMinIntervalMs: 5_000 })
      .describe('Runtime load-shedding controls for multi-agent coordination surfaces.'),
    rejectProtectedBranchClaims: z
      .boolean()
      .default(true)
      .describe(
        'If true, MCP task_claim_file rejects claims targeting tasks bound to protected branches (main/master/dev). Override per-call with the COLONY_ALLOW_PROTECTED_CLAIM=1 env var. Set to false to restore the historical soft-warning behavior.',
      ),
    protected_files: z
      .array(z.string().min(1))
      .default([...DEFAULT_PROTECTED_FILES])
      .describe(
        'Repo-relative high-risk files that require PROTECTED_FILE_CONTENTION escalation when multiple live sessions contend for them.',
      ),
    compression: z
      .object({
        intensity: CompressionIntensity.default('full').describe(
          'Caveman grammar intensity. lite ≈ 30% savings, full ≈ 60%, ultra ≈ 75%.',
        ),
        expandForModel: z
          .boolean()
          .default(false)
          .describe('If true, MCP get_observations returns expanded text; if false, compressed.'),
      })
      .default({ intensity: 'full', expandForModel: false })
      .describe('Write-path compression settings.'),
    embedding: z
      .object({
        provider: EmbeddingProvider.default('local').describe(
          'Embedding provider: local (Transformers.js, default), ollama, openai, or none.',
        ),
        model: z
          .string()
          .default('Xenova/all-MiniLM-L6-v2')
          .describe(
            'Embedding model id. Switching models clears existing vectors and re-embeds on next worker start.',
          ),
        endpoint: z.string().optional().describe('Remote endpoint for ollama / openai providers.'),
        apiKey: z.string().optional().describe('API key for remote providers.'),
        batchSize: z
          .number()
          .int()
          .positive()
          .default(16)
          .describe('How many observations the worker embeds per backfill batch.'),
        autoStart: z
          .boolean()
          .default(true)
          .describe(
            'If true, hooks detach-spawn the worker when it is not running so embeddings happen without manual start.',
          ),
        idleShutdownMs: z
          .number()
          .int()
          .positive()
          .default(600_000)
          .describe(
            'Milliseconds the worker stays idle (no embed work, no viewer traffic) before self-exiting.',
          ),
      })
      .default({
        provider: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        batchSize: 16,
        autoStart: true,
        idleShutdownMs: 600_000,
      })
      .describe('Embedding / vector search settings.'),
    search: z
      .object({
        alpha: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe('Hybrid rank weight: 0 = pure BM25, 1 = pure cosine, 0.5 = balanced.'),
        defaultLimit: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe('Default number of hits returned when no limit is given.'),
      })
      .default({ alpha: 0.5, defaultLimit: 10 })
      .describe('Search ranking defaults.'),
    privacy: z
      .object({
        excludePatterns: z
          .array(z.string())
          .default([])
          .describe('Glob patterns; matching paths are never read or stored.'),
        redactSecrets: z
          .boolean()
          .default(true)
          .describe('Strip content inside <private>…</private> tags before compression.'),
      })
      .default({ excludePatterns: [], redactSecrets: true })
      .describe('Privacy / redaction.'),
    ides: z
      .record(z.string(), z.boolean())
      .default({})
      .describe('Installed IDE integrations (set by `colony install`).'),
    notify: z
      .object({
        provider: NotifyProvider.default('none').describe(
          'Desktop notification provider. desktop = native (osascript on macOS, notify-send on Linux); none = silent. Default off so colony is unobtrusive on a fresh install.',
        ),
        minLevel: NotifyLevel.default('warn').describe(
          'Drop messages below this level. error surfaces only failures; warn includes degraded states like a missing embedder.',
        ),
      })
      .default({ provider: 'none', minLevel: 'warn' })
      .describe(
        'Background notifications. The worker uses this to surface conditions you would otherwise only see by reading stderr or running `colony status`.',
      ),
    bridge: z
      .object({
        writeOmxNotepadPointer: z
          .boolean()
          .default(false)
          .describe(
            'If true, successful Colony working-note writes append a tiny pointer to <repo>/.omx/notepad.md for transition-era OMX resume flows.',
          ),
        policyMode: BridgePolicyMode.default('warn').describe(
          'Claim-before-edit bridge policy: warn surfaces Colony warnings and continues; block-on-conflict denies only strong active claim conflicts; audit-only records telemetry silently.',
        ),
      })
      .default({ writeOmxNotepadPointer: false, policyMode: 'warn' })
      .describe(
        'Transition bridge settings between Colony-native coordination and legacy OMX state.',
      ),
    foraging: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Auto-index <repo_root>/examples food sources on SessionStart.'),
        maxDepth: z
          .number()
          .int()
          .positive()
          .max(5)
          .default(2)
          .describe('How deep to walk into each example directory.'),
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .default(200_000)
          .describe('Truncate indexed files larger than this.'),
        maxFilesPerSource: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe('Stop indexing after this many files per example.'),
        scanOnSessionStart: z
          .boolean()
          .default(true)
          .describe('Fire-and-forget the scanner when SessionStart fires.'),
        sessionStartScanMinIntervalMs: z
          .number()
          .int()
          .nonnegative()
          .default(300_000)
          .describe(
            'Minimum milliseconds between automatic SessionStart foraging scans for the same cwd. Set to 0 to scan on every SessionStart.',
          ),
        proposalHalfLifeMinutes: z
          .number()
          .positive()
          .default(60)
          .describe(
            'Minutes before a proposal reinforcement contributes half its original strength.',
          ),
        proposalNoiseFloor: z
          .number()
          .nonnegative()
          .default(0.3)
          .describe('Pending proposals below this decayed strength are omitted from foraging.'),
        promotionThreshold: z
          .number()
          .positive()
          .default(2.5)
          .describe('Decayed proposal strength required to auto-promote into a task.'),
        extraSecretEnvNames: z
          .array(z.string())
          .default([])
          .describe('Additional env-var names to treat as secrets during redaction.'),
      })
      .default({
        enabled: true,
        maxDepth: 2,
        maxFileBytes: 200_000,
        maxFilesPerSource: 50,
        scanOnSessionStart: true,
        sessionStartScanMinIntervalMs: 300_000,
        proposalHalfLifeMinutes: 60,
        proposalNoiseFloor: 0.3,
        promotionThreshold: 2.5,
        extraSecretEnvNames: [],
      })
      .describe('Foraging: turn <repo_root>/examples into a reusable food source.'),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
