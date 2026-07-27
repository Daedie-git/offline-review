import * as vscode from 'vscode';
import {
    CommitInfo,
    DiffPlan,
    FileChange,
    isThreadCurrentForPlan,
    LocalPr,
    PreparedDiffState,
} from '../types';
import { FileDiffUris, GitService } from '../git/gitService';
import { StorageService } from '../storage/storageService';
import { LocalPrManager } from '../services/localPrManager';

export type ChangedFileTreeItem = SectionItem | FolderItem | FileChangeItem | CommitItem | MessageItem;

export class ChangedFilesProvider implements vscode.TreeDataProvider<ChangedFileTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangedFileTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private files: readonly FileChange[] = [];
    private commits: readonly CommitInfo[] = [];
    private plan: DiffPlan | undefined;
    private preparedState: PreparedDiffState | undefined;
    private reviewedFiles = new Set<string>();
    private filesSection: SectionItem | undefined;
    private commitsSection: SectionItem | undefined;
    private requestGeneration = 0;

    constructor(
        private readonly gitService: GitService,
        private readonly storageService: StorageService,
        private readonly localPrManager: LocalPrManager
    ) {
        this.reviewedFiles = new Set(localPrManager.getReviewedFiles());
    }

    getTreeItem(element: ChangedFileTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ChangedFileTreeItem): ChangedFileTreeItem[] {
        if (!element) {
            return this.buildRootSections();
        }
        if (element instanceof SectionItem) {
            return element.getChildren();
        }
        if (element instanceof FolderItem) {
            return element.children;
        }
        return [];
    }

    getParent(element: ChangedFileTreeItem): ChangedFileTreeItem | undefined {
        if (element instanceof FileChangeItem || element instanceof FolderItem) {
            return this.filesSection;
        }
        if (element instanceof CommitItem) {
            return this.commitsSection;
        }
        return undefined;
    }

    private buildRootSections(): ChangedFileTreeItem[] {
        this.filesSection = undefined;
        this.commitsSection = undefined;
        if (!this.plan) {
            return [];
        }
        if (this.files.length === 0 && this.commits.length === 0) {
            return this.plan.kind === 'worktree'
                ? [new MessageItem('No uncommitted changes', 'HEAD and the working tree are identical.')]
                : [new MessageItem('No changes between these branches', 'The saved target commit matches its merge base.')];
        }

        this.filesSection = new SectionItem(
            'Files',
            'files',
            this.buildFileTree(),
            this.files.length
        );
        this.commitsSection = new SectionItem(
            'Commits',
            'commits',
            this.buildCommitList(),
            this.commits.length,
            vscode.TreeItemCollapsibleState.Collapsed
        );
        return [this.filesSection, this.commitsSection];
    }

    private buildFileTree(): ChangedFileTreeItem[] {
        const commentCounts = this.getCommentCounts();
        const groups = new Map<string, FileChange[]>();
        const rootFiles: FileChange[] = [];

        for (const file of this.files) {
            const slashIndex = file.filePath.lastIndexOf('/');
            if (slashIndex === -1) {
                rootFiles.push(file);
            } else {
                const directory = file.filePath.substring(0, slashIndex);
                const directoryFiles = groups.get(directory) ?? [];
                directoryFiles.push(file);
                groups.set(directory, directoryFiles);
            }
        }

        const items: ChangedFileTreeItem[] = [];
        for (const directory of [...groups.keys()].sort()) {
            const children = (groups.get(directory) ?? [])
                .sort((left, right) => left.filePath.localeCompare(right.filePath))
                .map(file => this.createFileItem(file, commentCounts, true));
            items.push(new FolderItem(directory, children));
        }
        for (const file of rootFiles.sort((left, right) => left.filePath.localeCompare(right.filePath))) {
            items.push(this.createFileItem(file, commentCounts, false));
        }
        return items;
    }

    private buildCommitList(): CommitItem[] {
        return this.commits.map(commit => new CommitItem(commit));
    }

    private createFileItem(
        file: FileChange,
        commentCounts: Map<string, number>,
        useBasename: boolean
    ): FileChangeItem {
        if (!this.plan) {
            throw new Error('Cannot create a changed-file item without a DiffPlan');
        }
        const item = new FileChangeItem(
            file,
            this.plan,
            this.gitService.getFileDiffUris(this.plan, file),
            commentCounts.get(file.filePath) ?? 0,
            useBasename
        );
        item.checkboxState = this.reviewedFiles.has(file.filePath)
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        return item;
    }

    private getCommentCounts(): Map<string, number> {
        const counts = new Map<string, number>();
        if (!this.plan) {
            return counts;
        }
        const comments = this.storageService.loadCommentsForReview(this.plan.reviewId);
        if (!comments) {
            return counts;
        }
        for (const thread of comments.threads) {
            if (thread.state !== 'resolved'
                && isThreadCurrentForPlan(thread, this.plan)) {
                counts.set(
                    thread.target.filePath,
                    (counts.get(thread.target.filePath) ?? 0) + 1
                );
            }
        }
        return counts;
    }

    setFileReviewed(filePath: string, checked: boolean): void {
        if (checked) {
            this.reviewedFiles.add(filePath);
        } else {
            this.reviewedFiles.delete(filePath);
        }

        const activeReview = this.localPrManager.getActiveReview();
        if (activeReview && activeReview.id === this.plan?.reviewId) {
            this.localPrManager.setReviewedFiles([...this.reviewedFiles]);
        }
    }

    /**
     * Resolve and query a review without changing visible provider state. This is
     * the async half used by an extension coordinator before an atomic apply.
     */
    async prepareRefresh(input: LocalPr | DiffPlan): Promise<PreparedDiffState> {
        const plan = isDiffPlan(input)
            ? freezeDiffPlan(input)
            : await this.gitService.prepareDiffPlan(input);
        const review = isDiffPlan(input)
            ? this.localPrManager.listReviews().find(candidate => candidate.id === plan.reviewId)
            : input;
        const [files, commits] = await Promise.all([
            this.gitService.getChangedFiles(plan),
            this.gitService.getCommitsForDiff(plan),
        ]);

        return Object.freeze({
            plan,
            files: Object.freeze(files.map(file => Object.freeze({ ...file }))),
            commits: Object.freeze(commits.map(commit => Object.freeze({ ...commit }))),
            reviewedFiles: Object.freeze([...(review?.reviewedFiles ?? [])]),
        });
    }

    /**
     * Synchronously publish a prepared state and invalidate older async refreshes.
     * Coordinators can apply this and then update comments/decorations as one turn.
     */
    applyPreparedState(state: PreparedDiffState): void {
        this.requestGeneration++;
        this.commitPreparedState(state);
    }

    /** Prepare and apply unless a newer request supersedes this one. */
    async refresh(input: LocalPr | DiffPlan): Promise<boolean> {
        const generation = ++this.requestGeneration;
        try {
            const state = await this.prepareRefresh(input);
            if (generation !== this.requestGeneration) {
                return false;
            }
            this.commitPreparedState(state);
            return true;
        } catch (error: unknown) {
            if (generation !== this.requestGeneration) {
                return false;
            }
            this.files = [];
            this.commits = [];
            this.plan = undefined;
            this.preparedState = undefined;
            this.filesSection = undefined;
            this.commitsSection = undefined;
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to prepare review diff: ${message}`);
            this._onDidChangeTreeData.fire(undefined);
            return false;
        }
    }

    private commitPreparedState(state: PreparedDiffState): void {
        this.preparedState = state;
        this.plan = state.plan;
        this.files = state.files;
        this.commits = state.commits;
        this.reviewedFiles = new Set(state.reviewedFiles);
        this.filesSection = undefined;
        this.commitsSection = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    getPreparedState(): PreparedDiffState | undefined {
        return this.preparedState;
    }

    getDiffPlan(): DiffPlan | undefined {
        return this.plan;
    }

    getAllExpandableItems(): ChangedFileTreeItem[] {
        const items: ChangedFileTreeItem[] = [];
        if (this.filesSection) {
            items.push(this.filesSection);
            for (const child of this.filesSection.getChildren()) {
                if (child instanceof FolderItem) {
                    items.push(child);
                }
            }
        }
        if (this.commitsSection) {
            items.push(this.commitsSection);
        }
        return items;
    }

    getAllFileItems(): FileChangeItem[] {
        const items: FileChangeItem[] = [];
        if (!this.filesSection) {
            return items;
        }
        for (const child of this.filesSection.getChildren()) {
            if (child instanceof FileChangeItem) {
                items.push(child);
            } else if (child instanceof FolderItem) {
                items.push(...child.children);
            }
        }
        return items;
    }

    getAllFilePaths(): string[] {
        return this.files.map(file => file.filePath);
    }

    clear(): void {
        this.requestGeneration++;
        this.files = [];
        this.commits = [];
        this.plan = undefined;
        this.preparedState = undefined;
        this.reviewedFiles.clear();
        this.filesSection = undefined;
        this.commitsSection = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    fireChange(): void {
        this.filesSection = undefined;
        this.commitsSection = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        this.requestGeneration++;
        this._onDidChangeTreeData.dispose();
    }
}

export class SectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly sectionType: 'files' | 'commits',
        private readonly children: ChangedFileTreeItem[],
        count: number,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
    ) {
        super(label, collapsibleState);
        this.description = `${count}`;
        this.contextValue = 'section';
        this.iconPath = sectionType === 'files'
            ? new vscode.ThemeIcon('files')
            : new vscode.ThemeIcon('git-commit');
    }

    getChildren(): ChangedFileTreeItem[] {
        return this.children;
    }
}

export class FolderItem extends vscode.TreeItem {
    constructor(
        public readonly folderPath: string,
        public readonly children: FileChangeItem[]
    ) {
        super(folderPath, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = vscode.ThemeIcon.Folder;
        this.contextValue = 'folder';
        this.description = `${children.length}`;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
            this.resourceUri = vscode.Uri.joinPath(workspaceRoot, folderPath);
        }
    }
}

export class FileChangeItem extends vscode.TreeItem {
    readonly leftUri: vscode.Uri;
    readonly rightUri: vscode.Uri;

    constructor(
        public readonly fileChange: FileChange,
        public readonly diffPlan: DiffPlan,
        uris: FileDiffUris,
        public readonly commentCount: number = 0,
        useBasename: boolean = false
    ) {
        const displayName = useBasename
            ? fileChange.filePath.substring(fileChange.filePath.lastIndexOf('/') + 1)
            : fileChange.filePath;
        super(displayName, vscode.TreeItemCollapsibleState.None);
        this.leftUri = uris.left;
        this.rightUri = uris.right;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
            this.resourceUri = vscode.Uri.joinPath(workspaceRoot, fileChange.filePath);
        }

        const statusLabel = fileChange.status.charAt(0).toUpperCase();
        const commentLabel = commentCount > 0
            ? ` (${commentCount} unresolved comment${commentCount === 1 ? '' : 's'})`
            : '';
        this.tooltip = `${fileChange.status}: ${fileChange.filePath}${commentLabel}`;
        this.description = commentCount > 0 ? `${statusLabel}  💬 ${commentCount}` : statusLabel;
        this.contextValue = 'fileChange';

        switch (fileChange.status) {
            case 'added':
                this.iconPath = new vscode.ThemeIcon(
                    'diff-added',
                    new vscode.ThemeColor('gitDecoration.addedResourceForeground')
                );
                break;
            case 'deleted':
                this.iconPath = new vscode.ThemeIcon(
                    'diff-removed',
                    new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
                );
                break;
            case 'renamed':
                this.iconPath = new vscode.ThemeIcon(
                    'diff-renamed',
                    new vscode.ThemeColor('gitDecoration.renamedResourceForeground')
                );
                break;
            default:
                this.iconPath = new vscode.ThemeIcon(
                    'diff-modified',
                    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
                );
                break;
        }

        this.command = {
            command: 'localPrReview.openDiff',
            title: 'Open Diff',
            arguments: [this],
        };
    }
}

export class CommitItem extends vscode.TreeItem {
    constructor(public readonly commit: CommitInfo) {
        super(commit.message, vscode.TreeItemCollapsibleState.None);
        this.description = commit.relativeDate;
        this.tooltip = `${commit.shortHash} by ${commit.author}\n${commit.message}\n${commit.relativeDate}`;
        this.iconPath = new vscode.ThemeIcon('git-commit');
        this.contextValue = 'commit';
    }
}

export class MessageItem extends vscode.TreeItem {
    constructor(label: string, tooltip?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'message';
    }
}

function isDiffPlan(value: LocalPr | DiffPlan): value is DiffPlan {
    return 'kind' in value && (value.kind === 'branch' || value.kind === 'worktree');
}

function freezeDiffPlan(plan: DiffPlan): DiffPlan {
    if (plan.kind === 'branch') {
        const left = Object.freeze({ kind: 'git' as const, ref: plan.left.ref });
        const right = Object.freeze({ kind: 'git' as const, ref: plan.right.ref });
        return Object.freeze({
            kind: 'branch' as const,
            reviewId: plan.reviewId,
            baseBranch: plan.baseBranch,
            targetBranch: plan.targetBranch,
            baseCommit: plan.baseCommit,
            mergeBaseCommit: plan.mergeBaseCommit,
            targetCommit: plan.targetCommit,
            left,
            right,
        });
    }

    const left = Object.freeze({ kind: 'git' as const, ref: plan.left.ref });
    const right = Object.freeze({
        kind: 'worktree' as const,
        reviewId: plan.right.reviewId,
        headCommit: plan.right.headCommit,
        planId: plan.right.planId,
    });
    return Object.freeze({
        kind: 'worktree' as const,
        reviewId: plan.reviewId,
        branch: plan.branch,
        headCommit: plan.headCommit,
        planId: plan.planId,
        left,
        right,
    });
}
