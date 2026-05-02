import { claudeCode } from './claude-code.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { geminiCli } from './gemini-cli.js';
import { openCode } from './opencode.js';
import type { Installer } from './types.js';

export type IdeName = 'claude-code' | 'gemini-cli' | 'opencode' | 'codex' | 'cursor';

export const installers: Record<IdeName, Installer> = {
  'claude-code': claudeCode,
  'gemini-cli': geminiCli,
  opencode: openCode,
  codex,
  cursor,
};

export function getInstaller(name: string): Installer {
  const found = installers[name as IdeName];
  if (!found) throw new Error(`Unknown IDE: ${name}. Known: ${Object.keys(installers).join(', ')}`);
  return found;
}

export type {
  Installer,
  InstallContext,
  InstallValidationIssue,
  InstallValidationResult,
} from './types.js';
