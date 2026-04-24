#!/usr/bin/env node
import { resolve } from 'node:path';
import { HivemindOrchestrator } from '../core/orchestrator.js';
import { createLogger } from '../utils/logger.js';

const DEMO_TASK =
  'Create a local TypeScript CLI that breaks one task into research, build, review, and verify phases, stores JSON run state, and keeps compact checkpoints.';

interface CliOptions {
  task: string;
  dataDir: string;
  maxTurns: number;
  maxRetries: number;
  checkpointInterval: number;
  demo: boolean;
  quiet: boolean;
  help: boolean;
}

main();

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }

    const task = options.demo ? DEMO_TASK : options.task;
    if (!task) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const orchestrator = new HivemindOrchestrator({
      dataDir: options.dataDir,
      maxTurns: options.maxTurns,
      maxRetries: options.maxRetries,
      checkpointInterval: options.checkpointInterval,
      logger: createLogger(!options.quiet),
    });
    const state = orchestrator.run(task);
    const runDir = resolve(options.dataDir, state.runId);

    console.log(`Run: ${state.runId}`);
    console.log(`Status: ${state.status}`);
    console.log(`Run dir: ${runDir}`);
    console.log(`Checkpoints: ${state.checkpoints.length}`);

    if (state.finalResult) {
      console.log(`Result: ${state.finalResult.result}`);
      console.log('Reasoning summary:');
      for (const line of state.finalResult.reasoningSummary) {
        console.log(`- ${line}`);
      }
      console.log('Open risks:');
      for (const line of state.finalResult.openRisks) {
        console.log(`- ${line}`);
      }
      console.log('Next steps:');
      for (const line of state.finalResult.nextSteps) {
        console.log(`- ${line}`);
      }
    } else if (state.blockers.length > 0) {
      console.log('Blockers:');
      for (const blocker of state.blockers) {
        console.log(`- ${blocker}`);
      }
    }

    if (state.status !== 'completed') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const taskParts: string[] = [];
  const options: CliOptions = {
    task: '',
    dataDir: resolve(process.cwd(), 'data', 'runs'),
    maxTurns: 10,
    maxRetries: 1,
    checkpointInterval: 2,
    demo: false,
    quiet: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    switch (arg) {
      case '--data-dir':
        options.dataDir = resolve(readValue(argv, index, '--data-dir'));
        index += 1;
        break;
      case '--max-turns':
        options.maxTurns = readInteger(argv, index, '--max-turns');
        index += 1;
        break;
      case '--max-retries':
        options.maxRetries = readInteger(argv, index, '--max-retries');
        index += 1;
        break;
      case '--checkpoint-interval':
        options.checkpointInterval = readInteger(argv, index, '--checkpoint-interval');
        index += 1;
        break;
      case '--demo':
        options.demo = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        taskParts.push(arg);
        break;
    }
  }

  options.task = taskParts.join(' ').trim();
  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readInteger(argv: string[], index: number, flag: string): number {
  const raw = readValue(argv, index, flag);
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage: colony-hivemind-demo [options] "<task>"`);
  console.log('');
  console.log('Options:');
  console.log('  --demo                    Run the built-in demo task');
  console.log('  --data-dir <path>         Directory for persisted run state');
  console.log('  --max-turns <n>           Maximum total agent turns (default: 10)');
  console.log(
    '  --max-retries <n>         Builder retry budget after review failures (default: 1)',
  );
  console.log('  --checkpoint-interval <n> Create a checkpoint every N steps (default: 2)');
  console.log('  --quiet                   Suppress per-step logs');
  console.log('  --help, -h                Show this usage text');
}
