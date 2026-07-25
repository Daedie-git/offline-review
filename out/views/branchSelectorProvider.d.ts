import * as vscode from 'vscode';
import { LocalPrManager } from '../services/localPrManager';
import { GitService } from '../git/gitService';
export declare class BranchSelectorProvider implements vscode.TreeDataProvider<BranchSelectorItem> {
    private gitService;
    private localPrManager;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<BranchSelectorItem | undefined>;
    private sourceBranch;
    private targetBranch;
    constructor(gitService: GitService, localPrManager: LocalPrManager);
    getTreeItem(element: BranchSelectorItem): vscode.TreeItem;
    getChildren(): BranchSelectorItem[];
    getSourceBranch(): string;
    getTargetBranch(): string;
    setSourceBranch(branch: string): void;
    setTargetBranch(branch: string): void;
    refresh(): void;
    dispose(): void;
}
declare class BranchSelectorItem extends vscode.TreeItem {
    readonly label: string;
    readonly branchName: string;
    constructor(label: string, branchName: string, commandId: string);
}
export {};
