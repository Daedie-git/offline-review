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
class StorageService {
    constructor(localPrManager) {
        this.localPrManager = localPrManager;
        // Wall-clock milliseconds; comments.json watchers should ignore writes until then.
        this.suppressWatcherUntil = 0;
        this.ignoreWatchDepth = 0;
    }
    markOwnWrite(serializedContent) {
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
    shouldIgnoreWatch(fsPath) {
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
            }
            catch {
                // Fall through to the short suppression window.
            }
        }
        return Date.now() < this.suppressWatcherUntil;
    }
    msUntilWatchAllowed() {
        return Math.max(0, this.suppressWatcherUntil - Date.now());
    }
    async withWatchSuppressed(fn) {
        this.suppressWatcherUntil = Date.now() + 5000;
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
    /** Write one explicit UUID-owned bucket without consulting active review state. */
    saveCommentsForReview(reviewId, comments) {
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
        this.markOwnWrite(serialized);
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
        this.markOwnWrite('');
        fs.unlinkSync(filePath);
        const reviewDir = path.dirname(filePath);
        if (fs.existsSync(reviewDir) && fs.readdirSync(reviewDir).length === 0) {
            fs.rmdirSync(reviewDir);
        }
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
    addThread(reviewId, target, filePath, startLine, endLine, body, author) {
        const review = this.localPrManager.getReviewById(reviewId);
        if (!review) {
            throw new Error(`Offline Review ${reviewId} no longer exists`);
        }
        validateThreadTarget(review, target, filePath);
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments) {
            throw new Error(`Could not load Offline Review ${reviewId}`);
        }
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
            target,
        };
        comments.threads.push(thread);
        this.saveCommentsForReview(reviewId, comments);
        return thread;
    }
    addReplyToThread(reviewId, threadId, body, author) {
        const comments = this.loadCommentsForReview(reviewId);
        if (!comments || !this.localPrManager.getReviewById(reviewId)) {
            return undefined;
        }
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
    deleteComment(reviewId, threadId, commentId) {
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
    editComment(reviewId, threadId, commentId, newBody) {
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