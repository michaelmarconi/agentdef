export interface ValidationIssue {
    level: 'error' | 'warning';
    message: string;
    hint?: string;
}
export declare function validate(dir: string): ValidationIssue[];
