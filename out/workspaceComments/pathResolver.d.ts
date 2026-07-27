import * as vscode from 'vscode';
import { WorkspacePathStatus } from './types';
export interface ResolvedWorkspacePath {
    readonly filePath: string;
    readonly absolutePath: string;
    readonly uri: vscode.Uri;
}
export declare class WorkspacePathResolver {
    readonly workspaceRoot: string;
    readonly canonicalRoot: string;
    constructor(workspaceRoot: string);
    resolveUri(uri: vscode.Uri): ResolvedWorkspacePath | undefined;
    normalizeStoredPath(filePath: string): string | undefined;
    inspectStoredPath(filePath: string): WorkspacePathStatus;
    uriForStoredPath(filePath: string): vscode.Uri | undefined;
    private relativePath;
    private safeCanonicalTarget;
    private canonicalRelative;
    private hasNestedGitBoundary;
    private hasSafeExistingAncestor;
}
