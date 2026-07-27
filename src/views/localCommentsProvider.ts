import * as vscode from 'vscode';
import { CommentFileDiscovery, ReviewMode } from '../types';
import { StorageService } from '../storage/storageService';

export class LocalCommentsProvider implements vscode.TreeDataProvider<CommentFileItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CommentFileItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly storageService: StorageService) {}

    getTreeItem(element: CommentFileItem): vscode.TreeItem {
        return element;
    }

    getChildren(): CommentFileItem[] {
        return this.storageService.getAllCommentFiles().map(file => new CommentFileItem(file));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}

export class CommentFileItem extends vscode.TreeItem {
    readonly reviewId: string;
    readonly mode: ReviewMode;
    readonly filePath: string;

    constructor(discovery: CommentFileDiscovery) {
        super(discovery.label, vscode.TreeItemCollapsibleState.None);
        this.reviewId = discovery.reviewId;
        this.mode = discovery.mode;
        this.filePath = discovery.filePath;

        const modeLabel = discovery.mode === 'uncommitted' ? 'uncommitted' : 'branch';
        this.description = discovery.isActive ? `active · ${modeLabel}` : modeLabel;
        this.tooltip = discovery.isActive
            ? `${discovery.filePath} (active ${modeLabel} review)`
            : `${discovery.filePath} (${modeLabel} review)`;
        this.iconPath = new vscode.ThemeIcon(
            discovery.isActive ? 'comment-discussion' : 'comment',
            discovery.isActive ? undefined : new vscode.ThemeColor('descriptionForeground')
        );
        this.contextValue = 'commentFile';
        this.command = {
            command: 'vscode.open',
            title: 'Open Comments File',
            arguments: [vscode.Uri.file(discovery.filePath)],
        };
    }
}
