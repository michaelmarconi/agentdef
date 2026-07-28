// Covers the three changes that came out of the 0.7.0 rollout, where every
// consumer repo with a pre-existing knowledge/ folder went red at once:
//   - a plain README.md in the tree is a folder explainer, not a broken doc
//   - errors name a path the reader can open, not the CI runner's absolute one
//   - `knowledge lint [--fix]` makes "add frontmatter to 138 files" mechanical
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { collectKnowledgeMetadata, lintKnowledge } from '../src/knowledge.js';
import { validate } from '../src/validate.js';

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

const MANIFEST = 'name: fixture\ndescription: test agent\n';

describe('README.md in the knowledge tree', () => {
  // hstm-allgemein's knowledge/seo/README.md is a table of where each export
  // came from. It has no meaningful OKF type, and failing the build over it
  // teaches people that the check is noise.
  test('a plain README is skipped, not reported as broken', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/seo/README.md': '# SEO-Operativdaten\n\nWoher welcher Export kommt.\n',
      'knowledge/seo/real.md': '---\ntype: seo\n---\nbody\n',
    });
    const { entries, errors } = collectKnowledgeMetadata(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.map((e) => e.relPath), ['seo/real.md']);
  });

  // The skip is conditional on purpose: noord-template-repo deliberately made
  // its knowledge/README.md OKF-conform, and an unconditional skip would have
  // silently dropped it from every index.
  test('a README that carries OKF frontmatter stays indexed', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/README.md': '---\ntype: guide\ntitle: How this folder works\n---\nbody\n',
    });
    const { entries, errors } = collectKnowledgeMetadata(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.map((e) => e.title), ['How this folder works']);
  });

  test('lint neither reports nor rewrites a plain README', () => {
    const root = fixture({ 'agent.yaml': MANIFEST, 'knowledge/README.md': '# explainer\n' });
    const before = readFileSync(join(root, 'knowledge/README.md'), 'utf-8');
    assert.deepEqual(lintKnowledge(root, { fix: true }), { findings: [], fixed: [] });
    assert.equal(readFileSync(join(root, 'knowledge/README.md'), 'utf-8'), before);
  });
});

describe('error paths are actionable', () => {
  // The CI log showed /home/runner/work/d24-allgemein/d24-allgemein/knowledge/
  // brand/x.md, a path that exists on no developer machine.
  test('errors are relative to the agent dir, not absolute', () => {
    const root = fixture({ 'agent.yaml': MANIFEST, 'knowledge/brand/competitors.md': '# no frontmatter\n' });
    const { errors } = collectKnowledgeMetadata(root);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], join('knowledge', 'brand', 'competitors.md') + ' is missing YAML frontmatter (---)');
    assert.ok(!errors[0].includes(root), 'the absolute fixture path must not appear');
  });

  test('an inherited doc is visibly inherited', () => {
    const root = fixture({
      'agent.yaml': `${MANIFEST}extends: ../whatever\n`,
      '.agentdef/parent/agent.yaml': MANIFEST,
      '.agentdef/parent/knowledge/broken.md': '# no frontmatter\n',
    });
    const { errors } = collectKnowledgeMetadata(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\.agentdef[/\\]parent[/\\]knowledge[/\\]broken\.md/);
  });

  test('validate carries one remedy for the local case and a different one for inherited', () => {
    const local = fixture({ 'agent.yaml': MANIFEST, 'knowledge/a.md': 'x', 'knowledge/b.md': 'y' });
    const issues = validate(local).filter((i) => i.message.startsWith('knowledge:'));
    assert.equal(issues.length, 2, 'one issue per broken file');
    assert.equal(new Set(issues.map((i) => i.hint)).size, 1, 'but a single shared remedy');
    assert.match(issues[0].hint ?? '', /knowledge lint --fix/);

    const inherited = fixture({
      'agent.yaml': `${MANIFEST}extends: ../w\n`,
      '.agentdef/parent/agent.yaml': MANIFEST,
      '.agentdef/parent/knowledge/broken.md': 'x',
    });
    const hint = validate(inherited).find((i) => i.message.startsWith('knowledge:'))?.hint ?? '';
    assert.match(hint, /parent repo/, 'an inherited doc is not fixed by lint --fix here');
  });
});

describe('knowledge lint', () => {
  test('reports without --fix and does not touch the file', () => {
    const root = fixture({ 'agent.yaml': MANIFEST, 'knowledge/brand/competitors.md': '# Competitors\n\nbody\n' });
    const before = readFileSync(join(root, 'knowledge/brand/competitors.md'), 'utf-8');

    const r = lintKnowledge(root);

    assert.equal(r.findings.length, 1);
    assert.deepEqual(r.fixed, []);
    assert.equal(r.findings[0].reason, 'missing-frontmatter');
    assert.deepEqual(r.findings[0].proposed, { type: 'brand', title: 'Competitors' });
    assert.equal(readFileSync(join(root, 'knowledge/brand/competitors.md'), 'utf-8'), before);
  });

  test('--fix writes frontmatter and the doc then validates', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/brand/competitors.md': '# Competitors\n\nbody\n',
      'knowledge/loose.md': 'no heading at all\n',
    });

    const r = lintKnowledge(root, { fix: true });

    assert.equal(r.fixed.length, 2);
    // Type from the folder, title from the first H1.
    assert.match(
      readFileSync(join(root, 'knowledge/brand/competitors.md'), 'utf-8'),
      /^---\ntype: brand\ntitle: Competitors\n---\n\n# Competitors/,
    );
    // No folder and no heading: neutral type, filename as title. The body is
    // preserved byte for byte, only prefixed.
    assert.match(
      readFileSync(join(root, 'knowledge/loose.md'), 'utf-8'),
      /^---\ntype: note\ntitle: loose\n---\n\nno heading at all\n$/,
    );
    assert.deepEqual(collectKnowledgeMetadata(root).errors, [], 'validate-clean after the fix');
    assert.deepEqual(lintKnowledge(root).findings, [], 'and idempotent');
  });

  // Frontmatter that is present but unusable is a half-written annotation. It
  // carries an intent lint cannot read, so overwriting it would destroy work.
  test('a doc with frontmatter but no type is reported, never rewritten', () => {
    const root = fixture({ 'agent.yaml': MANIFEST, 'knowledge/half.md': '---\ntitle: Started\n---\nbody\n' });
    const before = readFileSync(join(root, 'knowledge/half.md'), 'utf-8');

    const r = lintKnowledge(root, { fix: true });

    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].reason, 'malformed-frontmatter');
    assert.deepEqual(r.fixed, [], 'must not auto-repair');
    assert.equal(readFileSync(join(root, 'knowledge/half.md'), 'utf-8'), before);
  });

  // The chain lives under .agentdef/, a regenerable cache belonging to another
  // repo. Writing there would be undone by the next sync.
  test('never writes into the extends chain', () => {
    const root = fixture({
      'agent.yaml': `${MANIFEST}extends: ../w\n`,
      '.agentdef/parent/agent.yaml': MANIFEST,
      '.agentdef/parent/knowledge/broken.md': 'no frontmatter\n',
    });
    const r = lintKnowledge(root, { fix: true });
    assert.deepEqual(r.findings, []);
    assert.equal(readFileSync(join(root, '.agentdef/parent/knowledge/broken.md'), 'utf-8'), 'no frontmatter\n');
  });

  // hstm-allgemein has knowledge/seo/internal-linking/<campaign>/<doc>.md. The
  // immediate parent is a per-campaign folder, so using it would emit a type of
  // "hansetherm-waermepumpe-2026-05": a folder name masquerading as a category.
  test('type comes from the top-level folder, not the immediate parent', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/seo/internal-linking/hansetherm-waermepumpe-2026-05/targets.md': '# Targets\n',
      'knowledge/brand/x.md': '# X\n',
      'knowledge/team.md': '# Team\n',
    });
    const types = Object.fromEntries(
      lintKnowledge(root).findings.map((f) => [f.relPath, f.proposed?.type]),
    );
    assert.equal(types[join('knowledge/seo/internal-linking/hansetherm-waermepumpe-2026-05/targets.md')], 'seo');
    assert.equal(types[join('knowledge/brand/x.md')], 'brand');
    assert.equal(types[join('knowledge/team.md')], 'note');
  });

  test('honors a renamed knowledge.dir', () => {
    const root = fixture({
      'agent.yaml': `${MANIFEST}knowledge:\n  dir: wissen\n`,
      'wissen/brand/x.md': 'body\n',
      'knowledge/ignored.md': 'body\n',
    });
    const r = lintKnowledge(root, { fix: true });
    assert.deepEqual(r.fixed, [join('wissen', 'brand', 'x.md')]);
  });

  test('titles that would break YAML are quoted', () => {
    const root = fixture({ 'agent.yaml': MANIFEST, 'knowledge/x.md': '# Preise: 2026\n' });
    lintKnowledge(root, { fix: true });
    assert.match(readFileSync(join(root, 'knowledge/x.md'), 'utf-8'), /^---\ntype: note\ntitle: "Preise: 2026"\n---/);
    assert.deepEqual(collectKnowledgeMetadata(root).errors, [], 'and the result still parses');
  });

  test('a repo with no knowledge dir is clean, not an error', () => {
    const root = fixture({ 'agent.yaml': MANIFEST });
    assert.deepEqual(lintKnowledge(root, { fix: true }), { findings: [], fixed: [] });
  });
});
