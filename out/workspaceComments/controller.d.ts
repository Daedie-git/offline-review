import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
export declare class WorkspaceCommentController {
    private readonly storage;
    private readonly pathResolver;
    private readonly controller;
    private readonly threads;
    private readonly commentIdentities;
    constructor(storage: WorkspaceCommentStorage, pathResolver: WorkspacePathResolver);
    loadAllThreads(): void;
    createThread(document: vscode.TextDocument, range: vscode.Range, body: string, existingThread?: vscode.CommentThread): void;
    addReply(thread: vscode.CommentThread, body: string): void;
    resolveThread(thread: vscode.CommentThread): void;
    unresolveThread(thread: vscode.CommentThread): void;
    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, body: string): void;
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
    private toVscodeComments;
    private toVscodeComment;
}
