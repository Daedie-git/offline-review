import * as vscode from 'vscode';
import { CommentFileDiscovery, ReviewMode } from '../types';
import { StorageService } from '../storage/storageService';
export declare class LocalCommentsProvider implements vscode.TreeDataProvider<CommentFileItem> {
    private readonly storageService;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<CommentFileItem | undefined>;
    constructor(storageService: StorageService);
    getTreeItem(element: CommentFileItem): vscode.TreeItem;
    getChildren(): CommentFileItem[];
    refresh(): void;
    dispose(): void;
}
export declare class CommentFileItem extends vscode.TreeItem {
    readonly reviewId: string;
    readonly mode: ReviewMode;
    readonly filePath: string;
    constructor(discovery: CommentFileDiscovery);
}
