import { CommentFileDiscovery, CommentsFile, LocalPr, ReviewComment, ReviewThread, ReviewThreadTarget } from '../types';
import { LocalPrManager } from '../services/localPrManager';
export declare class StorageService {
    private readonly localPrManager;
    /** Hash used by the file watcher to distinguish the service's own write. */
    _lastWrittenHash: string | undefined;
    private suppressWatcherUntil;
    private ignoreWatchDepth;
    constructor(localPrManager: LocalPrManager);
    private markOwnWrite;
    shouldIgnoreWatch(fsPath?: string): boolean;
    msUntilWatchAllowed(): number;
    withWatchSuppressed<T>(fn: () => Promise<T> | T): Promise<T>;
    loadComments(): CommentsFile | undefined;
    /** Read one UUID-owned comment bucket without changing global active state. */
    loadCommentsForReview(reviewOrId: LocalPr | string): CommentsFile | undefined;
    /** Write one explicit UUID-owned bucket without consulting active review state. */
    saveCommentsForReview(reviewId: string, comments: CommentsFile): void;
    ensureCommentsFileForReview(reviewId: string): void;
    deleteCommentsForReview(reviewId: string): boolean;
    private createCommentsShell;
    addThread(reviewId: string, target: ReviewThreadTarget, filePath: string, startLine: number, endLine: number, body: string, author: string): ReviewThread;
    addReplyToThread(reviewId: string, threadId: string, body: string, author: string): ReviewComment | undefined;
    resolveThread(reviewId: string, threadId: string): boolean;
    unresolveThread(reviewId: string, threadId: string): boolean;
    private setThreadState;
    deleteComment(reviewId: string, threadId: string, commentId: string): boolean;
    editComment(reviewId: string, threadId: string, commentId: string, newBody: string): boolean;
    getAllCommentFiles(): CommentFileDiscovery[];
    getActiveReviewLabel(): string | undefined;
}
