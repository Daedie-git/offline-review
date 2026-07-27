import * as vscode from 'vscode';
import { LocalPr } from '../types';
import { LocalPrManager } from '../services/localPrManager';
export declare class LocalPrsProvider implements vscode.TreeDataProvider<LocalPrItem> {
    private readonly localPrManager;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<LocalPrItem | undefined>;
    private readonly managerChange;
    constructor(localPrManager: LocalPrManager);
    getTreeItem(element: LocalPrItem): vscode.TreeItem;
    getChildren(): LocalPrItem[];
    refresh(): void;
    dispose(): void;
}
export declare class LocalPrItem extends vscode.TreeItem {
    readonly review: LocalPr;
    constructor(review: LocalPr, isActive: boolean);
}
