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
const types_1 = require("./types");
async function activate(context) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showInformationMessage('Offline Review: Open a Git repository folder to use this extension.');
        return;
    }
    const gitService = new gitService_1.GitService(context);
    const localPrManager = new localPrManager_1.LocalPrManager(gitService, workspaceRoot);
    const storageService = new storageService_1.StorageService(localPrManager);
    const gitFileContentProvider = new gitFileContentProvider_1.GitFileContentProvider(gitService);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('git-local-review', gitFileContentProvider));
    (0, virtualDocLanguageFeatures_1.registerVirtualDocLanguageFeatures)(context);
    const branchSelectorProvider = new branchSelectorWebviewProvider_1.BranchSelectorWebviewProvider(context.extensionUri, gitService, localPrManager);
    const changedFilesProvider = new changedFilesProvider_1.ChangedFilesProvider(gitService, storageService, localPrManager);
    const localPrsProvider = new localPrsProvider_1.LocalPrsProvider(localPrManager);
    const localCommentsProvider = new localCommentsProvider_1.LocalCommentsProvider(storageService);
    const commentController = new commentController_1.ReviewCommentController(storageService);
    const fileDecorationProvider = new fileDecorationProvider_1.ReviewFileDecorationProvider(storageService);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(fileDecorationProvider));
    try {
        const localReviewTool = new localReviewTool_1.LocalReviewTool(gitService, localPrManager, storageService);
        context.subscriptions.push(vscode.lm.registerTool('localPrReview_getComments', localReviewTool));
    }
    catch {
        // The Language Model API is optional.
    }
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(branchSelectorWebviewProvider_1.BranchSelectorWebviewProvider.viewType, branchSelectorProvider));
    const changedFilesTreeView = vscode.window.createTreeView('localPrReview.changedFiles', {
        treeDataProvider: changedFilesProvider,
        manageCheckboxStateManually: true,
        showCollapseAll: true,
    });
    context.subscriptions.push(changedFilesTreeView.onDidChangeCheckboxState(event => {
        for (const [item, state] of event.items) {
            if (item instanceof changedFilesProvider_1.FileChangeItem) {
                changedFilesProvider.setFileReviewed(item.fileChange.filePath, state === vscode.TreeItemCheckboxState.Checked);
            }
        }
    }), changedFilesTreeView, vscode.window.createTreeView('localPrReview.localPrs', {
        treeDataProvider: localPrsProvider,
    }), vscode.window.createTreeView('localPrReview.localComments', {
        treeDataProvider: localCommentsProvider,
    }));
    const initialized = await gitService.initialize();
    if (!initialized) {
        vscode.window.showInformationMessage('Offline Review: No Git repository found. Open a folder with a Git repository.');
    }
    // Every review switch/refresh runs through this generation. Preparation does
    // not mutate visible state; one synchronous apply publishes only the winner.
    let transitionGeneration = 0;
    const transitionToReview = async (review, options = {}, reservedGeneration) => {
        const generation = reservedGeneration ?? ++transitionGeneration;
        if (generation !== transitionGeneration) {
            return false;
        }
        try {
            const [prepared, currentBranch] = await Promise.all([
                changedFilesProvider.prepareRefresh(review),
                gitService.getCurrentBranch(),
            ]);
            if (generation !== transitionGeneration) {
                return false;
            }
            if (options.ensureCommentsFile !== false) {
                storageService.ensureCommentsFileForReview(review.id);
            }
            localPrManager.setActiveReview(review.id);
            changedFilesProvider.applyPreparedState(prepared);
            if (prepared.plan.kind === 'branch') {
                localPrManager.updateBranchReviewFallbackCommits(prepared.plan.reviewId, prepared.plan.baseCommit, prepared.plan.targetCommit);
            }
            commentController.setReviewableFiles(prepared.files.map(file => file.filePath));
            commentController.loadAllThreads(prepared.plan);
            branchSelectorProvider.setReviewState({
                review,
                currentBranch: currentBranch ?? '',
            });
            localPrsProvider.refresh();
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            return true;
        }
        catch (error) {
            if (generation === transitionGeneration && options.showError !== false) {
                vscode.window.showErrorMessage(`Offline Review refresh failed: ${errorMessage(error)}`);
            }
            return false;
        }
    };
    const clearReviewUi = async () => {
        const generation = ++transitionGeneration;
        changedFilesProvider.clear();
        commentController.setReviewableFiles([]);
        commentController.loadAllThreads();
        localPrsProvider.refresh();
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        const currentBranch = await gitService.getCurrentBranch();
        if (generation === transitionGeneration) {
            branchSelectorProvider.setReviewState({
                currentBranch: currentBranch ?? '',
                mode: localPrManager.getActiveMode(),
            });
        }
    };
    const getOrCreateUncommittedReview = async (branch) => {
        const existing = localPrManager.findReviewByBranch(branch, 'uncommitted');
        return existing ?? localPrManager.createUncommittedReview(branch, false);
    };
    const getOrCreateBranchReview = async (baseBranch, targetBranch) => {
        const existing = localPrManager.listReviews().find(review => review.mode === 'branch'
            && review.baseBranch === baseBranch
            && review.targetBranch === targetBranch);
        return existing
            ?? localPrManager.createBranchReview(baseBranch, targetBranch, false);
    };
    const reviewUncommitted = async (options = {}) => {
        const generation = ++transitionGeneration;
        const branch = await gitService.getCurrentBranch();
        if (generation !== transitionGeneration) {
            return false;
        }
        if (!branch) {
            if (!options.quiet) {
                vscode.window.showWarningMessage('Offline Review: no current Git branch (detached HEAD?).');
            }
            return false;
        }
        try {
            const review = await getOrCreateUncommittedReview(branch);
            const applied = await transitionToReview(review, { showError: !options.quiet }, generation);
            if (applied && !options.quiet) {
                const count = changedFilesProvider.getAllFilePaths().length;
                vscode.window.showInformationMessage(`Uncommitted review on ${branch}: ${count} file${count === 1 ? '' : 's'}`);
            }
            return applied;
        }
        catch (error) {
            if (!options.quiet) {
                vscode.window.showErrorMessage(`Could not open uncommitted review: ${errorMessage(error)}`);
            }
            return false;
        }
    };
    const resolveBaseBranch = async (compareBranch, generation) => {
        const branches = await gitService.getBranches(true);
        if (generation !== undefined && generation !== transitionGeneration) {
            return undefined;
        }
        const selected = branchSelectorProvider.getSourceBranch()
            || localPrManager.getPreferredBaseBranch();
        let base = selected && branches.includes(selected) ? selected : undefined;
        if (!base) {
            base = await gitService.getPrimaryBranch(branches, undefined, {
                allowUnavailable: false,
                localFallback: false,
            });
        }
        if (!base) {
            base = await gitService.getSoleLocalBranch(compareBranch);
        }
        if (!base) {
            const localBranches = await gitService.getBranches(false);
            if (localBranches.length === 1 && localBranches[0] === compareBranch) {
                base = compareBranch;
            }
        }
        if (generation !== undefined && generation !== transitionGeneration) {
            return undefined;
        }
        if (base) {
            localPrManager.setPreferredBaseBranch(base);
        }
        return base;
    };
    const reviewActiveBranch = async (options = {}) => {
        const generation = ++transitionGeneration;
        const branch = await gitService.getCurrentBranch();
        if (generation !== transitionGeneration) {
            return false;
        }
        if (!branch) {
            if (!options.quiet) {
                vscode.window.showWarningMessage('Offline Review: no current Git branch (detached HEAD?).');
            }
            return false;
        }
        try {
            const base = await resolveBaseBranch(branch, generation);
            if (generation !== transitionGeneration) {
                return false;
            }
            if (!base) {
                if (!options.quiet) {
                    vscode.window.showWarningMessage('Offline Review: no primary/base branch found. Fetch remote metadata or select a base branch.');
                }
                return false;
            }
            const review = await getOrCreateBranchReview(base, branch);
            const applied = await transitionToReview(review, { showError: !options.quiet }, generation);
            if (applied && !options.quiet) {
                const count = changedFilesProvider.getAllFilePaths().length;
                const suffix = base === branch
                    ? ' (intentional primary-branch self-review)'
                    : '';
                vscode.window.showInformationMessage(`Branch review: ${(0, types_1.formatReviewLabel)(review)} — ${count} file${count === 1 ? '' : 's'}${suffix}`);
            }
            return applied;
        }
        catch (error) {
            if (!options.quiet) {
                vscode.window.showErrorMessage(`Could not open branch review: ${errorMessage(error)}`);
            }
            return false;
        }
    };
    const activateReviewFromUi = async (review) => {
        const generation = ++transitionGeneration;
        if (review.mode !== 'uncommitted') {
            await transitionToReview(review, {}, generation);
            return;
        }
        const currentBranch = await gitService.getCurrentBranch();
        if (generation !== transitionGeneration) {
            return;
        }
        if (currentBranch === review.branch) {
            await transitionToReview(review, {}, generation);
            return;
        }
        const openCurrent = currentBranch
            ? `Open ${currentBranch} (Recommended)`
            : undefined;
        const switchSaved = `Switch to ${review.branch}`;
        const choices = openCurrent
            ? [openCurrent, switchSaved, 'Cancel']
            : [switchSaved, 'Cancel'];
        const answer = await vscode.window.showWarningMessage(`This uncommitted review belongs to "${review.branch}", but `
            + `${currentBranch ? `"${currentBranch}" is checked out` : 'HEAD is detached'}.`, { modal: true }, ...choices);
        if (generation !== transitionGeneration) {
            return;
        }
        if (answer === openCurrent && currentBranch) {
            await reviewUncommitted();
        }
        else if (answer === switchSaved) {
            try {
                await gitService.checkoutBranch(review.branch);
                await transitionToReview(review);
            }
            catch (error) {
                vscode.window.showErrorMessage(`Could not switch to ${review.branch}: ${errorMessage(error)}`);
            }
        }
    };
    const restoreModeAfterClear = async (mode, previous) => {
        if (mode === 'uncommitted') {
            if (!await reviewUncommitted({ quiet: true })) {
                await clearReviewUi();
            }
            return;
        }
        if (previous?.mode === 'branch') {
            const generation = ++transitionGeneration;
            try {
                const review = await getOrCreateBranchReview(previous.baseBranch, previous.targetBranch);
                if (await transitionToReview(review, { showError: false }, generation)) {
                    return;
                }
            }
            catch {
                // Fall back to a review of the currently checked-out branch.
            }
        }
        if (!await reviewActiveBranch({ quiet: true })) {
            await clearReviewUi();
        }
    };
    if (initialized) {
        const active = localPrManager.getActiveReview();
        if (localPrManager.getActiveMode() === 'uncommitted') {
            // Checkout identity wins on startup; never auto-checkout a saved branch.
            await reviewUncommitted({ quiet: true });
        }
        else if (active?.mode === 'branch') {
            await transitionToReview(active);
        }
    }
    let refreshTimer;
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        const plan = changedFilesProvider.getDiffPlan();
        const active = localPrManager.getActiveReview();
        if (!active || !plan || plan.kind !== 'worktree' || plan.reviewId !== active.id) {
            return;
        }
        if (document.uri.scheme === 'file') {
            gitFileContentProvider.refreshWorkingTreeFile(vscode.workspace.asRelativePath(document.uri, false));
        }
        else {
            gitFileContentProvider.refreshAllWorkingTree();
        }
        if (refreshTimer) {
            clearTimeout(refreshTimer);
        }
        const reviewId = active.id;
        refreshTimer = setTimeout(() => {
            const current = localPrManager.getActiveReview();
            const appliedPlan = changedFilesProvider.getDiffPlan();
            if (current?.id === reviewId
                && appliedPlan?.kind === 'worktree'
                && appliedPlan.reviewId === reviewId) {
                void transitionToReview(current);
            }
        }, 500);
    }), { dispose: () => refreshTimer && clearTimeout(refreshTimer) });
    context.subscriptions.push(branchSelectorProvider.onDidSelectBranches(() => {
        // Selecting a base only updates preference. Mode buttons apply it.
    }), gitService.onDidChangeCheckout(({ branch }) => {
        // Open worktree documents may survive checkouts; invalidate each
        // actual cached identity before preparing the next branch state.
        gitFileContentProvider.refreshAllWorkingTree();
        if (!branch) {
            // Reserve immediately so any in-flight transition for the former
            // branch cannot publish after the checkout becomes detached.
            transitionGeneration++;
            if (localPrManager.getActiveMode() === 'uncommitted') {
                void clearReviewUi();
                void vscode.window.showWarningMessage('Offline Review: uncommitted reviews are unavailable while HEAD is detached. '
                    + 'Check out a branch to continue.');
            }
            return;
        }
        if (localPrManager.getActiveMode() === 'uncommitted') {
            // This path reserves its generation before the first Git await,
            // so rapid B -> C checkouts cannot let B cancel C.
            void reviewUncommitted({ quiet: true });
        }
        else {
            void reviewActiveBranch({ quiet: true });
        }
    }), gitService.onDidChangeHead(() => {
        void (async () => {
            const active = localPrManager.getActiveReview();
            if (!active) {
                return;
            }
            if (active.mode === 'uncommitted' && !await gitService.getCurrentBranch()) {
                await clearReviewUi();
                return;
            }
            await transitionToReview(active);
        })();
    }));
    let commentsWatchTimer;
    const reloadCommentsFromDisk = () => {
        const active = localPrManager.getActiveReview();
        if (active) {
            void transitionToReview(active, {
                ensureCommentsFile: false,
                showError: false,
            });
        }
        else {
            localCommentsProvider.refresh();
        }
    };
    const onCommentsFileChanged = (uri) => {
        const schedule = (delay) => {
            if (commentsWatchTimer) {
                clearTimeout(commentsWatchTimer);
            }
            commentsWatchTimer = setTimeout(() => {
                if (!storageService.shouldIgnoreWatch(uri.fsPath)) {
                    reloadCommentsFromDisk();
                }
            }, delay);
        };
        if (storageService.shouldIgnoreWatch(uri.fsPath)) {
            schedule(storageService.msUntilWatchAllowed() + 50);
        }
        else {
            schedule(400);
        }
    };
    const watcherPatterns = [
        '.vscode/local-reviews/reviews/*/comments.json',
    ];
    for (const pattern of watcherPatterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, pattern));
        context.subscriptions.push(watcher, watcher.onDidChange(onCommentsFileChanged), watcher.onDidCreate(onCommentsFileChanged), watcher.onDidDelete(onCommentsFileChanged));
    }
    context.subscriptions.push({
        dispose: () => commentsWatchTimer && clearTimeout(commentsWatchTimer),
    });
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.createReview', async () => {
        if (branchSelectorProvider.getMode() === 'uncommitted') {
            await reviewUncommitted();
        }
        else {
            await reviewActiveBranch();
        }
    }), vscode.commands.registerCommand('localPrReview.reviewUncommitted', async () => {
        await reviewUncommitted();
    }), vscode.commands.registerCommand('localPrReview.reviewActiveBranch', async () => {
        await reviewActiveBranch();
    }), vscode.commands.registerCommand('localPrReview.activateReview', async (item) => {
        const reviewId = item instanceof localPrsProvider_1.LocalPrItem
            ? item.review.id
            : typeof item === 'string'
                ? item
                : item?.id;
        const review = reviewId
            ? localPrManager.getReviewById(reviewId)
            : undefined;
        if (review) {
            await activateReviewFromUi(review);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.deleteReview', async (item) => {
        const reviewId = typeof item === 'string' ? item : item?.review.id;
        const review = reviewId
            ? localPrManager.getReviewById(reviewId)
            : localPrManager.getActiveReview();
        if (!review) {
            vscode.window.showInformationMessage('No review to delete.');
            return;
        }
        const answer = await vscode.window.showWarningMessage(`Delete review "${(0, types_1.formatReviewLabel)(review)}"? This also deletes its comments.`, { modal: true }, 'Delete');
        if (answer !== 'Delete') {
            return;
        }
        const wasActive = localPrManager.getActiveReview()?.id === review.id;
        transitionGeneration++;
        await storageService.withWatchSuppressed(() => {
            localPrManager.deleteReview(review.id);
        });
        if (wasActive) {
            await restoreModeAfterClear(review.mode, review);
        }
        else {
            localPrsProvider.refresh();
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
        }
    }), vscode.commands.registerCommand('localPrReview.clearActiveReview', async () => {
        const active = localPrManager.getActiveReview();
        if (!active) {
            vscode.window.showInformationMessage('No active review to clear.');
            return;
        }
        const answer = await vscode.window.showWarningMessage(`Clear active review "${(0, types_1.formatReviewLabel)(active)}" and its comments?`, { modal: true }, 'Clear');
        if (answer !== 'Clear') {
            return;
        }
        if (localPrManager.getActiveReview()?.id !== active.id) {
            vscode.window.showInformationMessage('The active review changed; nothing was cleared.');
            return;
        }
        transitionGeneration++;
        await storageService.withWatchSuppressed(() => {
            localPrManager.deleteReview(active.id);
        });
        await restoreModeAfterClear(active.mode, active);
        vscode.window.showInformationMessage('Active review comments cleared.');
    }), vscode.commands.registerCommand('localPrReview.clearAllReviews', async () => {
        const count = localPrManager.listReviews().length;
        if (count === 0) {
            vscode.window.showInformationMessage('No reviews to clear.');
            return;
        }
        const active = localPrManager.getActiveReview();
        const mode = active?.mode ?? localPrManager.getActiveMode();
        const answer = await vscode.window.showWarningMessage(`Clear all ${count} offline review${count === 1 ? '' : 's'} and their comments?`, { modal: true }, 'Clear all');
        if (answer !== 'Clear all') {
            return;
        }
        transitionGeneration++;
        await storageService.withWatchSuppressed(() => {
            localPrManager.clearAllReviews();
        });
        await restoreModeAfterClear(mode, active);
        vscode.window.showInformationMessage('All review comments cleared.');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.refreshFiles', async () => {
        const active = localPrManager.getActiveReview();
        if (active) {
            if (changedFilesProvider.getDiffPlan()?.kind === 'worktree') {
                gitFileContentProvider.refreshAllWorkingTree();
            }
            await transitionToReview(active);
        }
    }), vscode.commands.registerCommand('localPrReview.expandAll', async () => {
        for (const item of changedFilesProvider.getAllExpandableItems()) {
            try {
                await changedFilesTreeView.reveal(item, {
                    expand: true,
                    select: false,
                    focus: false,
                });
            }
            catch {
                // Tree contents may have changed while expanding.
            }
        }
    }), vscode.commands.registerCommand('localPrReview.openFile', async (item) => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root) {
            await vscode.window.showTextDocument(vscode.Uri.joinPath(root, item.fileChange.filePath));
        }
    }), vscode.commands.registerCommand('localPrReview.openDiff', async (item) => {
        const review = localPrManager.getReviewById(item.diffPlan.reviewId);
        const title = review
            ? `${item.fileChange.filePath} (${(0, types_1.formatReviewLabel)(review)})`
            : item.fileChange.filePath;
        await vscode.commands.executeCommand('vscode.diff', item.leftUri, item.rightUri, title);
        commentController.loadThreadsForFile(item.rightUri, item.fileChange.filePath, item.diffPlan);
    }), vscode.commands.registerCommand('localPrReview.openAllDiffs', async () => {
        const files = changedFilesProvider.getAllFileItems();
        if (files.length === 0) {
            vscode.window.showInformationMessage('No changed files to show.');
            return;
        }
        const plan = changedFilesProvider.getDiffPlan();
        const review = plan ? localPrManager.getReviewById(plan.reviewId) : undefined;
        const resources = files.map(item => [
            item.leftUri,
            item.rightUri,
            undefined,
        ]);
        try {
            await vscode.commands.executeCommand('vscode.changes', `Review: ${review ? (0, types_1.formatReviewLabel)(review) : 'changed files'}`, resources);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Multi-diff editor failed: ${errorMessage(error)}`);
        }
    }));
    const refreshCommentUi = () => {
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    };
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.addComment', (reply) => {
        try {
            addOrReply(commentController, reply);
            refreshCommentUi();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to add comment: ${errorMessage(error)}`);
        }
    }), vscode.commands.registerCommand('localPrReview.saveComment', (reply) => {
        try {
            const editing = reply.thread.comments.find(comment => comment.mode === vscode.CommentMode.Editing);
            if (editing) {
                commentController.saveEditedComment(reply.thread, editing, reply.text ?? '');
            }
            else {
                addOrReply(commentController, reply);
            }
            refreshCommentUi();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to save comment: ${errorMessage(error)}`);
        }
    }), vscode.commands.registerCommand('localPrReview.cancelComment', (reply) => {
        if (reply.thread.comments.length === 0) {
            reply.thread.dispose();
        }
    }), vscode.commands.registerCommand('localPrReview.resolveThread', (thread) => {
        if (thread.state === vscode.CommentThreadState.Unresolved) {
            commentController.resolveThread(thread);
        }
        else {
            commentController.unresolveThread(thread);
        }
        refreshCommentUi();
    }), vscode.commands.registerCommand('localPrReview.unresolveThread', (thread) => {
        commentController.unresolveThread(thread);
        refreshCommentUi();
    }), vscode.commands.registerCommand('localPrReview.editComment', (comment) => {
        const thread = comment.thread
            ?? comment.parent
            ?? commentController.findThreadForComment(comment);
        if (!thread) {
            return;
        }
        for (const candidate of thread.comments) {
            // Preserve the rendered comment object: the controller keeps
            // its stable persisted UUID identity in a WeakMap.
            candidate.mode = candidate === comment
                ? vscode.CommentMode.Editing
                : vscode.CommentMode.Preview;
        }
        thread.comments = [...thread.comments];
    }), vscode.commands.registerCommand('localPrReview.deleteComment', async (comment) => {
        const thread = comment.thread
            ?? comment.parent
            ?? commentController.findThreadForComment(comment);
        if (!thread) {
            vscode.window.showWarningMessage('Could not find that comment thread to delete.');
            return;
        }
        const answer = await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete');
        if (answer === 'Delete') {
            commentController.deleteComment(thread, comment);
            refreshCommentUi();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('localPrReview.refreshPrs', () => {
        localPrsProvider.refresh();
    }), vscode.commands.registerCommand('localPrReview.refreshComments', () => {
        reloadCommentsFromDisk();
    }), vscode.commands.registerCommand('localPrReview.suggestChange', async (reply) => {
        try {
            const range = reply.thread.range;
            if (!range) {
                vscode.window.showWarningMessage('Select a line range in the diff to suggest a change.');
                return;
            }
            const filePath = extractFilePath(reply.thread.uri);
            const pendingReviewId = reply.thread.comments.length === 0
                ? commentController.captureNewThreadReviewId(reply.thread.uri, filePath)
                : undefined;
            const document = await vscode.workspace.openTextDocument(reply.thread.uri);
            const normalized = new vscode.Range(range.start.line, 0, range.end.line, document.lineAt(range.end.line).text.length);
            const body = await suggestChangePanel_1.SuggestChangePanel.show(context.extensionUri, document.getText(normalized), filePath);
            if (body === undefined) {
                if (reply.thread.comments.length === 0) {
                    reply.thread.dispose();
                }
                return;
            }
            if (reply.thread.comments.length === 0) {
                commentController.createThread(reply.thread.uri, range, body, filePath, reply.thread, pendingReviewId);
            }
            else {
                commentController.addReply(reply.thread, body);
            }
            refreshCommentUi();
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to add suggestion: ${errorMessage(error)}`);
        }
    }), vscode.commands.registerCommand('localPrReview.deleteCommentsFile', async (item) => {
        const reviewId = typeof item === 'string' ? item : item.reviewId;
        const review = localPrManager.getReviewById(reviewId);
        if (!review) {
            return;
        }
        const answer = await vscode.window.showWarningMessage(`Delete all comments for "${(0, types_1.formatReviewLabel)(review)}"?`, { modal: true }, 'Delete');
        if (answer !== 'Delete') {
            return;
        }
        transitionGeneration++;
        await storageService.withWatchSuppressed(() => {
            storageService.deleteCommentsForReview(reviewId);
        });
        if (localPrManager.getActiveReview()?.id === reviewId) {
            await transitionToReview(review, {
                ensureCommentsFile: false,
            });
        }
        else {
            localCommentsProvider.refresh();
        }
    }));
    context.subscriptions.push(branchSelectorProvider, changedFilesProvider, localPrsProvider, localCommentsProvider, commentController, gitFileContentProvider, fileDecorationProvider, { dispose: () => localPrManager.dispose() });
}
function addOrReply(controller, reply) {
    const thread = reply.thread;
    const filePath = extractFilePath(thread.uri);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    if (!filePath) {
        throw new Error('Could not resolve the comment file path');
    }
    if (thread.comments.length === 0) {
        controller.createThread(thread.uri, range, reply.text ?? '', filePath, thread);
    }
    else {
        controller.addReply(thread, reply.text ?? '');
    }
}
function extractFilePath(uri) {
    if (uri.scheme === 'file') {
        return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map