import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../storage/storageService';
import { GitService } from '../git/gitService';
import { isEffectiveReviewProjection, ReviewAnchorResolver } from '../comments/reviewAnchorResolver';

export class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(
        _storageService: StorageService,
        private readonly gitService: GitService,
        private readonly anchorResolver?: ReviewAnchorResolver
    ) {}

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        // Only decorate workspace files (file:// scheme)
        if (uri.scheme !== 'file') {
            return undefined;
        }

        const worktreeRoot = this.gitService.getSelectedWorktreeRoot();
        if (!worktreeRoot) {
            return undefined;
        }

        const relative = path.relative(worktreeRoot, uri.fsPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return undefined;
        }
        const relativePath = relative.replace(/\\/g, '/');

        const count = this.getUnresolvedCount(relativePath);
        if (count === 0) {
            return undefined;
        }

        return {
            badge: `${count}`,
            tooltip: `${count} unresolved review comment${count > 1 ? 's' : ''}`,
            color: new vscode.ThemeColor('localPrReview.unresolvedCommentForeground'),
            propagate: true,
        };
    }

    private getUnresolvedCount(filePath: string): number {
        const state = this.anchorResolver?.getAppliedState();
        if (!state || state.plan.worktreeRoot !== this.gitService.getSelectedWorktreeRoot()) {
            return 0;
        }
        return state.projections.filter(projection =>
            projection.thread.filePath === filePath
            && projection.thread.state === 'unresolved'
            && isEffectiveReviewProjection(projection)
        ).length;
    }

    refresh(): void {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    dispose(): void {
        this._onDidChangeFileDecorations.dispose();
    }
}
