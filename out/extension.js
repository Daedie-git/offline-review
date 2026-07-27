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
const virtualDocLanguageFeatures_1 = require("./language/virtualDocLanguageFeatures");
async function activate(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showInformationMessage('Offline Review: Open a Git repository folder to use this extension.');
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
    // Bridge Go to Definition / Hover / etc. from virtual diffs onto real files
    (0, virtualDocLanguageFeatures_1.registerVirtualDocLanguageFeatures)(context);
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
        vscode.window.showInformationMessage('Offline Review: No git repository found. Open a folder with a git repo.');
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
    const autoRefreshFiles = async (base, compare, mode, options = {}) => {
        if (!(base && compare)) {
            return;
        }
        const resolvedMode = mode || (base === compare ? 'uncommitted' : 'branch');
        try {
            await localPrManager.createReview(base, compare, resolvedMode);
            storageService.ensureCommentsFile();
            await changedFilesProvider.refresh(base, compare);
            syncReviewableFiles();
            localCommentsProvider.refresh();
            await commentController.loadAllThreads(gitService, base, compare);
            fileDecorationProvider.refresh();
            const currentBranch = await gitService.getCurrentBranch();
            branchSelectorProvider.setReviewState({
                base: resolvedMode === 'uncommitted' ? localPrManager.getPreferredBaseBranch() : base,
                compare,
                mode: resolvedMode,
                currentBranch: currentBranch || '',
            });
            if (!options.quiet) {
                const n = changedFilesProvider.getAllFilePaths().length;
                if (resolvedMode === 'uncommitted') {
                    vscode.window.showInformationMessage(`Uncommitted review: ${n} file${n === 1 ? '' : 's'}`);
                }
                else {
                    vscode.window.showInformationMessage(`Branch review: ${compare} vs ${base} (${n} file${n === 1 ? '' : 's'})`);
                }
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Offline Review refresh failed: ${err?.message ?? err}`);
        }
    };
    const reviewUncommitted = async () => {
        const branch = await gitService.getCurrentBranch();
        if (!branch) {
            vscode.window.showWarningMessage('Offline Review: no current git branch (detached HEAD?)');
            return;
        }
        await autoRefreshFiles(branch, branch, 'uncommitted');
    };
    const resolveBaseBranch = async (compareBranch) => {
        const branches = await gitService.getBranches(true);
        const selected = branchSelectorProvider.getSourceBranch() || localPrManager.getPreferredBaseBranch();
        const base = selected && selected !== compareBranch && branches.includes(selected)
            ? selected
            : await gitService.getPrimaryBranch(branches, compareBranch);
        if (!base) {
            return undefined;
        }
        localPrManager.setPreferredBaseBranch(base);
        branchSelectorProvider.setSourceBranch(base);
        return base;
    };
    const reviewActiveBranch = async () => {
        const branch = await gitService.getCurrentBranch();
        if (!branch) {
            vscode.window.showWarningMessage('Offline Review: no current git branch (detached HEAD?)');
            return;
        }
        const base = await resolveBaseBranch(branch);
        if (!base) {
            vscode.window.showWarningMessage('Offline Review: no base branch found. Create or fetch another branch, or select a base branch first.');
            return;
        }
        await autoRefreshFiles(base, branch, 'branch');
    };
    // Auto-refresh changed files + WORKTREE virtual docs on save
    let refreshTimer;
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const active = localPrManager.getActiveReview();
        if (!active) {
            return;
        }
        const isWorkingTree = active.sourceBranch === active.targetBranch
            || await gitService.isCurrentBranch(active.targetBranch);
        if (!isWorkingTree) {
            return;
        }
        if (doc.uri.scheme === 'file') {
            const rel = vscode.workspace.asRelativePath(doc.uri, false);
            gitFileContentProvider.refreshWorkingTreeFile(rel);
        }
        else {
            gitFileContentProvider.refreshAllWorkingTree();
        }
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(async () => {
            await changedFilesProvider.refresh(active.sourceBranch, active.targetBranch);
            syncReviewableFiles();
        }, 500);
    }));
    // Mode buttons drive refresh; legacy base/compare fires are ignored.
    context.subscriptions.push(branchSelectorProvider.onDidSelectBranches(async () => { }));
    // When the git branch changes, refresh the active mode against the new tip.
    context.subscriptions.push(gitService.onDidChangeBranch(async (newBranch) => {
        const mode = localPrManager.getActiveMode();
        if (mode === 'uncommitted') {
            await autoRefreshFiles(newBranch, newBranch, 'uncommitted');
            return;
        }
        const base = newBranch ? await resolveBaseBranch(newBranch) : undefined;
        if (base && newBranch) {
            await autoRefreshFiles(base, newBranch, 'branch');
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
    // Reload UI when an external process edits comments.json (agents, scripts).
    const reloadCommentsFromDisk = async () => {
        localCommentsProvider.refresh();
        const active = localPrManager.getActiveReview();
        if (active) {
            await commentController.loadAllThreads(gitService, active.sourceBranch, active.targetBranch);
        }
        else {
            await commentController.loadAllThreads();
        }
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    };
    let commentsWatchTimer;
    const onCommentsFileChanged = (uri) => {
        const fsPath = uri?.fsPath;
        if (storageService.shouldIgnoreWatch(fsPath)) {
            // Own write (hash match) — ignore. Time-only suppress — retry after window
            // so an interleaved agent edit is not dropped forever.
            if (storageService._lastWrittenHash && fsPath && fs.existsSync(fsPath)) {
                try {
                    const hash = require('crypto').createHash('sha1').update(require('fs').readFileSync(fsPath)).digest('hex');
                    if (hash === storageService._lastWrittenHash) {
                        return;
                    }
                }
                catch { /* retry below */ }
            }
            const wait = (storageService.msUntilWatchAllowed?.() ?? 300) + 50;
            if (commentsWatchTimer) {
                clearTimeout(commentsWatchTimer);
            }
            commentsWatchTimer = setTimeout(() => {
                if (!storageService.shouldIgnoreWatch(fsPath)) {
                    void reloadCommentsFromDisk();
                }
            }, wait);
            return;
        }
        if (commentsWatchTimer) {
            clearTimeout(commentsWatchTimer);
        }
        commentsWatchTimer = setTimeout(() => {
            if (storageService.shouldIgnoreWatch(fsPath)) {
                return;
            }
            void reloadCommentsFromDisk();
        }, 400);
    };
    const commentsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.vscode/offline-review/**/comments.json'));
    context.subscriptions.push(commentsWatcher, commentsWatcher.onDidChange(onCommentsFileChanged), commentsWatcher.onDidCreate(onCommentsFileChanged), commentsWatcher.onDidDelete(onCommentsFileChanged));
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
        await autoRefreshFiles(source, target);
        const label = source === target
            ? `uncommitted on ${source}`
            : `${target} -> ${source}`;
        vscode.window.showInformationMessage(`Review created: ${label}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.reviewUncommitted', async () => {
        await reviewUncommitted();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.reviewActiveBranch', async () => {
        await reviewActiveBranch();
    }));
    // Activate review (click on Local PR)
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.activateReview', async (item) => {
        localPrManager.setActiveReview(item.review.id);
        const mode = item.review.sourceBranch === item.review.targetBranch ? 'uncommitted' : 'branch';
        localPrManager.setActiveMode(mode);
        if (mode === 'branch') {
            localPrManager.setPreferredBaseBranch(item.review.sourceBranch);
        }
        branchSelectorProvider.refresh();
        await changedFilesProvider.refresh(item.review.sourceBranch, item.review.targetBranch);
        syncReviewableFiles();
        localCommentsProvider.refresh();
        await commentController.loadAllThreads(gitService, item.review.sourceBranch, item.review.targetBranch);
    }));
    // Delete review (from Local PRs tree or command palette)
    const restoreModeAfterClear = async (mode, sourceBranch, targetBranch) => {
        localCommentsProvider.refresh();
        localPrsProvider.refresh();
        fileDecorationProvider.refresh();
        // Keep Changed Files populated: recreate an empty review in the same mode.
        if (mode === 'uncommitted') {
            const branch = targetBranch || await gitService.getCurrentBranch();
            if (branch) {
                await autoRefreshFiles(branch, branch, 'uncommitted', { quiet: true });
            }
            return;
        }
        const compare = targetBranch || await gitService.getCurrentBranch();
        if (sourceBranch && sourceBranch !== compare) {
            branchSelectorProvider.setSourceBranch(sourceBranch);
        }
        const base = compare ? await resolveBaseBranch(compare) : undefined;
        if (base && compare) {
            await autoRefreshFiles(base, compare, 'branch', { quiet: true });
            return;
        }
        await reviewActiveBranch();
    };
    const clearUiAfterDelete = async () => {
        changedFilesProvider.clear();
        commentController.setReviewableFiles([]);
        await commentController.loadAllThreads();
        localCommentsProvider.refresh();
        localPrsProvider.refresh();
        branchSelectorProvider.refresh();
        fileDecorationProvider.refresh();
    };
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteReview', async (item) => {
        const review = item?.review || localPrManager.getActiveReview();
        if (!review) {
            vscode.window.showInformationMessage('No review to delete.');
            return;
        }
        const label = review.sourceBranch === review.targetBranch
            ? `uncommitted on ${review.targetBranch}`
            : `${review.targetBranch} vs ${review.sourceBranch}`;
        const answer = await vscode.window.showWarningMessage(`Delete review "${label}"? This also deletes its comments.`, { modal: true }, 'Delete');
        if (answer === 'Delete') {
            const wasActive = localPrManager.getActiveReview()?.id === review.id;
            const mode = review.sourceBranch === review.targetBranch ? 'uncommitted' : 'branch';
            const { sourceBranch, targetBranch } = review;
            localPrManager.deleteReview(review.id);
            if (wasActive) {
                await restoreModeAfterClear(mode, sourceBranch, targetBranch);
            }
            else {
                // Non-active delete must not wipe the still-active review's file list.
                localPrsProvider.refresh();
                localCommentsProvider.refresh();
                fileDecorationProvider.refresh();
            }
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.clearActiveReview', async () => {
        const active = localPrManager.getActiveReview();
        if (!active) {
            vscode.window.showInformationMessage('No active review to clear.');
            return;
        }
        const label = active.sourceBranch === active.targetBranch
            ? `uncommitted on ${active.targetBranch}`
            : `${active.targetBranch} vs ${active.sourceBranch}`;
        const answer = await vscode.window.showWarningMessage(`Clear active review (${label}) and its comments?`, { modal: true }, 'Clear');
        if (answer !== 'Clear') {
            return;
        }
        const mode = active.sourceBranch === active.targetBranch ? 'uncommitted' : 'branch';
        const { sourceBranch, targetBranch } = active;
        localPrManager.clearActiveReview();
        await storageService.withWatchSuppressed(async () => {
            await restoreModeAfterClear(mode, sourceBranch, targetBranch);
        });
        vscode.window.showInformationMessage('Comments cleared.');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.clearAllReviews', async () => {
        const n = localPrManager.listReviews().length;
        if (n === 0) {
            vscode.window.showInformationMessage('No reviews to clear.');
            return;
        }
        const active = localPrManager.getActiveReview();
        const mode = active
            ? (active.sourceBranch === active.targetBranch ? 'uncommitted' : 'branch')
            : localPrManager.getActiveMode();
        const sourceBranch = active?.sourceBranch;
        const targetBranch = active?.targetBranch;
        const answer = await vscode.window.showWarningMessage(`Clear all ${n} offline review${n === 1 ? '' : 's'} and their comments?`, { modal: true }, 'Clear all');
        if (answer !== 'Clear all') {
            return;
        }
        localPrManager.clearAllReviews();
        await storageService.withWatchSuppressed(async () => {
            await restoreModeAfterClear(mode, sourceBranch, targetBranch);
        });
        vscode.window.showInformationMessage('All comments cleared.');
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
        const leftUri = gitService.getFileUri(item.sourceBranch, item.fileChange.filePath);
        const isWorkingTree = item.sourceBranch === item.targetBranch
            || await gitService.isCurrentBranch(item.targetBranch);
        const rightUri = isWorkingTree
            ? gitService.getWorkingTreeFileUri(item.fileChange.filePath)
            : gitService.getFileUri(item.targetBranch, item.fileChange.filePath, 'modified');
        const title = `${item.fileChange.filePath} (${item.sourceBranch} <-> ${item.targetBranch})`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
        commentController.loadThreadsForFile(rightUri, item.fileChange.filePath);
    }));
    // Comment commands
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.addComment', (reply) => {
        try {
            const thread = reply.thread;
            if (!thread) {
                throw new Error('Missing comment thread');
            }
            const filePath = extractFilePath(thread.uri);
            if (!filePath) {
                throw new Error('Could not resolve file path for comment');
            }
            const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
            if (thread.comments.length === 0) {
                commentController.createThread(thread.uri, range, reply.text ?? '', filePath, thread);
            }
            else {
                commentController.addReply(thread, reply.text ?? '');
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
            if (!thread) {
                throw new Error('Missing comment thread');
            }
            const filePath = extractFilePath(thread.uri);
            if (!filePath) {
                throw new Error('Could not resolve file path for comment');
            }
            const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
            const editing = thread.comments.find(c => c.mode === vscode.CommentMode.Editing);
            if (editing) {
                commentController.saveEditedComment(thread, editing, reply.text ?? '');
            }
            else if (thread.comments.length === 0) {
                commentController.createThread(thread.uri, range, reply.text ?? '', filePath, thread);
            }
            else {
                commentController.addReply(thread, reply.text ?? '');
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
        const thread = comment?.thread || comment?.parent || commentController.findThreadForComment(comment);
        if (!thread) {
            return;
        }
        // VS Code only picks up mode changes when the comments array is reassigned.
        thread.comments = thread.comments.map(c => {
            if (c !== comment && !(c.author?.name === comment.author?.name
                && (typeof c.body === 'string' ? c.body : c.body?.value)
                    === (typeof comment.body === 'string' ? comment.body : comment.body?.value))) {
                return { ...c, mode: vscode.CommentMode.Preview };
            }
            return { ...c, mode: vscode.CommentMode.Editing };
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteComment', async (comment) => {
        // VS Code may pass the comment, or a wrapper; resolve the live thread either way.
        const thread = comment?.thread || comment?.parent || commentController.findThreadForComment(comment);
        if (!thread) {
            vscode.window.showWarningMessage('Could not find that comment thread to delete.');
            return;
        }
        const answer = await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
        if (answer !== 'Delete') {
            return;
        }
        commentController.deleteComment(thread, comment);
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    }));
    // Refresh commands for Local PRs and Local Comments
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.refreshPrs', () => {
        localPrsProvider.refresh();
    }), vscode.commands.registerCommand('localPrReview.refreshComments', async () => {
        await reloadCommentsFromDisk();
    }));
    // Open all changed files in a multi-diff editor
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.openAllDiffs', async () => {
        const allFiles = changedFilesProvider.getAllFileItems();
        if (allFiles.length === 0) {
            vscode.window.showInformationMessage('No changed files to show. Select branches first.');
            return;
        }
        const { source, target } = changedFilesProvider.getBranches();
        const isWorkingTree = source === target || await gitService.isCurrentBranch(target);
        const resources = allFiles.map(item => {
            const original = gitService.getFileUri(source, item.fileChange.filePath);
            const modified = isWorkingTree
                ? gitService.getWorkingTreeFileUri(item.fileChange.filePath)
                : gitService.getFileUri(target, item.fileChange.filePath, 'modified');
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