import * as vscode from 'vscode';
import { LocalPrManager } from '../services/localPrManager';
import { GitService } from '../git/gitService';
import { getReviewSourceTarget, ReviewMode } from '../types';

export class BranchSelectorProvider implements vscode.TreeDataProvider<BranchSelectorItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<BranchSelectorItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sourceBranch = '';
    private targetBranch = '';
    private mode: ReviewMode;

    constructor(
        private readonly gitService: GitService,
        private readonly localPrManager: LocalPrManager
    ) {
        this.mode = localPrManager.getActiveMode();
        this.syncFromActiveReview();
    }

    getTreeItem(element: BranchSelectorItem): vscode.TreeItem {
        return element;
    }

    getChildren(): BranchSelectorItem[] {
        if (this.mode === 'uncommitted') {
            return [new BranchSelectorItem(
                'Uncommitted',
                this.targetBranch || '(current checkout)',
                'localPrReview.reviewUncommitted',
                'HEAD vs working tree'
            )];
        }
        const selfDescription = this.sourceBranch
            && this.sourceBranch === this.targetBranch
            ? 'intentional empty self-review'
            : undefined;
        return [
            new BranchSelectorItem(
                'Base',
                this.sourceBranch || '(select base branch)',
                'localPrReview.reviewActiveBranch'
            ),
            new BranchSelectorItem(
                'Active branch',
                this.targetBranch || '(current checkout)',
                'localPrReview.reviewActiveBranch',
                selfDescription
            ),
        ];
    }

    getSourceBranch(): string { return this.sourceBranch; }
    getTargetBranch(): string { return this.targetBranch; }
    getMode(): ReviewMode { return this.mode; }

    setSourceBranch(branch: string): void {
        this.sourceBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }

    setTargetBranch(branch: string): void {
        this.targetBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }

    setMode(mode: ReviewMode): void {
        this.mode = mode;
        this._onDidChangeTreeData.fire(undefined);
    }

    refresh(): void {
        this.syncFromActiveReview();
        this._onDidChangeTreeData.fire(undefined);
    }

    private syncFromActiveReview(): void {
        const active = this.localPrManager.getActiveReview();
        if (!active) {
            return;
        }
        const comparison = getReviewSourceTarget(active);
        this.mode = active.mode;
        this.sourceBranch = active.mode === 'branch'
            ? active.baseBranch
            : (this.localPrManager.getPreferredBaseBranch() ?? '');
        this.targetBranch = comparison.targetBranch;
    }

    dispose(): void {
        // Retain the service dependency in this lightweight tree implementation;
        // the webview provider is the primary selector UI.
        void this.gitService;
        this._onDidChangeTreeData.dispose();
    }
}

class BranchSelectorItem extends vscode.TreeItem {
    constructor(
        label: string,
        branchName: string,
        commandId: string,
        detail?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = detail ? `${branchName} · ${detail}` : branchName;
        this.tooltip = detail ?? `Click to review ${branchName}`;
        this.command = { command: commandId, title: label };
        this.iconPath = new vscode.ThemeIcon('git-branch');
    }
}
