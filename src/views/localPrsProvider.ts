import * as vscode from 'vscode';
import { formatReviewLabel, LocalPr } from '../types';
import { LocalPrManager } from '../services/localPrManager';

export class LocalPrsProvider implements vscode.TreeDataProvider<LocalPrItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<LocalPrItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly managerChange: vscode.Disposable;

    constructor(private readonly localPrManager: LocalPrManager) {
        this.managerChange = this.localPrManager.onDidChange(() => this.refresh());
    }

    getTreeItem(element: LocalPrItem): vscode.TreeItem {
        return element;
    }

    getChildren(): LocalPrItem[] {
        const activeId = this.localPrManager.getActiveReview()?.id;
        return this.localPrManager.listReviews().map(
            review => new LocalPrItem(review, review.id === activeId)
        );
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this.managerChange.dispose();
        this._onDidChangeTreeData.dispose();
    }
}

export class LocalPrItem extends vscode.TreeItem {
    constructor(
        public readonly review: LocalPr,
        isActive: boolean
    ) {
        super(formatReviewLabel(review), vscode.TreeItemCollapsibleState.None);

        const created = new Date(review.createdAt).toLocaleString();
        if (review.mode === 'uncommitted') {
            this.tooltip = `Uncommitted changes on ${review.branch}\nCreated: ${created}`;
            this.iconPath = new vscode.ThemeIcon('git-commit');
        } else {
            this.tooltip = review.baseBranch === review.targetBranch
                ? `Primary branch self-review (intentionally empty)\nCreated: ${created}`
                : `Branch review\nCreated: ${created}`;
            this.iconPath = new vscode.ThemeIcon('git-pull-request');
        }

        this.contextValue = 'localPr';
        this.description = isActive
            ? `active · ${review.mode}`
            : review.mode;
        if (isActive) {
            this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        }

        this.command = {
            command: 'localPrReview.activateReview',
            title: 'Activate Review',
            arguments: [this],
        };
    }
}
