const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const extensionPath = path.join(repoRoot, 'vscode', 'guardex-active-agents', 'extension.js');

function loadExtensionWithMockedVscode() {
  const originalLoad = Module._load;
  const terminals = [];
  const messages = [];

  const fakeVscode = {
    commands: {
      executeCommand: async () => undefined,
      registerCommand: () => ({ dispose() {} }),
    },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
      dispose() {}
    },
    FileDecoration: class {
      constructor(badge, tooltip, color) {
        this.badge = badge;
        this.tooltip = tooltip;
        this.color = color;
      }
    },
    scm: {
      createSourceControl: () => ({ dispose() {} }),
    },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    Uri: {
      file(fsPath) {
        return {
          fsPath,
          toString() {
            return fsPath;
          },
        };
      },
      parse(value) {
        return {
          toString() {
            return value;
          },
        };
      },
    },
    ViewColumn: { Beside: 2 },
    window: {
      createTerminal(options) {
        const terminal = {
          options,
          sentText: [],
          showCalled: false,
          show() {
            this.showCalled = true;
          },
          sendText(text, addNewLine) {
            this.sentText.push({ text, addNewLine });
          },
        };
        terminals.push(terminal);
        return terminal;
      },
      showInformationMessage(message) {
        messages.push(message);
        return Promise.resolve(undefined);
      },
    },
    workspace: {
      workspaceFolders: [],
      createFileSystemWatcher: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
  };

  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return fakeVscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve(extensionPath)];
  const extension = require(extensionPath);

  return {
    extension,
    messages,
    restore() {
      delete require.cache[require.resolve(extensionPath)];
      Module._load = originalLoad;
    },
    terminals,
  };
}

describe('Active Agents finish command', () => {
  it('uses the guarded PR merge and cleanup flags', () => {
    const context = loadExtensionWithMockedVscode();
    try {
      assert.equal(
        context.extension.__test.buildFinishSessionCommand({
          branch: "agent/codex/fix-finish-o'clock",
        }),
        "gx branch finish --branch 'agent/codex/fix-finish-o'\"'\"'clock' --via-pr --wait-for-merge --cleanup",
      );
    } finally {
      context.restore();
    }
  });

  it('runs finish from the repo root so the selected worktree can be pruned', () => {
    const context = loadExtensionWithMockedVscode();
    try {
      context.extension.__test.finishSession({
        branch: 'agent/codex/fix-finish-cleanup',
        repoRoot,
        worktreePath: path.join(repoRoot, '.omx', 'agent-worktrees', 'missing-active-cwd'),
      });

      assert.equal(context.messages.length, 0);
      assert.equal(context.terminals.length, 1);
      assert.equal(context.terminals[0].options.cwd, repoRoot);
      assert.deepEqual(context.terminals[0].sentText, [
        {
          text: "gx branch finish --branch 'agent/codex/fix-finish-cleanup' --via-pr --wait-for-merge --cleanup",
          addNewLine: true,
        },
      ]);
    } finally {
      context.restore();
    }
  });
});
