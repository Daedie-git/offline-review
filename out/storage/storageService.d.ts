import { CommentsFile, ReviewThread, ReviewComment } from '../types';
import { LocalPrManager } from '../services/localPrManager';
export declare class StorageService {
    private localPrManager;
    constructor(localPrManager: LocalPrManager);
    loadComments(): CommentsFile | undefined;
    saveComments(comments: CommentsFile): void;
    addThread(filePath: string, startLine: number, endLine: number, body: string, author: string): ReviewThread;
    addReplyToThread(threadId: string, body: string, author: string): ReviewComment | undefined;
    resolveThread(threadId: string): void;
    unresolveThread(threadId: string): void;
    deleteComment(threadId: string, commentId: string): void;
    editComment(threadId: string, commentId: string, newBody: string): void;
    getAllCommentFiles(): {
        reviewLabel: string;
        filePath: string;
    }[];
    getActiveReviewLabel(): string | undefined;
}
