import { describe, expect, it } from 'vitest';
import { parseBashCoordinationEvents } from '../src/bash-parser.js';

function compact(command: string) {
  return parseBashCoordinationEvents(command).map((event) => {
    if (event.kind === 'git-op') return { kind: event.kind, op: event.op };
    if (event.kind === 'file-op') {
      return { kind: event.kind, op: event.op, file_paths: event.file_paths };
    }
    return {
      kind: event.kind,
      operator: event.operator,
      file_path: event.file_path,
    };
  });
}

describe('parseBashCoordinationEvents', () => {
  const cases: Array<{
    name: string;
    command: string;
    expected: ReturnType<typeof compact>;
  }> = [
    {
      name: 'git checkout',
      command: 'git checkout main',
      expected: [{ kind: 'git-op', op: 'checkout' }],
    },
    {
      name: 'git switch',
      command: 'git switch -c feature/a',
      expected: [{ kind: 'git-op', op: 'switch' }],
    },
    {
      name: 'git merge',
      command: 'git merge origin/main',
      expected: [{ kind: 'git-op', op: 'merge' }],
    },
    {
      name: 'git rebase',
      command: 'git rebase --continue',
      expected: [{ kind: 'git-op', op: 'rebase' }],
    },
    {
      name: 'git reset',
      command: 'git reset --hard HEAD~1',
      expected: [{ kind: 'git-op', op: 'reset' }],
    },
    {
      name: 'git global option before op',
      command: 'git -C ../repo checkout main',
      expected: [{ kind: 'git-op', op: 'checkout' }],
    },
    {
      name: 'non-mutating git command ignored',
      command: 'git status --short',
      expected: [],
    },
    {
      name: 'and-chain parses each segment',
      command: 'git checkout main && rm old.ts',
      expected: [
        { kind: 'git-op', op: 'checkout' },
        { kind: 'file-op', op: 'rm', file_paths: ['old.ts'] },
      ],
    },
    {
      name: 'or and semicolon chains parse each segment',
      command: 'git checkout main || rm old.ts; cp a.ts b.ts',
      expected: [
        { kind: 'git-op', op: 'checkout' },
        { kind: 'file-op', op: 'rm', file_paths: ['old.ts'] },
        { kind: 'file-op', op: 'cp', file_paths: ['a.ts', 'b.ts'] },
      ],
    },
    {
      name: 'escaped spaces in file target',
      command: 'rm old\\ file.ts',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['old file.ts'] }],
    },
    {
      name: 'double-quoted file target',
      command: 'rm "old file.ts"',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['old file.ts'] }],
    },
    {
      name: 'single and double-quoted mv targets',
      command: 'mv \'old name.ts\' "new name.ts"',
      expected: [{ kind: 'file-op', op: 'mv', file_paths: ['old name.ts', 'new name.ts'] }],
    },
    {
      name: 'rm options and -- marker',
      command: 'rm -rf -- tmp/cache',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['tmp/cache'] }],
    },
    {
      name: 'stdout redirect',
      command: 'echo hi > out.txt',
      expected: [{ kind: 'auto-claim', operator: '>', file_path: 'out.txt' }],
    },
    {
      name: 'append redirect',
      command: 'echo hi >> logs/out.txt',
      expected: [{ kind: 'auto-claim', operator: '>>', file_path: 'logs/out.txt' }],
    },
    {
      name: 'cat stdout redirect',
      command: 'cat README.md > src/generated.ts',
      expected: [{ kind: 'auto-claim', operator: '>', file_path: 'src/generated.ts' }],
    },
    {
      name: 'adjacent redirect',
      command: 'printf x>src/out.ts',
      expected: [{ kind: 'auto-claim', operator: '>', file_path: 'src/out.ts' }],
    },
    {
      name: 'quoted redirect target',
      command: 'echo hi > "space file.txt"',
      expected: [{ kind: 'auto-claim', operator: '>', file_path: 'space file.txt' }],
    },
    {
      name: 'fd duplication is not a file write',
      command: 'echo hi 2>&1',
      expected: [],
    },
    {
      name: 'command substitution commands are ignored',
      command: 'echo $(git checkout main; rm hidden.ts)',
      expected: [],
    },
    {
      name: 'backtick commands are ignored',
      command: 'echo `git switch main; rm hidden.ts`',
      expected: [],
    },
    {
      name: 'outer command still parses after command substitution',
      command: 'echo $(git checkout main) && rm real.ts',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['real.ts'] }],
    },
    {
      name: 'single quotes keep command substitution literal',
      command: "rm '$(literal).ts'",
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['$(literal).ts'] }],
    },
    {
      name: 'tainted redirect target is ignored',
      command: 'echo hi > "$(pwd)/generated.ts"',
      expected: [],
    },
    {
      name: 'relative path stays relative',
      command: 'rm src/local.ts',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['src/local.ts'] }],
    },
    {
      name: 'absolute path inside repo stays absolute',
      command: 'cp /repo/src/a.ts /repo/src/b.ts',
      expected: [{ kind: 'file-op', op: 'cp', file_paths: ['/repo/src/a.ts', '/repo/src/b.ts'] }],
    },
    {
      name: 'absolute path outside repo stays absolute',
      command: 'rm /tmp/outside.ts',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['/tmp/outside.ts'] }],
    },
    {
      name: 'parent-relative path stays relative',
      command: 'rm ../outside.ts',
      expected: [{ kind: 'file-op', op: 'rm', file_paths: ['../outside.ts'] }],
    },
    {
      name: 'sed in-place file target',
      command: 'sed -i "s/a/b/" src/edit.ts',
      expected: [{ kind: 'file-op', op: 'sed', file_paths: ['src/edit.ts'] }],
    },
    {
      name: 'sed in-place with expression option and multiple files',
      command: 'sed -i.bak -e "s/a/b/" src/a.ts src/b.ts',
      expected: [{ kind: 'file-op', op: 'sed', file_paths: ['src/a.ts', 'src/b.ts'] }],
    },
    {
      name: 'sed without in-place is read-only',
      command: 'sed "s/a/b/" src/edit.ts',
      expected: [],
    },
    {
      name: 'perl in-place file target',
      command: 'perl -pi -e "s/a/b/" src/perl.ts',
      expected: [{ kind: 'file-op', op: 'perl', file_paths: ['src/perl.ts'] }],
    },
    {
      name: 'perl in-place with backup and multiple files',
      command: 'perl -i.bak -pe "s/a/b/" src/a.ts src/b.ts',
      expected: [{ kind: 'file-op', op: 'perl', file_paths: ['src/a.ts', 'src/b.ts'] }],
    },
    {
      name: 'tee output target',
      command: 'tee -a src/tee.ts',
      expected: [{ kind: 'file-op', op: 'tee', file_paths: ['src/tee.ts'] }],
    },
    {
      name: 'pipeline tee output target',
      command: 'printf x | tee src/pipe.ts > /dev/null',
      expected: [{ kind: 'file-op', op: 'tee', file_paths: ['src/pipe.ts'] }],
    },
    {
      name: 'pseudo redirect target is ignored',
      command: 'printf x > stdout',
      expected: [],
    },
  ];

  it.each(cases)('$name', ({ command, expected }) => {
    expect(compact(command)).toEqual(expected);
  });
});
