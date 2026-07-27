import * as vscode from 'vscode';
import { CommitInfo, DiffDocument, DiffPlan, FileChange, LocalPr, WorktreeDiffPlan } from '../types';
export interface FileDiffUris {
    readonly left: vscode.Uri;
    readonly right: vscode.Uri;
}
/** A checkout identity transition, including entering or leaving detached HEAD. */
export interface GitCheckoutChange {
    readonly previousBranch: string | undefined;
    readonly branch: string | undefined;
}
export interface ParsedDiffDocumentUri {
    readonly filePath: string;
    readonly side: 'original' | 'modified' | undefined;
    readonly reviewId: string | undefined;
    readonly document: DiffDocument;
}
/** Build a virtual-document URI from an already resolved document decision. */
export declare function getDiffDocumentUri(document: DiffDocument, filePath: string, side?: 'original' | 'modified', reviewId?: string): vscode.Uri;
/** Parse and validate one URI before it can reach Git or the working tree. */
export declare function parseDiffDocumentUri(uri: vscode.Uri): ParsedDiffDocumentUri | undefined;
export declare function getFileDiffUris(plan: DiffPlan, change: FileChange): FileDiffUris;
export declare class GitService {
    private readonly context;
    static readonly WORKTREE_REF = "WORKTREE";
    private repo;
    private readonly workspaceRoot;
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
    private trackBranchChanges;
    getBranches(includeRemote?: boolean): Promise<string[]>;
    getCurrentBranch(): Promise<string | undefined>;
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
    getFileContent(ref: string, filePath: string): Promise<string>;
    getCommitsForDiff(plan: DiffPlan): Promise<CommitInfo[]>;
    /** Both arguments must be immutable commit hashes. */
    getCommitsBetween(sourceCommit: string, targetCommit: string): Promise<CommitInfo[]>;
    private resolveCommitWithFallback;
    private resolveCommit;
    private getWorkingTreeFileContent;
    private assertValidPlan;
    private execGit;
}
