import path from 'node:path';

const GIT_OPS = new Set(['checkout', 'switch', 'merge', 'rebase', 'reset']);
const FILE_OPS = new Set(['mv', 'rm', 'cp']);
const REDIRECT_OPS = new Set(['>', '>>']);

export type BashCoordinationEvent =
  | {
      kind: 'git-op';
      op: 'checkout' | 'switch' | 'merge' | 'rebase' | 'reset';
      argv: string[];
      segment: string;
    }
  | {
      kind: 'file-op';
      op: 'mv' | 'rm' | 'cp';
      argv: string[];
      file_paths: string[];
      segment: string;
    }
  | {
      kind: 'auto-claim';
      op: 'redirect';
      operator: '>' | '>>';
      file_path: string;
      segment: string;
    };

export interface BashParseOptions {
  cwd?: string | null | undefined;
  repoRoot?: string | null | undefined;
}

interface Token {
  value: string;
  tainted: boolean;
}

export function parseBashCoordinationEvents(
  command: string,
  options: BashParseOptions = {},
): BashCoordinationEvent[] {
  if (!command.trim()) return [];

  const events: BashCoordinationEvent[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const commandTokens = stripRedirects(tokens);
    const argv = commandTokens.filter((token) => !token.tainted).map((token) => token.value);
    const commandEvent = parseCommandEvent(argv, segment, options);
    if (commandEvent) events.push(commandEvent);

    events.push(...parseRedirectEvents(tokens, segment, options));
  }

  return events;
}

function parseCommandEvent(
  argv: string[],
  segment: string,
  options: BashParseOptions,
): BashCoordinationEvent | undefined {
  if (argv.length === 0) return undefined;

  const gitEvent = parseGitEvent(argv, segment);
  if (gitEvent) return gitEvent;

  const fileEvent = parseFileEvent(argv, segment, options);
  if (fileEvent) return fileEvent;

  return undefined;
}

function parseGitEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  if (commandName(argv[0] ?? '') !== 'git') return undefined;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (isGitOp(arg)) {
      return { kind: 'git-op', op: arg, argv, segment };
    }
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree') {
      i += 1;
      continue;
    }
    if (arg?.startsWith('-')) continue;
    return undefined;
  }

  return undefined;
}

function parseFileEvent(
  argv: string[],
  segment: string,
  options: BashParseOptions,
): BashCoordinationEvent | undefined {
  const op = commandName(argv[0] ?? '');
  if (!isFileOp(op)) return undefined;

  const filePaths = unique(
    positionalArgs(argv.slice(1))
      .map((arg) => normalizeFilePath(arg, options))
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  if (filePaths.length === 0) return undefined;

  return { kind: 'file-op', op, argv, file_paths: filePaths, segment };
}

function parseRedirectEvents(
  tokens: Token[],
  segment: string,
  options: BashParseOptions,
): BashCoordinationEvent[] {
  const events: BashCoordinationEvent[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (!isRedirectOp(token.value)) continue;

    const target = tokens[i + 1];
    if (!target || target.tainted || isRedirectTargetSkipped(target.value)) continue;

    const filePath = normalizeFilePath(target.value, options);
    if (!filePath) continue;
    events.push({
      kind: 'auto-claim',
      op: 'redirect',
      operator: token.value,
      file_path: filePath,
      segment,
    });
  }
  return events;
}

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let single = false;
  let double = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';
    const next = command[i + 1];

    if (char === '\\' && !single) {
      current += char;
      if (next !== undefined) {
        current += next;
        i += 1;
      }
      continue;
    }

    if (!single && char === '`') {
      const end = findBacktickEnd(command, i);
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }

    if (!single && char === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(command, i);
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }

    if (!double && char === "'") {
      single = !single;
      current += char;
      continue;
    }
    if (!single && char === '"') {
      double = !double;
      current += char;
      continue;
    }

    if (!single && !double) {
      if (char === ';') {
        pushSegment(segments, current);
        current = '';
        continue;
      }
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        pushSegment(segments, current);
        current = '';
        i += 1;
        continue;
      }
    }

    current += char;
  }

  pushSegment(segments, current);
  return segments;
}

function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let current = '';
  let tainted = false;
  let single = false;
  let double = false;

  const push = () => {
    if (current.length > 0) tokens.push({ value: current, tainted });
    current = '';
    tainted = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i] ?? '';
    const next = segment[i + 1];

    if (single) {
      if (char === "'") single = false;
      else current += char;
      continue;
    }

    if (double) {
      if (char === '"') {
        double = false;
        continue;
      }
      if (char === '\\' && next !== undefined) {
        current += next;
        i += 1;
        continue;
      }
      if (char === '$' && next === '(') {
        const end = findCommandSubstitutionEnd(segment, i);
        tainted = true;
        i = end;
        continue;
      }
      if (char === '`') {
        const end = findBacktickEnd(segment, i);
        tainted = true;
        i = end;
        continue;
      }
      current += char;
      continue;
    }

    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = true;
      continue;
    }
    if (char === '\\' && next !== undefined) {
      current += next;
      i += 1;
      continue;
    }
    if (char === '$' && next === '(') {
      const end = findCommandSubstitutionEnd(segment, i);
      tainted = true;
      i = end;
      continue;
    }
    if (char === '`') {
      const end = findBacktickEnd(segment, i);
      tainted = true;
      i = end;
      continue;
    }
    if (char === '>') {
      if (current.length > 0 && /^\d+$/.test(current) && !tainted) {
        current = '';
      } else {
        push();
      }
      const op = next === '>' ? '>>' : '>';
      tokens.push({ value: op, tainted: false });
      if (next === '>') i += 1;
      continue;
    }

    current += char;
  }

  push();
  return tokens;
}

function stripRedirects(tokens: Token[]): Token[] {
  const stripped: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (isRedirectOp(token.value)) {
      i += 1;
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}

function positionalArgs(args: string[]): string[] {
  const paths: string[] = [];
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg.startsWith('-') && arg !== '-') continue;
    paths.push(arg);
  }
  return paths;
}

function normalizeFilePath(rawPath: string, options: BashParseOptions): string | undefined {
  if (!rawPath || rawPath.startsWith('&')) return undefined;

  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : undefined;
  const cwd = options.cwd ? path.resolve(options.cwd) : repoRoot;
  const absolutePath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : cwd
      ? path.resolve(cwd, rawPath)
      : undefined;

  if (!absolutePath) return normalizeSlashes(path.normalize(rawPath));
  if (repoRoot && isPathInside(absolutePath, repoRoot)) {
    const relativePath = path.relative(repoRoot, absolutePath);
    return relativePath ? normalizeSlashes(relativePath) : '.';
  }
  return normalizeSlashes(absolutePath);
}

function findCommandSubstitutionEnd(input: string, start: number): number {
  let depth = 1;
  let single = false;
  let double = false;

  for (let i = start + 2; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (char === '\\' && !single) {
      i += 1;
      continue;
    }
    if (!single && char === '`') {
      i = findBacktickEnd(input, i);
      continue;
    }
    if (!double && char === "'") {
      single = !single;
      continue;
    }
    if (!single && char === '"') {
      double = !double;
      continue;
    }
    if (!single && char === '$' && next === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (!single && char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return input.length - 1;
}

function findBacktickEnd(input: string, start: number): number {
  for (let i = start + 1; i < input.length; i += 1) {
    if (input[i] === '\\') {
      i += 1;
      continue;
    }
    if (input[i] === '`') return i;
  }
  return input.length - 1;
}

function pushSegment(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed) segments.push(trimmed);
}

function commandName(command: string): string {
  return command.split('/').pop() ?? command;
}

function isGitOp(
  op: string | undefined,
): op is 'checkout' | 'switch' | 'merge' | 'rebase' | 'reset' {
  return op !== undefined && GIT_OPS.has(op);
}

function isFileOp(op: string): op is 'mv' | 'rm' | 'cp' {
  return FILE_OPS.has(op);
}

function isRedirectOp(op: string): op is '>' | '>>' {
  return REDIRECT_OPS.has(op);
}

function isRedirectTargetSkipped(target: string): boolean {
  return target.startsWith('&') || target === '-';
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isPathInside(child: string, parent: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizeSlashes(value: string): string {
  return value.replaceAll(path.sep, '/');
}
