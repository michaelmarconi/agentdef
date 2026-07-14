export interface AgentEntry {
    description?: string;
    delegation?: {
        triggers?: string[];
    };
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
        hook?: boolean;
    };
}
export interface SkillMetadata {
    name: string;
    description: string;
    license?: string;
    allowedTools?: string[];
    directory: string;
}
export interface KnowledgeMetadata {
    type: string;
    title: string;
    description?: string;
    tags?: string[];
    timestamp?: string;
    resource?: string;
    relPath: string;
    path: string;
}
