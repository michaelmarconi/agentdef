import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildInstructionDoc } from '../src/doc.js';
import { exportToClaudeCode } from '../src/adapters/claude-code.js';
import { exportToGemini } from '../src/adapters/gemini.js';
import { exportToCursorFiles } from '../src/adapters/cursor.js';

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

const BASE = {
  'agent.yaml': [
    'name: fixture',
    'description: test agent',
    'agents:',
    '  helper:',
    '    description: does helper things',
    '',
  ].join('\n'),
  'SOUL.md': '## Soul\nBe helpful.\n',
};
const KNOWLEDGE = {
  'knowledge/orders.md': '---\ntype: Table\ntitle: Orders\ndescription: One row per order.\n---\n',
};

describe('knowledge in instruction docs', () => {
  test('a repo without knowledge/ emits no Knowledge section anywhere (backwards compat)', () => {
    const root = fixture(BASE);
    assert.ok(!buildInstructionDoc(root).includes('## Knowledge'));
    assert.ok(!exportToClaudeCode(root).includes('## Knowledge'));
    assert.ok(!exportToGemini(root).includes('## Knowledge'));
    assert.ok(!exportToCursorFiles(root).some((f) => f.path.endsWith('knowledge-index.mdc')));
  });

  test('AGENTS.md gets the full static index, between skills position and delegation', () => {
    const root = fixture({ ...BASE, ...KNOWLEDGE });
    const doc = buildInstructionDoc(root, { delegation: true });
    assert.ok(doc.includes('### Orders (Table)'));
    assert.ok(doc.includes('Full document: `knowledge/orders.md`'));
    assert.ok(doc.indexOf('## Knowledge') < doc.indexOf('## Delegation Pattern'));
  });

  test('hook-mode docs (CLAUDE.md, GEMINI.md) get a breadcrumb, not the index', () => {
    const root = fixture({ ...BASE, ...KNOWLEDGE });
    const claude = exportToClaudeCode(root);
    assert.ok(claude.includes('## Knowledge'));
    assert.ok(claude.includes('.claude/settings.json'));
    assert.ok(!claude.includes('Full document:'));
    const gemini = exportToGemini(root);
    assert.ok(gemini.includes('## Knowledge'));
    assert.ok(gemini.includes('.gemini/settings.json'));
    assert.ok(!gemini.includes('Full document:'));
  });

  test('cursor gets an always-applied knowledge-index rule', () => {
    const root = fixture({ ...BASE, ...KNOWLEDGE });
    const rule = exportToCursorFiles(root).find((f) => f.path === '.cursor/rules/knowledge-index.mdc');
    assert.ok(rule);
    assert.ok(rule!.content.includes('alwaysApply: true'));
    assert.ok(rule!.content.includes('### Orders (Table)'));
  });

  test('a broken knowledge doc fails a direct export loudly (skills parity)', () => {
    const root = fixture({ ...BASE, 'knowledge/broken.md': 'no frontmatter' });
    assert.throws(() => buildInstructionDoc(root), /broken\.md/);
    assert.throws(() => exportToClaudeCode(root), /broken\.md/);
  });
});
