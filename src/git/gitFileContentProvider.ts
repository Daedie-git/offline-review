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
        const ref = parsed.document.kind === 'worktree'
            ? GitService.WORKTREE_REF
            : parsed.document.ref;
        return this.gitService.getFileContent(ref, parsed.filePath);
    }

    /** Invalidate every open WORKTREE identity for one real file. */
    refreshWorkingTreeFile(filePath: string): void {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = parseDiffDocumentUri(document.uri);
            if (parsed?.document.kind === 'worktree' && parsed.filePath === filePath) {
                this._onDidChange.fire(document.uri);
            }
        }
    }

    /** Invalidate every open WORKTREE virtual document. */
    refreshAllWorkingTree(): void {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = parseDiffDocumentUri(document.uri);
            if (parsed?.document.kind === 'worktree') {
                this._onDidChange.fire(document.uri);
            }
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
