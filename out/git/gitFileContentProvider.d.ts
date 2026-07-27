import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
/**
 * Provides Git-object and WORKTREE content via the review's virtual URI scheme.
 * WORKTREE URIs include the owning review UUID and prepared HEAD commit.
 */
export declare class GitFileContentProvider implements vscode.TextDocumentContentProvider {
    private readonly gitService;
    private readonly _onDidChange;
    readonly onDidChange: vscode.Event<vscode.Uri>;
    constructor(gitService: GitService);
    provideTextDocumentContent(uri: vscode.Uri): Promise<string>;
    /** Invalidate open identities for one real file in one captured checkout. */
    refreshWorkingTreeFile(filePath: string, worktreeRoot?: string): void;
    /** Invalidate open WORKTREE documents, optionally for one checkout only. */
    refreshAllWorkingTree(worktreeRoot?: string): void;
    dispose(): void;
}
