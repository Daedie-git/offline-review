import * as vscode from 'vscode';
import { LocalPrManager } from '../services/localPrManager';
import { GitService } from '../git/gitService';
import { ReviewMode } from '../types';
export declare class BranchSelectorProvider implements vscode.TreeDataProvider<BranchSelectorItem> {
    private readonly gitService;
    private readonly localPrManager;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<BranchSelectorItem | undefined>;
    private sourceBranch;
    private targetBranch;
    private mode;
    constructor(gitService: GitService, localPrManager: LocalPrManager);
    getTreeItem(element: BranchSelectorItem): vscode.TreeItem;
    getChildren(): BranchSelectorItem[];
    getSourceBranch(): string;
    getTargetBranch(): string;
    getMode(): ReviewMode;
    setSourceBranch(branch: string): void;
    setTargetBranch(branch: string): void;
    setMode(mode: ReviewMode): void;
    refresh(): void;
    private syncFromActiveReview;
    dispose(): void;
}
declare class BranchSelectorItem extends vscode.TreeItem {
    constructor(label: string, branchName: string, commandId: string, detail?: string);
}
export {};
