import * as vscode from 'vscode';
import { AuthorIdentity } from '../authorIdentity';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
export declare class WorkspaceCommentController {
    private readonly storage;
    private readonly pathResolver;
    private readonly authorIdentity;
    private readonly controller;
    private readonly commentingRangeProvider;
    private readonly threads;
    private readonly commentIdentities;
    constructor(storage: WorkspaceCommentStorage, pathResolver: WorkspacePathResolver, authorIdentity?: AuthorIdentity);
    /**
     * Republishes the provider so hosts recompute commentable ranges for the
     * current editor. Cursor can otherwise retain an empty range cache after
     * activation or a same-version extension reload.
     */
    refreshCommentingRanges(): void;
    loadAllThreads(): void;
    createThread(document: vscode.TextDocument, range: vscode.Range, body: string, existingThread?: vscode.CommentThread): void;
    addReply(thread: vscode.CommentThread, body: string): void;
    resolveThread(thread: vscode.CommentThread): void;
    unresolveThread(thread: vscode.CommentThread): void;
    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, body: string): void;
    /** Reload thread comments from storage, discarding in-progress edit UI state. */
    discardCommentEdits(thread: vscode.CommentThread): void;
    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void;
    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined;
    dispose(): void;
    private createOrUpdateThread;
    private populateThread;
    private applyState;
    private setThreadState;
    private refreshThreadComments;
    private requireThreadId;
    private requireCommentIdentity;
    private resolveCommentIdentity;
    private toVscodeComments;
    private toVscodeComment;
}
