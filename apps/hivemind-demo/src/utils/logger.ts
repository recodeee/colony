import type { HivemindLogger } from '../core/types.js';

export function createLogger(verbose = true): HivemindLogger {
  return {
    info(message: string): void {
      if (!verbose) return;
      console.log(`[hivemind] ${message}`);
    },
  };
}
