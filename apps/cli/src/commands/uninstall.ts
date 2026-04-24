import { homedir } from 'node:os';
import { loadSettings, resolveDataDir, saveSettings } from '@colony/config';
import { type IdeName, getInstaller, installers } from '@colony/installers';
import type { Command } from 'commander';
import kleur from 'kleur';
import { resolveCliPath } from '../util/resolve.js';

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove IDE integration')
    .option('--ide <name>', 'IDE to target', 'claude-code')
    .action(async (opts: { ide: string }) => {
      const name = opts.ide as IdeName;
      if (!installers[name]) throw new Error(`Unknown --ide ${opts.ide}`);
      const settings = loadSettings();
      const installer = getInstaller(name);
      const msgs = await installer.uninstall({
        ideConfigDir: homedir(),
        cliPath: resolveCliPath(),
        nodeBin: process.execPath,
        dataDir: resolveDataDir(settings.dataDir),
      });
      for (const m of msgs) process.stdout.write(`${kleur.yellow('·')} ${m}\n`);
      delete settings.ides[name];
      saveSettings(settings);
    });
}
