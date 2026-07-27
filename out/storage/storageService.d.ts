import { CommentFileDiscovery, CommentsFile, LocalPr, ReviewComment, ReviewThread, ReviewThreadTarget } from '../types';
import { LocalPrManager } from '../services/localPrManager';
export type WatchEventClassification = 'exactOwnWrite' | 'suppressed' | 'external';
export declare class StorageService {
    private readonly localPrManager;
    private readonly now;
    private readonly ownWriteWindowMs;
    /** Hash used by the file watcher to distinguish the service's own write. */
    _lastWrittenHash: string | undefined;
    private suppressWatcherUntil;
    private ignoreWatchDepth;
    private readonly ownWrites;
    private readonly reviewRevisions;
    constructor(localPrManager: LocalPrManager, now?: () => number, ownWriteWindowMs?: number);
    getReviewRevision(reviewId: string): number;
    /** Signal an external watcher event before any debounce or suppression delay. */
    markExternalChange(reviewId: string): void;
    private markReviewChanged;
    private markOwnWrite;
    classifyWatch(fsPath?: string): WatchEventClassification;
    shouldIgnoreWatch(fsPath?: string): boolean;
    msUntilWatchAllowed(): number;
    withWatchSuppressed<T>(fn: () => Promise<T> | T): Promise<T>;
    loadComments(): CommentsFile | undefined;
    /** Read one UUID-owned comment bucket without changing global active state. */
    loadCommentsForReview(reviewOrId: LocalPr | string): CommentsFile | undefined;
    /** Mutations must never replace a present malformed or unsupported file. */
    private loadCommentsForMutation;
    /** Write one explicit UUID-owned bucket without consulting active review state. */
    saveCommentsForReview(reviewId: string, comments: CommentsFile): void;
    ensureCommentsFileForReview(reviewId: string): void;
    deleteCommentsForReview(reviewId: string): boolean;
    private createCommentsShell;
    addThread(reviewId: string, target: ReviewThreadTarget, filePath: string, startLine: number, endLine: number, body: string, author: string, sourceAnchor?: string): ReviewThread;
    addReplyToThread(reviewId: string, threadId: string, body: string, author: string): ReviewComment | undefined;
    resolveThread(reviewId: string, threadId: string): boolean;
    unresolveThread(reviewId: string, threadId: string): boolean;
    private setThreadState;
    deleteComment(reviewId: string, threadId: string, commentId: string): boolean;
    editComment(reviewId: string, threadId: string, commentId: string, newBody: string): boolean;
    getAllCommentFiles(): CommentFileDiscovery[];
    getActiveReviewLabel(): string | undefined;
}
