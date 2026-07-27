"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageItem = exports.CommitItem = exports.FileChangeItem = exports.FolderItem = exports.SectionItem = exports.ChangedFilesProvider = void 0;
const vscode = __importStar(require("vscode"));
const types_1 = require("../types");
class ChangedFilesProvider {
    constructor(gitService, storageService, localPrManager) {
        this.gitService = gitService;
        this.storageService = storageService;
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.files = [];
        this.commits = [];
        this.reviewedFiles = new Set();
        this.requestGeneration = 0;
        this.reviewedFiles = new Set(localPrManager.getReviewedFiles());
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
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
    getParent(element) {
        if (element instanceof FileChangeItem || element instanceof FolderItem) {
            return this.filesSection;
        }
        if (element instanceof CommitItem) {
            return this.commitsSection;
        }
        return undefined;
    }
    buildRootSections() {
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
        this.filesSection = new SectionItem('Files', 'files', this.buildFileTree(), this.files.length);
        this.commitsSection = new SectionItem('Commits', 'commits', this.buildCommitList(), this.commits.length, vscode.TreeItemCollapsibleState.Collapsed);
        return [this.filesSection, this.commitsSection];
    }
    buildFileTree() {
        const commentCounts = this.getCommentCounts();
        const groups = new Map();
        const rootFiles = [];
        for (const file of this.files) {
            const slashIndex = file.filePath.lastIndexOf('/');
            if (slashIndex === -1) {
                rootFiles.push(file);
            }
            else {
                const directory = file.filePath.substring(0, slashIndex);
                const directoryFiles = groups.get(directory) ?? [];
                directoryFiles.push(file);
                groups.set(directory, directoryFiles);
            }
        }
        const items = [];
        for (const directory of [...groups.keys()].sort()) {
            const children = (groups.get(directory) ?? [])
                .sort((left, right) => left.filePath.localeCompare(right.filePath))
                .map(file => this.createFileItem(file, commentCounts, true));
            items.push(new FolderItem(directory, children, this.plan?.worktreeRoot));
        }
        for (const file of rootFiles.sort((left, right) => left.filePath.localeCompare(right.filePath))) {
            items.push(this.createFileItem(file, commentCounts, false));
        }
        return items;
    }
    buildCommitList() {
        return this.commits.map(commit => new CommitItem(commit));
    }
    createFileItem(file, commentCounts, useBasename) {
        if (!this.plan) {
            throw new Error('Cannot create a changed-file item without a DiffPlan');
        }
        const item = new FileChangeItem(file, this.plan, this.gitService.getFileDiffUris(this.plan, file), commentCounts.get(file.filePath) ?? 0, useBasename);
        item.checkboxState = this.reviewedFiles.has(file.filePath)
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        return item;
    }
    getCommentCounts() {
        const counts = new Map();
        if (!this.plan) {
            return counts;
        }
        const comments = this.storageService.loadCommentsForReview(this.plan.reviewId);
        if (!comments) {
            return counts;
        }
        for (const thread of comments.threads) {
            if (thread.state !== 'resolved'
                && (0, types_1.isThreadCurrentForPlan)(thread, this.plan)) {
                counts.set(thread.target.filePath, (counts.get(thread.target.filePath) ?? 0) + 1);
            }
        }
        return counts;
    }
    setFileReviewed(filePath, checked) {
        if (checked) {
            this.reviewedFiles.add(filePath);
        }
        else {
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
    async prepareRefresh(input) {
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
    applyPreparedState(state) {
        this.requestGeneration++;
        this.commitPreparedState(state);
    }
    /** Prepare and apply unless a newer request supersedes this one. */
    async refresh(input) {
        const generation = ++this.requestGeneration;
        try {
            const state = await this.prepareRefresh(input);
            if (generation !== this.requestGeneration) {
                return false;
            }
            this.commitPreparedState(state);
            return true;
        }
        catch (error) {
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
    commitPreparedState(state) {
        this.preparedState = state;
        this.plan = state.plan;
        this.files = state.files;
        this.commits = state.commits;
        this.reviewedFiles = new Set(state.reviewedFiles);
        this.filesSection = undefined;
        this.commitsSection = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }
    getPreparedState() {
        return this.preparedState;
    }
    getDiffPlan() {
        return this.plan;
    }
    getAllExpandableItems() {
        const items = [];
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
    getAllFileItems() {
        const items = [];
        if (!this.filesSection) {
            return items;
        }
        for (const child of this.filesSection.getChildren()) {
            if (child instanceof FileChangeItem) {
                items.push(child);
            }
            else if (child instanceof FolderItem) {
                items.push(...child.children);
            }
        }
        return items;
    }
    getAllFilePaths() {
        return this.files.map(file => file.filePath);
    }
    clear() {
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
    fireChange() {
        this.filesSection = undefined;
        this.commitsSection = undefined;
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this.requestGeneration++;
        this._onDidChangeTreeData.dispose();
    }
}
exports.ChangedFilesProvider = ChangedFilesProvider;
class SectionItem extends vscode.TreeItem {
    constructor(label, sectionType, children, count, collapsibleState = vscode.TreeItemCollapsibleState.Expanded) {
        super(label, collapsibleState);
        this.sectionType = sectionType;
        this.children = children;
        this.description = `${count}`;
        this.contextValue = 'section';
        this.iconPath = sectionType === 'files'
            ? new vscode.ThemeIcon('files')
            : new vscode.ThemeIcon('git-commit');
    }
    getChildren() {
        return this.children;
    }
}
exports.SectionItem = SectionItem;
class FolderItem extends vscode.TreeItem {
    constructor(folderPath, children, worktreeRoot) {
        super(folderPath, vscode.TreeItemCollapsibleState.Expanded);
        this.folderPath = folderPath;
        this.children = children;
        this.iconPath = vscode.ThemeIcon.Folder;
        this.contextValue = 'folder';
        this.description = `${children.length}`;
        if (worktreeRoot) {
            this.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(worktreeRoot), folderPath);
        }
    }
}
exports.FolderItem = FolderItem;
class FileChangeItem extends vscode.TreeItem {
    constructor(fileChange, diffPlan, uris, commentCount = 0, useBasename = false) {
        const displayName = useBasename
            ? fileChange.filePath.substring(fileChange.filePath.lastIndexOf('/') + 1)
            : fileChange.filePath;
        super(displayName, vscode.TreeItemCollapsibleState.None);
        this.fileChange = fileChange;
        this.diffPlan = diffPlan;
        this.commentCount = commentCount;
        this.leftUri = uris.left;
        this.rightUri = uris.right;
        this.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(diffPlan.worktreeRoot), fileChange.filePath);
        const statusLabel = fileChange.status.charAt(0).toUpperCase();
        const commentLabel = commentCount > 0
            ? ` (${commentCount} unresolved comment${commentCount === 1 ? '' : 's'})`
            : '';
        this.tooltip = `${fileChange.status}: ${fileChange.filePath}${commentLabel}`;
        this.description = commentCount > 0 ? `${statusLabel}  💬 ${commentCount}` : statusLabel;
        this.contextValue = 'fileChange';
        switch (fileChange.status) {
            case 'added':
                this.iconPath = new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
                break;
            case 'deleted':
                this.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
                break;
            case 'renamed':
                this.iconPath = new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
                break;
        }
        this.command = {
            command: 'localPrReview.openDiff',
            title: 'Open Diff',
            arguments: [this],
        };
    }
}
exports.FileChangeItem = FileChangeItem;
class CommitItem extends vscode.TreeItem {
    constructor(commit) {
        super(commit.message, vscode.TreeItemCollapsibleState.None);
        this.commit = commit;
        this.description = commit.relativeDate;
        this.tooltip = `${commit.shortHash} by ${commit.author}\n${commit.message}\n${commit.relativeDate}`;
        this.iconPath = new vscode.ThemeIcon('git-commit');
        this.contextValue = 'commit';
    }
}
exports.CommitItem = CommitItem;
class MessageItem extends vscode.TreeItem {
    constructor(label, tooltip) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'message';
    }
}
exports.MessageItem = MessageItem;
function isDiffPlan(value) {
    return 'kind' in value && (value.kind === 'branch' || value.kind === 'worktree');
}
function freezeDiffPlan(plan) {
    if (plan.kind === 'branch') {
        const left = Object.freeze({ kind: 'git', ref: plan.left.ref });
        const right = Object.freeze({ kind: 'git', ref: plan.right.ref });
        return Object.freeze({
            kind: 'branch',
            reviewId: plan.reviewId,
            worktreeRoot: plan.worktreeRoot,
            baseBranch: plan.baseBranch,
            targetBranch: plan.targetBranch,
            baseCommit: plan.baseCommit,
            mergeBaseCommit: plan.mergeBaseCommit,
            targetCommit: plan.targetCommit,
            left,
            right,
        });
    }
    const left = Object.freeze({ kind: 'git', ref: plan.left.ref });
    const right = Object.freeze({
        kind: 'worktree',
        reviewId: plan.right.reviewId,
        headCommit: plan.right.headCommit,
        planId: plan.right.planId,
        worktreeRoot: plan.right.worktreeRoot,
    });
    return Object.freeze({
        kind: 'worktree',
        reviewId: plan.reviewId,
        worktreeRoot: plan.worktreeRoot,
        branch: plan.branch,
        headCommit: plan.headCommit,
        planId: plan.planId,
        left,
        right,
    });
}
//# sourceMappingURL=changedFilesProvider.js.map