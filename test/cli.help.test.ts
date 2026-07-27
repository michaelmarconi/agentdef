// The CLI dispatches on argv[2] and every command runs for its side effects, so
// an unparsed --help does not print usage, it executes: `agentdef sync --help`
// regenerated CLAUDE.md and .claude/, and `agentdef init --help` installed git
// hooks, rewrote .gitignore and deleted the legacy .gitagent/ cache. These tests
// pin the interception, and they assert on the filesystem rather than only on
// output — a usage text printed *after* the side effect would still be a bug.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.ts');

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-test-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Runs the real CLI as a subprocess: the defect lives in argv handling and
// process exit codes, neither of which is observable from an in-process import.
// It runs from the repo (so `--import tsx` resolves) and targets the fixture via
// --dir, which is how a globally installed agentdef is actually invoked anyway.
const REPO = resolve(import.meta.dirname, '..');
function run(args: string[], dir?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', CLI, ...args, ...(dir ? ['--dir', dir] : [])],
    {
      cwd: REPO,
      encoding: 'utf-8',
      // A stale update-notifier cache must not add lines to stderr mid-assertion.
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    },
  );
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const AGENT = {
  'agent.yaml': 'name: helptest\ndescription: fixture\n',
  'SOUL.md': '# soul\n',
  'skills/demo/SKILL.md': '---\nname: demo\ndescription: demo skill\n---\nbody\n',
  '.agent-adapters': 'claude-code\n',
};

describe('--help never reaches a command', () => {
  test('sync --help prints usage and writes nothing', () => {
    const root = fixture(AGENT);
    const before = readdirSync(root).sort();

    const r = run(['sync', '--help'], root);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: agentdef sync/);
    assert.match(r.stdout, /--adapters/);
    assert.deepEqual(readdirSync(root).sort(), before, 'sync --help must not generate files');
    assert.ok(!existsSync(join(root, 'CLAUDE.md')));
    assert.ok(!existsSync(join(root, '.claude')));
  });

  // The destructive one: init untracks and deletes .gitagent/ from disk, so an
  // unparsed --help here removes a directory rather than only regenerating one.
  test('init --help installs no hooks and deletes no legacy cache', () => {
    const root = fixture({ ...AGENT, '.gitagent/parent/agent.yaml': 'name: legacy\n' });
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
    git(['init', '-q', '-b', 'main']);

    const r = run(['init', '--help'], root);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: agentdef init/);
    assert.ok(existsSync(join(root, '.gitagent', 'parent')), 'init --help must not delete the legacy cache');
    assert.ok(!existsSync(join(root, '.gitignore')), 'init --help must not write .gitignore');
    assert.ok(!existsSync(join(root, 'CLAUDE.md')), 'init --help must not run the initial sync');
    const hooks = join(root, '.git', 'hooks');
    for (const hook of ['post-merge', 'post-checkout', 'post-rewrite']) {
      assert.ok(!existsSync(join(hooks, hook)), `init --help must not install ${hook}`);
    }
  });

  test('install --help does not materialize the extends chain', () => {
    const parent = fixture({ 'agent.yaml': 'name: parent\ndescription: p\n', 'SOUL.md': '# p\n' });
    const root = fixture({ ...AGENT, 'agent.yaml': `name: child\ndescription: c\nextends: ${parent}\n` });

    const r = run(['install', '--help'], root);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: agentdef install/);
    assert.ok(!existsSync(join(root, '.agentdef')), 'install --help must not clone or copy the parent');
  });

  test('-h is interception too, not a command argument', () => {
    const root = fixture(AGENT);
    const r = run(['sync', '-h'], root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: agentdef sync/);
    assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  });
});

describe('help output and exit codes', () => {
  // Asking for help is not an error: exit 0 and stdout, so `--help | less` and
  // `--help | grep` work and a `set -e` script offering help does not die.
  for (const args of [['help'], ['--help'], ['-h']]) {
    test(`${args.join(' ')} exits 0 with the command list on stdout`, () => {
      const root = fixture(AGENT);
      const r = run(args, root);
      assert.equal(r.code, 0);
      for (const cmd of ['init', 'sync', 'adapters', 'export', 'install', 'validate', 'watch', 'knowledge']) {
        assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `${args.join(' ')} should list ${cmd}`);
      }
    });
  }

  test('help <command> documents that command, not the whole CLI', () => {
    const root = fixture(AGENT);
    const r = run(['help', 'adapters'], root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /usage: agentdef adapters/);
    assert.match(r.stdout, /--local/);
  });

  // The flags that were missing from the old single-line usage. They are the
  // reason this is not just an exit-code fix: they were undiscoverable.
  test('per-command help names the flags only that command takes', () => {
    const root = fixture(AGENT);
    assert.match(run(['init', '--help'], root).stdout, /--no-sync/);
    assert.match(run(['watch', '--help'], root).stdout, /--baseline/);
    assert.match(run(['export', '--help'], root).stdout, /codex/);
  });

  // Unknown input stays fail-loud: a usage text on stdout with exit 0 would tell
  // a CI script that a typo'd command succeeded.
  test('an unknown command exits 1 with the help on stderr', () => {
    const root = fixture(AGENT);
    const r = run(['bogus'], root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command: bogus/);
    assert.equal(r.stdout, '', 'diagnostics must not go to stdout');
  });

  test('help for an unknown command exits 1 rather than printing nothing useful', () => {
    const root = fixture(AGENT);
    const r = run(['help', 'bogus'], root);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command: bogus/);
  });

  test('a bare invocation exits 1 and shows the command list', () => {
    const r = run([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown command: \(none\)/);
    assert.match(r.stderr, /agentdef <command>/);
  });
});

describe('failures surface as a message, not a stack trace', () => {
  // main() was called bare, so any throw printed a raw Node stack naming
  // internal frames. `sync` outside an agent directory is the shortest path to
  // a real throw (loader.ts cannot find agent.yaml).
  test('a missing agent.yaml prints one line and no internal frames', () => {
    const empty = fixture({});
    const r = run(['sync'], empty);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /agent\.yaml not found/);
    assert.ok(!/\n\s+at /.test(r.stderr), `expected no stack frames, got:\n${r.stderr}`);
    assert.ok(!r.stderr.includes('node:internal'), 'internal frames must not reach the user');
  });
});
