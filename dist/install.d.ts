export type InstallMode = 'reuse' | 'refresh' | 'force';
export interface InstallResult {
    installed: string[];
    warnings: string[];
}
export declare function install(dir: string, opts?: {
    mode?: InstallMode;
}): InstallResult;
