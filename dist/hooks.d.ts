export interface KnowledgeHookTarget {
    settingsFile: string;
    command: string;
}
export declare const KNOWLEDGE_HOOK: Record<string, KnowledgeHookTarget>;
export interface EnsureHookResult {
    changed: boolean;
    path: string;
    warnings: string[];
}
export declare function ensureSessionHook(agentDir: string, target: KnowledgeHookTarget): EnsureHookResult;
export declare function removeSessionHook(agentDir: string, target: KnowledgeHookTarget): EnsureHookResult;
