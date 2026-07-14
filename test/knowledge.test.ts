import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadKnowledgeMetadata,
  collectKnowledgeMetadata,
  collectKnowledgeMetadataStrict,
  renderKnowledgeIndex,
  knowledgeDirName,
} from '../src/knowledge.js';

// Fixtures are the MATERIALIZED layout (.agentdef/parent already on disk), so
// no install() run is needed — exactly what the collectors read after a sync.

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

describe('loadKnowledgeMetadata', () => {
  test('reads OKF frontmatter, tolerating unknown keys and a free-form type', () => {
    const root = fixture({
      'knowledge/tables/orders.md': [
        '---',
        'type: BigQuery Table',
        'title: Orders',
        'description: One row per order.',
        'tags: [sales, revenue]',
        'timestamp: 2026-05-28T14:30:00Z',
        'resource: https://console.cloud.google.com/bigquery?t=orders',
        'owner: someone-unknown-key',
        '---',
        '# Orders',
      ].join('\n'),
    });
    const doc = loadKnowledgeMetadata(join(root, 'knowledge/tables/orders.md'), join(root, 'knowledge'));
    assert.equal(doc.type, 'BigQuery Table');
    assert.equal(doc.title, 'Orders');
    assert.equal(doc.description, 'One row per order.');
    assert.deepEqual(doc.tags, ['sales', 'revenue']);
    assert.equal(doc.timestamp, '2026-05-28T14:30:00.000Z');
    assert.equal(doc.resource, 'https://console.cloud.google.com/bigquery?t=orders');
    assert.equal(doc.relPath, 'tables/orders.md');
  });

  test('derives the title from the filename when absent', () => {
    const root = fixture({ 'knowledge/runbook-deploy.md': '---\ntype: Runbook\n---\nBody' });
    const doc = loadKnowledgeMetadata(join(root, 'knowledge/runbook-deploy.md'), join(root, 'knowledge'));
    assert.equal(doc.title, 'runbook-deploy');
  });

  test('throws on missing frontmatter', () => {
    const root = fixture({ 'knowledge/plain.md': '# no frontmatter here' });
    assert.throws(
      () => loadKnowledgeMetadata(join(root, 'knowledge/plain.md'), join(root, 'knowledge')),
      /missing YAML frontmatter/,
    );
  });

  test('throws on missing or empty type (the OKF conformance boundary)', () => {
    const root = fixture({
      'knowledge/no-type.md': '---\ntitle: Nope\n---\nBody',
      'knowledge/empty-type.md': '---\ntype: "  "\n---\nBody',
    });
    assert.throws(
      () => loadKnowledgeMetadata(join(root, 'knowledge/no-type.md'), join(root, 'knowledge')),
      /required OKF field: type/,
    );
    assert.throws(
      () => loadKnowledgeMetadata(join(root, 'knowledge/empty-type.md'), join(root, 'knowledge')),
      /required OKF field: type/,
    );
  });
});

describe('collectKnowledgeMetadata', () => {
  test('discovers recursively, skips reserved files at every level, ignores non-md, sorts by relPath', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/index.md': '# reserved, no frontmatter on purpose',
      'knowledge/log.md': '# reserved',
      'knowledge/zeta.md': '---\ntype: Concept\n---\n',
      'knowledge/asset.csv': 'not,markdown',
      'knowledge/tables/index.md': '# reserved nested',
      'knowledge/tables/orders.md': '---\ntype: Table\n---\n',
    });
    const { entries, errors } = collectKnowledgeMetadata(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.relPath),
      ['tables/orders.md', 'zeta.md'],
    );
  });

  test('returns empty for a repo without a knowledge dir', () => {
    const root = fixture({ 'agent.yaml': MANIFEST });
    assert.deepEqual(collectKnowledgeMetadata(root), { entries: [], errors: [] });
  });

  test('dedupes by relPath across the extends chain, nearest wins', () => {
    const root = fixture({
      'agent.yaml': `${MANIFEST}extends: ../whatever\n`,
      'knowledge/shared.md': '---\ntype: Concept\ndescription: local wins\n---\n',
      '.agentdef/parent/agent.yaml': MANIFEST,
      '.agentdef/parent/knowledge/shared.md': '---\ntype: Concept\ndescription: shadowed\n---\n',
      '.agentdef/parent/knowledge/inherited.md': '---\ntype: Runbook\n---\n',
    });
    const { entries, errors } = collectKnowledgeMetadata(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.relPath),
      ['inherited.md', 'shared.md'],
    );
    const shared = entries.find((e) => e.relPath === 'shared.md');
    assert.equal(shared?.description, 'local wins');
    const inherited = entries.find((e) => e.relPath === 'inherited.md');
    assert.ok(inherited?.path.includes(join('.agentdef', 'parent', 'knowledge')));
  });

  test('honors knowledge.dir from agent.yaml per chain level', () => {
    const root = fixture({
      'agent.yaml': `${MANIFEST}knowledge:\n  dir: docs/kb\n`,
      'docs/kb/local.md': '---\ntype: Concept\n---\n',
      'knowledge/ignored.md': '---\ntype: Concept\n---\n',
      '.agentdef/parent/agent.yaml': MANIFEST,
      '.agentdef/parent/knowledge/inherited.md': '---\ntype: Concept\n---\n',
    });
    assert.equal(knowledgeDirName(root), 'docs/kb');
    const { entries } = collectKnowledgeMetadata(root);
    // local level reads docs/kb (not knowledge/); the parent level uses its own default
    assert.deepEqual(
      entries.map((e) => e.relPath).sort(),
      ['inherited.md', 'local.md'],
    );
  });

  test('collects per-file errors leniently while keeping parseable entries', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/good.md': '---\ntype: Concept\n---\n',
      'knowledge/broken.md': 'no frontmatter',
    });
    const { entries, errors } = collectKnowledgeMetadata(root);
    assert.equal(entries.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken\.md/);
    assert.throws(() => collectKnowledgeMetadataStrict(root), /broken\.md/);
  });
});

describe('renderKnowledgeIndex', () => {
  test('renders the compact index: title, type, description, pointer', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/tables/orders.md':
        '---\ntype: Table\ntitle: Orders\ndescription: One row per order.\n---\n',
      'knowledge/zeta.md': '---\ntype: Concept\n---\n',
    });
    const { entries } = collectKnowledgeMetadata(root);
    assert.equal(
      renderKnowledgeIndex(entries, { agentDir: root }),
      [
        '## Knowledge',
        '',
        '### Orders (Table)',
        'One row per order.',
        'Full document: `knowledge/tables/orders.md`',
        '',
        '### zeta (Concept)',
        'Full document: `knowledge/zeta.md`',
      ].join('\n'),
    );
  });
});
