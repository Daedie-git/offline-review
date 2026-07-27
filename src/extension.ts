import * as vscode from 'vscode';
import * as path from 'path';
import { AuthorIdentity } from './authorIdentity';
import { GitService } from './git/gitService';
import { GitFileContentProvider } from './git/gitFileContentProvider';
import { LocalPrManager } from './services/localPrManager';
import { ReviewTransitionCoordinator } from './services/reviewTransitionCoordinator';
import { ReviewCommentsWatcherCoordinator } from './services/reviewCommentsWatcherCoordinator';
import { StorageService } from './storage/storageService';
import { BranchSelectorWebviewProvider } from './views/branchSelectorWebviewProvider';
import { ChangedFilesProvider, FileChangeItem } from './views/changedFilesProvider';
import { LocalPrsProvider, LocalPrItem } from './views/localPrsProvider';
import { LocalCommentsProvider, CommentFileItem } from './views/localCommentsProvider';
import { ReviewCommentController } from './comments/commentController';
import { ReviewAnchorResolver } from './comments/reviewAnchorResolver';
import { LocalReviewTool } from './tools/localReviewTool';
import { ReviewFileDecorationProvider } from './decorations/fileDecorationProvider';
import { SuggestChangePanel } from './views/suggestChangePanel';
import { registerVirtualDocLanguageFeatures } from './language/virtualDocLanguageFeatures';
import { WorkspacePathResolver } from './workspaceComments/pathResolver';
import { WorkspaceCommentStorage } from './workspaceComments/storage';
import { WorkspaceCommentController } from './workspaceComments/controller';
import {
    CodeCommentThreadItem,
    WorkspaceCommentsProvider,
} from './workspaceComments/provider';
import { WorkspaceCommentsTool } from './workspaceComments/tool';
import {
    WorkspaceCommentOpener,
    WorkspaceCommentRefresher,
    WorkspaceCommentsWatcherCoordinator,
} from './workspaceComments/wiring';
import {
    formatReviewLabel,
    LocalPr,
} from './types';

interface TransitionOptions {
    ensureCommentsFile?: boolean;
    showError?: boolean;
}

interface ReviewModeOptions {
    quiet?: boolean;
}

type ReviewAttempt = 'applied' | 'superseded' | 'failed';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showInformationMessage(
            'Offline Review: Open a Git repository folder to use this extension.'
        );
        return;
    }

    const gitService = new GitService(context);
    const localPrManager = new LocalPrManager(gitService, workspaceRoot);
    const storageService = new StorageService(localPrManager);
    const transitionCoordinator = new ReviewTransitionCoordinator(storageService);
    const reviewAnchorResolver = new ReviewAnchorResolver(gitService, storageService);
    const workspacePathResolver = new WorkspacePathResolver(workspaceRoot);
    const workspaceCommentStorage = new WorkspaceCommentStorage(
        workspaceRoot,
        workspacePathResolver
    );
    const authorIdentity = new AuthorIdentity();
    const workspaceCommentController = new WorkspaceCommentController(
        workspaceCommentStorage,
        workspacePathResolver,
        authorIdentity
    );
    const workspaceCommentsProvider = new WorkspaceCommentsProvider(
        workspaceCommentStorage,
        workspacePathResolver
    );
    const workspaceCommentRefresher = new WorkspaceCommentRefresher(
        workspacePathResolver,
        workspaceCommentController,
        workspaceCommentsProvider
    );
    const workspaceCommentOpener = new WorkspaceCommentOpener(
        workspaceCommentStorage,
        workspacePathResolver
    );
    const gitFileContentProvider = new GitFileContentProvider(gitService);

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            'git-local-review',
            gitFileContentProvider
        )
    );
    registerVirtualDocLanguageFeatures(context, gitService);

    const branchSelectorProvider = new BranchSelectorWebviewProvider(
        context.extensionUri,
        gitService,
        localPrManager
    );
    const changedFilesProvider = new ChangedFilesProvider(
        gitService,
        storageService,
        localPrManager,
        reviewAnchorResolver
    );
    const localPrsProvider = new LocalPrsProvider(localPrManager);
    const localCommentsProvider = new LocalCommentsProvider(storageService);
    const commentController = new ReviewCommentController(
        storageService,
        reviewAnchorResolver,
        authorIdentity
    );
    const fileDecorationProvider = new ReviewFileDecorationProvider(
        storageService,
        gitService,
        reviewAnchorResolver
    );

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    try {
        workspaceCommentRefresher.refresh();
    } catch (error: unknown) {
        vscode.window.showErrorMessage(
            `Workspace code comments could not be loaded: ${errorMessage(error)}`
        );
    }

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && workspacePathResolver.resolveUri(editor.document.uri)) {
            workspaceCommentController.refreshCommentingRanges();
        }
    }));

    try {
        const localReviewTool = new LocalReviewTool(
            gitService,
            localPrManager,
            storageService,
            reviewAnchorResolver
        );
        context.subscriptions.push(
            vscode.lm.registerTool('localPrReview_getComments', localReviewTool)
        );
    } catch {
        // The Language Model API is optional.
    }
    try {
        context.subscriptions.push(vscode.lm.registerTool(
            'localPrReview_getCodeComments',
            new WorkspaceCommentsTool(workspaceCommentStorage, workspacePathResolver)
        ));
    } catch {
        // Register independently so one optional tool cannot disable the other.
    }

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            BranchSelectorWebviewProvider.viewType,
            branchSelectorProvider
        )
    );

    const changedFilesTreeView = vscode.window.createTreeView(
        'localPrReview.changedFiles',
        {
            treeDataProvider: changedFilesProvider,
            manageCheckboxStateManually: true,
            showCollapseAll: true,
        }
    );
    context.subscriptions.push(
        changedFilesTreeView.onDidChangeCheckboxState(event => {
            for (const [item, state] of event.items) {
                if (item instanceof FileChangeItem) {
                    changedFilesProvider.setFileReviewed(
                        item.fileChange.filePath,
                        state === vscode.TreeItemCheckboxState.Checked
                    );
                }
            }
        }),
        changedFilesTreeView,
        vscode.window.createTreeView('localPrReview.localPrs', {
            treeDataProvider: localPrsProvider,
        }),
        vscode.window.createTreeView('localPrReview.localComments', {
            treeDataProvider: localCommentsProvider,
        }),
        vscode.window.createTreeView('localPrReview.codeComments', {
            treeDataProvider: workspaceCommentsProvider,
        })
    );

    const initialized = await gitService.initialize();
    if (!initialized) {
        vscode.window.showInformationMessage(
            'Offline Review: No Git repository found. Open a folder with a Git repository.'
        );
    }

    // Every review switch/refresh runs through this generation. Preparation does
    // not mutate visible state; one synchronous apply publishes only the winner.
    let transitionRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const transitionToReview = async (
        review: LocalPr,
        options: TransitionOptions = {},
        reservedGeneration?: number
    ): Promise<boolean> => {
        const generation = reservedGeneration ?? transitionCoordinator.beginTransition();
        if (!transitionCoordinator.isCurrent(generation)) {
            return false;
        }
        try {
            const guarded = await transitionCoordinator.prepareStable({
                generation,
                reviewId: review.id,
                worktreeRoot: review.mode === 'uncommitted'
                    ? gitService.getSelectedWorktreeRoot()
                    : undefined,
                prepare: async () => {
                    const [prepared, currentBranch] = await Promise.all([
                        changedFilesProvider.prepareRefresh(review),
                        gitService.getCurrentBranch(),
                    ]);
                    const preparedComments = await reviewAnchorResolver.prepare(
                        prepared.plan,
                        prepared.files
                    );
                    return { prepared, currentBranch, preparedComments };
                },
            });
            if (guarded.status === 'superseded'
                || !localPrManager.getReviewById(review.id)) {
                return false;
            }
            if (guarded.status === 'retry') {
                if (transitionRetryTimer) {
                    clearTimeout(transitionRetryTimer);
                }
                transitionRetryTimer = setTimeout(() => {
                    if (transitionCoordinator.isCurrent(generation)
                        && localPrManager.getReviewById(review.id)) {
                        void transitionToReview(review, options, generation);
                    }
                }, 100);
                return false;
            }
            if (!transitionCoordinator.isCurrent(generation)
                || !transitionCoordinator.inputsAreCurrent(guarded.snapshot)) {
                return false;
            }

            const { prepared, currentBranch, preparedComments } = guarded.value;
            if (options.ensureCommentsFile !== false) {
                storageService.ensureCommentsFileForReview(review.id);
            }
            if (!transitionCoordinator.isCurrent(generation)
                || !transitionCoordinator.inputsAreCurrent(guarded.snapshot)) {
                return false;
            }
            localPrManager.setActiveReview(review.id);
            reviewAnchorResolver.applyPreparedState(preparedComments);
            changedFilesProvider.applyPreparedState(prepared);
            if (prepared.plan.kind === 'branch') {
                localPrManager.updateBranchReviewFallbackCommits(
                    prepared.plan.reviewId,
                    prepared.plan.baseCommit,
                    prepared.plan.targetCommit
                );
            }
            commentController.setReviewableFiles(
                prepared.files.map(file => file.filePath),
                prepared.files
                    .filter(file => file.status === 'deleted')
                    .map(file => file.filePath)
            );
            commentController.loadAllThreads(prepared.plan, preparedComments);
            branchSelectorProvider.setReviewState({
                review,
                currentBranch: currentBranch ?? '',
            });
            localPrsProvider.refresh();
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            return true;
        } catch (error: unknown) {
            if (transitionCoordinator.isCurrent(generation) && options.showError !== false) {
                vscode.window.showErrorMessage(
                    `Offline Review refresh failed: ${errorMessage(error)}`
                );
            }
            return false;
        }
    };

    const clearReviewUi = async (reservedGeneration?: number): Promise<void> => {
        const generation = reservedGeneration ?? transitionCoordinator.beginTransition();
        if (!transitionCoordinator.isCurrent(generation)) {
            return;
        }
        localPrManager.deactivateReview();
        reviewAnchorResolver.clear();
        changedFilesProvider.clear();
        commentController.setReviewableFiles([]);
        commentController.loadAllThreads();
        localPrsProvider.refresh();
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        const currentBranch = await gitService.getCurrentBranch();
        if (transitionCoordinator.isCurrent(generation)) {
            branchSelectorProvider.setReviewState({
                currentBranch: currentBranch ?? '',
                compare: currentBranch ?? '',
                mode: localPrManager.getActiveMode(),
            });
        }
    };

    const getOrCreateUncommittedReview = async (branch: string): Promise<LocalPr> => {
        const existing = localPrManager.findReviewByBranch(branch, 'uncommitted');
        return existing ?? localPrManager.createUncommittedReview(branch, false);
    };

    const getOrCreateBranchReview = async (
        baseBranch: string,
        targetBranch: string
    ): Promise<LocalPr> => {
        const existing = localPrManager.listReviews().find(review =>
            review.mode === 'branch'
            && review.baseBranch === baseBranch
            && review.targetBranch === targetBranch
        );
        return existing
            ?? localPrManager.createBranchReview(baseBranch, targetBranch, false);
    };

    const reviewUncommitted = async (
        options: ReviewModeOptions = {}
    ): Promise<ReviewAttempt> => {
        const generation = transitionCoordinator.beginTransition();
        const branch = await gitService.getCurrentBranch();
        if (!transitionCoordinator.isCurrent(generation)) {
            return 'superseded';
        }
        if (!branch) {
            if (!options.quiet) {
                vscode.window.showWarningMessage(
                    'Offline Review: no current Git branch (detached HEAD?).'
                );
            }
            return 'failed';
        }
        try {
            const review = await getOrCreateUncommittedReview(branch);
            const applied = await transitionToReview(
                review,
                { showError: !options.quiet },
                generation
            );
            if (!applied) {
                return transitionCoordinator.isCurrent(generation) ? 'failed' : 'superseded';
            }
            if (!options.quiet) {
                const count = changedFilesProvider.getAllFilePaths().length;
                vscode.window.showInformationMessage(
                    `Uncommitted review on ${branch}: ${count} file${count === 1 ? '' : 's'}`
                );
            }
            return 'applied';
        } catch (error: unknown) {
            if (!transitionCoordinator.isCurrent(generation)) {
                return 'superseded';
            }
            if (!options.quiet) {
                vscode.window.showErrorMessage(
                    `Could not open uncommitted review: ${errorMessage(error)}`
                );
            }
            return 'failed';
        }
    };

    const resolveBaseBranch = async (
        compareBranch: string,
        generation?: number
    ): Promise<string | undefined> => {
        const branches = await gitService.getBranches(true);
        if (generation !== undefined && !transitionCoordinator.isCurrent(generation)) {
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
        if (generation !== undefined && !transitionCoordinator.isCurrent(generation)) {
            return undefined;
        }
        if (base) {
            localPrManager.setPreferredBaseBranch(base);
        }
        return base;
    };

    const reviewActiveBranch = async (
        options: ReviewModeOptions = {}
    ): Promise<ReviewAttempt> => {
        const generation = transitionCoordinator.beginTransition();
        const branch = await gitService.getCurrentBranch();
        if (!transitionCoordinator.isCurrent(generation)) {
            return 'superseded';
        }
        if (!branch) {
            if (!options.quiet) {
                vscode.window.showWarningMessage(
                    'Offline Review: no current Git branch (detached HEAD?).'
                );
            }
            return 'failed';
        }

        try {
            const base = await resolveBaseBranch(branch, generation);
            if (!transitionCoordinator.isCurrent(generation)) {
                return 'superseded';
            }
            if (!base) {
                if (!options.quiet) {
                    vscode.window.showWarningMessage(
                        'Offline Review: no primary/base branch found. Fetch remote metadata or select a base branch.'
                    );
                }
                return 'failed';
            }
            const review = await getOrCreateBranchReview(base, branch);
            const applied = await transitionToReview(
                review,
                { showError: !options.quiet },
                generation
            );
            if (!applied) {
                return transitionCoordinator.isCurrent(generation) ? 'failed' : 'superseded';
            }
            if (!options.quiet) {
                const count = changedFilesProvider.getAllFilePaths().length;
                const suffix = base === branch
                    ? ' (intentional primary-branch self-review)'
                    : '';
                vscode.window.showInformationMessage(
                    `Branch review: ${formatReviewLabel(review)} — ${count} file${count === 1 ? '' : 's'}${suffix}`
                );
            }
            return 'applied';
        } catch (error: unknown) {
            if (!transitionCoordinator.isCurrent(generation)) {
                return 'superseded';
            }
            if (!options.quiet) {
                vscode.window.showErrorMessage(
                    `Could not open branch review: ${errorMessage(error)}`
                );
            }
            return 'failed';
        }
    };

    const activateReviewFromUi = async (review: LocalPr): Promise<void> => {
        const generation = transitionCoordinator.beginTransition();
        if (review.mode === 'branch') {
            await transitionToReview(review, {}, generation);
            return;
        }

        const currentBranch = await gitService.getCurrentBranch();
        if (!transitionCoordinator.isCurrent(generation)) {
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
        const answer = await vscode.window.showWarningMessage(
            `This uncommitted review belongs to "${review.branch}", but `
                + `${currentBranch ? `"${currentBranch}" is checked out` : 'HEAD is detached'}.`,
            { modal: true },
            ...choices
        );
        if (!transitionCoordinator.isCurrent(generation)) {
            return;
        }

        if (answer === openCurrent && currentBranch) {
            await reviewUncommitted();
        } else if (answer === switchSaved) {
            try {
                await gitService.checkoutBranch(review.branch);
                await transitionToReview(review);
            } catch (error: unknown) {
                vscode.window.showErrorMessage(
                    `Could not switch to ${review.branch}: ${errorMessage(error)}`
                );
            }
        }
    };

    if (initialized) {
        const active = localPrManager.getActiveReview();
        if (!active) {
            await clearReviewUi();
        } else {
            const restored = active.mode === 'uncommitted'
                // Local is the default worktree; never auto-checkout a saved branch.
                ? await reviewUncommitted({ quiet: true }) !== 'failed'
                : await transitionToReview(active);
            if (!restored) {
                await clearReviewUi();
            }
        }
    }

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            // Workspace comments are independent of review state and refresh on
            // every authorized source save, even when no review is active.
            try {
                workspaceCommentRefresher.refreshAuthorizedSave(document);
            } catch (error: unknown) {
                vscode.window.showErrorMessage(
                    `Workspace code comments could not be reloaded: ${errorMessage(error)}`
                );
            }

            const selectedWorktreeRoot = gitService.getSelectedWorktreeRoot();
            const relevantSource = document.uri.scheme !== 'file'
                || relativePathInRoot(document.uri.fsPath, selectedWorktreeRoot);
            const active = localPrManager.getActiveReview();
            if (!relevantSource || active?.mode !== 'uncommitted') {
                return;
            }
            transitionCoordinator.markWorktreeChanged(selectedWorktreeRoot);

            const plan = changedFilesProvider.getDiffPlan();
            if (plan?.kind === 'worktree'
                && plan.reviewId === active.id
                && plan.worktreeRoot === selectedWorktreeRoot) {
                if (document.uri.scheme === 'file') {
                    const filePath = relativePathInRoot(
                        document.uri.fsPath,
                        plan.worktreeRoot
                    );
                    if (filePath) {
                        gitFileContentProvider.refreshWorkingTreeFile(
                            filePath,
                            plan.worktreeRoot
                        );
                    }
                } else {
                    gitFileContentProvider.refreshAllWorkingTree(plan.worktreeRoot);
                }
            }
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            const reviewId = active.id;
            refreshTimer = setTimeout(() => {
                const current = localPrManager.getActiveReview();
                if (current?.id === reviewId
                    && current.mode === 'uncommitted'
                    && gitService.getSelectedWorktreeRoot() === selectedWorktreeRoot) {
                    // Always reserve a fresh winner. This is also the fallback
                    // when a save raced a preparation that later failed.
                    void reviewUncommitted({ quiet: true });
                }
            }, 500);
        }),
        { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
        { dispose: () => transitionRetryTimer && clearTimeout(transitionRetryTimer) }
    );

    let worktreeSelectionGeneration = 0;
    context.subscriptions.push(
        branchSelectorProvider.onDidSelectBranches(() => {
            // Selecting a base only updates preference. Mode buttons apply it.
        }),
        gitService.onDidChangeWorktreeSelection(() => {
            // The selector changes only Git review context. VS Code stays in the
            // original workspace while this coordinator refreshes the mode.
            const selectionGeneration = ++worktreeSelectionGeneration;
            void (async () => {
                const initiatingReviewId = localPrManager.getActiveReview()?.id;
                if (!initiatingReviewId) {
                    await clearReviewUi();
                    branchSelectorProvider.refresh();
                    fileDecorationProvider.refresh();
                    return;
                }
                const applySelectedMode = (): Promise<ReviewAttempt> =>
                    localPrManager.getActiveMode() === 'uncommitted'
                        ? reviewUncommitted({ quiet: true })
                        : reviewActiveBranch({ quiet: true });
                let result = await applySelectedMode();
                if (selectionGeneration !== worktreeSelectionGeneration) {
                    return;
                }

                const appliedPlan = changedFilesProvider.getDiffPlan();
                if (result === 'superseded'
                    && appliedPlan?.worktreeRoot !== gitService.getSelectedWorktreeRoot()) {
                    // A background event raced the selector. Retry once so the
                    // latest selected checkout remains authoritative, unless a
                    // destructive command deliberately made the UI inactive.
                    if (localPrManager.getActiveReview()?.id !== initiatingReviewId) {
                        return;
                    }
                    result = await applySelectedMode();
                    if (selectionGeneration !== worktreeSelectionGeneration) {
                        return;
                    }
                }
                if (result === 'failed') {
                    await clearReviewUi();
                }
                branchSelectorProvider.refresh();
                fileDecorationProvider.refresh();
            })();
        }),
        gitService.onDidChangeCheckout(({ branch }) => {
            if (!gitService.isLocalWorktreeSelected()) {
                return;
            }
            // Open worktree documents may survive checkouts; invalidate each
            // actual cached identity before preparing the next branch state.
            gitFileContentProvider.refreshAllWorkingTree(
                gitService.getSelectedWorktreeRoot()
            );
            if (!localPrManager.getActiveReview()) {
                void clearReviewUi();
                return;
            }
            if (!branch) {
                // Reserve immediately so any in-flight transition for the former
                // branch cannot publish after the checkout becomes detached.
                transitionCoordinator.beginTransition();
                if (localPrManager.getActiveMode() === 'uncommitted') {
                    void clearReviewUi();
                    void vscode.window.showWarningMessage(
                        'Offline Review: uncommitted reviews are unavailable while HEAD is detached. '
                            + 'Check out a branch to continue.'
                    );
                }
                return;
            }

            if (localPrManager.getActiveMode() === 'uncommitted') {
                // This path reserves its generation before the first Git await,
                // so rapid B -> C checkouts cannot let B cancel C.
                void reviewUncommitted({ quiet: true });
            } else {
                void reviewActiveBranch({ quiet: true });
            }
        }),
        gitService.onDidChangeHead(() => {
            if (!gitService.isLocalWorktreeSelected()) {
                return;
            }
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
        })
    );

    const reloadCommentsFromDisk = (changedReviewId?: string): void => {
        const active = localPrManager.getActiveReview();
        if (active && (!changedReviewId || active.id === changedReviewId)) {
            // Reserve a new winner even when another transition is preparing;
            // the external revision must never be folded into stale work.
            void transitionToReview(active, {
                ensureCommentsFile: false,
                showError: false,
            });
        } else {
            localCommentsProvider.refresh();
        }
    };
    const commentsWatcherCoordinator = new ReviewCommentsWatcherCoordinator(
        storageService,
        reloadCommentsFromDisk
    );
    const onCommentsFileChanged = (uri: vscode.Uri): void => {
        commentsWatcherCoordinator.notify(
            path.basename(path.dirname(uri.fsPath)),
            uri.fsPath
        );
    };
    const watcherPatterns = [
        '.vscode/offline-reviews/reviews/*/comments.json',
    ];
    for (const pattern of watcherPatterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, pattern)
        );
        context.subscriptions.push(
            watcher,
            watcher.onDidChange(onCommentsFileChanged),
            watcher.onDidCreate(onCommentsFileChanged),
            watcher.onDidDelete(onCommentsFileChanged)
        );
    }
    context.subscriptions.push(commentsWatcherCoordinator);

    const reloadWorkspaceComments = (): void => {
        try {
            workspaceCommentRefresher.refresh();
        } catch (error: unknown) {
            vscode.window.showErrorMessage(
                `Workspace code comments could not be reloaded: ${errorMessage(error)}`
            );
        }
    };
    const workspaceCommentsWatcherCoordinator =
        new WorkspaceCommentsWatcherCoordinator(
            workspaceCommentStorage,
            reloadWorkspaceComments
        );
    const onWorkspaceCommentsChanged = (uri: vscode.Uri): void => {
        workspaceCommentsWatcherCoordinator.notify(uri.fsPath);
    };
    const workspaceCommentsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
            workspaceRoot,
            '.vscode/offline-reviews/workspace-comments.json'
        )
    );
    context.subscriptions.push(
        workspaceCommentsWatcher,
        workspaceCommentsWatcher.onDidChange(onWorkspaceCommentsChanged),
        workspaceCommentsWatcher.onDidCreate(onWorkspaceCommentsChanged),
        workspaceCommentsWatcher.onDidDelete(onWorkspaceCommentsChanged),
        workspaceCommentsWatcherCoordinator
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localPrReview.createReview', async () => {
            if (branchSelectorProvider.getMode() === 'uncommitted') {
                await reviewUncommitted();
            } else {
                await reviewActiveBranch();
            }
        }),
        vscode.commands.registerCommand('localPrReview.reviewUncommitted', async () => {
            await reviewUncommitted();
        }),
        vscode.commands.registerCommand('localPrReview.reviewActiveBranch', async () => {
            await reviewActiveBranch();
        }),
        vscode.commands.registerCommand(
            'localPrReview.activateReview',
            async (item: LocalPrItem | LocalPr | string | undefined) => {
                const reviewId = item instanceof LocalPrItem
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
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localPrReview.deleteReview',
            async (item?: LocalPrItem | string) => {
                const reviewId = typeof item === 'string' ? item : item?.review.id;
                const review = reviewId
                    ? localPrManager.getReviewById(reviewId)
                    : localPrManager.getActiveReview();
                if (!review) {
                    vscode.window.showInformationMessage('No review to delete.');
                    return;
                }
                const answer = await vscode.window.showWarningMessage(
                    `Delete review "${formatReviewLabel(review)}"? This also deletes its comments.`,
                    { modal: true },
                    'Delete'
                );
                if (answer !== 'Delete') {
                    return;
                }
                const wasActive = localPrManager.getActiveReview()?.id === review.id;
                if (wasActive) {
                    const generation = transitionCoordinator.beginTransition();
                    await storageService.withWatchSuppressed(async () => {
                        localPrManager.deleteReview(review.id);
                        await clearReviewUi(generation);
                    });
                } else {
                    await storageService.withWatchSuppressed(() => {
                        localPrManager.deleteReview(review.id);
                        localPrsProvider.refresh();
                        localCommentsProvider.refresh();
                        fileDecorationProvider.refresh();
                    });
                }
            }
        ),
        vscode.commands.registerCommand('localPrReview.clearActiveReview', async () => {
            const active = localPrManager.getActiveReview();
            if (!active) {
                vscode.window.showInformationMessage('No active review to clear.');
                return;
            }
            const answer = await vscode.window.showWarningMessage(
                `Clear active review "${formatReviewLabel(active)}" and its comments?`,
                { modal: true },
                'Clear'
            );
            if (answer !== 'Clear') {
                return;
            }
            if (localPrManager.getActiveReview()?.id !== active.id) {
                vscode.window.showInformationMessage(
                    'The active review changed; nothing was cleared.'
                );
                return;
            }
            const generation = transitionCoordinator.beginTransition();
            await storageService.withWatchSuppressed(async () => {
                localPrManager.deleteReview(active.id);
                await clearReviewUi(generation);
            });
            vscode.window.showInformationMessage('Active review cleared.');
        }),
        vscode.commands.registerCommand('localPrReview.clearAllReviews', async () => {
            const count = localPrManager.listReviews().length;
            if (count === 0) {
                vscode.window.showInformationMessage('No reviews to clear.');
                return;
            }
            const answer = await vscode.window.showWarningMessage(
                `Clear all ${count} offline review${count === 1 ? '' : 's'} and their comments?`,
                { modal: true },
                'Clear all'
            );
            if (answer !== 'Clear all') {
                return;
            }
            const generation = transitionCoordinator.beginTransition();
            await storageService.withWatchSuppressed(async () => {
                localPrManager.clearAllReviews();
                await clearReviewUi(generation);
            });
            vscode.window.showInformationMessage('All reviews and comments cleared.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localPrReview.refreshFiles', async () => {
            const plan = changedFilesProvider.getDiffPlan();
            if (plan?.kind === 'worktree') {
                gitFileContentProvider.refreshAllWorkingTree(plan.worktreeRoot);
            }
            const active = localPrManager.getActiveReview();
            if (!active) {
                vscode.window.showInformationMessage(
                    'No active review. Choose a review mode to create one.'
                );
                return;
            }
            if (active.mode === 'branch'
                && plan?.worktreeRoot === gitService.getSelectedWorktreeRoot()) {
                await transitionToReview(active, { showError: false });
            } else if (active.mode === 'uncommitted') {
                await reviewUncommitted({ quiet: true });
            } else {
                await reviewActiveBranch({ quiet: true });
            }
        }),
        vscode.commands.registerCommand('localPrReview.expandAll', async () => {
            for (const item of changedFilesProvider.getAllExpandableItems()) {
                try {
                    await changedFilesTreeView.reveal(item, {
                        expand: true,
                        select: false,
                        focus: false,
                    });
                } catch {
                    // Tree contents may have changed while expanding.
                }
            }
        }),
        vscode.commands.registerCommand(
            'localPrReview.openFile',
            async (item: FileChangeItem) => {
                await vscode.window.showTextDocument(vscode.Uri.joinPath(
                    vscode.Uri.file(item.diffPlan.worktreeRoot),
                    item.fileChange.filePath
                ));
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.openDiff',
            async (item: FileChangeItem) => {
                const review = localPrManager.getReviewById(item.diffPlan.reviewId);
                const title = review
                    ? `${item.fileChange.filePath} (${formatReviewLabel(review)})`
                    : item.fileChange.filePath;
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    item.leftUri,
                    item.rightUri,
                    title
                );
                commentController.loadThreadsForFile(
                    item.commentUri,
                    item.fileChange.filePath,
                    item.diffPlan
                );
            }
        ),
        vscode.commands.registerCommand('localPrReview.openAllDiffs', async () => {
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
            ] as [vscode.Uri, vscode.Uri, undefined]);
            try {
                await vscode.commands.executeCommand(
                    'vscode.changes',
                    `Review: ${review ? formatReviewLabel(review) : 'changed files'}`,
                    resources
                );
            } catch (error: unknown) {
                vscode.window.showErrorMessage(
                    `Multi-diff editor failed: ${errorMessage(error)}`
                );
            }
        })
    );

    const refreshCommentUi = (): void => {
        localCommentsProvider.refresh();
        fileDecorationProvider.refresh();
        changedFilesProvider.fireChange();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localPrReview.addComment',
            async (reply: vscode.CommentReply) => {
                try {
                    await addOrReply(commentController, reply);
                    refreshCommentUi();
                } catch (error: unknown) {
                    vscode.window.showErrorMessage(
                        `Failed to add comment: ${errorMessage(error)}`
                    );
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.saveComment',
            async (reply: vscode.CommentReply) => {
                try {
                    const editing = reply.thread.comments.find(
                        comment => comment.mode === vscode.CommentMode.Editing
                    );
                    if (editing) {
                        commentController.saveEditedComment(
                            reply.thread,
                            editing,
                            reply.text ?? ''
                        );
                    } else {
                        await addOrReply(commentController, reply);
                    }
                    refreshCommentUi();
                } catch (error: unknown) {
                    vscode.window.showErrorMessage(
                        `Failed to save comment: ${errorMessage(error)}`
                    );
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.cancelComment',
            (reply: vscode.CommentReply) => {
                if (reply.thread.comments.length === 0) {
                    reply.thread.dispose();
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.resolveThread',
            (thread: vscode.CommentThread) => {
                if (thread.state === vscode.CommentThreadState.Unresolved) {
                    commentController.resolveThread(thread);
                } else {
                    commentController.unresolveThread(thread);
                }
                refreshCommentUi();
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.unresolveThread',
            (thread: vscode.CommentThread) => {
                commentController.unresolveThread(thread);
                refreshCommentUi();
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.editComment',
            (comment: vscode.Comment & { thread?: vscode.CommentThread; parent?: vscode.CommentThread }) => {
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
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.deleteComment',
            async (comment: vscode.Comment & { thread?: vscode.CommentThread; parent?: vscode.CommentThread }) => {
                const thread = comment.thread
                    ?? comment.parent
                    ?? commentController.findThreadForComment(comment);
                if (!thread) {
                    vscode.window.showWarningMessage(
                        'Could not find that comment thread to delete.'
                    );
                    return;
                }
                const answer = await vscode.window.showWarningMessage(
                    'Delete this comment?',
                    { modal: true },
                    'Delete'
                );
                if (answer === 'Delete') {
                    commentController.deleteComment(thread, comment);
                    refreshCommentUi();
                }
            }
        )
    );

    const refreshWorkspaceCommentUi = (): void => {
        workspaceCommentsProvider.refresh();
    };
    const reportWorkspaceCommentFailure = (operation: string, error: unknown): void => {
        vscode.window.showErrorMessage(
            `Failed to ${operation} workspace code comment: ${errorMessage(error)}`
        );
        reloadWorkspaceComments();
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'localPrReview.addCodeComment',
            async (reply: vscode.CommentReply) => {
                try {
                    await addOrReplyWorkspaceComment(workspaceCommentController, reply);
                    refreshWorkspaceCommentUi();
                } catch (error: unknown) {
                    reportWorkspaceCommentFailure('add', error);
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.saveCodeComment',
            async (reply: vscode.CommentReply) => {
                try {
                    const editing = reply.thread.comments.find(
                        comment => comment.mode === vscode.CommentMode.Editing
                    );
                    if (editing) {
                        workspaceCommentController.saveEditedComment(
                            reply.thread,
                            editing,
                            reply.text ?? ''
                        );
                    } else {
                        await addOrReplyWorkspaceComment(workspaceCommentController, reply);
                    }
                    refreshWorkspaceCommentUi();
                } catch (error: unknown) {
                    reportWorkspaceCommentFailure('save', error);
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.cancelCodeComment',
            (reply: vscode.CommentReply) => {
                if (reply.thread.comments.length === 0) {
                    reply.thread.dispose();
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.resolveCodeComment',
            (thread: vscode.CommentThread) => {
                try {
                    workspaceCommentController.resolveThread(thread);
                    refreshWorkspaceCommentUi();
                } catch (error: unknown) {
                    reportWorkspaceCommentFailure('resolve', error);
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.unresolveCodeComment',
            (thread: vscode.CommentThread) => {
                try {
                    workspaceCommentController.unresolveThread(thread);
                    refreshWorkspaceCommentUi();
                } catch (error: unknown) {
                    reportWorkspaceCommentFailure('unresolve', error);
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.editCodeComment',
            (comment: vscode.Comment & { thread?: vscode.CommentThread; parent?: vscode.CommentThread }) => {
                const thread = comment.thread
                    ?? comment.parent
                    ?? workspaceCommentController.findThreadForComment(comment);
                if (!thread) {
                    reportWorkspaceCommentFailure(
                        'edit',
                        new Error('The comment is stale or no longer available')
                    );
                    return;
                }
                for (const candidate of thread.comments) {
                    candidate.mode = candidate === comment
                        ? vscode.CommentMode.Editing
                        : vscode.CommentMode.Preview;
                }
                thread.comments = [...thread.comments];
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.deleteCodeComment',
            async (comment: vscode.Comment & { thread?: vscode.CommentThread; parent?: vscode.CommentThread }) => {
                const thread = comment.thread
                    ?? comment.parent
                    ?? workspaceCommentController.findThreadForComment(comment);
                if (!thread) {
                    reportWorkspaceCommentFailure(
                        'delete',
                        new Error('The comment is stale or no longer available')
                    );
                    return;
                }
                const answer = await vscode.window.showWarningMessage(
                    'Delete this workspace code comment?',
                    { modal: true },
                    'Delete'
                );
                if (answer === 'Delete') {
                    try {
                        workspaceCommentController.deleteComment(thread, comment);
                        refreshWorkspaceCommentUi();
                    } catch (error: unknown) {
                        reportWorkspaceCommentFailure('delete', error);
                    }
                }
            }
        ),
        vscode.commands.registerCommand('localPrReview.refreshCodeComments', () => {
            reloadWorkspaceComments();
        }),
        vscode.commands.registerCommand('localPrReview.clearCodeComments', async () => {
            try {
                if (workspaceCommentStorage.load().threads.length === 0) {
                    vscode.window.showInformationMessage('No workspace code comments to clear.');
                    return;
                }
                const answer = await vscode.window.showWarningMessage(
                    'Clear all workspace code comments? Review comments are not affected.',
                    { modal: true },
                    'Clear'
                );
                if (answer === 'Clear') {
                    workspaceCommentStorage.clear();
                    reloadWorkspaceComments();
                }
            } catch (error: unknown) {
                reportWorkspaceCommentFailure('clear', error);
            }
        }),
        vscode.commands.registerCommand(
            'localPrReview.openCodeComment',
            async (item: CodeCommentThreadItem) => {
                try {
                    const opened = await workspaceCommentOpener.open(
                        item.report.id,
                        item.report.filePath
                    );
                    const editor = await vscode.window.showTextDocument(opened.document);
                    if (opened.report.anchorStatus === 'reanchored') {
                        vscode.window.showInformationMessage(
                            `Workspace code comment reanchored from lines ${opened.report.startLine + 1}-${opened.report.endLine + 1} `
                                + `to ${opened.range.start.line + 1}-${opened.range.end.line + 1}.`
                        );
                    }
                    editor.selection = new vscode.Selection(
                        opened.range.start,
                        opened.range.end
                    );
                    editor.revealRange(
                        opened.range,
                        vscode.TextEditorRevealType.InCenterIfOutsideViewport
                    );
                } catch (error: unknown) {
                    reportWorkspaceCommentFailure('open', error);
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localPrReview.refreshPrs', () => {
            localPrsProvider.refresh();
        }),
        vscode.commands.registerCommand('localPrReview.refreshComments', () => {
            reloadCommentsFromDisk();
        }),
        vscode.commands.registerCommand(
            'localPrReview.suggestChange',
            async (reply: vscode.CommentReply) => {
                try {
                    const range = reply.thread.range;
                    if (!range) {
                        vscode.window.showWarningMessage(
                            'Select a line range in the diff to suggest a change.'
                        );
                        return;
                    }
                    const filePath = extractFilePath(reply.thread.uri);
                    const pendingReviewId = reply.thread.comments.length === 0
                        ? commentController.captureNewThreadReviewId(reply.thread.uri, filePath)
                        : undefined;
                    const document = findOpenDocument(reply.thread.uri)
                        ?? await vscode.workspace.openTextDocument(reply.thread.uri);
                    if (document.uri.toString() !== reply.thread.uri.toString()) {
                        throw new Error('The review document changed while the suggestion was opening');
                    }
                    const normalized = new vscode.Range(
                        range.start.line,
                        0,
                        range.end.line,
                        document.lineAt(range.end.line).text.length
                    );
                    const body = await SuggestChangePanel.show(
                        context.extensionUri,
                        document.getText(normalized),
                        filePath
                    );
                    if (body === undefined) {
                        if (reply.thread.comments.length === 0) {
                            reply.thread.dispose();
                        }
                        return;
                    }
                    if (reply.thread.comments.length === 0) {
                        await commentController.createThread(
                            reply.thread.uri,
                            range,
                            body,
                            filePath,
                            reply.thread,
                            pendingReviewId,
                            document
                        );
                    } else {
                        commentController.addReply(reply.thread, body);
                    }
                    refreshCommentUi();
                } catch (error: unknown) {
                    vscode.window.showErrorMessage(
                        `Failed to add suggestion: ${errorMessage(error)}`
                    );
                }
            }
        ),
        vscode.commands.registerCommand(
            'localPrReview.deleteCommentsFile',
            async (item: CommentFileItem | string) => {
                const reviewId = typeof item === 'string' ? item : item.reviewId;
                const review = localPrManager.getReviewById(reviewId);
                if (!review) {
                    return;
                }
                const answer = await vscode.window.showWarningMessage(
                    `Delete all comments for "${formatReviewLabel(review)}"?`,
                    { modal: true },
                    'Delete'
                );
                if (answer !== 'Delete') {
                    return;
                }
                transitionCoordinator.beginTransition();
                await storageService.withWatchSuppressed(() => {
                    storageService.deleteCommentsForReview(reviewId);
                });
                if (localPrManager.getActiveReview()?.id === reviewId) {
                    await transitionToReview(review, {
                        ensureCommentsFile: false,
                    });
                } else {
                    localCommentsProvider.refresh();
                }
            }
        )
    );

    context.subscriptions.push(
        branchSelectorProvider,
        changedFilesProvider,
        localPrsProvider,
        localCommentsProvider,
        commentController,
        workspaceCommentsProvider,
        workspaceCommentController,
        gitFileContentProvider,
        fileDecorationProvider,
        { dispose: () => localPrManager.dispose() }
    );

    // Activation can finish after Cursor has already cached an empty result for
    // the restored editor. Republish once after all asynchronous setup is done.
    workspaceCommentController.refreshCommentingRanges();
}

async function addOrReply(
    controller: ReviewCommentController,
    reply: vscode.CommentReply
): Promise<void> {
    const thread = reply.thread;
    const filePath = extractFilePath(thread.uri);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    if (!filePath) {
        throw new Error('Could not resolve the comment file path');
    }
    if (thread.comments.length === 0) {
        await controller.createThread(
            thread.uri,
            range,
            reply.text ?? '',
            filePath,
            thread
        );
    } else {
        controller.addReply(thread, reply.text ?? '');
    }
}

export async function addOrReplyWorkspaceComment(
    controller: WorkspaceCommentController,
    reply: vscode.CommentReply
): Promise<void> {
    if (reply.thread.comments.length > 0) {
        controller.addReply(reply.thread, reply.text ?? '');
        return;
    }
    const expectedUri = reply.thread.uri.toString();
    const document = findOpenDocument(reply.thread.uri)
        ?? await vscode.workspace.openTextDocument(reply.thread.uri);
    if (document.uri.toString() !== expectedUri) {
        throw new Error('The workspace comment document changed while it was opening');
    }
    controller.createThread(
        document,
        reply.thread.range ?? new vscode.Range(0, 0, 0, 0),
        reply.text ?? '',
        reply.thread
    );
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const target = uri.toString();
    return vscode.workspace.textDocuments.find(document =>
        document.uri.toString() === target
    );
}

function extractFilePath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') {
        return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}

function relativePathInRoot(filePath: string, root: string): string | undefined {
    const relative = path.relative(root, filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        return undefined;
    }
    return relative.split(path.sep).join('/');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {}
