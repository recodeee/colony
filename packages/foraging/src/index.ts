export { scanExamples, scanExamplesFs } from './scanner.js';
export type { ScanFsOptions, ScanFsResult, ScanOptions } from './scanner.js';
export { extract, readCapped } from './extractor.js';
export type { ExtractedShape } from './extractor.js';
export { indexFoodSource } from './indexer.js';
export type { IndexFoodSourceOptions } from './indexer.js';
export { buildIntegrationPlan } from './integration-plan.js';
export type { BuildIntegrationPlanOptions } from './integration-plan.js';
export { redact } from './redact.js';
export type {
  ExampleManifestKind,
  ForagedFileEntry,
  FoodSource,
  ForagedPattern,
  ForagingSkipReason,
  IntegrationPlan,
  ScanLimits,
  ScanResult,
  SkippedForagedFile,
} from './types.js';
export { DEFAULT_SCAN_LIMITS } from './types.js';
