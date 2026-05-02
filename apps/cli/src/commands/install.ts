import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  defaultSettings,
  loadSettings,
  resolveDataDir,
  saveSettings,
  settingsPath,
} from '@colony/config';
import {
  type IdeName,
  type InstallValidationIssue,
  getInstaller,
  installers,
} from '@colony/installers';
import type { Command } from 'commander';
import kleur from 'kleur';
import { resolveCliPath } from '../util/resolve.js';

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Register hooks + MCP server for an IDE')
    .option('--ide <name>', 'IDE to target', 'claude-code')
    .option('--verify', 'validate the IDE integration without writing config')
    .action(async (opts: { ide: string; verify?: boolean }) => {
      const name = opts.ide as IdeName;
      if (!installers[name]) {
        throw new Error(
          `Unknown --ide ${opts.ide}. Choices: ${Object.keys(installers).join(', ')}`,
        );
      }
      const path = settingsPath();
      if (!opts.verify && !existsSync(path)) {
        saveSettings(defaultSettings);
        process.stdout.write(`${kleur.dim('wrote')} ${path}\n`);
      }
      const settings = loadSettings();
      const ctx = {
        ideConfigDir: homedir(),
        cliPath: resolveCliPath(),
        nodeBin: process.execPath,
        dataDir: resolveDataDir(settings.dataDir),
      };
      const installer = getInstaller(name);
      if (opts.verify) {
        if (!installer.verify) {
          throw new Error(`Installer ${name} does not support --verify`);
        }
        const result = await installer.verify(ctx);
        for (const m of result.messages) process.stdout.write(`${kleur.green('✓')} ${m}\n`);
        for (const issue of result.issues) writeValidationIssue(issue);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const msgs = await installer.install(ctx);
      for (const m of msgs) process.stdout.write(`${kleur.green('✓')} ${m}\n`);
      settings.ides[name] = true;
      saveSettings(settings);

      const model = settings.embedding.model;
      const provider = settings.embedding.provider;

      process.stdout.write(`\n${kleur.bold('colony is wired into')} ${kleur.cyan(name)}\n`);
      process.stdout.write(
        `${kleur.dim('memory writes happen in hooks — no daemon required on the hot path.')}\n\n`,
      );
      process.stdout.write(`${kleur.bold('what to try next:')}\n`);
      process.stdout.write(
        `  ${kleur.cyan('colony status')}        show wiring + embedding backfill\n`,
      );
      process.stdout.write(`  ${kleur.cyan('colony viewer')}        open the memory viewer\n`);
      process.stdout.write(
        `  ${kleur.cyan('colony search "…"')}    query your memory from the terminal\n`,
      );
      process.stdout.write(`  ${kleur.cyan('colony config show')}   see settings + docs\n\n`);

      if (provider === 'local') {
        process.stdout.write(
          `${kleur.dim(
            `embeddings: local ${model} — weights (~25 MB) download to ${ctx.dataDir}/models on first use.`,
          )}\n`,
        );
      } else if (provider === 'none') {
        process.stdout.write(
          `${kleur.yellow('embeddings: disabled')} (provider=none). enable with \`colony config set embedding.provider local\`.\n`,
        );
      } else {
        process.stdout.write(
          `${kleur.dim(`embeddings: ${provider} / ${model} — configure endpoint/apiKey via \`colony config\`.`)}\n`,
        );
      }
    });
}

function writeValidationIssue(issue: InstallValidationIssue): void {
  process.stderr.write(`${kleur.red('✗')} ${issue.file}: ${issue.message}\n`);
  if (issue.missingHooks?.length) {
    process.stderr.write(`  missing hooks: ${issue.missingHooks.join(', ')}\n`);
  }
  if (issue.staleHooks?.length) {
    process.stderr.write(`  stale hooks: ${issue.staleHooks.join(', ')}\n`);
  }
  if (issue.missingMcpServers?.length) {
    process.stderr.write(`  missing MCP servers: ${issue.missingMcpServers.join(', ')}\n`);
  }
}
