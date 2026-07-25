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
class StorageService {
    constructor(localPrManager) {
        this.localPrManager = localPrManager;
    }
    loadComments() {
        const review = this.localPrManager.getActiveReview();
        if (!review) {
            return undefined;
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(data);
            }
        }
        catch {
            // ignore parse errors
        }
        return {
            version: 1,
            sourceBranch: review.sourceBranch,
            targetBranch: review.targetBranch,
            sourceCommit: review.sourceCommit,
            targetCommit: review.targetCommit,
            threads: [],
        };
    }
    saveComments(comments) {
        const review = this.localPrManager.getActiveReview();
        if (!review) {
            return;
        }
        const filePath = this.localPrManager.getCommentsFilePath(review);
        // If no threads, delete the file and directory instead of writing empty data
        if (comments.threads.length === 0) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                const dir = path.dirname(filePath);
                const remaining = fs.readdirSync(dir);
                if (remaining.length === 0) {
                    fs.rmdirSync(dir);
                }
            }
            return;
        }
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(comments, null, 2), 'utf-8');
    }
    addThread(filePath, startLine, endLine, body, author) {
        const comments = this.loadComments();
        if (!comments) {
            throw new Error('No active review');
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
        };
        comments.threads.push(thread);
        this.saveComments(comments);
        return thread;
    }
    addReplyToThread(threadId, body, author) {
        const comments = this.loadComments();
        if (!comments) {
            return undefined;
        }
        const thread = comments.threads.find(t => t.id === threadId);
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
        this.saveComments(comments);
        return comment;
    }
    resolveThread(threadId) {
        const comments = this.loadComments();
        if (!comments) {
            return;
        }
        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            thread.state = 'resolved';
            this.saveComments(comments);
        }
    }
    unresolveThread(threadId) {
        const comments = this.loadComments();
        if (!comments) {
            return;
        }
        const thread = comments.threads.find(t => t.id === threadId);
        if (thread) {
            thread.state = 'unresolved';
            this.saveComments(comments);
        }
    }
    deleteComment(threadId, commentId) {
        const comments = this.loadComments();
        if (!comments) {
            return;
        }
        const thread = comments.threads.find(t => t.id === threadId);
        if (!thread) {
            return;
        }
        thread.comments = thread.comments.filter(c => c.id !== commentId);
        // If no comments left, remove the thread
        if (thread.comments.length === 0) {
            comments.threads = comments.threads.filter(t => t.id !== threadId);
        }
        this.saveComments(comments);
    }
    editComment(threadId, commentId, newBody) {
        const comments = this.loadComments();
        if (!comments) {
            return;
        }
        const thread = comments.threads.find(t => t.id === threadId);
        if (!thread) {
            return;
        }
        const comment = thread.comments.find(c => c.id === commentId);
        if (comment) {
            comment.body = newBody;
            comment.timestamp = new Date().toISOString();
            this.saveComments(comments);
        }
    }
    getAllCommentFiles() {
        const reviews = this.localPrManager.listReviews();
        const files = [];
        for (const review of reviews) {
            const commentsPath = this.localPrManager.getCommentsFilePath(review);
            if (fs.existsSync(commentsPath)) {
                files.push({
                    reviewLabel: `${review.targetBranch} -> ${review.sourceBranch}`,
                    filePath: commentsPath,
                });
            }
        }
        return files;
    }
    getActiveReviewLabel() {
        const review = this.localPrManager.getActiveReview();
        if (!review) {
            return undefined;
        }
        return `${review.targetBranch} -> ${review.sourceBranch}`;
    }
}
exports.StorageService = StorageService;
//# sourceMappingURL=storageService.js.map