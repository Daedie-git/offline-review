import * as vscode from 'vscode';
import { AuthorIdentity } from '../authorIdentity';
import { StorageService } from '../storage/storageService';
import { DiffPlan, PreparedReviewCommentState } from '../types';
import { ReviewAnchorResolver } from './reviewAnchorResolver';
export declare class ReviewCommentController {
    private readonly storageService;
    private readonly anchorResolver?;
    private readonly authorIdentity;
    private readonly controller;
    private readonly threads;
    private readonly commentIdentities;
    private readonly reviewableFiles;
    private readonly originalSideFiles;
    private activePlan;
    constructor(storageService: StorageService, anchorResolver?: ReviewAnchorResolver | undefined, authorIdentity?: AuthorIdentity);
    setReviewableFiles(filePaths: readonly string[], originalSideFilePaths?: readonly string[]): void;
    pickFileComment(uri: vscode.Uri): Promise<vscode.CommentThread | undefined>;
    private currentTargetUri;
    /** Load one file's threads only on its exact reviewable diff side. */
    loadThreadsForFile(targetUri: vscode.Uri, filePath: string, plan?: DiffPlan | undefined): void;
    /**
     * Replace all loaded threads using the exact target document in a prepared
     * plan. No branch equality or checked-out-branch inference is performed.
     */
    loadAllThreads(plan?: DiffPlan, preparedState?: PreparedReviewCommentState): void;
    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri: vscode.Uri, filePath: string): string;
    createThread(uri: vscode.Uri, range: vscode.Range, text: string, filePath: string, existingThread?: vscode.CommentThread, expectedReviewId?: string, capturedDocument?: vscode.TextDocument): Promise<void>;
    private requireCurrentCommentTarget;
    private populateThread;
    private createVscodeThread;
    private removeOtherUris;
    private applyThreadState;
    private toVscodeComments;
    private toVscodeComment;
    private resolveCommentIdentity;
    resolveThread(thread: vscode.CommentThread): void;
    unresolveThread(thread: vscode.CommentThread): void;
    addReply(thread: vscode.CommentThread, text: string): void;
    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, newBody: string): void;
    /** Reload thread comments from storage, discarding in-progress edit UI state. */
    discardCommentEdits(thread: vscode.CommentThread): void;
    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void;
    private disposeThread;
    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined;
    private clearAllThreads;
    dispose(): void;
}
