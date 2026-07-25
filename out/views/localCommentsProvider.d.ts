import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
export declare class LocalCommentsProvider implements vscode.TreeDataProvider<CommentFileItem> {
    private storageService;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<CommentFileItem | undefined>;
    constructor(storageService: StorageService);
    getTreeItem(element: CommentFileItem): vscode.TreeItem;
    getChildren(): CommentFileItem[];
    refresh(): void;
    dispose(): void;
}
export declare class CommentFileItem extends vscode.TreeItem {
    readonly filePath: string;
    constructor(reviewLabel: string, filePath: string, isActive: boolean);
}
