// Minimal manifest + skill + knowledge types for the formats agentdef actually
// emits. Compliance/SOD fields from the upstream spec are intentionally omitted:
// noord does not use them, so the adapters never read them. Knowledge is the
// exception: upstream's knowledge-index concept returns here, but generic — OKF
// frontmatter (see knowledge.ts) instead of upstream's index.yaml manifest.

export interface AgentEntry {
  description?: string;
  delegation?: { triggers?: string[] };
}

export interface AgentManifest {
  name: string;
  description: string;
  version?: string;
  extends?: string;
  model?: {
    preferred?: string;
    fallback?: string[];
  };
  agents?: Record<string, AgentEntry>;
  knowledge?: {
    dir?: string;
    hook?: boolean; // false: no SessionStart hooks, hook-mode tools get the static index
  };
}

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  allowedTools?: string[];
  directory: string;
}

// One knowledge document's OKF frontmatter (Open Knowledge Format, see
// knowledge.ts). Only `type` is required by the spec; every other field is
// optional and unknown keys are tolerated, so this stays a plain projection.
export interface KnowledgeMetadata {
  type: string;
  title: string; // frontmatter title, else the filename without .md
  description?: string;
  tags?: string[];
  timestamp?: string; // ISO 8601, kept as a string
  resource?: string;
  relPath: string; // path relative to its knowledge root; concept ID = relPath minus .md
  path: string; // absolute on-disk path
}
