import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionHook, removeSessionHook, KNOWLEDGE_HOOK } from '../src/hooks.js';

const dirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentdef-test-'));
  dirs.push(root);
  return root;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CLAUDE = KNOWLEDGE_HOOK['claude-code'];

describe('ensureSessionHook', () => {
  test('creates a fresh settings file with the SessionStart entry', () => {
    const root = fixture();
    const r = ensureSessionHook(root, CLAUDE);
    assert.equal(r.changed, true);
    assert.deepEqual(r.warnings, []);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf-8'));
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0].matcher, 'startup|resume|clear');
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /agentdef knowledge hook claude/);
  });

  test('running twice is identical to running once', () => {
    const root = fixture();
    ensureSessionHook(root, CLAUDE);
    const once = readFileSync(join(root, '.claude/settings.json'), 'utf-8');
    const r = ensureSessionHook(root, CLAUDE);
    assert.equal(r.changed, false);
    assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf-8'), once);
  });

  test('appends to existing hooks and preserves every user key', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    );
    const r = ensureSessionHook(root, CLAUDE);
    assert.equal(r.changed, true);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf-8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  });

  test('respects a user-edited agentdef entry instead of duplicating it', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const edited = {
      hooks: {
        SessionStart: [
          // user changed the matcher and dropped the guard — still ours
          { matcher: 'startup', hooks: [{ type: 'command', command: 'agentdef knowledge hook claude --dir /elsewhere' }] },
        ],
      },
    };
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(edited));
    const r = ensureSessionHook(root, CLAUDE);
    assert.equal(r.changed, false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf-8')), edited);
  });

  test('warns and leaves the file untouched on invalid JSON', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'), { recursive: true });
    const broken = '{ "hooks": /* JSONC comment */ {} }';
    writeFileSync(join(root, '.claude/settings.json'), broken);
    const r = ensureSessionHook(root, CLAUDE);
    assert.equal(r.changed, false);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /not parseable JSON/);
    assert.match(r.warnings[0], /agentdef knowledge hook claude/); // paste-ready snippet
    assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf-8'), broken);
  });

  test('warns and skips on a wrong-typed hooks or SessionStart value', () => {
    const root = fixture();
    mkdirSync(join(root, '.gemini'), { recursive: true });
    const gemini = KNOWLEDGE_HOOK['gemini'];
    writeFileSync(join(root, '.gemini/settings.json'), JSON.stringify({ hooks: { SessionStart: 'nope' } }));
    const r = ensureSessionHook(root, gemini);
    assert.equal(r.changed, false);
    assert.match(r.warnings[0], /"hooks\.SessionStart" value that is not an array/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.gemini/settings.json'), 'utf-8')), {
      hooks: { SessionStart: 'nope' },
    });
  });

  test('removeSessionHook drops only the agentdef entry and prunes what it emptied', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          SessionStart: [
            { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] },
            // hand-edited agentdef entry: explicit unhook still removes it
            { matcher: 'resume', hooks: [{ type: 'command', command: 'ad knowledge hook claude' }] },
          ],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo untouched' }] }],
        },
      }),
    );
    const r = removeSessionHook(root, CLAUDE);
    assert.equal(r.changed, true);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf-8'));
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo mine');
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo untouched');
  });

  test('removeSessionHook after ensureSessionHook restores an entry-free SessionStart', () => {
    const root = fixture();
    ensureSessionHook(root, CLAUDE);
    const r = removeSessionHook(root, CLAUDE);
    assert.equal(r.changed, true);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf-8'));
    assert.equal(settings.hooks, undefined); // emptied containers pruned
  });

  test('removeSessionHook is a no-op without a file or without our entry', () => {
    const root = fixture();
    assert.deepEqual(removeSessionHook(root, CLAUDE), {
      changed: false,
      path: join(root, '.claude/settings.json'),
      warnings: [],
    });
    mkdirSync(join(root, '.claude'), { recursive: true });
    const other = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo x' }] }] } });
    writeFileSync(join(root, '.claude/settings.json'), other);
    const r = removeSessionHook(root, CLAUDE);
    assert.equal(r.changed, false);
    assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf-8'), other);
  });

  test('removeSessionHook warns and leaves invalid JSON untouched', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), '{ not json');
    const r = removeSessionHook(root, CLAUDE);
    assert.equal(r.changed, false);
    assert.match(r.warnings[0], /not parseable JSON/);
    assert.equal(readFileSync(join(root, '.claude/settings.json'), 'utf-8'), '{ not json');
  });

  test('gemini command guard emits a valid empty envelope by itself', () => {
    // The guard runs when agentdef is missing; Gemini still parses stdout as
    // JSON, so the printf payload must be a valid envelope.
    const gemini = KNOWLEDGE_HOOK['gemini'];
    const printfMatch = gemini.command.match(/printf '([^']+)'/);
    assert.ok(printfMatch, 'gemini guard must printf an envelope');
    const envelope = JSON.parse(printfMatch![1]);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(envelope.hookSpecificOutput.additionalContext, '');
  });
});
