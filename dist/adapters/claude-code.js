import { join, resolve } from 'node:path';
import { loadAgentManifest, loadFileIfExists } from '../loader.js';
import { resolveIdentity } from '../merge.js';
import { collectSkillMetadata } from '../skills.js';
import { collectKnowledgeMetadataStrict, knowledgeDirName, renderKnowledgeBreadcrumb, } from '../knowledge.js';
// Emits CLAUDE.md: identity + SOUL + RULES + a skills index (metadata plus a
// pointer to each SKILL.md, since Claude Code loads skills on demand) + a
// knowledge breadcrumb (claude-code is a hook-mode adapter: the OKF knowledge
// index is injected fresh at session start via the SessionStart hook sync
// registers in .claude/settings.json, see hooks.ts) + the model hint.
// Compliance sections from the upstream spec stay dropped: noord uses none.
export function exportToClaudeCode(dir) {
    const agentDir = resolve(dir);
    const manifest = loadAgentManifest(agentDir);
    const { soul, rules } = resolveIdentity(agentDir);
    const parts = [];
    parts.push(`# ${manifest.name}`);
    parts.push(`${manifest.description}\n`);
    if (soul)
        parts.push(soul);
    if (rules)
        parts.push(rules);
    const duty = loadFileIfExists(join(agentDir, 'DUTIES.md'));
    if (duty)
        parts.push(duty);
    const skills = collectSkillMetadata(agentDir);
    if (skills.length > 0) {
        const skillParts = ['## Skills\n'];
        for (const skill of skills) {
            const skillDirName = skill.directory.split('/').pop();
            skillParts.push(`### ${skill.name}`);
            skillParts.push(skill.description);
            if (skill.allowedTools && skill.allowedTools.length > 0) {
                skillParts.push(`Allowed tools: ${skill.allowedTools.join(', ')}`);
            }
            skillParts.push(`Full instructions: \`skills/${skillDirName}/SKILL.md\``);
            skillParts.push('');
        }
        parts.push(skillParts.join('\n'));
    }
    const knowledge = collectKnowledgeMetadataStrict(agentDir);
    if (knowledge.length > 0) {
        parts.push(renderKnowledgeBreadcrumb(knowledgeDirName(agentDir), '.claude/settings.json'));
    }
    if (manifest.model?.preferred) {
        parts.push(`<!-- Model: ${manifest.model.preferred} -->`);
    }
    return parts.join('\n\n');
}
