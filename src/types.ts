import * as vscode from 'vscode';

export type ReviewMode = 'uncommitted' | 'branch';

/** Metadata shared by every persisted review kind. */
export interface LocalPrBase {
    id: string;
    /** Persisted source snapshot; branch reviews refresh it as the deletion fallback. */
    sourceCommit: string;
    /** Persisted target snapshot; branch reviews refresh it as the deletion fallback. */
    targetCommit: string;
    createdAt: string;
    reviewedFiles?: string[];
}

export interface BranchReview extends LocalPrBase {
    mode: 'branch';
    baseBranch: string;
    targetBranch: string;
}

export interface UncommittedReview extends LocalPrBase {
    mode: 'uncommitted';
    branch: string;
}

export type LocalPr = BranchReview | UncommittedReview;

/**
 * Compatibility shape for APIs which still operate on source/target comparisons.
 * Callers must obtain this explicitly instead of reconstructing a review's mode.
 */
export interface ReviewSourceTarget {
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
}

export function getReviewSourceTarget(review: LocalPr): ReviewSourceTarget {
    if (review.mode === 'branch') {
        return {
            sourceBranch: review.baseBranch,
            targetBranch: review.targetBranch,
            sourceCommit: review.sourceCommit,
            targetCommit: review.targetCommit,
        };
    }

    return {
        sourceBranch: review.branch,
        targetBranch: review.branch,
        sourceCommit: review.sourceCommit,
        targetCommit: review.targetCommit,
    };
}

/** The single user-facing label format for persisted reviews. */
export function formatReviewLabel(review: LocalPr): string {
    return review.mode === 'uncommitted'
        ? `uncommitted (${review.branch})`
        : `${review.targetBranch} vs ${review.baseBranch}`;
}

export interface FileChange {
    status: FileChangeStatus;
    filePath: string;
    oldFilePath?: string; // for renames
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** A file snapshot loaded from Git object storage. */
export interface GitObjectDiffDocument {
    readonly kind: 'git';
    /** An immutable commit hash, never a moving branch name. */
    readonly ref: string;
}

/** The repository's on-disk working tree for one prepared review snapshot. */
export interface WorktreeDiffDocument {
    readonly kind: 'worktree';
    /** UUID-owned review whose prepared plan created this document. */
    readonly reviewId: string;
    /** Immutable HEAD snapshot against which this worktree was prepared. */
    readonly headCommit: string;
    /** Stable identity unique to this prepared worktree plan. */
    readonly planId: string;
}

export type DiffDocument = GitObjectDiffDocument | WorktreeDiffDocument;

interface DiffPlanBase {
    readonly reviewId: string;
    readonly left: GitObjectDiffDocument;
    readonly right: DiffDocument;
}

/** A branch review compares the resolved branch snapshots for this refresh. */
export interface BranchDiffPlan extends DiffPlanBase {
    readonly kind: 'branch';
    readonly baseBranch: string;
    readonly targetBranch: string;
    /** Current resolved base-branch tip, retained separately from the merge base. */
    readonly baseCommit: string;
    readonly mergeBaseCommit: string;
    readonly targetCommit: string;
    readonly right: GitObjectDiffDocument;
}

/** An uncommitted review compares the current HEAD snapshot to WORKTREE. */
export interface WorktreeDiffPlan extends DiffPlanBase {
    readonly kind: 'worktree';
    readonly branch: string;
    readonly headCommit: string;
    readonly planId: string;
    readonly right: WorktreeDiffDocument;
}

/**
 * Fully resolved comparison strategy. Commit refs in a plan are immutable and
 * the UI must use its left/right document decisions without branch inference.
 */
export type DiffPlan = BranchDiffPlan | WorktreeDiffPlan;

/** Async diff data which a coordinator can synchronously apply as one state. */
export interface PreparedDiffState {
    readonly plan: DiffPlan;
    readonly files: readonly FileChange[];
    readonly commits: readonly CommitInfo[];
    readonly reviewedFiles: readonly string[];
}

export interface GitThreadTarget {
    readonly kind: 'git';
    /** Immutable target commit on which the thread was authored. */
    readonly ref: string;
    /** Path as it existed in the immutable target snapshot. */
    readonly filePath: string;
}

export interface WorktreeThreadTarget {
    readonly kind: 'worktree';
    readonly reviewId: string;
    readonly headCommit: string;
    readonly planId: string;
    readonly filePath: string;
}

export type ReviewThreadTarget = GitThreadTarget | WorktreeThreadTarget;

export interface ReviewThread {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    state: 'resolved' | 'unresolved';
    comments: ReviewComment[];
    /** Snapshot/path identity captured when the thread was first persisted. */
    target: ReviewThreadTarget;
}

export interface ReviewComment {
    id: string;
    body: string;
    author: string;
    timestamp: string;
}

export interface CommentsFile {
    version: 2;
    sourceBranch: string;
    targetBranch: string;
    sourceCommit: string;
    targetCommit: string;
    threads: ReviewThread[];
}

export function isThreadCurrentForPlan(
    thread: ReviewThread,
    plan: DiffPlan,
    filePath: string = thread.filePath
): boolean {
    const target = thread.target;
    if (target.filePath !== filePath) {
        return false;
    }
    return plan.kind === 'branch'
        ? target.kind === 'git' && target.ref === plan.targetCommit
        : target.kind === 'worktree'
            && target.reviewId === plan.reviewId
            && target.headCommit === plan.headCommit
            && target.planId === plan.planId;
}

export interface LocalPrRegistry {
    version: 2;
    reviews: LocalPr[];
    activeReviewId?: string;
    activeMode: ReviewMode;
    preferredBaseBranch?: string;
}

export interface CommentFileDiscovery {
    reviewId: string;
    mode: ReviewMode;
    label: string;
    filePath: string;
    isActive: boolean;
}

export interface GitApi {
    repositories: GitRepository[];
    onDidOpenRepository: (cb: (repo: GitRepository) => void) => vscode.Disposable;
}

export interface GitRepository {
    rootUri: vscode.Uri;
    state: {
        HEAD?: {
            name?: string;
            commit?: string;
        };
        onDidChange: vscode.Event<void>;
    };
    getBranches(query: { remote?: boolean }): Promise<GitBranch[]>;
}

export interface GitBranch {
    name?: string;
    commit?: string;
    type?: number;
}

export interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    relativeDate: string;
}
