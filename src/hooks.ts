import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Registration of the knowledge SessionStart hook (see knowledge-hook.ts) in a
// tool's settings file. Only tools with a DEDICATED config surface are hook-mode:
// the AGENTS.md family (codex, opencode, antigravity, kiro, copilot) shares one
// instruction file, so it carries the static index instead — its content must be
// identical no matter which of those adapters asked. A future adapter becomes
// hook-mode by adding a row here (plus, if its settings shape differs from the
// hooks/SessionStart form below, a shape variant in ensureSessionHook).

export interface KnowledgeHookTarget {
  settingsFile: string; // repo-relative settings path the hook is registered in
  command: string; // the exact command string written into that settings file
}

// Both commands carry an inline missing-binary guard (the settings file may be
// committed and reach machines without agentdef, same philosophy as init.ts's
// MISSING_GUARD): claude tolerates empty stdout, but gemini parses stdout as
// JSON, so its guard must itself print a valid empty envelope. POSIX sh only,
// matching the git hooks' precedent.
const CLAUDE_HOOK_COMMAND =
  'command -v agentdef >/dev/null 2>&1 || exit 0; ' +
  'agentdef knowledge hook claude --dir "${CLAUDE_PROJECT_DIR:-.}"';
const GEMINI_HOOK_COMMAND =
  'command -v agentdef >/dev/null 2>&1 || ' +
  `{ printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}'; exit 0; }; ` +
  'agentdef knowledge hook gemini';

export const KNOWLEDGE_HOOK: Record<string, KnowledgeHookTarget> = {
  'claude-code': { settingsFile: '.claude/settings.json', command: CLAUDE_HOOK_COMMAND },
  claude: { settingsFile: '.claude/settings.json', command: CLAUDE_HOOK_COMMAND },
  gemini: { settingsFile: '.gemini/settings.json', command: GEMINI_HOOK_COMMAND },
};

// The presence invariant: any SessionStart command mentioning `agentdef
// knowledge hook` (or the `ad` alias) counts as registered. Substring matching,
// not equality, so a user who edited our entry (changed matcher, added a
// timeout, swapped --dir) is respected — never duplicated, never "corrected".
const REGISTERED_RE = /\b(agentdef|ad) knowledge hook\b/;

export interface EnsureHookResult {
  changed: boolean;
  path: string;
  warnings: string[];
}

function manualSnippet(target: KnowledgeHookTarget): string {
  const entry = {
    hooks: {
      SessionStart: [
        { matcher: 'startup|resume|clear', hooks: [{ type: 'command', command: target.command }] },
      ],
    },
  };
  return JSON.stringify(entry);
}

// Idempotently register the hook in the tool's settings file. The file is
// user-owned: anything unexpected (invalid JSON — possibly legitimate JSONC the
// tool itself accepts — or a wrong-typed hooks/SessionStart) means warn-and-skip
// with a paste-ready snippet, never touch the file, never fail the sync over a
// file we don't own. Registered entries are only ever appended; removal is
// deliberately manual (a stale hook is a silent no-op, and auto-removal could
// not tell our entry from one the user customized).
export function ensureSessionHook(agentDir: string, target: KnowledgeHookTarget): EnsureHookResult {
  const path = join(agentDir, target.settingsFile);
  const skip = (reason: string): EnsureHookResult => ({
    changed: false,
    path,
    warnings: [
      `warning: ${target.settingsFile} ${reason} — knowledge SessionStart hook not registered. Merge it manually: ${manualSnippet(target)}`,
    ],
  });

  const original = existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
  let root: Record<string, unknown> = {};
  if (original !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      return skip('is not parseable JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return skip('is not a JSON object');
    }
    root = parsed as Record<string, unknown>;
  }

  const hooks = root.hooks === undefined ? {} : root.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return skip('has a "hooks" value that is not an object');
  }
  const hooksObj = hooks as Record<string, unknown>;
  const sessionStart = hooksObj.SessionStart === undefined ? [] : hooksObj.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return skip('has a "hooks.SessionStart" value that is not an array');
  }

  for (const matcherEntry of sessionStart) {
    const inner = (matcherEntry as Record<string, unknown> | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const command = (hook as Record<string, unknown> | null)?.command;
      if (typeof command === 'string' && REGISTERED_RE.test(command)) {
        return { changed: false, path, warnings: [] };
      }
    }
  }

  sessionStart.push({
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: target.command }],
  });
  hooksObj.SessionStart = sessionStart;
  root.hooks = hooksObj;

  // Whole-document parse -> mutate -> stringify keeps every user key; only the
  // formatting normalizes to 2-space indent. Write only on an actual change.
  const next = `${JSON.stringify(root, null, 2)}\n`;
  if (next === original) return { changed: false, path, warnings: [] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { changed: true, path, warnings: [] };
}

// The inverse, for `agentdef knowledge unhook <tool>`: drop every SessionStart
// command matching the registration invariant, keep everything else, and prune
// only the containers this leaves empty. Removal here is explicit user intent,
// so matching entries go even if they were hand-edited. Note the next sync
// re-registers while knowledge exists, unless agent.yaml sets
// knowledge: { hook: false } — the caller prints that hint.
export function removeSessionHook(agentDir: string, target: KnowledgeHookTarget): EnsureHookResult {
  const path = join(agentDir, target.settingsFile);
  const skip = (reason: string): EnsureHookResult => ({
    changed: false,
    path,
    warnings: [
      `warning: ${target.settingsFile} ${reason} — remove the entry whose command contains "agentdef knowledge hook" manually`,
    ],
  });

  if (!existsSync(path)) return { changed: false, path, warnings: [] };
  const original = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return skip('is not parseable JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return skip('is not a JSON object');
  }
  const root = parsed as Record<string, unknown>;
  const hooks = root.hooks;
  if (hooks === undefined) return { changed: false, path, warnings: [] };
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return skip('has a "hooks" value that is not an object');
  }
  const hooksObj = hooks as Record<string, unknown>;
  const sessionStart = hooksObj.SessionStart;
  if (sessionStart === undefined) return { changed: false, path, warnings: [] };
  if (!Array.isArray(sessionStart)) {
    return skip('has a "hooks.SessionStart" value that is not an array');
  }

  let removed = false;
  const kept: unknown[] = [];
  for (const matcherEntry of sessionStart) {
    const entry = matcherEntry as Record<string, unknown> | null;
    const inner = entry?.hooks;
    if (Array.isArray(inner)) {
      const keptInner = inner.filter((hook) => {
        const command = (hook as Record<string, unknown> | null)?.command;
        return !(typeof command === 'string' && REGISTERED_RE.test(command));
      });
      if (keptInner.length !== inner.length) {
        removed = true;
        if (keptInner.length === 0) continue; // matcher entry existed only for us
        kept.push({ ...entry, hooks: keptInner });
        continue;
      }
    }
    kept.push(matcherEntry);
  }
  if (!removed) return { changed: false, path, warnings: [] };

  if (kept.length > 0) hooksObj.SessionStart = kept;
  else delete hooksObj.SessionStart;
  if (Object.keys(hooksObj).length === 0) delete root.hooks;

  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { changed: true, path, warnings: [] };
}
