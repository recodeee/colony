import type { Command } from 'commander';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run the MCP stdio server (typically invoked by the IDE)')
    .action(async () => {
      const { main } = await import('@colony/mcp-server');
      await main();
    });
}
