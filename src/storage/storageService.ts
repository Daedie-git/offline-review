import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    CommentFileDiscovery,
    CommentsFile,
    formatReviewLabel,
    getReviewSourceTarget,
    LocalPr,
    ReviewComment,
    ReviewThread,
    ReviewThreadTarget,
} from '../types';
import { LocalPrManager } from '../services/localPrManager';

export class StorageService {
    /** Hash used by the file watcher to distinguish the service's own write. */
    public _lastWrittenHash: string | undefined;

    // Wall-clock milliseconds; comments.json watchers should ignore writes until then.
    private suppressWatcherUntil = 0;
    private ignoreWatchDepth = 0;

    constructor(private readonly localPrManager: LocalPrManager) {}

    private markOwnWrite(serializedContent: string): void {
        this._lastWrittenHash = crypto
            .createHash('sha1')
            .update(serializedContent)
            .digest('hex');

        // The short time window handles delete/create races. The content hash is
        // the durable own-write check and avoids dropping unrelated later edits.
        this.suppressWatcherUntil = Date.now() + 300;
        this.ignoreWatchDepth++;
        setTimeout(() => {
            this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
        }, 0);
    }

    shouldIgnoreWatch(fsPath?: string): boolean {
        if (this.ignoreWatchDepth > 0) {
            return true;
        }

        if (fsPath && this._lastWrittenHash && fs.existsSync(fsPath)) {
            try {
                const hash = crypto
                    .createHash('sha1')
                    .update(fs.readFileSync(fsPath))
                    .digest('hex');
                if (hash === this._lastWrittenHash) {
                    return true;
                }
            } catch {
                // Fall through to the short suppression window.
            }
        }

        return Date.now() < this.suppressWatcherUntil;
    }

    msUntilWatchAllowed(): number {
        return Math.max(0, this.suppressWatcherUntil - Date.now());
    }

    async withWatchSuppressed<T>(fn: () => Promise<T> | T): Promise<T> {
        this.suppressWatcherUntil = Date.now() + 5000;
        this.ignoreWatchDepth++;
        try {
            return await fn();
        } finally {
            setTimeout(() => {
                this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
            }, 800);
        }
    }

    loadComments(): CommentsFile | undefined {
        const review = this.localPrManager.getActiveReview();
        return review ? this.loadCommentsForReview(review) : undefined;
    }

    /** Read one UUID-owned comment bucket without changing global active state. */
    loadCommentsForReview(reviewOrId: LocalPr | string): CommentsFile | undefined {
        const review = typeof reviewOrId === 'string'
            ? this.localPrManager.getReviewById(reviewOrId)
            : reviewOrId;
        if (!review) {
            return undefined;
        }

        const filePath = this.localPrManager.getCommentsFilePath(review);
        try {
            if (fs.existsSync(filePath)) {
                const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (isCurrentCommentsFile(parsed)) {
                    return parsed;
                }
            }
        } catch {
            // An unreadable file presents an empty in-memory shell and remains
            // untouched until the user explicitly writes to this review.
        }

        return this.createCommentsShell(review);
    }

    /** Write one explicit UUID-owned bucket without consulting active review state. */
    saveCommentsForReview(reviewId: string, comments: CommentsFile): void {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }

        const filePath = this.localPrManager.getCommentsFilePath(review);

        // Empty comments remove only this review's UUID-owned file/directory.
        if (comments.threads.length === 0) {
            this.markOwnWrite('');
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const reviewDir = path.dirname(filePath);
                if (fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 0) {
                    fs.rmdirSync(reviewDir);
                }
            }
            return;
        }

        const reviewDir = path.dirname(filePath);
        fs.mkdirSync(reviewDir, { recursive: true });
        const serialized = JSON.stringify(comments, null, 2);
        this.markOwnWrite(serialized);
        fs.writeFileSync(filePath, serialized, 'utf-8');
    }

    ensureCommentsFileForReview(reviewId: string): void {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            return;
        }

        const filePath = this.localPrManager.getCommentsFilePath(review);
        if (fs.existsSync(filePath)) {
            return;
        }

        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const serialized = JSON.stringify(this.createCommentsShell(review), null, 2);
        this.markOwnWrite(serialized);
        fs.writeFileSync(filePath, serialized, 'utf-8');
    }

    deleteCommentsForReview(reviewId: string): boolean {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            return false;
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        if (!fs.existsSync(filePath)) {
            return false;
        }
        this.markOwnWrite('');
        fs.unlinkSync(filePath);
        const reviewDir = path.dirname(filePath);
        if (fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 0) {
            fs.rmdirSync(reviewDir);
        }
        return true;
    }

    private createCommentsShell(review: LocalPr): CommentsFile {
        const comparison = getReviewSourceTarget(review);
        return {
            version: 2,
            sourceBranch: comparison.sourceBranch,
            targetBranch: comparison.targetBranch,
            sourceCommit: comparison.sourceCommit,
            targetCommit: comparison.targetCommit,
            threads: [],
        };
    }

    addThread(
        reviewId: string,
        target: ReviewThreadTarget,
        filePath: string,
        startLine: number,
        endLine: number,
        body: string,
        author: string
    ): ReviewThread {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }
        validateThreadTarget(review, target, filePath);
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments) {
            throw new Error(`Could not load Offline Review ${reviewId}`);
        }

        const thread: ReviewThread = {
            id: crypto.randomUUID(),
            filePath,
            startLine,
            endLine,
            state: 'unresolved',
            comments: [{
                id: crypto.randomUUID(),
                body,
                author,
                timestamp: new Date().toISOString(),
            }],
            target,
        };

        comments.threads.push(thread);
        this.saveCommentsForReview(reviewId, comments);
        return thread;
    }

    addReplyToThread(
        reviewId: string,
        threadId: string,
        body: string,
        author: string
    ): ReviewComment | undefined {
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments || !this.localPrManager.getReviewById(reviewId)) {
            return undefined;
        }

        const thread = comments.threads.find(candidate => candidate.id === threadId);
        if (!thread) {
            return undefined;
        }

        const comment: ReviewComment = {
            id: crypto.randomUUID(),
            body,
            author,
            timestamp: new Date().toISOString(),
        };

        thread.comments.push(comment);
        this.saveCommentsForReview(reviewId, comments);
        return comment;
    }

    resolveThread(reviewId: string, threadId: string): boolean {
        return this.setThreadState(reviewId, threadId, 'resolved');
    }

    unresolveThread(reviewId: string, threadId: string): boolean {
        return this.setThreadState(reviewId, threadId, 'unresolved');
    }

    private setThreadState(
        reviewId: string,
        threadId: string,
        state: ReviewThread['state']
    ): boolean {
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments || !this.localPrManager.getReviewById(reviewId)) {
            return false;
        }

        const thread = comments.threads.find(candidate => candidate.id === threadId);
        if (!thread) {
            return false;
        }
        thread.state = state;
        this.saveCommentsForReview(reviewId, comments);
        return true;
    }

    deleteComment(reviewId: string, threadId: string, commentId: string): boolean {
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments || !this.localPrManager.getReviewById(reviewId)) {
            return false;
        }

        const thread = comments.threads.find(candidate => candidate.id === threadId);
        if (!thread || !thread.comments.some(comment => comment.id === commentId)) {
            return false;
        }

        thread.comments = thread.comments.filter(comment => comment.id !== commentId);
        if (thread.comments.length === 0) {
            comments.threads = comments.threads.filter(candidate => candidate.id !== threadId);
        }
        this.saveCommentsForReview(reviewId, comments);
        return true;
    }

    editComment(reviewId: string, threadId: string, commentId: string, newBody: string): boolean {
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments || !this.localPrManager.getReviewById(reviewId)) {
            return false;
        }

        const thread = comments.threads.find(candidate => candidate.id === threadId);
        const comment = thread?.comments.find(candidate => candidate.id === commentId);
        if (!comment) {
            return false;
        }
        comment.body = newBody;
        comment.timestamp = new Date().toISOString();
        this.saveCommentsForReview(reviewId, comments);
        return true;
    }

    getAllCommentFiles(): CommentFileDiscovery[] {
        const activeReviewId = this.localPrManager.getActiveReview()?.id;
        const files: CommentFileDiscovery[] = [];

        for (const review of this.localPrManager.listReviews()) {
            const commentsPath = this.localPrManager.getCommentsFilePath(review);
            if (fs.existsSync(commentsPath)) {
                files.push({
                    reviewId: review.id,
                    mode: review.mode,
                    label: formatReviewLabel(review),
                    filePath: commentsPath,
                    isActive: review.id === activeReviewId,
                });
            }
        }

        return files;
    }

    getActiveReviewLabel(): string | undefined {
        const review = this.localPrManager.getActiveReview();
        return review ? formatReviewLabel(review) : undefined;
    }
}

function validateThreadTarget(
    review: LocalPr,
    target: ReviewThreadTarget,
    filePath: string
): void {
    if (!filePath || target.filePath !== filePath) {
        throw new Error('Comment target path does not match its thread path');
    }
    if (review.mode === 'branch') {
        if (target.kind !== 'git' || !isFullObjectId(target.ref)) {
            throw new Error('Branch comments require an immutable target commit');
        }
        return;
    }
    if (target.kind !== 'worktree'
        || target.reviewId !== review.id
        || !isFullObjectId(target.headCommit)
        || !isUuid(target.planId)) {
        throw new Error('Worktree comments require their prepared review and HEAD identity');
    }
}

function isFullObjectId(value: string): boolean {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCurrentCommentsFile(value: unknown): value is CommentsFile {
    if (!isRecord(value)
        || value.version !== 2
        || typeof value.sourceBranch !== 'string'
        || typeof value.targetBranch !== 'string'
        || typeof value.sourceCommit !== 'string'
        || typeof value.targetCommit !== 'string'
        || !Array.isArray(value.threads)) {
        return false;
    }
    return value.threads.every(thread => isRecord(thread)
        && typeof thread.id === 'string'
        && typeof thread.filePath === 'string'
        && typeof thread.startLine === 'number'
        && typeof thread.endLine === 'number'
        && (thread.state === 'resolved' || thread.state === 'unresolved')
        && Array.isArray(thread.comments)
        && thread.comments.every(comment => isRecord(comment)
            && typeof comment.id === 'string'
            && typeof comment.body === 'string'
            && typeof comment.author === 'string'
            && typeof comment.timestamp === 'string')
        && isCurrentThreadTarget(thread.target));
}

function isCurrentThreadTarget(value: unknown): value is ReviewThreadTarget {
    if (!isRecord(value) || typeof value.filePath !== 'string') {
        return false;
    }
    return value.kind === 'git'
        ? typeof value.ref === 'string' && isFullObjectId(value.ref)
        : value.kind === 'worktree'
            && typeof value.reviewId === 'string'
            && isUuid(value.reviewId)
            && typeof value.headCommit === 'string'
            && isFullObjectId(value.headCommit)
            && typeof value.planId === 'string'
            && isUuid(value.planId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
