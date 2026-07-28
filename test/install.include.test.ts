// `include:` lets a base repo declare which extra directories a consumer's clone
// should fetch. Fixtures are real git repos addressed by file:// URL, so the
// clone path runs, not the cpSync local-path shortcut.
//
// The fixtures set uploadpack.allowFilter explicitly. Without it the local
// transport IGNORES --filter and quietly does a full fetch, while still writing
// remote.origin.partialclonefilter=blob:none, so a test that asserts on that
// config key alone passes exactly as loudly when no filtering happened. The
// assertions here are on missing objects instead, which is transfer-observable.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, parseIncludeList } from '../src/install.js';
import { collectKnowledgeMetadata } from '../src/knowledge.js';
import { validate } from '../src/validate.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Hermetic: the ambient ~/.gitconfig may carry commit.gpgsign, a global
// core.hooksPath or an excludesfile, any of which breaks fixture creation on
// someone else's machine while passing on mine.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@e',
};
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: 'pipe' });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

const TREE = {
  'SOUL.md': '# soul\n',
  'RULES.md': '# rules\n',
  'skills/foo/SKILL.md': '---\nname: foo\ndescription: a skill\n---\nbody\n',
  'agents/bar.md': 'an agent\n',
  'knowledge/policies/refund.md': '---\ntype: policy\ntitle: Refunds\n---\nbody\n',
  'docs/adr.md': '# internal\n',
  'internal/secret.md': 'CONFIDENTIAL\n',
  'tools/runtime/cli.js': 'console.log(1);\n',
};

// The directory is named repo.git because isGitSource() decides from the string:
// a file:// path without that suffix is not recognised as a git source at all.
function makeParent(manifest: string, extra: Record<string, string> = {}): string {
  const base = mkdtempSync(join(tmpdir(), 'agentdef-parent-'));
  dirs.push(base);
  const dir = join(base, 'repo.git');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  // Without this the local transport silently ignores --filter (see header).
  git(dir, ['config', 'uploadpack.allowFilter', 'true']);
  write(dir, { 'agent.yaml': manifest, ...TREE, ...extra });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

function makeChild(parent: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdef-child-'));
  dirs.push(dir);
  write(dir, { 'agent.yaml': `name: child\ndescription: c\nextends: file://${parent}\n` });
  return dir;
}

const parentDirOf = (child: string) => join(child, '.agentdef', 'parent');

// Blobs git deliberately did not fetch. The real test of "never downloaded":
// a working tree can look right while everything sits in .git.
function missingObjectCount(repo: string): number {
  const out = git(repo, ['rev-list', '--objects', '--all', '--missing=print']);
  return out.split('\n').filter((l) => l.startsWith('?')).length;
}

describe('include: absent (every existing repo)', () => {
  test('full tree, unchanged from a plain clone', () => {
    const child = makeChild(makeParent('name: p\ndescription: p\n'));
    const r = install(child, { mode: 'force' });
    assert.deepEqual(r.warnings, []);

    const p = parentDirOf(child);
    for (const rel of Object.keys(TREE)) {
      assert.ok(existsSync(join(p, rel)), `${rel} must still be present`);
    }
    assert.equal(missingObjectCount(p), 0, 'disable backfills everything, so the cache stays offline-usable');
  });
});

describe('include: present', () => {
  test('essentials plus the declared path, and nothing else is fetched', () => {
    const child = makeChild(makeParent('name: p\ndescription: p\ninclude:\n  - tools/runtime\n'));
    install(child, { mode: 'force' });
    const p = parentDirOf(child);

    // Cone mode always materialises root files, so these need no declaration.
    assert.ok(existsSync(join(p, 'agent.yaml')));
    assert.ok(existsSync(join(p, 'SOUL.md')));
    assert.ok(existsSync(join(p, 'RULES.md')));
    // Essentials: agentdef reads these for every consumer.
    assert.ok(existsSync(join(p, 'skills/foo/SKILL.md')));
    assert.ok(existsSync(join(p, 'agents/bar.md')));
    assert.ok(existsSync(join(p, 'tools/runtime/cli.js')), 'the declared path');

    assert.ok(!existsSync(join(p, 'docs')), 'undeclared');
    assert.ok(!existsSync(join(p, 'internal')), 'undeclared');
    assert.ok(missingObjectCount(p) > 0, 'undeclared blobs are genuinely not fetched, not merely hidden');
  });

  // The regression this whole feature is one line away from: knowledge/ became a
  // chain-walked root in 0.7.0, so a static ['skills','agents'] essentials list
  // would drop a parent's entire knowledge corpus with no error and no warning.
  test('the knowledge dir survives include: [], including when renamed', () => {
    for (const [manifest, dir] of [
      ['name: p\ndescription: p\ninclude: []\n', 'knowledge'],
      ['name: p\ndescription: p\nknowledge:\n  dir: wissen\ninclude: []\n', 'wissen'],
    ]) {
      const parent = makeParent(manifest, {
        [`${dir}/policies/refund.md`]: '---\ntype: policy\ntitle: Refunds\n---\nbody\n',
      });
      const child = makeChild(parent);
      install(child, { mode: 'force' });

      assert.ok(existsSync(join(parentDirOf(child), dir, 'policies/refund.md')), `${dir}/ must survive`);
      assert.deepEqual(
        collectKnowledgeMetadata(child).entries.map((e) => e.title),
        ['Refunds'],
        `the inherited doc must still reach the index with knowledge.dir=${dir}`,
      );
    }
  });

  test('include: [] keeps essentials and drops the rest', () => {
    const child = makeChild(makeParent('name: p\ndescription: p\ninclude: []\n'));
    install(child, { mode: 'force' });
    const p = parentDirOf(child);
    assert.ok(existsSync(join(p, 'skills/foo/SKILL.md')));
    assert.ok(!existsSync(join(p, 'tools')));
    assert.ok(!existsSync(join(p, 'docs')));
  });

  test('a declared path that does not exist is a harmless no-op', () => {
    const child = makeChild(makeParent('name: p\ndescription: p\ninclude:\n  - does/not/exist\n'));
    assert.doesNotThrow(() => install(child, { mode: 'force' }));
    assert.ok(existsSync(join(parentDirOf(child), 'skills/foo/SKILL.md')));
  });

  // Each level applies its OWN manifest; patterns must not leak down the chain.
  test('a two-level chain keeps each ancestor on its own selection', () => {
    const grandparent = makeParent('name: gp\ndescription: gp\ninclude:\n  - tools/runtime\n');
    const parent = makeParent(`name: p\ndescription: p\nextends: file://${grandparent}\ninclude: []\n`);
    const child = makeChild(parent);
    install(child, { mode: 'force' });

    const p1 = parentDirOf(child);
    const p2 = join(p1, '.agentdef', 'parent');
    assert.ok(!existsSync(join(p1, 'tools')), "the parent's own include: [] excludes tools/");
    assert.ok(existsSync(join(p2, 'tools/runtime/cli.js')), "the grandparent's include: is not overridden");
    assert.ok(existsSync(join(p2, 'skills/foo/SKILL.md')));
  });

  test('re-resolving after include: changes reflects the new list', () => {
    const parent = makeParent('name: p\ndescription: p\ninclude:\n  - tools/runtime\n');
    const child = makeChild(parent);
    install(child, { mode: 'force' });
    assert.ok(existsSync(join(parentDirOf(child), 'tools/runtime/cli.js')));

    writeFileSync(join(parent, 'agent.yaml'), 'name: p\ndescription: p\ninclude: []\n');
    git(parent, ['commit', '-q', '-am', 'lean']);

    install(child, { mode: 'force' });
    assert.ok(!existsSync(join(parentDirOf(child), 'tools')), 'stale selection is gone');
    assert.ok(existsSync(join(parentDirOf(child), 'skills/foo/SKILL.md')));
  });

  // A local path is a filesystem copy, not a fetch, so there is nothing to filter.
  test('a local (non-URL) parent ignores include: and is copied whole', () => {
    const parent = mkdtempSync(join(tmpdir(), 'agentdef-local-'));
    dirs.push(parent);
    write(parent, { 'agent.yaml': 'name: p\ndescription: p\ninclude: []\n', ...TREE });
    const child = mkdtempSync(join(tmpdir(), 'agentdef-child-'));
    dirs.push(child);
    write(child, { 'agent.yaml': `name: c\ndescription: c\nextends: ${parent}\n` });

    install(child, { mode: 'force' });
    assert.ok(existsSync(join(parentDirOf(child), 'docs/adr.md')));
  });
});

describe('a failure mid-selection leaves the previous cache intact', () => {
  test('a bad include: does not destroy a working cache', () => {
    const parent = makeParent('name: p\ndescription: p\ninclude:\n  - tools/runtime\n');
    const child = makeChild(parent);
    install(child, { mode: 'force' });
    assert.ok(existsSync(join(parentDirOf(child), 'skills/foo/SKILL.md')), 'good cache first');

    writeFileSync(join(parent, 'agent.yaml'), 'name: p\ndescription: p\ninclude:\n  - "docs/*"\n');
    git(parent, ['commit', '-q', '-am', 'broken include']);

    assert.throws(() => install(child, { mode: 'force' }), /wildcard/);
    assert.ok(
      existsSync(join(parentDirOf(child), 'skills/foo/SKILL.md')),
      'the previous materialization must survive the failed re-clone',
    );
  });

  // This is the one that pins the ORDERING, and it needs the sparse-checkout
  // call itself to fail rather than its input validation, which happens before
  // the swap either way. On a partial clone that call is a real network
  // operation against the promisor remote and at --depth 1 it moves most of the
  // bytes, so it is the likelier of the two to die.
  //
  // Run after the swap, its failure leaves a root-files-only cache carrying the
  // correct origin URL and HEAD SHA, which is exactly and only what
  // cachedParentIsCurrent() inspects. Every later sync would then report success
  // with all inherited skills, agents and knowledge silently missing.
  test('a sparse-checkout failure does not destroy a working cache', () => {
    const parent = makeParent('name: p\ndescription: p\ninclude:\n  - tools/runtime\n');
    const child = makeChild(parent);
    install(child, { mode: 'force' });

    // A git on PATH that passes everything through except sparse-checkout.
    const shimDir = mkdtempSync(join(tmpdir(), 'agentdef-shim-'));
    dirs.push(shimDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/sh\nfor a in "$@"; do\n  [ "$a" = "sparse-checkout" ] && {\n    echo "fatal: could not fetch from promisor remote" >&2; exit 128; }\ndone\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );

    const path = process.env.PATH;
    process.env.PATH = `${shimDir}:${path}`;
    try {
      assert.throws(() => install(child, { mode: 'force' }), /sparse-checkout|promisor/);
    } finally {
      process.env.PATH = path;
    }

    const p = parentDirOf(child);
    assert.ok(existsSync(join(p, 'skills/foo/SKILL.md')), 'inherited skills must survive');
    assert.ok(existsSync(join(p, 'agents/bar.md')), 'inherited agents must survive');
    assert.ok(existsSync(join(p, 'tools/runtime/cli.js')), 'the previous selection must survive');
    // And the chain still resolves, i.e. the next sync would not silently
    // generate an instruction file with everything inherited missing.
    assert.equal(collectKnowledgeMetadata(child).entries.length, 1);
  });
});

describe('include: validation', () => {
  const bad: [string, unknown, RegExp][] = [
    ['a scalar instead of a list', 'docs', /must be a list of paths, got string/],
    ['a non-string entry', [1], /must be a string, got number/],
    ['a null entry', [null], /must be a string, got null/],
    ['an empty entry', [''], /is empty/],
    ['an option-shaped entry', ['--no-cone'], /must not start with/],
    ['an absolute path', ['/etc'], /must not start with/],
    ['a negation', ['!docs'], /must not start with/],
    ['a wildcard', ['docs/*'], /wildcard/],
    ['a traversal', ['../../etc'], /must not start with|".." segment/],
    ['a nested traversal', ['skills/../../etc'], /".." segment/],
    ['an embedded newline', ['tools\n!/agent.yaml'], /control characters/],
  ];
  for (const [label, value, re] of bad) {
    test(`rejects ${label}`, () => {
      assert.throws(() => parseIncludeList(value, 'agent.yaml'), re);
    });
  }

  test('accepts a plain relative path, including non-ASCII', () => {
    assert.deepEqual(parseIncludeList(['tools/runtime', 'wissen/übersicht'], 'agent.yaml'), [
      'tools/runtime',
      'wissen/übersicht',
    ]);
    assert.equal(parseIncludeList(undefined, 'agent.yaml'), undefined);
    assert.deepEqual(parseIncludeList([], 'agent.yaml'), []);
  });

  // The point of validating in validate(): a parent never applies its own
  // include:, so without this the author cannot see the mistake at all.
  test('validate() reports it in the repo that declares it', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdef-v-'));
    dirs.push(root);
    write(root, { 'agent.yaml': 'name: p\ndescription: p\ninclude:\n  - "docs/*"\n', 'SOUL.md': '# s\n' });
    assert.match(validate(root).find((i) => i.level === 'error')?.message ?? '', /wildcard/);
  });

  test('validate() warns when a declared path does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdef-v-'));
    dirs.push(root);
    write(root, { 'agent.yaml': 'name: p\ndescription: p\ninclude:\n  - tools/nope\n', 'SOUL.md': '# s\n' });
    const warn = validate(root).filter((i) => i.level === 'warning');
    assert.ok(warn.some((i) => /include "tools\/nope" does not exist/.test(i.message)));
  });
});
