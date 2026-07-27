"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const types_1 = require("../types");
const DEFAULT_OWN_WRITE_WINDOW_MS = 300;
class StorageService {
    constructor(localPrManager, now = () => Date.now(), ownWriteWindowMs = DEFAULT_OWN_WRITE_WINDOW_MS) {
        this.localPrManager = localPrManager;
        this.now = now;
        this.ownWriteWindowMs = ownWriteWindowMs;
        // Wall-clock milliseconds; comments.json watchers should ignore writes until then.
        this.suppressWatcherUntil = 0;
        this.ignoreWatchDepth = 0;
        this.ownWrites = new Map();
        this.reviewRevisions = new Map();
    }
    getReviewRevision(reviewId) {
        return this.reviewRevisions.get(reviewId) ?? 0;
    }
    /** Signal an external watcher event before any debounce or suppression delay. */
    markExternalChange(reviewId) {
        if (this.localPrManager.getReviewById(reviewId)) {
            this.markReviewChanged(reviewId);
        }
    }
    markReviewChanged(reviewId) {
        this.reviewRevisions.set(reviewId, this.getReviewRevision(reviewId) + 1);
    }
    markOwnWrite(serializedContent, filePath) {
        this._lastWrittenHash = crypto
            .createHash('sha1')
            .update(serializedContent)
            .digest('hex');
        const deadline = this.now() + this.ownWriteWindowMs;
        this.ownWrites.set(filePath, {
            expectedHash: serializedContent === '' ? undefined : this._lastWrittenHash,
            expiresAt: deadline,
        });
        // Multiple immediate watcher events can belong to one write, but exact
        // byte/absence recognition is intentionally bounded by this deadline.
        this.suppressWatcherUntil = Math.max(this.suppressWatcherUntil, deadline);
        this.ignoreWatchDepth++;
        setTimeout(() => {
            this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
        }, 0);
    }
    classifyWatch(fsPath) {
        const now = this.now();
        const ownWrite = fsPath ? this.ownWrites.get(fsPath) : undefined;
        if (fsPath && ownWrite) {
            if (now >= ownWrite.expiresAt) {
                this.ownWrites.delete(fsPath);
            }
            else {
                try {
                    if (ownWrite.expectedHash === undefined) {
                        if (!fs.existsSync(fsPath)) {
                            return 'exactOwnWrite';
                        }
                    }
                    else if (fs.existsSync(fsPath)) {
                        const actualHash = crypto
                            .createHash('sha1')
                            .update(fs.readFileSync(fsPath))
                            .digest('hex');
                        if (actualHash === ownWrite.expectedHash) {
                            return 'exactOwnWrite';
                        }
                    }
                }
                catch {
                    // An unreadable or changing path is never an exact own write.
                }
            }
        }
        if (this.ignoreWatchDepth > 0 || now < this.suppressWatcherUntil) {
            return 'suppressed';
        }
        return 'external';
    }
    shouldIgnoreWatch(fsPath) {
        return this.classifyWatch(fsPath) !== 'external';
    }
    msUntilWatchAllowed() {
        return Math.max(0, this.suppressWatcherUntil - this.now());
    }
    async withWatchSuppressed(fn) {
        this.suppressWatcherUntil = Math.max(this.suppressWatcherUntil, this.now() + 5000);
        this.ignoreWatchDepth++;
        try {
            return await fn();
        }
        finally {
            setTimeout(() => {
                this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
            }, 800);
        }
    }
    loadComments() {
        const review = this.localPrManager.getActiveReview();
        return review ? this.loadCommentsForReview(review) : undefined;
    }
    /** Read one UUID-owned comment bucket without changing global active state. */
    loadCommentsForReview(reviewOrId) {
        const review = typeof reviewOrId === 'string'
            ? this.localPrManager.getReviewById(reviewOrId)
            : reviewOrId;
        if (!review) {
            return undefined;
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        try {
            if (fs.existsSync(filePath)) {
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (isCurrentCommentsFile(parsed)) {
                    return parsed;
                }
            }
        }
        catch {
            // An unreadable file presents an empty in-memory shell and remains
            // untouched until the user explicitly writes to this review.
        }
        return this.createCommentsShell(review);
    }
    /** Mutations must never replace a present malformed or unsupported file. */
    loadCommentsForMutation(reviewId) {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        if (!fs.existsSync(filePath)) {
            return this.createCommentsShell(review);
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (isCurrentCommentsFile(parsed)) {
                return parsed;
            }
        }
        catch {
            // Report one stable refusal below without exposing parser details.
        }
        throw new Error('Review comments file is malformed or unsupported; refusing to overwrite it');
    }
    /** Write one explicit UUID-owned bucket without consulting active review state. */
    saveCommentsForReview(reviewId, comments) {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        // Empty comments remove only this review's UUID-owned file/directory.
        if (comments.threads.length === 0) {
            this.markOwnWrite('', filePath);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const reviewDir = path.dirname(filePath);
                if (fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 0) {
                    fs.rmdirSync(reviewDir);
                }
            }
            this.markReviewChanged(reviewId);
            return;
        }
        const reviewDir = path.dirname(filePath);
        fs.mkdirSync(reviewDir, { recursive: true });
        const serialized = JSON.stringify(comments, null, 2);
        this.markOwnWrite(serialized, filePath);
        fs.writeFileSync(filePath, serialized, 'utf-8');
        this.markReviewChanged(reviewId);
    }
    ensureCommentsFileForReview(reviewId) {
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
        this.markOwnWrite(serialized, filePath);
        fs.writeFileSync(filePath, serialized, 'utf-8');
    }
    deleteCommentsForReview(reviewId) {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            return false;
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        if (!fs.existsSync(filePath)) {
            return false;
        }
        this.markOwnWrite('', filePath);
        fs.unlinkSync(filePath);
        const reviewDir = path.dirname(filePath);
        if (fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 0) {
            fs.rmdirSync(reviewDir);
        }
        this.markReviewChanged(reviewId);
        return true;
    }
    createCommentsShell(review) {
        const comparison = (0, types_1.getReviewSourceTarget)(review);
        return {
            version: 2,
            sourceBranch: comparison.sourceBranch,
            targetBranch: comparison.targetBranch,
            sourceCommit: comparison.sourceCommit,
            targetCommit: comparison.targetCommit,
            threads: [],
        };
    }
    addThread(reviewId, target, filePath, startLine, endLine, body, author, sourceAnchor) {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }
        validateThreadTarget(review, target, filePath);
        const comments = this.loadCommentsForMutation(reviewId);
        const thread = {
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
            ...(sourceAnchor === undefined ? {} : { sourceAnchor }),
            target,
        };
        comments.threads.push(thread);
        this.saveCommentsForReview(reviewId, comments);
        return thread;
    }
    addReplyToThread(reviewId, threadId, body, author) {
        if (!this.localPrManager.getReviewById(reviewId)) {
            return undefined;
        }
        const comments = this.loadCommentsForMutation(reviewId);
        const thread = comments.threads.find(candidate => candidate.id === threadId);
        if (!thread) {
            return undefined;
        }
        const comment = {
            id: crypto.randomUUID(),
            body,
            author,
            timestamp: new Date().toISOString(),
        };
        thread.comments.push(comment);
        this.saveCommentsForReview(reviewId, comments);
        return comment;
    }
    resolveThread(reviewId, threadId) {
        return this.setThreadState(reviewId, threadId, 'resolved');
    }
    unresolveThread(reviewId, threadId) {
        return this.setThreadState(reviewId, threadId, 'unresolved');
    }
    setThreadState(reviewId, threadId, state) {
        if (!this.localPrManager.getReviewById(reviewId)) {
            return false;
        }
        const comments = this.loadCommentsForMutation(reviewId);
        const thread = comments.threads.find(candidate => candidate.id === threadId);
        if (!thread) {
            return false;
        }
        thread.state = state;
        this.saveCommentsForReview(reviewId, comments);
        return true;
    }
    deleteComment(reviewId, threadId, commentId) {
        const comments = this.loadCommentsForMutation(reviewId);
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
    editComment(reviewId, threadId, commentId, newBody) {
        const comments = this.loadCommentsForMutation(reviewId);
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
    getAllCommentFiles() {
        const activeReviewId = this.localPrManager.getActiveReview()?.id;
        const files = [];
        for (const review of this.localPrManager.listReviews()) {
            const commentsPath = this.localPrManager.getCommentsFilePath(review);
            if (fs.existsSync(commentsPath)) {
                files.push({
                    reviewId: review.id,
                    mode: review.mode,
                    label: (0, types_1.formatReviewLabel)(review),
                    filePath: commentsPath,
                    isActive: review.id === activeReviewId,
                });
            }
        }
        return files;
    }
    getActiveReviewLabel() {
        const review = this.localPrManager.getActiveReview();
        return review ? (0, types_1.formatReviewLabel)(review) : undefined;
    }
}
exports.StorageService = StorageService;
function validateThreadTarget(review, target, filePath) {
    if (!filePath || target.filePath !== filePath) {
        throw new Error('Comment target path does not match its thread path');
    }
    if (target.kind === 'git') {
        if (!isFullObjectId(target.ref)
            || (target.side !== undefined
                && target.side !== 'original' && target.side !== 'modified')
            || (review.mode === 'uncommitted' && target.side !== 'original')) {
            throw new Error('Git comments require an immutable target commit and valid review side');
        }
        return;
    }
    if (review.mode === 'branch'
        || target.reviewId !== review.id
        || !isFullObjectId(target.headCommit)
        || !isUuid(target.planId)) {
        throw new Error('Worktree comments require their prepared review and HEAD identity');
    }
}
function isFullObjectId(value) {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isCurrentCommentsFile(value) {
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
        && (!Object.prototype.hasOwnProperty.call(thread, 'sourceAnchor')
            || typeof thread.sourceAnchor === 'string')
        && Array.isArray(thread.comments)
        && thread.comments.every(comment => isRecord(comment)
            && typeof comment.id === 'string'
            && typeof comment.body === 'string'
            && typeof comment.author === 'string'
            && typeof comment.timestamp === 'string')
        && isCurrentThreadTarget(thread.target));
}
function isCurrentThreadTarget(value) {
    if (!isRecord(value) || typeof value.filePath !== 'string') {
        return false;
    }
    return value.kind === 'git'
        ? typeof value.ref === 'string'
            && isFullObjectId(value.ref)
            && (value.side === undefined
                || value.side === 'original' || value.side === 'modified')
        : value.kind === 'worktree'
            && typeof value.reviewId === 'string'
            && isUuid(value.reviewId)
            && typeof value.headCommit === 'string'
            && isFullObjectId(value.headCommit)
            && typeof value.planId === 'string'
            && isUuid(value.planId);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=storageService.js.map