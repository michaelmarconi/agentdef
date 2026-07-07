// Verifies the `include:` sparse-checkout mechanism in install.ts:
//   - no `include` key on the parent's agent.yaml -> unchanged full clone
//   - `include: [...]`                            -> essentials + listed paths only
//   - `include: []`                                -> essentials only
// Fixtures are real git repos (not filesystem copies), addressed via a
// `file://` URL, so the git-clone + sparse-checkout code path is exercised —
// the same path a real https:// GitHub clone would take — rather than the
// `cpSync` local-path shortcut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/install.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function writeYaml(path: string, obj: Record<string, unknown>): void {
  const lines = Object.entries(obj).map(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return `${key}: []`;
      return `${key}:\n${value.map((v) => `  - ${v}`).join('\n')}`;
    }
    return `${key}: ${value}`;
  });
  writeFileSync(path, lines.join('\n') + '\n');
}

// Populates a fixed set of directories that mimic a real toolbelt-shaped repo:
// root files (SOUL.md/RULES.md), skills/ (an essential), plus docs/, tests/,
// and a nested consumer-owned runtime dir that a lean `include:` would prune.
function writeStandardTree(dir: string): void {
  writeFileSync(join(dir, 'SOUL.md'), '# soul\n');
  writeFileSync(join(dir, 'RULES.md'), '# rules\n');

  mkdirSync(join(dir, 'skills', 'foo'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\nbody\n');

  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'adr.md'), '# adr\n');

  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'x.txt'), 'x\n');

  mkdirSync(join(dir, 'tools', 'runtime', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'runtime', 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("ok");\n');
}

// Builds a git fixture repo under a fresh tmpdir carrying an arbitrary manifest,
// plus the standard toolbelt-shaped tree. The repo directory itself is named
// `repo.git` — install.ts's isGitSource() string-matches on a `.git` suffix
// (or a known host name) to decide whether an `extends:` value is a git URL at
// all, so a `file://` path without that suffix would be silently treated as
// unrecognized.
function makeGitRepo(manifest: Record<string, unknown>): string {
  const base = mkdtempSync(join(tmpdir(), 'agentdef-fixture-parent-'));
  const dir = join(base, 'repo.git');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writeYaml(join(dir, 'agent.yaml'), manifest);
  writeStandardTree(dir);

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture parent']);
  return dir;
}

// Convenience wrapper preserving the original signature: a fixture parent whose
// only variable is its `include` value (omitted entirely when undefined).
function makeFixtureParent(include: string[] | undefined): string {
  const manifest: Record<string, unknown> = { name: 'fixture-parent', description: 'test fixture' };
  if (include !== undefined) manifest.include = include;
  return makeGitRepo(manifest);
}

// A plain (non-git) local parent dir with the standard tree — used as a bare
// filesystem path in `extends:`, so install.ts routes through its cpSync copy
// path rather than cloneGitRepo.
function makeLocalParent(manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdef-fixture-local-'));
  writeYaml(join(dir, 'agent.yaml'), manifest);
  writeStandardTree(dir);
  return dir;
}

function makeChild(parentFileUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdef-fixture-child-'));
  writeYaml(join(dir, 'agent.yaml'), {
    name: 'fixture-child',
    description: 'test fixture',
    extends: parentFileUrl,
  });
  return dir;
}

// A plain filesystem path is treated as a *local* extends source by
// install.ts (the cpSync path). Wrapping it as a `file://` URL instead makes
// isGitSource() route through cloneGitRepo, exercising the same code path a
// real https:// clone takes.
const parentDirIn = (childDir: string) => join(childDir, '.agentdef', 'parent');

test('no include key: full clone, everything present (behaviour preserved)', () => {
  const parent = makeFixtureParent(undefined);
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')));
  assert.ok(existsSync(join(p, 'SOUL.md')));
  assert.ok(existsSync(join(p, 'RULES.md')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')));
  assert.ok(existsSync(join(p, 'docs', 'adr.md')), 'docs/ should still be present when include is absent');
  assert.ok(existsSync(join(p, 'tests', 'x.txt')), 'tests/ should still be present when include is absent');
  assert.ok(existsSync(join(p, 'tools', 'runtime', 'dist', 'cli.js')));
});

test('include: [tools/runtime]: essentials + listed path only, noise excluded', () => {
  const parent = makeFixtureParent(['tools/runtime']);
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')), 'root files always present via cone mode');
  assert.ok(existsSync(join(p, 'SOUL.md')));
  assert.ok(existsSync(join(p, 'RULES.md')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')), 'essential: skills/ retained even though not listed');
  assert.ok(existsSync(join(p, 'tools', 'runtime', 'dist', 'cli.js')), 'declared include path present');
  assert.ok(!existsSync(join(p, 'docs')), 'docs/ excluded');
  assert.ok(!existsSync(join(p, 'tests')), 'tests/ excluded');
});

test('include: []: essentials-only lean mode', () => {
  const parent = makeFixtureParent([]);
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')), 'essential retained even with empty include');
  assert.ok(!existsSync(join(p, 'tools')), 'no extra path declared, so consumer runtime dir excluded');
  assert.ok(!existsSync(join(p, 'docs')));
  assert.ok(!existsSync(join(p, 'tests')));
});

test('non-existent include path is a harmless no-op', () => {
  const parent = makeFixtureParent(['does/not/exist']);
  const child = makeChild(`file://${parent}`);

  assert.doesNotThrow(() => install(child, { force: true }));

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')));
  assert.ok(!existsSync(join(p, 'docs')));
});

test('idempotent: running install twice reproduces the same pruned result', () => {
  const parent = makeFixtureParent(['tools/runtime']);
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });
  install(child, { force: true });

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'tools', 'runtime', 'dist', 'cli.js')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')));
  assert.ok(!existsSync(join(p, 'docs')));
  assert.ok(!existsSync(join(p, 'tests')));
});

test('include path triggers real partial-clone fetch filtering, not just a hidden working tree', () => {
  const parent = makeFixtureParent(['tools/runtime']);
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });

  const p = parentDirIn(child);
  const filter = git(p, ['config', 'remote.origin.partialclonefilter']).trim();
  assert.equal(filter, 'blob:none');
});

// A transitive chain (child -> parent -> grandparent) with a different `include`
// at each git level. Each ancestor's sparse selection is derived from its OWN
// agent.yaml, so patterns must not leak across levels while essentials survive
// every hop. The parent's cache lands at .agentdef/parent, the grandparent one
// level deeper at .agentdef/parent/.agentdef/parent.
test('transitive chain: sparse patterns do not leak across levels, essentials survive each hop', () => {
  const grandparent = makeGitRepo({ name: 'gp', description: 'gp', include: ['tools/runtime'] });
  const parent = makeGitRepo({
    name: 'p',
    description: 'p',
    extends: `file://${grandparent}`,
    include: [],
  });
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });

  const p1 = parentDirIn(child); // parent cache
  const p2 = join(p1, '.agentdef', 'parent'); // grandparent cache

  // Parent used include: [] -> essentials only, no tools/ or docs/.
  assert.ok(existsSync(join(p1, 'agent.yaml')));
  assert.ok(existsSync(join(p1, 'skills', 'foo', 'SKILL.md')), 'parent essentials retained');
  assert.ok(!existsSync(join(p1, 'tools')), "parent's own include:[] excludes tools/");
  assert.ok(!existsSync(join(p1, 'docs')));

  // Grandparent used include: [tools/runtime] -> its own whitelist, unaffected
  // by the parent's []. If patterns leaked, tools/runtime would be missing here.
  assert.ok(existsSync(join(p2, 'agent.yaml')));
  assert.ok(existsSync(join(p2, 'skills', 'foo', 'SKILL.md')), 'grandparent essentials retained');
  assert.ok(
    existsSync(join(p2, 'tools', 'runtime', 'dist', 'cli.js')),
    "grandparent's include path present, not overridden by parent's include:[]",
  );
  assert.ok(!existsSync(join(p2, 'docs')), 'grandparent noise still excluded');
});

// A forced re-clone must reflect the parent's CURRENT include:, not a stale
// working tree left by an earlier run with a different whitelist.
test('force re-clone after changing include reflects the new whitelist, not stale state', () => {
  const parent = makeGitRepo({ name: 'p', description: 'p', include: ['tools/runtime'] });
  const child = makeChild(`file://${parent}`);

  install(child, { force: true });
  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'tools', 'runtime', 'dist', 'cli.js')), 'initial include path present');

  // Rebuild the fixture parent's agent.yaml to essentials-only, as a new commit.
  writeYaml(join(parent, 'agent.yaml'), { name: 'p', description: 'p', include: [] });
  git(parent, ['commit', '-q', '-am', 'lean include']);

  install(child, { force: true });
  assert.ok(existsSync(join(p, 'agent.yaml')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')), 'essentials survive the re-clone');
  assert.ok(!existsSync(join(p, 'tools')), 're-clone reflects the new include:[], stale tools/ is gone');
  assert.ok(!existsSync(join(p, 'docs')));
});

// A LOCAL (non-URL, filesystem-path) parent is a plain cpSync copy, not a git
// clone — there is no partial fetch to gate, so `include:` does not apply and
// the full tree is copied even with include: [].
test('local (cpSync) parent ignores include: [] and copies the full tree', () => {
  const parent = makeLocalParent({ name: 'p', description: 'p', include: [] });
  const child = makeChild(parent); // bare path, NOT file:// -> isGitSource false

  install(child, { force: true });

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')));
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')));
  assert.ok(existsSync(join(p, 'docs', 'adr.md')), 'local copy is full: include does not apply to cpSync path');
  assert.ok(existsSync(join(p, 'tests', 'x.txt')));
  assert.ok(existsSync(join(p, 'tools', 'runtime', 'dist', 'cli.js')));
});

// An include entry that looks like a git option (e.g. --no-cone) must be treated
// as a literal path thanks to the `--` end-of-options token, not switch off cone
// mode. It is a harmless no-op: essentials + root present, cone mode still on.
test('option-like include entry (--no-cone) is a harmless no-op, cone mode intact', () => {
  const parent = makeGitRepo({ name: 'p', description: 'p', include: ['--no-cone'] });
  const child = makeChild(`file://${parent}`);

  assert.doesNotThrow(() => install(child, { force: true }));

  const p = parentDirIn(child);
  assert.ok(existsSync(join(p, 'agent.yaml')), 'root files present');
  assert.ok(existsSync(join(p, 'skills', 'foo', 'SKILL.md')), 'essentials present');
  assert.ok(!existsSync(join(p, 'docs')), 'noise still excluded');
  const cone = git(p, ['config', 'core.sparseCheckoutCone']).trim();
  assert.equal(cone, 'true', 'cone mode not flipped off by the option-like entry');
});

// A malformed `include` (a scalar instead of a list) is a broken manifest: it
// must throw a clear error rather than silently spread the string into one
// sparse path per character.
test('malformed include (scalar) throws a clear error', () => {
  const parent = makeGitRepo({ name: 'p', description: 'p', include: 'foo' });
  const child = makeChild(`file://${parent}`);

  assert.throws(() => install(child, { force: true }), /include: must be a list of paths/);
});
