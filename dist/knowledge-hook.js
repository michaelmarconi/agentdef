import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadAgentManifest } from './loader.js';
import { INLINE_INDEX_BUDGET, collectKnowledgeMetadata, renderKnowledgeDigest, renderKnowledgeIndex, } from './knowledge.js';
import { AGENTDEF_DIR } from './paths.js';
// The implementation behind `agentdef knowledge hook <tool>`: the SessionStart
// hook that sync registers in the tool's settings (see hooks.ts). It prints the
// same index the static sections carry — rendered live from on-disk state, so
// local edits and pulled parent changes surface at the next session start with
// no re-sync in between. No network, no install(): it reads whatever the last
// sync materialized under .agentdef/.
//
// Session-start failure semantics differ deliberately from agentdef's build-time
// fail-loud rule: a hook that exits non-zero or crashes degrades EVERY session,
// and hook stderr is effectively invisible. So the hook always succeeds and
// reports problems in-band, as a marker appended to the injected context — the
// one channel guaranteed to reach a human — while validate()/sync remain the
// fail-loud enforcement point for the same errors.
// Lives under the cache dir because it is exactly that: regenerable, gitignored,
// rewritten at every session start.
export const INDEX_FILE = 'knowledge-index.md';
function buildPayload(agentDir, stderr) {
    // Not an agentdef repo: the hook fires wherever the settings file reaches
    // (fresh clones, copied configs), so this must be a silent no-op.
    if (!existsSync(join(agentDir, 'agent.yaml')))
        return '';
    const { entries, errors } = collectKnowledgeMetadata(agentDir);
    const markers = [];
    for (const error of errors) {
        markers.push(`> [agentdef] knowledge index incomplete — ${error}. Run 'agentdef validate'.`);
        stderr.push(error);
    }
    // extends declared but never materialized (e.g. a fresh clone with committed
    // settings, before the first sync): inherited knowledge is invisible here.
    const manifest = loadAgentManifest(agentDir);
    if (manifest.extends && !existsSync(join(agentDir, AGENTDEF_DIR, 'parent', 'agent.yaml'))) {
        markers.push(`> [agentdef] inherited knowledge may be missing (extends parent not materialized — run 'agentdef sync').`);
    }
    const parts = [];
    if (entries.length > 0)
        parts.push(renderIndexOrDigest(agentDir, entries, stderr));
    if (markers.length > 0)
        parts.push(markers.join('\n'));
    return parts.join('\n\n');
}
// Writing is the only side effect this hook has, and it stays subordinate to
// injecting something: a failed write falls back to the full index inline, which
// is what every release before this one did anyway.
function renderIndexOrDigest(agentDir, entries, stderr) {
    const index = renderKnowledgeIndex(entries, { agentDir });
    if (index.length <= INLINE_INDEX_BUDGET)
        return index;
    const indexPath = join(agentDir, AGENTDEF_DIR, INDEX_FILE);
    try {
        mkdirSync(dirname(indexPath), { recursive: true });
        writeFileSync(indexPath, `${index}\n`);
    }
    catch (e) {
        stderr.push(`agentdef knowledge hook: could not write ${indexPath}: ${e.message}`);
        return index;
    }
    return renderKnowledgeDigest(entries, { indexPath: join(AGENTDEF_DIR, INDEX_FILE) });
}
// Always exits cleanly (the caller writes stdout/stderr and exits 0): parseable
// entries are emitted even when others fail, and any unexpected error collapses
// to an empty payload with the detail on stderr.
export function runKnowledgeHook(dir, tool) {
    const stderr = [];
    let payload = '';
    try {
        payload = buildPayload(resolve(dir), stderr);
    }
    catch (e) {
        stderr.push(`agentdef knowledge hook: ${e.message}`);
        payload = '';
    }
    if (tool === 'gemini') {
        // Gemini parses stdout as JSON: exactly one envelope, always — even empty —
        // and nothing else may reach stdout in this mode.
        const envelope = {
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: payload },
        };
        return { stdout: `${JSON.stringify(envelope)}\n`, stderr };
    }
    // claude: plain text on stdout is added as context; empty means inject nothing.
    return { stdout: payload ? `${payload}\n` : '', stderr };
}
