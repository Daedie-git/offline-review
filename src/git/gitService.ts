import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    BranchDiffPlan,
    CommitInfo,
    DiffDocument,
    DiffPlan,
    FileChange,
    FileChangeStatus,
    GitApi,
    GitRepository,
    GitWorktreeInfo,
    LocalPr,
    WorktreeDiffDocument,
    WorktreeDiffPlan,
} from '../types';

const MAX_GIT_OUTPUT = 10 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT = 30_000;
const GIT_URI_SCHEME = 'git-local-review';
const REVIEW_STORAGE_PATHS = [
    '.vscode/offline-reviews',
] as const;

export interface FileDiffUris {
    readonly left: vscode.Uri;
    readonly right: vscode.Uri;
}

export type GitFileContentResult =
    | { readonly status: 'available'; readonly content: string }
    | { readonly status: 'unavailable' };

/** A checkout identity transition, including entering or leaving detached HEAD. */
export interface GitCheckoutChange {
    readonly previousBranch: string | undefined;
    readonly branch: string | undefined;
}

export interface ParsedDiffDocumentUri {
    readonly filePath: string;
    readonly side: 'original' | 'modified' | undefined;
    readonly reviewId: string | undefined;
    /** Captured checkout used for modified-side language forwarding. */
    readonly worktreeRoot: string | undefined;
    readonly document: DiffDocument;
}

/** Build a virtual-document URI from an already resolved document decision. */
export function getDiffDocumentUri(
    document: DiffDocument,
    filePath: string,
    side?: 'original' | 'modified',
    reviewId?: string,
    capturedWorktreeRoot?: string
): vscode.Uri {
    const query = new URLSearchParams({
        ref: document.kind === 'worktree' ? GitService.WORKTREE_REF : document.ref,
    });
    const worktreeRoot = document.kind === 'worktree'
        ? document.worktreeRoot
        : capturedWorktreeRoot;
    if (worktreeRoot) {
        query.set('worktreeRoot', normalizeRoot(worktreeRoot));
    }
    if (side) {
        query.set('side', side);
    }
    const ownerId = document.kind === 'worktree' ? document.reviewId : reviewId;
    if (ownerId) {
        query.set('reviewId', ownerId);
    }
    if (document.kind === 'worktree') {
        query.set('head', document.headCommit);
        query.set('planId', document.planId);
    }

    return vscode.Uri.from({
        scheme: GIT_URI_SCHEME,
        authority: 'authority',
        path: `/${filePath}`,
        query: query.toString(),
    });
}

/** Parse and validate one URI before it can reach Git or the working tree. */
export function parseDiffDocumentUri(uri: vscode.Uri): ParsedDiffDocumentUri | undefined {
    if (uri.scheme !== GIT_URI_SCHEME || uri.authority !== 'authority') {
        return undefined;
    }
    const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    if (!isSafeRelativeGitPath(filePath)) {
        return undefined;
    }

    const query = new URLSearchParams(uri.query);
    const ref = query.get('ref');
    const sideValue = query.get('side');
    if (sideValue !== null && sideValue !== 'original' && sideValue !== 'modified') {
        return undefined;
    }
    const side = sideValue ?? undefined;
    const reviewId = query.get('reviewId') ?? undefined;
    const rootValue = query.get('worktreeRoot');
    const worktreeRoot = rootValue && isAbsoluteNormalizedRoot(rootValue)
        ? rootValue
        : undefined;
    if (rootValue && !worktreeRoot) {
        return undefined;
    }

    if (ref === GitService.WORKTREE_REF) {
        const headCommit = query.get('head');
        const planId = query.get('planId');
        if (side !== 'modified' || !reviewId || !isUuid(reviewId)
            || !headCommit || !isFullObjectId(headCommit)
            || !planId || !isUuid(planId) || !worktreeRoot) {
            return undefined;
        }
        return {
            filePath,
            side,
            reviewId,
            worktreeRoot,
            document: {
                kind: 'worktree',
                reviewId,
                headCommit,
                planId,
                worktreeRoot,
            },
        };
    }

    if (!ref || !isFullObjectId(ref) || (reviewId && !isUuid(reviewId))) {
        return undefined;
    }
    return {
        filePath,
        side,
        reviewId,
        worktreeRoot,
        document: { kind: 'git', ref },
    };
}

export function getFileDiffUris(plan: DiffPlan, change: FileChange): FileDiffUris {
    const leftPath = change.status === 'renamed' && change.oldFilePath
        ? change.oldFilePath
        : change.filePath;
    return Object.freeze({
        left: getDiffDocumentUri(
            plan.left,
            leftPath,
            'original',
            plan.reviewId,
            plan.worktreeRoot
        ),
        right: getDiffDocumentUri(
            plan.right,
            change.filePath,
            'modified',
            plan.reviewId,
            plan.worktreeRoot
        ),
    });
}

export class GitService {
    static readonly WORKTREE_REF = 'WORKTREE';

    private repo: GitRepository | undefined;
    /** Original workspace location; storage and repository discovery stay here. */
    private readonly localWorkspaceRoot: string;
    /** Repository top-level for the checkout containing the workspace. */
    private localWorktreeRoot: string;
    /** Session-only review context, reset to Local on each activation. */
    private selectedWorktreeRoot: string;
    /** Last-request-wins guard for overlapping webview selection messages. */
    private worktreeSelectionGeneration = 0;

    private readonly _onDidChangeWorktreeSelection = new vscode.EventEmitter<GitWorktreeInfo>();
    readonly onDidChangeWorktreeSelection = this._onDidChangeWorktreeSelection.event;

    /** Compatibility event for named-branch checkouts. */
    private readonly _onDidChangeBranch = new vscode.EventEmitter<string>();
    readonly onDidChangeBranch = this._onDidChangeBranch.event;
    private readonly _onDidChangeCheckout = new vscode.EventEmitter<GitCheckoutChange>();
    readonly onDidChangeCheckout = this._onDidChangeCheckout.event;
    private readonly _onDidChangeHead = new vscode.EventEmitter<void>();
    readonly onDidChangeHead = this._onDidChangeHead.event;
    private _lastBranch: string | undefined;
    private _lastCommit: string | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.localWorkspaceRoot = normalizeRoot(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
        );
        this.localWorktreeRoot = this.localWorkspaceRoot;
        this.selectedWorktreeRoot = this.localWorkspaceRoot;
        this.context.subscriptions.push(this._onDidChangeWorktreeSelection);
    }

    async initialize(): Promise<boolean> {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            vscode.window.showErrorMessage('Git extension not found');
            return false;
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const api = gitExtension.exports.getAPI(1) as GitApi;
        try {
            await this.initializeLocalWorktreeRoot();
        } catch {
            return false;
        }

        const matchingRepository = api.repositories.find(repo =>
            sameRoot(repo.rootUri.fsPath, this.localWorktreeRoot)
        );
        if (matchingRepository) {
            this.repo = matchingRepository;
            this.trackBranchChanges();
            return true;
        }

        return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
                disposable.dispose();
                resolve(false);
            }, 10_000);

            const disposable = api.onDidOpenRepository((repo: GitRepository) => {
                if (!sameRoot(repo.rootUri.fsPath, this.localWorktreeRoot)) {
                    return;
                }
                clearTimeout(timeout);
                disposable.dispose();
                this.repo = repo;
                this.trackBranchChanges();
                resolve(true);
            });
        });
    }

    private async initializeLocalWorktreeRoot(): Promise<void> {
        const root = (await this.execGit(
            ['rev-parse', '--show-toplevel'],
            DEFAULT_GIT_TIMEOUT,
            this.localWorkspaceRoot
        )).trim();
        if (!root || !path.isAbsolute(root)) {
            throw new Error('Git did not return the local worktree root');
        }
        this.localWorktreeRoot = normalizeRoot(root);
        this.selectedWorktreeRoot = this.localWorktreeRoot;
    }

    private trackBranchChanges(): void {
        if (!this.repo) {
            return;
        }

        this._lastBranch = this.repo.state.HEAD?.name;
        this._lastCommit = this.repo.state.HEAD?.commit;
        const disposable = this.repo.state.onDidChange(() => {
            const currentBranch = this.repo?.state.HEAD?.name;
            const currentCommit = this.repo?.state.HEAD?.commit;
            if (currentBranch !== this._lastBranch) {
                const previousBranch = this._lastBranch;
                this._lastBranch = currentBranch;
                this._lastCommit = currentCommit;
                this._onDidChangeCheckout.fire({ previousBranch, branch: currentBranch });
                if (currentBranch !== undefined) {
                    this._onDidChangeBranch.fire(currentBranch);
                }
            } else if (currentCommit !== this._lastCommit) {
                this._lastCommit = currentCommit;
                this._onDidChangeHead.fire();
            }
        });
        this.context.subscriptions.push(disposable);
    }

    getLocalWorkspaceRoot(): string {
        return this.localWorkspaceRoot;
    }

    getSelectedWorktreeRoot(): string {
        return this.selectedWorktreeRoot;
    }

    isLocalWorktreeSelected(): boolean {
        return sameRoot(this.selectedWorktreeRoot, this.localWorktreeRoot);
    }

    /** Always discover linked worktrees from the original workspace checkout. */
    async listWorktrees(): Promise<GitWorktreeInfo[]> {
        const output = await this.execGit(
            ['worktree', 'list', '--porcelain', '-z'],
            DEFAULT_GIT_TIMEOUT,
            this.localWorkspaceRoot
        );
        return parseWorktreeList(output, this.localWorktreeRoot);
    }

    /** Select one currently linked and accessible checkout for this session. */
    async selectWorktree(root: string): Promise<GitWorktreeInfo> {
        const generation = ++this.worktreeSelectionGeneration;
        const normalized = normalizeRoot(root);
        const worktrees = await this.listWorktrees();
        const currentSelection = (): GitWorktreeInfo | undefined => worktrees.find(candidate =>
            sameRoot(candidate.root, this.selectedWorktreeRoot)
        );
        const selected = worktrees.find(candidate => sameRoot(candidate.root, normalized));
        if (!selected) {
            const current = currentSelection();
            if (generation !== this.worktreeSelectionGeneration && current) {
                return current;
            }
            throw new Error(`The selected Git worktree is no longer linked: ${root}`);
        }
        if (!await this.validateLinkedWorktreeRoot(selected.root)) {
            const current = currentSelection();
            if (generation !== this.worktreeSelectionGeneration && current) {
                return current;
            }
            throw new Error(`The selected Git worktree is no longer available: ${selected.root}`);
        }

        // A slower, older request must not overwrite the user's latest choice.
        if (generation !== this.worktreeSelectionGeneration) {
            return currentSelection() ?? selected;
        }

        if (!sameRoot(this.selectedWorktreeRoot, selected.root)) {
            this.selectedWorktreeRoot = selected.root;
            this._onDidChangeWorktreeSelection.fire(selected);
        }
        return selected;
    }

    /** Validate an identity embedded in a virtual URI without trusting its path. */
    async isLinkedWorktreeRoot(root: string): Promise<boolean> {
        if (!isAbsoluteNormalizedRoot(root)) {
            return false;
        }
        try {
            const worktrees = await this.listWorktrees();
            const linked = worktrees.find(candidate => sameRoot(candidate.root, root));
            return Boolean(linked) && await this.validateLinkedWorktreeRoot(root);
        } catch {
            return false;
        }
    }

    /**
     * Revalidate both the filesystem entry and common Git directory. A stale
     * worktree-list path must never authorize an unrelated repository or symlink.
     */
    private async validateLinkedWorktreeRoot(root: string): Promise<boolean> {
        try {
            const stat = await fs.promises.lstat(root);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                return false;
            }
            const inside = (await this.execGit(
                ['rev-parse', '--is-inside-work-tree'],
                DEFAULT_GIT_TIMEOUT,
                root
            )).trim();
            if (inside !== 'true') {
                return false;
            }
            const [candidateCommonDir, localCommonDir] = await Promise.all([
                this.getCommonGitDir(root),
                this.getCommonGitDir(this.localWorkspaceRoot),
            ]);
            return sameRoot(candidateCommonDir, localCommonDir);
        } catch {
            return false;
        }
    }

    private async getCommonGitDir(root: string): Promise<string> {
        const commonDir = (await this.execGit(
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            DEFAULT_GIT_TIMEOUT,
            root
        )).trim();
        if (!commonDir || !path.isAbsolute(commonDir)) {
            throw new Error('Git did not return an absolute common directory');
        }
        return normalizeRoot(await fs.promises.realpath(commonDir));
    }

    private async requireLinkedWorktreeRoot(root: string): Promise<void> {
        if (await this.isLinkedWorktreeRoot(root)) {
            return;
        }

        // Fail closed, and return the live selector to Local when an external
        // checkout disappears or is replaced while the extension is running.
        if (sameRoot(root, this.selectedWorktreeRoot)
            && !sameRoot(root, this.localWorktreeRoot)
            && await this.isLinkedWorktreeRoot(this.localWorktreeRoot)) {
            const worktrees = await this.listWorktrees();
            const local = worktrees.find(candidate => candidate.isLocal);
            if (local) {
                this.worktreeSelectionGeneration++;
                this.selectedWorktreeRoot = local.root;
                this._onDidChangeWorktreeSelection.fire(local);
            }
        }
        throw new Error(`Git worktree is no longer linked to this repository: ${root}`);
    }

    async getBranches(includeRemote: boolean = false): Promise<string[]> {
        if (!this.repo) {
            return [];
        }

        const localBranches = await this.repo.getBranches({ remote: false });
        const localNames = localBranches
            .map(branch => branch.name)
            .filter((name): name is string => Boolean(name));
        if (!includeRemote) {
            return localNames;
        }

        try {
            const remoteBranches = await this.repo.getBranches({ remote: true });
            const remoteNames = remoteBranches
                .map(branch => branch.name)
                .filter((name): name is string => Boolean(name));
            const localSet = new Set(localNames);
            return [...localNames, ...remoteNames.filter(name => !localSet.has(name))];
        } catch {
            return localNames;
        }
    }

    async getCurrentBranch(): Promise<string | undefined> {
        const root = this.selectedWorktreeRoot;
        return this.getCurrentBranchAt(root);
    }

    private async getCurrentBranchAt(
        root: string,
        alreadyValidated: boolean = false
    ): Promise<string | undefined> {
        if (!alreadyValidated) {
            await this.requireLinkedWorktreeRoot(root);
        }
        try {
            const branch = (await this.execGit(
                ['symbolic-ref', '--quiet', '--short', 'HEAD'],
                DEFAULT_GIT_TIMEOUT,
                root
            )).trim();
            return branch || undefined;
        } catch {
            return undefined;
        }
    }

    /** Detect the primary branch from remote metadata without guessing names. */
    async getPrimaryBranch(
        branches?: string[],
        excludeBranch?: string,
        options: { allowUnavailable?: boolean; localFallback?: boolean } = {}
    ): Promise<string | undefined> {
        const available = branches ?? await this.getBranches(true);
        const { allowUnavailable = false, localFallback = true } = options;
        let remotes: string[] = [];
        try {
            remotes = splitLines(await this.execGit(['remote']));
        } catch {
            // A repository without remotes can still use the sole-local fallback.
        }

        const isEligible = (branch: string): boolean => {
            if (!branch || !available.includes(branch)) {
                return false;
            }
            if (!excludeBranch) {
                return true;
            }
            const mirrorsExcluded = remotes.some(remote => branch === `${remote}/${excludeBranch}`);
            return branch !== excludeBranch && !mirrorsExcluded;
        };

        const selectRemoteHead = (remote: string, remoteHead: string): string | undefined => {
            const localHead = remoteHead.startsWith(`${remote}/`)
                ? remoteHead.slice(remote.length + 1)
                : remoteHead;
            if (isEligible(localHead)) {
                return localHead;
            }
            if (isEligible(remoteHead)) {
                return remoteHead;
            }
            return allowUnavailable && localHead !== excludeBranch ? localHead : undefined;
        };

        const primaryRemote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (primaryRemote) {
            try {
                const cachedHead = (await this.execGit([
                    'symbolic-ref',
                    '--quiet',
                    '--short',
                    `refs/remotes/${primaryRemote}/HEAD`,
                ])).trim();
                const selected = selectRemoteHead(primaryRemote, cachedHead);
                if (selected) {
                    return selected;
                }
            } catch {
                // The cached symbolic ref is optional.
            }

            try {
                const output = await this.execGit(
                    ['ls-remote', '--symref', primaryRemote, 'HEAD'],
                    3_000
                );
                const match = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(output);
                if (match) {
                    const selected = selectRemoteHead(primaryRemote, `${primaryRemote}/${match[1]}`);
                    if (selected) {
                        return selected;
                    }
                }
            } catch {
                // Stay usable offline.
            }
        }

        return localFallback ? this.getSoleLocalBranch(excludeBranch) : undefined;
    }

    async getSoleLocalBranch(excludeBranch?: string): Promise<string | undefined> {
        const localBranches = await this.getBranches(false);
        const alternatives = excludeBranch
            ? localBranches.filter(branch => branch !== excludeBranch)
            : localBranches;
        return alternatives.length === 1 ? alternatives[0] : undefined;
    }

    async getCommitHash(ref: string): Promise<string> {
        return this.resolveCommit(ref);
    }

    async isCurrentBranch(branch: string): Promise<boolean> {
        return (await this.getCurrentBranch()) === branch;
    }

    async checkoutBranch(branch: string): Promise<void> {
        if (!branch) {
            throw new Error('Cannot switch to an empty branch name');
        }
        const worktreeRoot = this.selectedWorktreeRoot;
        await this.requireLinkedWorktreeRoot(worktreeRoot);
        await this.execGit(['checkout', branch], DEFAULT_GIT_TIMEOUT, worktreeRoot);
    }

    /** Resolve a persisted review into one explicit, immutable diff strategy. */
    async prepareDiffPlan(review: LocalPr): Promise<DiffPlan> {
        // Capture before the first await so a concurrent selector change cannot
        // mix Git commands or document identities from two linked checkouts.
        const worktreeRoot = this.selectedWorktreeRoot;
        await this.requireLinkedWorktreeRoot(worktreeRoot);
        if (review.mode === 'branch') {
            // Resolve branch names on every refresh so newly-created commits are
            // included, then freeze this refresh to immutable object IDs. Saved
            // commits remain a fallback for reviews whose branches were deleted.
            const [baseCommit, targetCommit] = await Promise.all([
                this.resolveCommitWithFallback(
                    review.baseBranch,
                    review.sourceCommit,
                    worktreeRoot
                ),
                this.resolveCommitWithFallback(
                    review.targetBranch,
                    review.targetCommit,
                    worktreeRoot
                ),
            ]);
            const mergeBaseCommit = (await this.execGit([
                'merge-base',
                baseCommit,
                targetCommit,
            ], DEFAULT_GIT_TIMEOUT, worktreeRoot)).trim();
            if (!isFullObjectId(mergeBaseCommit)) {
                throw new Error('Git did not return an immutable merge-base commit');
            }

            const left = Object.freeze({ kind: 'git' as const, ref: mergeBaseCommit });
            const right = Object.freeze({ kind: 'git' as const, ref: targetCommit });
            return Object.freeze<BranchDiffPlan>({
                kind: 'branch',
                reviewId: review.id,
                worktreeRoot,
                baseBranch: review.baseBranch,
                targetBranch: review.targetBranch,
                baseCommit,
                mergeBaseCommit,
                targetCommit,
                left,
                right,
            });
        }

        const currentBranch = await this.getCurrentBranchAt(worktreeRoot, true);
        if (!currentBranch) {
            throw new Error('Cannot review uncommitted changes from detached HEAD');
        }
        if (currentBranch !== review.branch) {
            throw new Error(
                `Uncommitted review is saved for branch "${review.branch}", but "${currentBranch}" is checked out`
            );
        }

        const headCommit = await this.resolveCommit('HEAD', worktreeRoot);
        const planId = crypto.randomUUID();
        const left = Object.freeze({ kind: 'git' as const, ref: headCommit });
        const right = Object.freeze<WorktreeDiffDocument>({
            kind: 'worktree',
            reviewId: review.id,
            headCommit,
            planId,
            worktreeRoot,
        });
        return Object.freeze<WorktreeDiffPlan>({
            kind: 'worktree',
            reviewId: review.id,
            worktreeRoot,
            branch: review.branch,
            headCommit,
            planId,
            left,
            right,
        });
    }

    async getChangedFiles(plan: DiffPlan): Promise<FileChange[]> {
        this.assertValidPlan(plan);
        await this.requireLinkedWorktreeRoot(plan.worktreeRoot);
        const output = plan.kind === 'branch'
            ? await this.execGit([
                'diff',
                '--no-ext-diff',
                '--name-status',
                '-z',
                '--find-renames',
                plan.mergeBaseCommit,
                plan.targetCommit,
                '--',
            ], DEFAULT_GIT_TIMEOUT, plan.worktreeRoot)
            : await this.execGit([
                'diff',
                '--no-ext-diff',
                '--name-status',
                '-z',
                '--find-renames',
                plan.headCommit,
                '--',
            ], DEFAULT_GIT_TIMEOUT, plan.worktreeRoot);

        // Review metadata is implementation state, never user-authored review
        // content—even when the host repository does not ignore these paths.
        const files = parseNameStatus(output).filter(change =>
            !isReviewStoragePath(change.filePath)
            && (!change.oldFilePath || !isReviewStoragePath(change.oldFilePath))
        );
        if (plan.kind === 'worktree') {
            const untrackedOutput = await this.execGit([
                'ls-files',
                '--others',
                '--exclude-standard',
                '-z',
                '--',
            ], DEFAULT_GIT_TIMEOUT, plan.worktreeRoot);
            const seen = new Set(files.map(file => file.filePath));
            for (const filePath of splitNul(untrackedOutput)) {
                if (!isReviewStoragePath(filePath) && !seen.has(filePath)) {
                    files.push({ status: 'added', filePath });
                    seen.add(filePath);
                }
            }
        }
        return files;
    }

    getFileUri(ref: string, filePath: string, side?: 'original' | 'modified'): vscode.Uri {
        assertFullObjectId(ref, 'document ref');
        return getDiffDocumentUri({ kind: 'git', ref }, filePath, side);
    }

    getWorkingTreeFileUri(plan: WorktreeDiffPlan, filePath: string): vscode.Uri {
        this.assertValidPlan(plan);
        return getDiffDocumentUri(plan.right, filePath, 'modified', plan.reviewId);
    }

    getFileDiffUris(plan: DiffPlan, change: FileChange): FileDiffUris {
        return getFileDiffUris(plan, change);
    }

    async getFileContent(document: DiffDocument, filePath: string): Promise<string> {
        const result = await this.getFileContentResult(document, filePath);
        return result.status === 'available' ? result.content : '';
    }

    /** Read content while preserving the distinction between an empty blob and failure. */
    async getFileContentResult(
        document: DiffDocument,
        filePath: string
    ): Promise<GitFileContentResult> {
        if (!isSafeRelativeGitPath(filePath)) {
            return { status: 'unavailable' };
        }
        if (document.kind === 'worktree') {
            return this.getWorkingTreeFileContentResult(document.worktreeRoot, filePath);
        }
        if (!isFullObjectId(document.ref)) {
            return { status: 'unavailable' };
        }

        try {
            // Linked worktrees share object storage. Reading immutable objects
            // from Local avoids trusting a root supplied by a virtual URI.
            const content = await this.execGit(
                ['cat-file', 'blob', `${document.ref}:${filePath}`],
                DEFAULT_GIT_TIMEOUT,
                this.localWorkspaceRoot
            );
            return { status: 'available', content };
        } catch {
            return { status: 'unavailable' };
        }
    }

    async getCommitsForDiff(plan: DiffPlan): Promise<CommitInfo[]> {
        if (plan.kind === 'worktree') {
            return [];
        }
        await this.requireLinkedWorktreeRoot(plan.worktreeRoot);
        return this.getCommitsBetween(
            plan.mergeBaseCommit,
            plan.targetCommit,
            plan.worktreeRoot
        );
    }

    /** Both arguments must be immutable commit hashes. */
    async getCommitsBetween(
        sourceCommit: string,
        targetCommit: string,
        worktreeRoot: string = this.selectedWorktreeRoot
    ): Promise<CommitInfo[]> {
        assertFullObjectId(sourceCommit, 'source commit');
        assertFullObjectId(targetCommit, 'target commit');
        const fieldSeparator = '\u001f';
        const recordSeparator = '\u001e';
        const format = [
            '%H',
            '%h',
            '%s',
            '%an',
            '%aI',
            '%ar',
        ].join(fieldSeparator) + recordSeparator;

        try {
            const output = await this.execGit([
                'log',
                `--format=${format}`,
                `${sourceCommit}..${targetCommit}`,
                '--',
            ], DEFAULT_GIT_TIMEOUT, worktreeRoot);
            return output
                .split(recordSeparator)
                .map(record => record.replace(/^\n+|\n+$/g, ''))
                .filter(Boolean)
                .map(record => {
                    const [hash, shortHash, message, author, date, relativeDate] = record.split(fieldSeparator);
                    return { hash, shortHash, message, author, date, relativeDate };
                });
        } catch {
            return [];
        }
    }

    private async resolveCommitWithFallback(
        ref: string,
        fallbackCommit: string,
        worktreeRoot: string
    ): Promise<string> {
        try {
            return await this.resolveCommit(ref, worktreeRoot);
        } catch (error) {
            if (!fallbackCommit) {
                throw error;
            }
            return this.resolveCommit(fallbackCommit, worktreeRoot);
        }
    }

    private async resolveCommit(
        ref: string,
        worktreeRoot: string = this.selectedWorktreeRoot
    ): Promise<string> {
        if (!ref) {
            throw new Error('Cannot resolve an empty Git ref');
        }
        const resolved = (await this.execGit([
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${ref}^{commit}`,
        ], DEFAULT_GIT_TIMEOUT, worktreeRoot)).trim();
        if (!isFullObjectId(resolved)) {
            throw new Error(`Git ref "${ref}" did not resolve to a full commit hash`);
        }
        return resolved;
    }

    private async getWorkingTreeFileContentResult(
        worktreeRoot: string,
        filePath: string
    ): Promise<GitFileContentResult> {
        try {
            if (!await this.isLinkedWorktreeRoot(worktreeRoot)) {
                return { status: 'unavailable' };
            }
            const root = normalizeRoot(worktreeRoot);
            const absolutePath = path.resolve(root, filePath);
            if (!isPathInside(root, absolutePath)) {
                return { status: 'unavailable' };
            }

            // Resolve the parent to prevent an untracked symlinked directory
            // from turning a forged virtual URI into an arbitrary file read.
            const [realRoot, realParent] = await Promise.all([
                fs.promises.realpath(root),
                fs.promises.realpath(path.dirname(absolutePath)),
            ]);
            if (!isPathInside(realRoot, realParent, true)) {
                return { status: 'unavailable' };
            }

            const stat = await fs.promises.lstat(absolutePath);
            if (stat.isSymbolicLink()) {
                return {
                    status: 'available',
                    content: await fs.promises.readlink(absolutePath, 'utf8'),
                };
            }
            if (!stat.isFile()) {
                return { status: 'unavailable' };
            }
            const realFile = await fs.promises.realpath(absolutePath);
            if (!isPathInside(realRoot, realFile)) {
                return { status: 'unavailable' };
            }
            return {
                status: 'available',
                content: await fs.promises.readFile(realFile, 'utf8'),
            };
        } catch {
            return { status: 'unavailable' };
        }
    }

    private assertValidPlan(plan: DiffPlan): void {
        if (!isAbsoluteNormalizedRoot(plan.worktreeRoot)) {
            throw new Error('DiffPlan worktree root is not an absolute normalized path');
        }
        if (plan.kind === 'branch') {
            assertFullObjectId(plan.baseCommit, 'base commit');
            assertFullObjectId(plan.mergeBaseCommit, 'merge-base commit');
            assertFullObjectId(plan.targetCommit, 'target commit');
            if (plan.left.ref !== plan.mergeBaseCommit || plan.right.ref !== plan.targetCommit) {
                throw new Error('Branch DiffPlan document refs do not match its immutable commits');
            }
            return;
        }

        assertFullObjectId(plan.headCommit, 'HEAD commit');
        if (plan.left.ref !== plan.headCommit
            || plan.right.kind !== 'worktree'
            || plan.right.reviewId !== plan.reviewId
            || plan.right.headCommit !== plan.headCommit
            || plan.right.planId !== plan.planId
            || !sameRoot(plan.right.worktreeRoot, plan.worktreeRoot)
            || !isUuid(plan.planId)) {
            throw new Error('Worktree DiffPlan document refs do not match its strategy');
        }
    }

    private execGit(
        args: readonly string[],
        timeout: number = DEFAULT_GIT_TIMEOUT,
        worktreeRoot: string = this.selectedWorktreeRoot
    ): Promise<string> {
        if (!worktreeRoot) {
            return Promise.reject(new Error('No workspace folder is open'));
        }

        return new Promise<string>((resolve, reject) => {
            cp.execFile('git', [...args], {
                cwd: worktreeRoot,
                encoding: 'utf8',
                maxBuffer: MAX_GIT_OUTPUT,
                timeout,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}

/** Parse NUL-delimited porcelain without treating spaces or newlines as separators. */
export function parseWorktreeList(
    output: string,
    localWorktreeRoot: string
): GitWorktreeInfo[] {
    const records: string[][] = [];
    let record: string[] = [];
    for (const token of output.split('\0')) {
        if (token === '') {
            if (record.length > 0) {
                records.push(record);
                record = [];
            }
        } else {
            record.push(token);
        }
    }
    if (record.length > 0) {
        records.push(record);
    }

    const localRoot = normalizeRoot(localWorktreeRoot);
    const worktrees: GitWorktreeInfo[] = [];
    for (const fields of records) {
        let root: string | undefined;
        let headCommit: string | undefined;
        let branch: string | undefined;
        let detached = false;
        let unavailable = false;
        for (const field of fields) {
            const separator = field.indexOf(' ');
            const key = separator === -1 ? field : field.slice(0, separator);
            const value = separator === -1 ? '' : field.slice(separator + 1);
            switch (key) {
                case 'worktree':
                    root = value;
                    break;
                case 'HEAD':
                    headCommit = value;
                    break;
                case 'branch':
                    branch = value.startsWith('refs/heads/')
                        ? value.slice('refs/heads/'.length)
                        : value;
                    break;
                case 'detached':
                    detached = true;
                    break;
                case 'bare':
                case 'prunable':
                    unavailable = true;
                    break;
            }
        }
        if (unavailable || !root || !path.isAbsolute(root)
            || !headCommit || !isFullObjectId(headCommit)) {
            continue;
        }
        const normalizedRoot = normalizeRoot(root);
        worktrees.push(Object.freeze({
            root: normalizedRoot,
            headCommit,
            branch: detached ? undefined : branch,
            detached: detached || !branch,
            isLocal: sameRoot(normalizedRoot, localRoot),
        }));
    }
    return worktrees;
}

function parseNameStatus(output: string): FileChange[] {
    const tokens = splitNul(output);
    const files: FileChange[] = [];
    for (let index = 0; index < tokens.length;) {
        const statusToken = tokens[index++];
        const statusChar = statusToken.charAt(0);
        if (statusChar === 'R' || statusChar === 'C') {
            const oldFilePath = tokens[index++];
            const filePath = tokens[index++];
            if (oldFilePath === undefined || filePath === undefined) {
                break;
            }
            files.push(statusChar === 'R'
                ? { status: 'renamed', filePath, oldFilePath }
                : { status: 'added', filePath });
            continue;
        }

        const filePath = tokens[index++];
        if (filePath === undefined) {
            break;
        }
        files.push({ status: toFileChangeStatus(statusChar), filePath });
    }
    return files;
}

function toFileChangeStatus(statusChar: string): FileChangeStatus {
    switch (statusChar) {
        case 'A': return 'added';
        case 'D': return 'deleted';
        default: return 'modified';
    }
}

function splitNul(output: string): string[] {
    const tokens = output.split('\0');
    if (tokens[tokens.length - 1] === '') {
        tokens.pop();
    }
    return tokens;
}

function splitLines(output: string): string[] {
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function normalizeRoot(root: string): string {
    return root ? path.resolve(root) : '';
}

function sameRoot(left: string, right: string): boolean {
    const normalizedLeft = normalizeRoot(left);
    const normalizedRight = normalizeRoot(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}

function isAbsoluteNormalizedRoot(root: string): boolean {
    if (!root || root.includes('\0') || !path.isAbsolute(root)) {
        return false;
    }
    const normalized = normalizeRoot(root);
    return process.platform === 'win32'
        ? root.toLowerCase() === normalized.toLowerCase()
        : root === normalized;
}

function isSafeRelativeGitPath(filePath: string): boolean {
    if (!filePath || filePath.includes('\0') || path.isAbsolute(filePath)) {
        return false;
    }
    return !filePath.split(/[\\/]/).some(segment => segment === '..' || segment === '');
}

function isReviewStoragePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return REVIEW_STORAGE_PATHS.some(storagePath =>
        normalized === storagePath || normalized.startsWith(`${storagePath}/`)
    );
}

function isPathInside(root: string, candidate: string, allowEqual: boolean = false): boolean {
    const relative = path.relative(root, candidate);
    if (relative === '') {
        return allowEqual;
    }
    return relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function isFullObjectId(value: string): boolean {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertFullObjectId(value: string, label: string): void {
    if (!isFullObjectId(value)) {
        throw new Error(`DiffPlan ${label} is not an immutable full Git object id`);
    }
}
