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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const gitService_1 = require("./git/gitService");
const gitFileContentProvider_1 = require("./git/gitFileContentProvider");
const localPrManager_1 = require("./services/localPrManager");
const storageService_1 = require("./storage/storageService");
const branchSelectorWebviewProvider_1 = require("./views/branchSelectorWebviewProvider");
const changedFilesProvider_1 = require("./views/changedFilesProvider");
const localPrsProvider_1 = require("./views/localPrsProvider");
const localCommentsProvider_1 = require("./views/localCommentsProvider");
const commentController_1 = require("./comments/commentController");
const localReviewTool_1 = require("./tools/localReviewTool");
const fileDecorationProvider_1 = require("./decorations/fileDecorationProvider");
const suggestChangePanel_1 = require("./views/suggestChangePanel");
async function activate(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showInformationMessage('Local PR Review: Open a Git repository folder to use this extension.');
        return;
    }
    // Initialize git service
    const gitService = new gitService_1.GitService(context);
    // Initialize services (will work once git is ready)
    const localPrManager = new localPrManager_1.LocalPrManager(gitService, workspaceRoot);
    const storageService = new storageService_1.StorageService(localPrManager);
    // Register custom URI scheme for git file content
    const gitFileContentProvider = new gitFileContentProvider_1.GitFileContentProvider(gitService);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('git-local-review', gitFileContentProvider));
    // Initialize view providers
    const branchSelectorProvider = new branchSelectorWebviewProvider_1.BranchSelectorWebviewProvider(context.extensionUri, gitService, localPrManager);
    const changedFilesProvider = new changedFilesProvider_1.ChangedFilesProvider(gitService, storageService, localPrManager);
    const localPrsProvider = new localPrsProvider_1.LocalPrsProvider(localPrManager);
    const localCommentsProvider = new localCommentsProvider_1.LocalCommentsProvider(storageService);
    // Initialize comment controller
    const commentController = new commentController_1.ReviewCommentController(storageService);
    // Initialize file decoration provider (shows unresolved comment badges in explorer)
    const fileDecorationProvider = new fileDecorationProvider_1.ReviewFileDecorationProvider(storageService);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));
    // Register Copilot Language Model Tool (optional — requires VS Code 1.93+ and Copilot)
    try {
        const localReviewTool = new localReviewTool_1.LocalReviewTool(gitService, localPrManager, storageService);
        context.subscriptions.push(vscode.lm.registerTool('localPrReview_getComments', localReviewTool));
    }
    catch {
        // Language Model API unavailable — extension works without it
    }
    // Register views
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(branchSelectorWebviewProvider_1.BranchSelectorWebviewProvider.viewType, branchSelectorProvider));
    // Changed files tree view with checkbox support
    const changedFilesTreeView = vscode.window.createTreeView('localPrReview.changedFiles', {
        treeDataProvider: changedFilesProvider,
        manageCheckboxStateManually: true,
        showCollapseAll: true,
    });
    changedFilesTreeView.onDidChangeCheckboxState(e => {
        for (const [item, state] of e.items) {
            if (item instanceof changedFilesProvider_1.FileChangeItem) {
                changedFilesProvider.setFileReviewed(item.fileChange.filePath, state === vscode.TreeItemCheckboxState.Checked);
            }
        }
    });
    context.subscriptions.push(changedFilesTreeView, vscode.window.createTreeView('localPrReview.localPrs', {
        treeDataProvider: localPrsProvider,
    }), vscode.window.createTreeView('localPrReview.localComments', {
        treeDataProvider: localCommentsProvider,
    }));
    // Initialize git asynchronously (after tree views are registered)
    const initialized = await gitService.initialize();
    if (!initialized) {
        vscode.window.showInformationMessage('Local PR Review: No git repository found. Open a folder with a git repo.');
    }
    // Sync the list of reviewable file paths so comments work on working-tree files
    const syncReviewableFiles = () => {
        commentController.setReviewableFiles(changedFilesProvider.getAllFilePaths());
    };
    // Load active review on startup
    if (initialized) {
        const activeReview = localPrManager.getActiveReview();
        if (activeReview) {
            await changedFilesProvider.refresh(activeReview.sourceBranch, activeReview.targetBranch);
            syncReviewableFiles();
            await commentController.loadAllThreads(gitService, activeReview.sourceBranch, activeReview.targetBranch);
        }
    }
    // Helper: auto-create review and refresh files when both branches are selected
    const autoRefreshFiles = async (base, compare) => {
        if (base && compare && base !== compare) {
            await localPrManager.createReview(base, compare);
            await changedFilesProvider.refresh(base, compare);
            syncReviewableFiles();
            localCommentsProvider.refresh();
            await commentController.loadAllThreads(gitService, base, compare);
            fileDecorationProvider.refresh();
        }
    };
    // Auto-refresh changed files on save when comparing against the working tree
    let refreshTimer;
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async () => {
        const active = localPrManager.getActiveReview();
        if (!active) {
            return;
        }
        const isWorkingTree = await gitService.isCurrentBranch(active.targetBranch);
        if (!isWorkingTree) {
            return;
        }
        // Debounce to avoid rapid successive refreshes
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(async () => {
            await changedFilesProvider.refresh(active.sourceBranch, active.targetBranch);
            syncReviewableFiles();
        }, 500);
    }));
    // Listen for branch selection from webview
    context.subscriptions.push(branchSelectorProvider.onDidSelectBranches(async ({ base, compare }) => {
        await autoRefreshFiles(base, compare);
    }));
    // Auto-update compare branch when user switches git branches
    context.subscriptions.push(gitService.onDidChangeBranch(async (newBranch) => {
        const base = branchSelectorProvider.getSourceBranch();
        if (base && newBranch !== base) {
            branchSelectorProvider.setTargetBranch(newBranch);
            await autoRefreshFiles(base, newBranch);
        }
    }));
    // Auto-refresh when new commits are made on the current branch
    context.subscriptions.push(gitService.onDidChangeHead(async () => {
        const active = localPrManager.getActiveReview();
        if (!active) {
            return;
        }
        await changedFilesProvider.refresh(active.sourceBranch, active.targetBranch);
        syncReviewableFiles();
        fileDecorationProvider.refresh();
    }));
    // --- Register commands ---
    // Create review
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.createReview', async () => {
        const source = branchSelectorProvider.getSourceBranch();
        const target = branchSelectorProvider.getTargetBranch();
        if (!source) {
            vscode.window.showWarningMessage('Please select a base branch first');
            return;
        }
        if (!target) {
            vscode.window.showWarningMessage('Please select a compare branch first');
            return;
        }
        if (source === target) {
            vscode.window.showWarningMessage('Base and compare branches must be different');
            return;
        }
        const review = await localPrManager.createReview(source, target);
        await changedFilesProvider.refresh(source, target);
        syncReviewableFiles();
        localCommentsProvider.refresh();
        vscode.window.showInformationMessage(`Review created: ${target} -> ${source}`);
    }));
    // Activate review (click on Local PR)
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.activateReview', async (item) => {
        localPrManager.setActiveReview(item.review.id);
        branchSelectorProvider.refresh();
        await changedFilesProvider.refresh(item.review.sourceBranch, item.review.targetBranch);
        syncReviewableFiles();
        localCommentsProvider.refresh();
        await commentController.loadAllThreads(gitService, item.review.sourceBranch, item.review.targetBranch);
    }));
    // Delete review
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteReview', async (item) => {
        const answer = await vscode.window.showWarningMessage(`Delete review "${item.review.targetBranch} -> ${item.review.sourceBranch}"? This will also delete all comments.`, { modal: true }, 'Delete');
        if (answer === 'Delete') {
            localPrManager.deleteReview(item.review.id);
            changedFilesProvider.clear();
            commentController.setReviewableFiles([]);
            localCommentsProvider.refresh();
            branchSelectorProvider.refresh();
            await commentController.loadAllThreads();
        }
    }));
    // Refresh changed files
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.refreshFiles', async () => {
        const active = localPrManager.getActiveReview();
        if (active) {
            await changedFilesProvider.refresh(active.sourceBranch, active.targetBranch);
            syncReviewableFiles();
        }
    }));
    // Expand all in changed files tree
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.expandAll', async () => {
        const items = changedFilesProvider.getAllExpandableItems();
        for (const item of items) {
            try {
                await changedFilesTreeView.reveal(item, { expand: true, select: false, focus: false });
            }
            catch {
                // item may not be visible
            }
        }
    }));
    // Open file (working copy)
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.openFile', async (item) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot) {
            const fileUri = vscode.Uri.joinPath(workspaceRoot, item.fileChange.filePath);
            await vscode.window.showTextDocument(fileUri);
        }
    }));
    // Open diff
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.openDiff', async (item) => {
        const leftUri = vscode.Uri.parse(`git-local-review://authority/${item.fileChange.filePath}?ref=${encodeURIComponent(item.sourceBranch)}`);
        // If compare branch is the current branch, show working tree file instead of committed version
        const isWorkingTree = await gitService.isCurrentBranch(item.targetBranch);
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const rightUri = isWorkingTree && workspaceUri
            ? vscode.Uri.joinPath(workspaceUri, item.fileChange.filePath)
            : vscode.Uri.parse(`git-local-review://authority/${item.fileChange.filePath}?ref=${encodeURIComponent(item.targetBranch)}`);
        const title = `${item.fileChange.filePath} (${item.sourceBranch} <-> ${item.targetBranch})`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
        // Load comments for this file on both sides of the diff
        commentController.loadThreadsForFile(leftUri, item.fileChange.filePath);
        commentController.loadThreadsForFile(rightUri, item.fileChange.filePath);
    }));
    // Comment commands
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.addComment', (reply) => {
        try {
            const thread = reply.thread;
            const filePath = extractFilePath(thread.uri);
            if (thread.comments.length === 0) {
                commentController.createThread(thread.uri, thread.range, reply.text, filePath, thread);
            }
            else {
                commentController.addReply(thread, reply.text);
            }
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            changedFilesProvider.fireChange();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to add comment: ${err.message}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.saveComment', (reply) => {
        try {
            const thread = reply.thread;
            const filePath = extractFilePath(thread.uri);
            if (thread.comments.length === 0) {
                commentController.createThread(thread.uri, thread.range, reply.text, filePath, thread);
            }
            else {
                commentController.addReply(thread, reply.text);
            }
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            changedFilesProvider.fireChange();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to save comment: ${err.message}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.cancelComment', (reply) => {
        if (reply.thread.comments.length === 0) {
            reply.thread.dispose();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.resolveThread', (thread) => {
        if (thread.state === vscode.CommentThreadState.Unresolved) {
            commentController.resolveThread(thread);
        }
        else {
            commentController.unresolveThread(thread);
        }
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.unresolveThread', (thread) => {
        commentController.unresolveThread(thread);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.editComment', (comment) => {
        // Toggle to editing mode
        comment.mode = vscode.CommentMode.Editing;
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteComment', (comment) => {
        // For comments/comment/title, VS Code may pass comment with parent reference
        // We need to find the thread from our controller
        const thread = comment.thread || commentController.findThreadForComment(comment);
        if (!thread) {
            return;
        }
        vscode.window.showWarningMessage('Delete this comment?', 'Delete', 'Cancel')
            .then(answer => {
            if (answer === 'Delete') {
                commentController.deleteComment(thread, comment);
                localCommentsProvider.refresh();
                fileDecorationProvider.refresh();
                changedFilesProvider.fireChange();
            }
        });
    }));
    // Refresh commands for Local PRs and Local Comments
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.refreshPrs', () => {
        localPrsProvider.refresh();
    }), vscode.commands.registerCommand('localPrReview.refreshComments', () => {
        localCommentsProvider.refresh();
    }));
    // Open all changed files in a multi-diff editor
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.openAllDiffs', async () => {
        const allFiles = changedFilesProvider.getAllFileItems();
        if (allFiles.length === 0) {
            vscode.window.showInformationMessage('No changed files to show. Select branches first.');
            return;
        }
        const { source, target } = changedFilesProvider.getBranches();
        const isWorkingTree = await gitService.isCurrentBranch(target);
        const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const resources = allFiles.map(item => {
            const original = vscode.Uri.parse(`git-local-review://authority/${item.fileChange.filePath}?ref=${encodeURIComponent(source)}`);
            const modified = isWorkingTree && workspaceUri
                ? vscode.Uri.joinPath(workspaceUri, item.fileChange.filePath)
                : vscode.Uri.parse(`git-local-review://authority/${item.fileChange.filePath}?ref=${encodeURIComponent(target)}`);
            return [original, modified, undefined];
        });
        try {
            await vscode.commands.executeCommand('vscode.changes', `Review: ${source} <-> ${target}`, resources);
        }
        catch (err) {
            const msg = err?.message ?? String(err);
            vscode.window.showErrorMessage(`Multi-diff editor failed: ${msg}`);
        }
    }));
    // Suggest a Change — compose a diff suggestion as an inline comment
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.suggestChange', async (reply) => {
        try {
            const thread = reply.thread;
            const range = thread.range;
            if (!range) {
                vscode.window.showWarningMessage('Please select a line range in the diff to suggest a change.');
                return;
            }
            const doc = await vscode.workspace.openTextDocument(thread.uri);
            const filePath = extractFilePath(thread.uri);
            // Get the full lines covered by the selection
            const normalizedRange = new vscode.Range(range.start.line, 0, range.end.line, doc.lineAt(range.end.line).text.length);
            const originalCode = doc.getText(normalizedRange);
            const commentBody = await suggestChangePanel_1.SuggestChangePanel.show(context.extensionUri, originalCode, filePath);
            if (commentBody === undefined) {
                // User cancelled — dispose empty thread
                if (thread.comments.length === 0) {
                    thread.dispose();
                }
                return;
            }
            if (thread.comments.length === 0) {
                commentController.createThread(thread.uri, range, commentBody, filePath);
                thread.dispose();
            }
            else {
                commentController.addReply(thread, commentBody);
            }
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            changedFilesProvider.fireChange();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to add suggestion: ${err.message}`);
        }
    }));
    // Delete comments file
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteCommentsFile', async (item) => {
        const answer = await vscode.window.showWarningMessage('Delete all comments for this review?', { modal: true }, 'Delete');
        if (answer === 'Delete') {
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            if (fs.existsSync(item.filePath)) {
                fs.unlinkSync(item.filePath);
                const dir = path.dirname(item.filePath);
                const remaining = fs.readdirSync(dir);
                if (remaining.length === 0) {
                    fs.rmdirSync(dir);
                }
            }
            localCommentsProvider.refresh();
            await commentController.loadAllThreads();
            fileDecorationProvider.refresh();
        }
    }));
    // Disposables
    context.subscriptions.push(branchSelectorProvider, changedFilesProvider, localPrsProvider, localCommentsProvider, commentController, gitFileContentProvider, fileDecorationProvider, { dispose: () => localPrManager.dispose() });
}
function extractFilePath(uri) {
    if (uri.scheme === 'file') {
        return vscode.workspace.asRelativePath(uri, false);
    }
    const path = uri.path;
    return path.startsWith('/') ? path.slice(1) : path;
}
function deactivate() { }
//# sourceMappingURL=extension.js.map