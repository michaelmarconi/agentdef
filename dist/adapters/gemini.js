import { buildInstructionDoc } from '../doc.js';
// GEMINI.md: same shape as AGENTS.md plus a delegation (sub-agents) section and
// an optional memory section, which Gemini CLI documents inline. Knowledge is a
// breadcrumb only: gemini is a hook-mode adapter, the index is injected fresh at
// session start via the SessionStart hook sync registers in .gemini/settings.json
// (see hooks.ts). Model endpoint and MCP config stay per-machine, not generated.
export function exportToGemini(dir) {
    return buildInstructionDoc(dir, {
        delegation: true,
        memory: true,
        knowledgeBreadcrumb: '.gemini/settings.json',
    });
}
