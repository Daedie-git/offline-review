import * as vscode from 'vscode';
import { CommitInfo, DiffDocument, DiffPlan, FileChange, GitWorktreeInfo, LocalPr, WorktreeDiffPlan } from '../types';
export interface FileDiffUris {
    readonly left: vscode.Uri;
    readonly right: vscode.Uri;
}
export type GitFileContentResult = {
    readonly status: 'available';
    readonly content: string;
} | {
    readonly status: 'unavailable';
};
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
export declare function getDiffDocumentUri(document: DiffDocument, filePath: string, side?: 'original' | 'modified', reviewId?: string, capturedWorktreeRoot?: string): vscode.Uri;
/** Parse and validate one URI before it can reach Git or the working tree. */
export declare function parseDiffDocumentUri(uri: vscode.Uri): ParsedDiffDocumentUri | undefined;
export declare function getFileDiffUris(plan: DiffPlan, change: FileChange): FileDiffUris;
export declare class GitService {
    private readonly context;
    static readonly WORKTREE_REF = "WORKTREE";
    private repo;
    /** Original workspace location; storage and repository discovery stay here. */
    private readonly localWorkspaceRoot;
    /** Repository top-level for the checkout containing the workspace. */
    private localWorktreeRoot;
    /** Session-only review context, reset to Local on each activation. */
    private selectedWorktreeRoot;
    /** Last-request-wins guard for overlapping webview selection messages. */
    private worktreeSelectionGeneration;
    private readonly _onDidChangeWorktreeSelection;
    readonly onDidChangeWorktreeSelection: vscode.Event<GitWorktreeInfo>;
    /** Compatibility event for named-branch checkouts. */
    private readonly _onDidChangeBranch;
    readonly onDidChangeBranch: vscode.Event<string>;
    private readonly _onDidChangeCheckout;
    readonly onDidChangeCheckout: vscode.Event<GitCheckoutChange>;
    private readonly _onDidChangeHead;
    readonly onDidChangeHead: vscode.Event<void>;
    private _lastBranch;
    private _lastCommit;
    constructor(context: vscode.ExtensionContext);
    initialize(): Promise<boolean>;
    private initializeLocalWorktreeRoot;
    private trackBranchChanges;
    getLocalWorkspaceRoot(): string;
    getSelectedWorktreeRoot(): string;
    isLocalWorktreeSelected(): boolean;
    /** Always discover linked worktrees from the original workspace checkout. */
    listWorktrees(): Promise<GitWorktreeInfo[]>;
    /** Select one currently linked and accessible checkout for this session. */
    selectWorktree(root: string): Promise<GitWorktreeInfo>;
    /** Validate an identity embedded in a virtual URI without trusting its path. */
    isLinkedWorktreeRoot(root: string): Promise<boolean>;
    /**
     * Revalidate both the filesystem entry and common Git directory. A stale
     * worktree-list path must never authorize an unrelated repository or symlink.
     */
    private validateLinkedWorktreeRoot;
    private getCommonGitDir;
    private requireLinkedWorktreeRoot;
    getBranches(includeRemote?: boolean): Promise<string[]>;
    getCurrentBranch(): Promise<string | undefined>;
    private getCurrentBranchAt;
    /** Detect the primary branch from remote metadata without guessing names. */
    getPrimaryBranch(branches?: string[], excludeBranch?: string, options?: {
        allowUnavailable?: boolean;
        localFallback?: boolean;
    }): Promise<string | undefined>;
    getSoleLocalBranch(excludeBranch?: string): Promise<string | undefined>;
    getCommitHash(ref: string): Promise<string>;
    isCurrentBranch(branch: string): Promise<boolean>;
    checkoutBranch(branch: string): Promise<void>;
    /** Resolve a persisted review into one explicit, immutable diff strategy. */
    prepareDiffPlan(review: LocalPr): Promise<DiffPlan>;
    getChangedFiles(plan: DiffPlan): Promise<FileChange[]>;
    getFileUri(ref: string, filePath: string, side?: 'original' | 'modified'): vscode.Uri;
    getWorkingTreeFileUri(plan: WorktreeDiffPlan, filePath: string): vscode.Uri;
    getFileDiffUris(plan: DiffPlan, change: FileChange): FileDiffUris;
    getFileContent(document: DiffDocument, filePath: string): Promise<string>;
    /** Read content while preserving the distinction between an empty blob and failure. */
    getFileContentResult(document: DiffDocument, filePath: string): Promise<GitFileContentResult>;
    getCommitsForDiff(plan: DiffPlan): Promise<CommitInfo[]>;
    /** Both arguments must be immutable commit hashes. */
    getCommitsBetween(sourceCommit: string, targetCommit: string, worktreeRoot?: string): Promise<CommitInfo[]>;
    private resolveCommitWithFallback;
    private resolveCommit;
    private getWorkingTreeFileContentResult;
    private assertValidPlan;
    private execGit;
}
/** Parse NUL-delimited porcelain without treating spaces or newlines as separators. */
export declare function parseWorktreeList(output: string, localWorktreeRoot: string): GitWorktreeInfo[];
