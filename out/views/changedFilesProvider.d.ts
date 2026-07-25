import * as vscode from 'vscode';
import { FileChange, CommitInfo } from '../types';
import { GitService } from '../git/gitService';
import { StorageService } from '../storage/storageService';
import { LocalPrManager } from '../services/localPrManager';
export type ChangedFileTreeItem = SectionItem | FolderItem | FileChangeItem | CommitItem | MessageItem;
export declare class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFileTreeItem> {
    private gitService;
    private storageService;
    private localPrManager;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<ChangedFileTreeItem | undefined>;
    private files;
    private commits;
    private sourceBranch;
    private targetBranch;
    private reviewedFiles;
    private filesSection;
    private commitsSection;
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
    refresh(sourceBranch: string, targetBranch: string): Promise<void>;
    getAllExpandableItems(): ChangedFileTreeItem[];
    getAllFileItems(): FileChangeItem[];
    /**
     * Get all changed file paths directly (not dependent on tree rendering).
     */
    getAllFilePaths(): string[];
    getBranches(): {
        source: string;
        target: string;
    };
    clear(): void;
    fireChange(): void;
    dispose(): void;
}
export declare class SectionItem extends vscode.TreeItem {
    readonly sectionType: 'files' | 'commits';
    private children;
    constructor(label: string, sectionType: 'files' | 'commits', children: ChangedFileTreeItem[], count: number, collapsibleState?: vscode.TreeItemCollapsibleState);
    getChildren(): ChangedFileTreeItem[];
}
export declare class FolderItem extends vscode.TreeItem {
    readonly folderPath: string;
    readonly children: FileChangeItem[];
    constructor(folderPath: string, children: FileChangeItem[]);
}
export declare class FileChangeItem extends vscode.TreeItem {
    readonly fileChange: FileChange;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly commentCount: number;
    constructor(fileChange: FileChange, sourceBranch: string, targetBranch: string, commentCount?: number, useBasename?: boolean);
}
export declare class CommitItem extends vscode.TreeItem {
    readonly commit: CommitInfo;
    constructor(commit: CommitInfo);
}
export declare class MessageItem extends vscode.TreeItem {
    constructor(label: string, tooltip?: string);
}
