export declare const INDEX_FILE = "knowledge-index.md";
export type HookTool = 'claude' | 'gemini';
export interface HookOutput {
    stdout: string;
    stderr: string[];
}
export declare function runKnowledgeHook(dir: string, tool: HookTool): HookOutput;
