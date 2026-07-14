import { buildInstructionDoc } from '../doc.js';

// AGENTS.md: the universal instruction file (Codex, Cursor, Kimi, Grok,
// Antigravity, Windsurf, Zed, ...). Skills and knowledge are indexed (metadata
// plus a pointer per entry), not inlined: the tools load them on demand. The
// runtime codex.json the upstream tool also emitted is not generated: that is
// per-machine config, not derived from source.
export function exportToAgentsMd(dir: string): string {
  return buildInstructionDoc(dir);
}
