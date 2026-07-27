import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './git/gitService';
import { GitFileContentProvider } from './git/gitFileContentProvider';
import { LocalPrManager } from './services/localPrManager';
import { StorageService } from './storage/storageService';
import { BranchSelectorWebviewProvider } from './views/branchSelectorWebviewProvider';
import { ChangedFilesProvider, FileChangeItem } from './views/changedFilesProvider';
import { LocalPrsProvider, LocalPrItem } from './views/localPrsProvider';
import { LocalCommentsProvider, CommentFileItem } from './views/localCommentsProvider';
import { ReviewCommentController } from './comments/commentController';
import { LocalReviewTool } from './tools/localReviewTool';
import { ReviewFileDecorationProvider } from './decorations/fileDecorationProvider';
import { SuggestChangePanel } from './views/suggestChangePanel';
import { registerVirtualDocLanguageFeatures } from './language/virtualDocLanguageFeatures';
import {
    formatReviewLabel,
    LocalPr,
    ReviewMode,
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
        localPrManager
    );
    const localPrsProvider = new LocalPrsProvider(localPrManager);
    const localCommentsProvider = new LocalCommentsProvider(storageService);
    const commentController = new ReviewCommentController(storageService);
    const fileDecorationProvider = new ReviewFileDecorationProvider(
        storageService,
        gitService
    );

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    try {
        const localReviewTool = new LocalReviewTool(
            gitService,
            localPrManager,
            storageService
        );
        context.subscriptions.push(
            vscode.lm.registerTool('localPrReview_getComments', localReviewTool)
        );
    } catch {
        // The Language Model API is optional.
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
    let transitionGeneration = 0;
    /** Generation whose review state is fully visible; lower means a transition is in flight. */
    let appliedTransitionGeneration = 0;
    const transitionToReview = async (
        review: LocalPr,
        options: TransitionOptions = {},
        reservedGeneration?: number
    ): Promise<boolean> => {
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
                localPrManager.updateBranchReviewFallbackCommits(
                    prepared.plan.reviewId,
                    prepared.plan.baseCommit,
                    prepared.plan.targetCommit
                );
            }
            commentController.setReviewableFiles(
                prepared.files.map(file => file.filePath)
            );
            commentController.loadAllThreads(prepared.plan);
            branchSelectorProvider.setReviewState({
                review,
                currentBranch: currentBranch ?? '',
            });
            localPrsProvider.refresh();
            localCommentsProvider.refresh();
            fileDecorationProvider.refresh();
            appliedTransitionGeneration = generation;
            return true;
        } catch (error: unknown) {
            if (generation === transitionGeneration && options.showError !== false) {
                vscode.window.showErrorMessage(
                    `Offline Review refresh failed: ${errorMessage(error)}`
                );
            }
            return false;
        }
    };

    const clearReviewUi = async (): Promise<void> => {
        const generation = ++transitionGeneration;
        localPrManager.deactivateReview();
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
                compare: currentBranch ?? '',
                mode: localPrManager.getActiveMode(),
            });
            appliedTransitionGeneration = generation;
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
        const generation = ++transitionGeneration;
        const branch = await gitService.getCurrentBranch();
        if (generation !== transitionGeneration) {
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
                return generation === transitionGeneration ? 'failed' : 'superseded';
            }
            if (!options.quiet) {
                const count = changedFilesProvider.getAllFilePaths().length;
                vscode.window.showInformationMessage(
                    `Uncommitted review on ${branch}: ${count} file${count === 1 ? '' : 's'}`
                );
            }
            return 'applied';
        } catch (error: unknown) {
            if (generation !== transitionGeneration) {
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

    const reviewActiveBranch = async (
        options: ReviewModeOptions = {}
    ): Promise<ReviewAttempt> => {
        const generation = ++transitionGeneration;
        const branch = await gitService.getCurrentBranch();
        if (generation !== transitionGeneration) {
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
            if (generation !== transitionGeneration) {
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
                return generation === transitionGeneration ? 'failed' : 'superseded';
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
            if (generation !== transitionGeneration) {
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
        const generation = ++transitionGeneration;
        if (review.mode === 'branch') {
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
        const answer = await vscode.window.showWarningMessage(
            `This uncommitted review belongs to "${review.branch}", but `
                + `${currentBranch ? `"${currentBranch}" is checked out` : 'HEAD is detached'}.`,
            { modal: true },
            ...choices
        );
        if (generation !== transitionGeneration) {
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

    const restoreModeAfterClear = async (
        mode: ReviewMode,
        previous?: LocalPr
    ): Promise<void> => {
        if (mode === 'uncommitted') {
            if (await reviewUncommitted({ quiet: true }) === 'failed') {
                await clearReviewUi();
            }
            return;
        }
        if (previous?.mode === 'branch') {
            const generation = ++transitionGeneration;
            try {
                const review = await getOrCreateBranchReview(
                    previous.baseBranch,
                    previous.targetBranch
                );
                if (await transitionToReview(
                    review,
                    { showError: false },
                    generation
                )) {
                    return;
                }
                if (generation !== transitionGeneration) {
                    return;
                }
            } catch {
                if (generation !== transitionGeneration) {
                    return;
                }
                // Fall back to a review of the selected worktree's branch.
            }
        }
        if (await reviewActiveBranch({ quiet: true }) === 'failed') {
            await clearReviewUi();
        }
    };

    if (initialized) {
        const active = localPrManager.getActiveReview();
        let restored = true;
        if (localPrManager.getActiveMode() === 'uncommitted') {
            // Local is the default worktree; never auto-checkout a saved branch.
            restored = await reviewUncommitted({ quiet: true }) !== 'failed';
        } else if (active?.mode === 'branch') {
            restored = await transitionToReview(active);
        } else {
            restored = await reviewActiveBranch({ quiet: true }) !== 'failed';
        }
        if (!restored) {
            await clearReviewUi();
        }
    }

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            const plan = changedFilesProvider.getDiffPlan();
            const active = localPrManager.getActiveReview();
            if (transitionGeneration !== appliedTransitionGeneration
                || !active || !plan || plan.kind !== 'worktree'
                || plan.reviewId !== active.id) {
                return;
            }
            if (document.uri.scheme === 'file') {
                const filePath = relativePathInRoot(document.uri.fsPath, plan.worktreeRoot);
                if (!filePath) {
                    return;
                }
                gitFileContentProvider.refreshWorkingTreeFile(
                    filePath,
                    plan.worktreeRoot
                );
            } else {
                gitFileContentProvider.refreshAllWorkingTree(plan.worktreeRoot);
            }
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            const reviewId = active.id;
            const planId = plan.planId;
            const worktreeRoot = plan.worktreeRoot;
            const backgroundGeneration = appliedTransitionGeneration;
            refreshTimer = setTimeout(() => {
                const current = localPrManager.getActiveReview();
                const appliedPlan = changedFilesProvider.getDiffPlan();
                if (transitionGeneration === backgroundGeneration
                    && appliedTransitionGeneration === backgroundGeneration
                    && current?.id === reviewId
                    && appliedPlan?.kind === 'worktree'
                    && appliedPlan.reviewId === reviewId
                    && appliedPlan.planId === planId
                    && appliedPlan.worktreeRoot === worktreeRoot
                    && gitService.getSelectedWorktreeRoot() === worktreeRoot) {
                    void reviewUncommitted({ quiet: true });
                }
            }, 500);
        }),
        { dispose: () => refreshTimer && clearTimeout(refreshTimer) }
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
                    // latest selected checkout remains authoritative.
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
            if (!branch) {
                // Reserve immediately so any in-flight transition for the former
                // branch cannot publish after the checkout becomes detached.
                transitionGeneration++;
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

    let commentsWatchTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadCommentsFromDisk = (): void => {
        const active = localPrManager.getActiveReview();
        const plan = changedFilesProvider.getDiffPlan();
        if (transitionGeneration === appliedTransitionGeneration
            && active
            && plan?.reviewId === active.id
            && plan.worktreeRoot === gitService.getSelectedWorktreeRoot()) {
            void transitionToReview(active, {
                ensureCommentsFile: false,
                showError: false,
            });
        } else {
            // A worktree transition may still be preparing. Do not let a stale
            // comments event supersede it; the transition will load comments.
            localCommentsProvider.refresh();
        }
    };
    const onCommentsFileChanged = (uri: vscode.Uri): void => {
        const schedule = (delay: number): void => {
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
        } else {
            schedule(400);
        }
    };
    const watcherPatterns = [
        '.vscode/local-reviews/reviews/*/comments.json',
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
    context.subscriptions.push({
        dispose: () => commentsWatchTimer && clearTimeout(commentsWatchTimer),
    });

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
                transitionGeneration++;
                await storageService.withWatchSuppressed(() => {
                    localPrManager.deleteReview(review.id);
                });
                if (wasActive) {
                    await restoreModeAfterClear(review.mode, review);
                } else {
                    localPrsProvider.refresh();
                    localCommentsProvider.refresh();
                    fileDecorationProvider.refresh();
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
            transitionGeneration++;
            await storageService.withWatchSuppressed(() => {
                localPrManager.deleteReview(active.id);
            });
            await restoreModeAfterClear(active.mode, active);
            vscode.window.showInformationMessage('Active review comments cleared.');
        }),
        vscode.commands.registerCommand('localPrReview.clearAllReviews', async () => {
            const count = localPrManager.listReviews().length;
            if (count === 0) {
                vscode.window.showInformationMessage('No reviews to clear.');
                return;
            }
            const active = localPrManager.getActiveReview();
            const mode = active?.mode ?? localPrManager.getActiveMode();
            const answer = await vscode.window.showWarningMessage(
                `Clear all ${count} offline review${count === 1 ? '' : 's'} and their comments?`,
                { modal: true },
                'Clear all'
            );
            if (answer !== 'Clear all') {
                return;
            }
            transitionGeneration++;
            await storageService.withWatchSuppressed(() => {
                localPrManager.clearAllReviews();
            });
            await restoreModeAfterClear(mode, active);
            vscode.window.showInformationMessage('All review comments cleared.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('localPrReview.refreshFiles', async () => {
            const plan = changedFilesProvider.getDiffPlan();
            if (plan?.kind === 'worktree') {
                gitFileContentProvider.refreshAllWorkingTree(plan.worktreeRoot);
            }
            const active = localPrManager.getActiveReview();
            if (active?.mode === 'branch'
                && plan?.worktreeRoot === gitService.getSelectedWorktreeRoot()) {
                await transitionToReview(active, { showError: false });
            } else if (localPrManager.getActiveMode() === 'uncommitted') {
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
                    item.rightUri,
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
            (reply: vscode.CommentReply) => {
                try {
                    addOrReply(commentController, reply);
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
            (reply: vscode.CommentReply) => {
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
                        addOrReply(commentController, reply);
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
                    const document = await vscode.workspace.openTextDocument(reply.thread.uri);
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
                        commentController.createThread(
                            reply.thread.uri,
                            range,
                            body,
                            filePath,
                            reply.thread,
                            pendingReviewId
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
                transitionGeneration++;
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
        gitFileContentProvider,
        fileDecorationProvider,
        { dispose: () => localPrManager.dispose() }
    );
}

function addOrReply(
    controller: ReviewCommentController,
    reply: vscode.CommentReply
): void {
    const thread = reply.thread;
    const filePath = extractFilePath(thread.uri);
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    if (!filePath) {
        throw new Error('Could not resolve the comment file path');
    }
    if (thread.comments.length === 0) {
        controller.createThread(
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
