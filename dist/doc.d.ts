export interface DocOptions {
    delegation?: boolean;
    memory?: boolean;
    knowledgeBreadcrumb?: string;
}
export declare function buildInstructionDoc(dir: string, opts?: DocOptions): string;
