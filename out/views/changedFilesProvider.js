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
class ChangedFilesProvider {
    constructor(gitService, storageService, localPrManager) {
        this.gitService = gitService;
        this.storageService = storageService;
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.files = [];
        this.commits = [];
        this.sourceBranch = '';
        this.targetBranch = '';
        this.reviewedFiles = new Set();
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
        if (this.files.length === 0 && this.commits.length === 0) {
            if (this.sourceBranch && this.targetBranch) {
                return [new MessageItem('No changes between these branches', 'The base and compare branches are identical.')];
            }
            return [];
        }
        const fileChildren = this.buildFileTree();
        this.filesSection = new SectionItem('Files', 'files', fileChildren, this.files.length);
        this.commitsSection = new SectionItem('Commits', 'commits', this.buildCommitList(), this.commits.length, vscode.TreeItemCollapsibleState.Collapsed);
        return [this.filesSection, this.commitsSection];
    }
    buildFileTree() {
        const commentCounts = this.getCommentCounts();
        const groups = new Map();
        const rootFiles = [];
        for (const file of this.files) {
            const slashIdx = file.filePath.lastIndexOf('/');
            if (slashIdx === -1) {
                rootFiles.push(file);
            }
            else {
                const dir = file.filePath.substring(0, slashIdx);
                if (!groups.has(dir)) {
                    groups.set(dir, []);
                }
                groups.get(dir).push(file);
            }
        }
        const items = [];
        const sortedDirs = Array.from(groups.keys()).sort();
        for (const dir of sortedDirs) {
            const dirFiles = groups.get(dir);
            const children = dirFiles.map(f => this.createFileItem(f, commentCounts, true));
            items.push(new FolderItem(dir, children));
        }
        for (const file of rootFiles.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
            items.push(this.createFileItem(file, commentCounts, false));
        }
        return items;
    }
    buildCommitList() {
        return this.commits.map(c => new CommitItem(c));
    }
    createFileItem(file, commentCounts, useBasename) {
        const item = new FileChangeItem(file, this.sourceBranch, this.targetBranch, commentCounts.get(file.filePath) || 0, useBasename);
        item.checkboxState = this.reviewedFiles.has(file.filePath)
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        return item;
    }
    getCommentCounts() {
        const counts = new Map();
        const comments = this.storageService.loadComments();
        if (comments) {
            for (const thread of comments.threads) {
                if (thread.state !== 'resolved') {
                    counts.set(thread.filePath, (counts.get(thread.filePath) || 0) + 1);
                }
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
        this.localPrManager.setReviewedFiles(Array.from(this.reviewedFiles));
    }
    async refresh(sourceBranch, targetBranch) {
        this.sourceBranch = sourceBranch;
        this.targetBranch = targetBranch;
        this.reviewedFiles = new Set(this.localPrManager.getReviewedFiles());
        if (!sourceBranch || !targetBranch) {
            this.files = [];
            this.commits = [];
            this._onDidChangeTreeData.fire(undefined);
            return;
        }
        try {
            const [files, commits] = await Promise.all([
                this.gitService.getChangedFiles(sourceBranch, targetBranch),
                this.gitService.getCommitsBetween(sourceBranch, targetBranch),
            ]);
            this.files = files;
            this.commits = commits;
        }
        catch (e) {
            vscode.window.showErrorMessage(`Failed to get changed files: ${e.message}`);
            this.files = [];
            this.commits = [];
        }
        this._onDidChangeTreeData.fire(undefined);
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
    /**
     * Get all changed file paths directly (not dependent on tree rendering).
     */
    getAllFilePaths() {
        return this.files.map(f => f.filePath);
    }
    getBranches() {
        return { source: this.sourceBranch, target: this.targetBranch };
    }
    clear() {
        this.files = [];
        this.commits = [];
        this.reviewedFiles.clear();
        this._onDidChangeTreeData.fire(undefined);
    }
    fireChange() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
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
    constructor(folderPath, children) {
        super(folderPath, vscode.TreeItemCollapsibleState.Expanded);
        this.folderPath = folderPath;
        this.children = children;
        this.iconPath = vscode.ThemeIcon.Folder;
        this.contextValue = 'folder';
        this.description = `${children.length}`;
        // Set resourceUri so FileDecorationProvider can propagate decorations to folders
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
            this.resourceUri = vscode.Uri.joinPath(workspaceRoot, folderPath);
        }
    }
}
exports.FolderItem = FolderItem;
class FileChangeItem extends vscode.TreeItem {
    constructor(fileChange, sourceBranch, targetBranch, commentCount = 0, useBasename = false) {
        const displayName = useBasename
            ? fileChange.filePath.substring(fileChange.filePath.lastIndexOf('/') + 1)
            : fileChange.filePath;
        super(displayName, vscode.TreeItemCollapsibleState.None);
        this.fileChange = fileChange;
        this.sourceBranch = sourceBranch;
        this.targetBranch = targetBranch;
        this.commentCount = commentCount;
        // Set resourceUri so FileDecorationProvider can show comment badges
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
            this.resourceUri = vscode.Uri.joinPath(workspaceRoot, fileChange.filePath);
        }
        const statusLabel = fileChange.status.charAt(0).toUpperCase();
        this.tooltip = `${fileChange.status}: ${fileChange.filePath}${commentCount > 0 ? ` (${commentCount} unresolved comment${commentCount > 1 ? 's' : ''})` : ''}`;
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
//# sourceMappingURL=changedFilesProvider.js.map