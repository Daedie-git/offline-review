import * as vscode from 'vscode';
import { CommitInfo, DiffPlan, FileChange, LocalPr, PreparedDiffState } from '../types';
import { FileDiffUris, GitService } from '../git/gitService';
import { StorageService } from '../storage/storageService';
import { LocalPrManager } from '../services/localPrManager';
export type ChangedFileTreeItem = SectionItem | FolderItem | FileChangeItem | CommitItem | MessageItem;
export declare class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFileTreeItem> {
    private readonly gitService;
    private readonly storageService;
    private readonly localPrManager;
    private readonly _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<ChangedFileTreeItem | undefined>;
    private files;
    private commits;
    private plan;
    private preparedState;
    private reviewedFiles;
    private filesSection;
    private commitsSection;
    private requestGeneration;
    constructor(gitService: GitService, storageService: StorageService, localPrManager: LocalPrManager);
    getTreeItem(element: ChangedFileTreeItem): vscode.TreeItem;
    getChildren(element?: ChangedFileTreeItem): ChangedFileTreeItem[];
    getParent(element: ChangedFileTreeItem): ChangedFileTreeItem | undefined;
    private buildRootSections;
    private buildFileTree;
    private buildCommitList;
    private createFileItem;
    private getCommentCounts;
    setFileReviewed(filePath: string, checked: boolean): void;
    /**
     * Resolve and query a review without changing visible provider state. This is
     * the async half used by an extension coordinator before an atomic apply.
     */
    prepareRefresh(input: LocalPr | DiffPlan): Promise<PreparedDiffState>;
    /**
     * Synchronously publish a prepared state and invalidate older async refreshes.
     * Coordinators can apply this and then update comments/decorations as one turn.
     */
    applyPreparedState(state: PreparedDiffState): void;
    /** Prepare and apply unless a newer request supersedes this one. */
    refresh(input: LocalPr | DiffPlan): Promise<boolean>;
    private commitPreparedState;
    getPreparedState(): PreparedDiffState | undefined;
    getDiffPlan(): DiffPlan | undefined;
    getAllExpandableItems(): ChangedFileTreeItem[];
    getAllFileItems(): FileChangeItem[];
    getAllFilePaths(): string[];
    clear(): void;
    fireChange(): void;
    dispose(): void;
}
export declare class SectionItem extends vscode.TreeItem {
    readonly sectionType: 'files' | 'commits';
    private readonly children;
    constructor(label: string, sectionType: 'files' | 'commits', children: ChangedFileTreeItem[], count: number, collapsibleState?: vscode.TreeItemCollapsibleState);
    getChildren(): ChangedFileTreeItem[];
}
export declare class FolderItem extends vscode.TreeItem {
    readonly folderPath: string;
    readonly children: FileChangeItem[];
    constructor(folderPath: string, children: FileChangeItem[], worktreeRoot?: string);
}
export declare class FileChangeItem extends vscode.TreeItem {
    readonly fileChange: FileChange;
    readonly diffPlan: DiffPlan;
    readonly commentCount: number;
    readonly leftUri: vscode.Uri;
    readonly rightUri: vscode.Uri;
    constructor(fileChange: FileChange, diffPlan: DiffPlan, uris: FileDiffUris, commentCount?: number, useBasename?: boolean);
}
export declare class CommitItem extends vscode.TreeItem {
    readonly commit: CommitInfo;
    constructor(commit: CommitInfo);
}
export declare class MessageItem extends vscode.TreeItem {
    constructor(label: string, tooltip?: string);
}
