import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { GitService } from '../git/gitService';
export declare class ReviewCommentController {
    private storageService;
    private controller;
    private threads;
    private gitService;
    private reviewableFiles;
    constructor(storageService: StorageService);
    /**
     * Set the list of file paths (workspace-relative) that are part of the active review.
     * This enables commenting on working-tree files shown in diffs.
     */
    setReviewableFiles(filePaths: string[]): void;
    /**
     * Check if any loaded threads reference this file path.
     */
    private hasThreadsForFile;
    /**
     * Load comment threads from storage for a given file in the diff view.
     * Creates additional threads on the diff URI so inline comments show in the diff editor.
     */
    loadThreadsForFile(fileUri: vscode.Uri, filePath: string): void;
    /**
     * Load all threads for the active review across all files
     */
    loadAllThreads(gitService?: GitService, sourceBranch?: string, targetBranch?: string): Promise<void>;
    private loadAllThreadsForBranches;
    createThread(uri: vscode.Uri, range: vscode.Range, text: string, filePath: string, existingThread?: vscode.CommentThread): void;
    private populateThread;
    private createVscodeThread;
    private toVscodeComment;
    resolveThread(thread: vscode.CommentThread): void;
    unresolveThread(thread: vscode.CommentThread): void;
    addReply(thread: vscode.CommentThread, text: string): void;
    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void;
    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined;
    private clearAllThreads;
    dispose(): void;
}
