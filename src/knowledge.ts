import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import type { KnowledgeMetadata } from './types.js';
import { collectSourceRoots } from './sources.js';
import { loadAgentManifest } from './loader.js';

// Knowledge documents follow Google's Open Knowledge Format (OKF, Apache-2.0):
// markdown files with YAML frontmatter where only `type` is required (and
// explicitly free-form — no central vocabulary, agentdef never interprets it).
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// Per the spec, consumers must tolerate unknown types, unknown extra keys, and
// missing optional fields; only a missing/empty `type` (or no frontmatter at
// all) is a conformance error, which per noord's fail-loud rule must throw.

export const DEFAULT_KNOWLEDGE_DIR = 'knowledge';

// OKF reserved filenames: directory listings and update logs, valid at any
// directory level. Never concept documents, so discovery skips them.
const RESERVED_FILES = new Set(['index.md', 'log.md']);

// The knowledge folder name for one chain level, from that level's agent.yaml
// (`knowledge: { dir: ... }`), defaulting to knowledge/. A resolver rather than
// a constant so every level of the extends chain can use its own name.
export function knowledgeDirName(levelDir: string): string {
  if (!existsSync(join(levelDir, 'agent.yaml'))) return DEFAULT_KNOWLEDGE_DIR;
  const dir = loadAgentManifest(levelDir)?.knowledge?.dir;
  return typeof dir === 'string' && dir.trim() !== '' ? dir : DEFAULT_KNOWLEDGE_DIR;
}

// OKF frontmatter only; bodies stay untouched so bundles remain OKF-portable.
export function loadKnowledgeMetadata(filePath: string, rootDir: string): KnowledgeMetadata {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`knowledge doc at ${filePath} is missing YAML frontmatter (---)`);
  }
  const fm = yaml.load(match[1]) as Record<string, unknown> | null;
  const type = fm?.type == null ? '' : String(fm.type).trim();
  if (type === '') {
    throw new Error(`knowledge doc at ${filePath} is missing the required OKF field: type`);
  }
  const timestamp = fm?.timestamp;
  return {
    type,
    title: fm?.title ? String(fm.title) : basename(filePath, '.md'),
    description: fm?.description ? String(fm.description) : undefined,
    tags: Array.isArray(fm?.tags) ? fm.tags.map(String) : undefined,
    timestamp:
      timestamp instanceof Date
        ? timestamp.toISOString()
        : timestamp != null
          ? String(timestamp)
          : undefined,
    resource: fm?.resource ? String(fm.resource) : undefined,
    relPath: relative(rootDir, filePath),
    path: filePath,
  };
}

// Recursive: OKF bundles are arbitrary directory trees (unlike skills' fixed
// one-level layout). Only .md files count; everything else is bundle assets.
// Symlinks are not followed (isDirectory() is false for them — skills parity).
function listKnowledgeFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      listKnowledgeFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith('.md') && !RESERVED_FILES.has(entry.name)) {
      out.push(path);
    }
  }
}

export interface KnowledgeCollection {
  entries: KnowledgeMetadata[];
  errors: string[];
}

// Merged across local knowledge/ + the extends parent + deps, deduped by
// relPath (the OKF concept ID) with the nearest definition winning, then sorted
// by relPath (code-unit order — deterministic across machines and locales).
// Lenient by design: per-file errors are collected, not thrown, because the two
// consumers need different failure modes — validate() turns them into fail-loud
// build errors (so sync aborts), while the session-start hook must keep every
// parseable entry and degrade with a marker instead of breaking sessions.
export function collectKnowledgeMetadata(agentDir: string): KnowledgeCollection {
  const seen = new Set<string>();
  const entries: KnowledgeMetadata[] = [];
  const errors: string[] = [];
  for (const root of collectSourceRoots(resolve(agentDir), knowledgeDirName)) {
    const files: string[] = [];
    listKnowledgeFiles(root, files);
    for (const file of files) {
      try {
        const doc = loadKnowledgeMetadata(file, root);
        if (seen.has(doc.relPath)) continue;
        seen.add(doc.relPath);
        entries.push(doc);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { entries, errors };
}

// For build-time consumers (the adapters): a broken knowledge doc must surface,
// not vanish from the generated index. Under sync, validate() reports the same
// errors first (with all of them at once), so this throw is only ever reached
// by a direct `agentdef export`.
export function collectKnowledgeMetadataStrict(agentDir: string): KnowledgeMetadata[] {
  const { entries, errors } = collectKnowledgeMetadata(agentDir);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  return entries;
}

// The ONE index renderer, shared by the static instruction-file sections and
// the session-start hook so both inject byte-identical content. Compact by
// design (type, title, description, pointer — tags/timestamp/resource are
// parsed but not rendered): tools load the full document on demand via the
// pointer, like the skills index. Pointers are real repo-relative paths —
// knowledge is indexed, never mirrored, so inherited docs point into the
// regenerated .agentdef/ cache (fine: instruction files are themselves
// gitignored build artifacts that only exist alongside that cache).
export function renderKnowledgeIndex(
  entries: KnowledgeMetadata[],
  opts: { agentDir: string },
): string {
  const agentDir = resolve(opts.agentDir);
  const parts: string[] = ['## Knowledge', ''];
  for (const doc of entries) {
    parts.push(`### ${doc.title} (${doc.type})`);
    if (doc.description) parts.push(doc.description);
    parts.push(`Full document: \`${relative(agentDir, doc.path)}\``);
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

// For hook-mode instruction files (CLAUDE.md, GEMINI.md): the full index is
// injected fresh at session start, so the file itself only carries a pointer —
// humans reading it still learn the corpus exists, and an agent whose hook
// never ran can still browse the folder.
export function renderKnowledgeBreadcrumb(knowledgeDir: string, settingsFile: string): string {
  return [
    '## Knowledge',
    '',
    `A knowledge index from \`${knowledgeDir}/\` is injected fresh at each session start`,
    `via a SessionStart hook (registered in \`${settingsFile}\` by \`agentdef sync\`).`,
    `If it is missing from context, run \`agentdef sync\` and start a new session.`,
  ].join('\n');
}
