import * as vscode from 'vscode';
import { GitService, parseDiffDocumentUri } from '../git/gitService';

/**
 * Provides Git-object and WORKTREE content via the review's virtual URI scheme.
 * WORKTREE URIs include the owning review UUID and prepared HEAD commit.
 */
export class GitFileContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly gitService: GitService) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const parsed = parseDiffDocumentUri(uri);
        if (!parsed) {
            return '';
        }
        return this.gitService.getFileContent(parsed.document, parsed.filePath);
    }

    /** Invalidate open identities for one real file in one captured checkout. */
    refreshWorkingTreeFile(filePath: string, worktreeRoot?: string): void {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = parseDiffDocumentUri(document.uri);
            if (parsed?.document.kind === 'worktree'
                && parsed.filePath === filePath
                && (!worktreeRoot || parsed.document.worktreeRoot === worktreeRoot)) {
                this._onDidChange.fire(document.uri);
            }
        }
    }

    /** Invalidate open WORKTREE documents, optionally for one checkout only. */
    refreshAllWorkingTree(worktreeRoot?: string): void {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = parseDiffDocumentUri(document.uri);
            if (parsed?.document.kind === 'worktree'
                && (!worktreeRoot || parsed.document.worktreeRoot === worktreeRoot)) {
                this._onDidChange.fire(document.uri);
            }
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
