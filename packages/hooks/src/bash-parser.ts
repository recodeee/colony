const GIT_OPS = new Set(['checkout', 'switch', 'merge', 'rebase', 'reset']);
const FILE_OPS = new Set(['mv', 'rm', 'cp']);
const REDIRECT_OPS = new Set(['>', '>>']);
const PSEUDO_FILE_PATHS = new Set([
  '/dev/null',
  'dev/null',
  '/dev/stdout',
  'dev/stdout',
  '/dev/stderr',
  'dev/stderr',
  'stdout',
  'stderr',
  'NUL',
]);
type FileOp = 'mv' | 'rm' | 'cp' | 'sed' | 'perl' | 'tee';

export type BashCoordinationEvent =
  | {
      kind: 'git-op';
      op: 'checkout' | 'switch' | 'merge' | 'rebase' | 'reset';
      argv: string[];
      segment: string;
    }
  | {
      kind: 'file-op';
      op: FileOp;
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

interface Token {
  value: string;
  tainted: boolean;
}

export function parseBashCoordinationEvents(command: string): BashCoordinationEvent[] {
  if (!command.trim()) return [];

  const events: BashCoordinationEvent[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const commandTokens = stripRedirects(tokens);
    const argv = commandTokens.filter((token) => !token.tainted).map((token) => token.value);
    const commandEvent = parseCommandEvent(argv, segment);
    if (commandEvent) events.push(commandEvent);

    events.push(...parseRedirectEvents(tokens, segment));
  }

  return events;
}

function parseCommandEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  if (argv.length === 0) return undefined;

  const gitEvent = parseGitEvent(argv, segment);
  if (gitEvent) return gitEvent;

  const fileEvent = parseFileEvent(argv, segment);
  if (fileEvent) return fileEvent;

  const sedEvent = parseSedEvent(argv, segment);
  if (sedEvent) return sedEvent;

  const perlEvent = parsePerlEvent(argv, segment);
  if (perlEvent) return perlEvent;

  const teeEvent = parseTeeEvent(argv, segment);
  if (teeEvent) return teeEvent;

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

function parseFileEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  const op = commandName(argv[0] ?? '');
  if (!isFileOp(op)) return undefined;

  const filePaths = unique(
    positionalArgs(argv.slice(1))
      .map((arg) => parseFilePath(arg))
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  if (filePaths.length === 0) return undefined;

  return { kind: 'file-op', op, argv, file_paths: filePaths, segment };
}

function parseSedEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  if (commandName(argv[0] ?? '') !== 'sed') return undefined;
  if (!hasSedInPlaceOption(argv.slice(1))) return undefined;

  const filePaths = unique(
    sedEditedFileArgs(argv.slice(1))
      .map((arg) => parseFilePath(arg))
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  if (filePaths.length === 0) return undefined;

  return { kind: 'file-op', op: 'sed', argv, file_paths: filePaths, segment };
}

function hasSedInPlaceOption(args: string[]): boolean {
  return args.some((arg) => isSedInPlaceOption(arg));
}

function sedEditedFileArgs(args: string[]): string[] {
  const candidates: string[] = [];
  let scriptFromOption = false;
  let parsingOptions = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && isSedOptionWithSeparateValue(arg)) {
      scriptFromOption = true;
      i += 1;
      continue;
    }
    if (parsingOptions && isSedScriptOptionWithAttachedValue(arg)) {
      scriptFromOption = true;
      continue;
    }
    if (parsingOptions && isSedInPlaceOption(arg)) continue;
    if (parsingOptions && arg.startsWith('-')) continue;
    candidates.push(arg);
  }

  return scriptFromOption ? candidates : candidates.slice(1);
}

function isSedInPlaceOption(arg: string): boolean {
  return (
    arg === '-i' ||
    (arg.startsWith('-i') && !arg.startsWith('--')) ||
    arg === '--in-place' ||
    arg.startsWith('--in-place=')
  );
}

function isSedOptionWithSeparateValue(arg: string): boolean {
  return arg === '-e' || arg === '--expression' || arg === '-f' || arg === '--file';
}

function isSedScriptOptionWithAttachedValue(arg: string): boolean {
  return (
    (arg.startsWith('-e') && arg.length > 2) ||
    arg.startsWith('--expression=') ||
    (arg.startsWith('-f') && arg.length > 2) ||
    arg.startsWith('--file=')
  );
}

function parsePerlEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  if (commandName(argv[0] ?? '') !== 'perl') return undefined;
  if (!hasPerlInPlaceOption(argv.slice(1))) return undefined;

  const filePaths = unique(
    perlEditedFileArgs(argv.slice(1))
      .map((arg) => parseFilePath(arg))
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  if (filePaths.length === 0) return undefined;

  return { kind: 'file-op', op: 'perl', argv, file_paths: filePaths, segment };
}

function hasPerlInPlaceOption(args: string[]): boolean {
  return args.some((arg) => isPerlInPlaceOption(arg));
}

function perlEditedFileArgs(args: string[]): string[] {
  const candidates: string[] = [];
  let programSeen = false;
  let parsingOptions = true;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && isPerlProgramOptionWithSeparateValue(arg)) {
      programSeen = true;
      i += 1;
      continue;
    }
    if (parsingOptions && isPerlProgramOptionWithAttachedValue(arg)) {
      programSeen = true;
      continue;
    }
    if (parsingOptions && isPerlModuleOption(arg)) {
      if (arg === '-M' || arg === '-m') i += 1;
      continue;
    }
    if (parsingOptions && isPerlInPlaceOption(arg)) continue;
    if (parsingOptions && arg.startsWith('-')) continue;

    if (!programSeen) {
      programSeen = true;
      continue;
    }
    candidates.push(arg);
  }

  return candidates;
}

function isPerlInPlaceOption(arg: string): boolean {
  return arg === '-i' || (arg.startsWith('-i') && !arg.startsWith('--')) || /^-[^-]*i/.test(arg);
}

function isPerlProgramOptionWithSeparateValue(arg: string): boolean {
  return arg === '-e' || arg === '-E' || /^-[^-]*[eE]$/.test(arg);
}

function isPerlProgramOptionWithAttachedValue(arg: string): boolean {
  return /^-[^-]*[eE].+/.test(arg) && !isPerlProgramOptionWithSeparateValue(arg);
}

function isPerlModuleOption(arg: string): boolean {
  return arg === '-M' || arg === '-m' || arg.startsWith('-M') || arg.startsWith('-m');
}

function parseTeeEvent(argv: string[], segment: string): BashCoordinationEvent | undefined {
  if (commandName(argv[0] ?? '') !== 'tee') return undefined;

  const filePaths = unique(
    teeOutputArgs(argv.slice(1))
      .map((arg) => parseFilePath(arg))
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  if (filePaths.length === 0) return undefined;

  return { kind: 'file-op', op: 'tee', argv, file_paths: filePaths, segment };
}

function teeOutputArgs(args: string[]): string[] {
  const outputs: string[] = [];
  let parsingOptions = true;

  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && isTeeOption(arg)) continue;
    outputs.push(arg);
  }

  return outputs;
}

function isTeeOption(arg: string): boolean {
  return (
    arg === '-a' ||
    arg === '--append' ||
    arg === '-i' ||
    arg === '--ignore-interrupts' ||
    arg === '-p' ||
    arg === '--output-error' ||
    arg.startsWith('--output-error=') ||
    (arg.startsWith('-') && arg !== '-')
  );
}

function parseRedirectEvents(tokens: Token[], segment: string): BashCoordinationEvent[] {
  const events: BashCoordinationEvent[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (!isRedirectOp(token.value)) continue;

    const target = tokens[i + 1];
    if (!target || target.tainted || isRedirectTargetSkipped(target.value)) continue;

    const filePath = parseFilePath(target.value);
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
      if (char === '|') {
        pushSegment(segments, current);
        current = '';
        if (next === '&') i += 1;
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

function parseFilePath(rawPath: string): string | undefined {
  const value = rawPath.trim();
  if (!value || value === '-' || value.startsWith('&')) return undefined;
  if (PSEUDO_FILE_PATHS.has(value)) return undefined;
  if (isLikelyCodeFragment(value)) return undefined;
  return value;
}

function isLikelyCodeFragment(value: string): boolean {
  return /^(?:s|tr|y)(.).+\1.*\1[A-Za-z]*$/.test(value);
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
