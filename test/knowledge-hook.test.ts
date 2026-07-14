import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runKnowledgeHook, INDEX_FILE } from '../src/knowledge-hook.js';
import { INLINE_INDEX_BUDGET } from '../src/knowledge.js';
import { AGENTDEF_DIR } from '../src/paths.js';

// The hook is the only channel that reaches a session, and it cannot report
// failure: non-zero exits and stderr are invisible there. So every case below
// asserts what lands in stdout, never that something threw.

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

function doc(type: string, title: string, description: string): string {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\n---\n\n# ${title}\n`;
}

// One doc renders to ~107 chars before its description, so a corpus that must
// exceed the budget is built from long descriptions rather than many files.
function corpus(count: number, descLength: number): Record<string, string> {
  const files: Record<string, string> = { 'agent.yaml': MANIFEST };
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(3, '0');
    files[`knowledge/wiki/doc-${n}.md`] = doc('wiki', `Doc ${n}`, 'x'.repeat(descLength));
  }
  return files;
}

describe('runKnowledgeHook: index below the budget', () => {
  test('injects the index itself, writes no file', () => {
    const root = fixture({
      'agent.yaml': MANIFEST,
      'knowledge/wiki/serp.md': doc('wiki', 'SERP-Analyse', 'How a SERP is read.'),
    });
    const { stdout } = runKnowledgeHook(root, 'claude');

    assert.match(stdout, /### SERP-Analyse \(wiki\)/);
    assert.match(stdout, /How a SERP is read\./);
    assert.ok(!existsSync(join(root, AGENTDEF_DIR, INDEX_FILE)), 'no file for a corpus that fits');
  });
});

describe('runKnowledgeHook: index above the budget', () => {
  test('injects a digest and parks the full index on disk', () => {
    const root = fixture(corpus(40, 400));
    const { stdout } = runKnowledgeHook(root, 'claude');

    // The point of the whole feature: what reaches the session stays small,
    // because past the host's undocumented limit it would be truncated instead.
    assert.ok(
      stdout.length < INLINE_INDEX_BUDGET,
      `digest must stay injectable, got ${stdout.length}`,
    );
    assert.match(stdout, /40 documents are indexed for this agent: wiki \(40\)/);
    assert.match(stdout, new RegExp(`${AGENTDEF_DIR}/${INDEX_FILE}`));
    assert.ok(!stdout.includes('Doc 039'), 'digest must not carry the entries');

    // Nothing is lost, it moved: every entry is in the file the digest points at.
    const written = readFileSync(join(root, AGENTDEF_DIR, INDEX_FILE), 'utf-8');
    assert.match(written, /### Doc 000 \(wiki\)/);
    assert.match(written, /### Doc 039 \(wiki\)/);
    assert.equal(written.match(/^### /gm)?.length, 40);
  });

  test('digest reports every type, largest group first', () => {
    const files = corpus(20, 400);
    files['knowledge/brand/voice.md'] = doc('brand', 'Voice', 'How the brand sounds.');
    files['knowledge/zued/engines.md'] = doc('zued', 'Engines', 'How engines differ.');
    files['knowledge/zued/crawling.md'] = doc('zued', 'Crawling', 'How crawling works.');
    const { stdout } = runKnowledgeHook(fixture(files), 'claude');

    assert.match(stdout, /wiki \(20\) · zued \(2\) · brand \(1\)/);
  });

  test('stays a digest as the corpus grows', () => {
    const small = runKnowledgeHook(fixture(corpus(40, 400)), 'claude').stdout;
    const large = runKnowledgeHook(fixture(corpus(200, 400)), 'claude').stdout;

    // A digest that grew with the corpus would eventually be truncated too, and
    // fail exactly like the index it replaces.
    assert.ok(large.length < INLINE_INDEX_BUDGET, `got ${large.length}`);
    assert.ok(
      large.length - small.length < 200,
      `digest must not scale with the corpus: ${small.length} -> ${large.length}`,
    );
  });

  test('rewrites the parked index on every run', () => {
    const root = fixture(corpus(40, 400));
    runKnowledgeHook(root, 'claude');

    writeFileSync(join(root, 'knowledge/wiki/doc-000.md'), doc('wiki', 'Renamed', 'y'.repeat(400)));
    runKnowledgeHook(root, 'claude');

    const written = readFileSync(join(root, AGENTDEF_DIR, INDEX_FILE), 'utf-8');
    assert.match(written, /### Renamed \(wiki\)/);
    assert.ok(!written.includes('### Doc 000'), 'stale entry must not survive');
  });

  test('falls back to the full index when the file cannot be written', () => {
    const root = fixture(corpus(40, 400));
    mkdirSync(join(root, AGENTDEF_DIR), { recursive: true });
    chmodSync(join(root, AGENTDEF_DIR), 0o500);
    after(() => chmodSync(join(root, AGENTDEF_DIR), 0o700));

    const { stdout, stderr } = runKnowledgeHook(root, 'claude');

    // Losing the corpus because a cache file could not be created would be worse
    // than injecting an index the host may truncate, which is the old behaviour.
    assert.match(stdout, /### Doc 000 \(wiki\)/);
    assert.ok(!stdout.includes('documents are indexed for this agent'), 'no digest without its file');
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /could not write/);
  });
});

describe('runKnowledgeHook: gemini envelope', () => {
  test('carries the digest as additionalContext, still one JSON object', () => {
    const { stdout } = runKnowledgeHook(fixture(corpus(40, 400)), 'gemini');
    const parsed = JSON.parse(stdout);

    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(parsed.hookSpecificOutput.additionalContext, /40 documents are indexed/);
  });
});
