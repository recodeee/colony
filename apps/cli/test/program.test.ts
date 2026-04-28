import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/index.js';

describe('Colony CLI program', () => {
  it('registers the stable top-level commands users rely on', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    const expected = [
      'bridge',
      'coordination',
      'doctor',
      'foraging',
      'health',
      'hook',
      'inbox',
      'install',
      'mcp',
      'note',
      'observe',
      'plan',
      'queen',
      'reindex',
      'search',
      'start',
      'status',
      'stop',
      'suggest',
      'viewer',
    ].sort();
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('keeps help output reviewable without making command registration brittle', () => {
    const program = createProgram();
    expect(program.helpInformation()).toMatchInlineSnapshot(`
      "Usage: colony [options] [command]

      Cross-agent persistent memory with compressed storage.

      Options:
        -V, --version                       output the version number
        -h, --help                          display help for command

      Commands:
        install [options]                   Register hooks + MCP server for an IDE
        uninstall [options]                 Remove IDE integration
        status                              Show colony wiring, data, and worker
                                            state
        health [options]                    Show Colony adoption ratios from local DB
                                            evidence
        config                              View or edit colony settings
        doctor                              Run health checks
        start                               Start the worker daemon (embeddings +
                                            viewer)
        stop                                Stop the worker daemon
        restart                             Restart the worker daemon
        viewer                              Open the memory viewer in your browser
                                            (auto-starts worker)
        worker                              Manage local worker daemon
        mcp                                 Run the MCP stdio server (typically
                                            invoked by the IDE)
        bridge                              OMX/HUD bridge helpers for compact Colony
                                            status
        search [options] <query>            Query memory from the terminal
        suggest [options] <description...>  Suggest an approach from similar past
                                            task history
        compress [options] <file>           Compress a file in place (.original
                                            backup created)
        expand <file>                       Expand abbreviations in a file
        coordination                        Inspect biological coordination signals
        export <out>                        Export memory to JSONL
        import <in>                         Import memory from JSONL
        hook                                Internal: hook handler entrypoints
        reindex                             Rebuild FTS index
        backfill                            Heal historical rows that predate newer
                                            inference logic.
        note [options] <text...>            Record a timestamped scratch note into
                                            the memory timeline
        observe [options]                   Live dashboard of collaboration state.
                                            Run in a spare terminal during a session.
        plan                                Create and operate OpenSpec-like Colony
                                            plan workspaces
        debrief [options]                   End-of-day collaboration post-mortem over
                                            structured DB evidence.
        inbox [options]                     Compact list of attention items for a
                                            session: pending handoffs, wakes, stalled
                                            lanes, recent claims, stale claim
                                            signals, hot files
        foraging                            Index and query <repo_root>/examples food
                                            sources
        queen                               Queen coordination helpers for published
                                            plan lanes
        help [command]                      display help for command
      "
    `);
  });

  it('the install command accepts --ide', () => {
    const program = createProgram();
    const install = program.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    const ide = install?.options.find((o) => o.long === '--ide');
    expect(ide?.defaultValue).toBe('claude-code');
  });

  it('exposes a hook subcommand with a `run` action', () => {
    const program = createProgram();
    const hook = program.commands.find((c) => c.name() === 'hook');
    expect(hook).toBeDefined();
    expect(hook?.commands.map((c) => c.name())).toContain('run');
  });

  it('exposes debrief JSON output for worker rendering', () => {
    const program = createProgram();
    const debrief = program.commands.find((c) => c.name() === 'debrief');
    expect(debrief).toBeDefined();
    expect(debrief?.options.find((o) => o.long === '--json')).toBeDefined();
  });

  it('exposes health JSON output for dashboards and agents', () => {
    const program = createProgram();
    const health = program.commands.find((c) => c.name() === 'health');
    expect(health).toBeDefined();
    expect(health?.options.find((o) => o.long === '--json')).toBeDefined();
    expect(health?.options.find((o) => o.long === '--prompts')).toBeDefined();
  });

  it('advertises a semantic version', () => {
    const program = createProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes foraging scan/list/clear subcommands', () => {
    const program = createProgram();
    const foraging = program.commands.find((c) => c.name() === 'foraging');
    expect(foraging).toBeDefined();
    const subs = foraging?.commands.map((c) => c.name()).sort() ?? [];
    expect(subs).toEqual(['clear', 'list', 'scan']);
    const scan = foraging?.commands.find((c) => c.name() === 'scan');
    expect(scan?.options.find((o) => o.long === '--cwd')).toBeDefined();
    const clear = foraging?.commands.find((c) => c.name() === 'clear');
    expect(clear?.options.find((o) => o.long === '--example')).toBeDefined();
  });

  it('exposes queen sweep with dry-run and auto-message controls', () => {
    const program = createProgram();
    const queen = program.commands.find((c) => c.name() === 'queen');
    expect(queen).toBeDefined();
    expect(queen?.commands.map((c) => c.name()).sort()).toEqual([
      'list',
      'plan',
      'status',
      'sweep',
    ]);
    const plan = queen?.commands.find((c) => c.name() === 'plan');
    expect(plan?.options.find((o) => o.long === '--file')).toBeDefined();
    expect(plan?.options.find((o) => o.long === '--json')).toBeDefined();
    expect(plan?.options.find((o) => o.long === '--dry-run')).toBeDefined();
    const sweep = queen?.commands.find((c) => c.name() === 'sweep');
    expect(sweep).toBeDefined();
    expect(sweep?.options.find((o) => o.long === '--dry-run')).toBeDefined();
    expect(sweep?.options.find((o) => o.long === '--auto-message')).toBeDefined();
  });

  it('exposes plan create/status/publish/close subcommands', () => {
    const program = createProgram();
    const plan = program.commands.find((c) => c.name() === 'plan');
    expect(plan).toBeDefined();
    expect(plan?.commands.map((c) => c.name()).sort()).toEqual([
      'close',
      'create',
      'publish',
      'status',
    ]);
  });
});
