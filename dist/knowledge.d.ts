import type { KnowledgeMetadata } from './types.js';
export declare const DEFAULT_KNOWLEDGE_DIR = "knowledge";
export declare function knowledgeDirName(levelDir: string): string;
export declare function knowledgeHookEnabled(agentDir: string): boolean;
export declare function loadKnowledgeMetadata(filePath: string, rootDir: string): KnowledgeMetadata;
export interface KnowledgeCollection {
    entries: KnowledgeMetadata[];
    errors: string[];
}
export declare function collectKnowledgeMetadata(agentDir: string): KnowledgeCollection;
export declare function collectKnowledgeMetadataStrict(agentDir: string): KnowledgeMetadata[];
export declare function renderKnowledgeIndex(entries: KnowledgeMetadata[], opts: {
    agentDir: string;
}): string;
export declare const INLINE_INDEX_BUDGET = 8000;
export declare function renderKnowledgeDigest(entries: KnowledgeMetadata[], opts: {
    indexPath: string;
}): string;
export declare function renderKnowledgeBreadcrumb(knowledgeDir: string, settingsFile: string): string;
