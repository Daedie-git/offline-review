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
    /** Invalidate every open WORKTREE identity for one real file. */
    refreshWorkingTreeFile(filePath: string): void;
    /** Invalidate every open WORKTREE virtual document. */
    refreshAllWorkingTree(): void;
    dispose(): void;
}
