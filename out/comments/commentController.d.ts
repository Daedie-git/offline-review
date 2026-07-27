import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { DiffPlan } from '../types';
export declare class ReviewCommentController {
    private readonly storageService;
    private readonly controller;
    private readonly threads;
    private readonly commentIdentities;
    private readonly reviewableFiles;
    private activePlan;
    constructor(storageService: StorageService);
    setReviewableFiles(filePaths: readonly string[]): void;
    /** Load one file's threads only on the exact modified/right URI. */
    loadThreadsForFile(targetUri: vscode.Uri, filePath: string, plan?: DiffPlan | undefined): void;
    /**
     * Replace all loaded threads using the exact target document in a prepared
     * plan. No branch equality or checked-out-branch inference is performed.
     */
    loadAllThreads(plan?: DiffPlan): void;
    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri: vscode.Uri, filePath: string): string;
    createThread(uri: vscode.Uri, range: vscode.Range, text: string, filePath: string, existingThread?: vscode.CommentThread, expectedReviewId?: string): void;
    private requireCurrentCommentTarget;
    private populateThread;
    private createVscodeThread;
    private removeOtherUris;
    private applyThreadState;
    private toVscodeComments;
    private toVscodeComment;
    resolveThread(thread: vscode.CommentThread): void;
    unresolveThread(thread: vscode.CommentThread): void;
    addReply(thread: vscode.CommentThread, text: string): void;
    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, newBody: string): void;
    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void;
    private disposeThread;
    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined;
    private clearAllThreads;
    dispose(): void;
}
