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
exports.ReviewCommentController = void 0;
const vscode = __importStar(require("vscode"));
const os = __importStar(require("os"));
const types_1 = require("../types");
const gitService_1 = require("../git/gitService");
class ReviewCommentController {
    constructor(storageService) {
        this.storageService = storageService;
        this.threads = new Map();
        this.commentIdentities = new WeakMap();
        this.reviewableFiles = new Set();
        this.controller = vscode.comments.createCommentController('localPrReview', 'Offline Review');
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (document.uri.scheme === 'git-local-review') {
                    const params = new URLSearchParams(document.uri.query);
                    if (params.get('side') !== 'modified') {
                        return [];
                    }
                    if (this.activePlan) {
                        const filePath = uriFilePath(document.uri);
                        const expected = (0, gitService_1.getDiffDocumentUri)(this.activePlan.right, filePath, 'modified', this.activePlan.reviewId, this.activePlan.worktreeRoot);
                        if (document.uri.toString() !== expected.toString()) {
                            return [];
                        }
                    }
                }
                else {
                    // New threads are authored only on plan-identified virtual
                    // targets. A file:// URI cannot retain pending ownership
                    // across a review switch, so accepting it could write into
                    // the newly active review by accident.
                    return [];
                }
                const lastLine = Math.max(0, document.lineCount - 1);
                const endColumn = document.lineAt(lastLine).range.end.character;
                return [new vscode.Range(0, 0, lastLine, endColumn)];
            },
        };
        this.controller.options = {
            prompt: 'Add Offline Review comment',
            placeHolder: 'Comment for the active Offline Review mode',
        };
    }
    setReviewableFiles(filePaths) {
        this.reviewableFiles.clear();
        for (const filePath of filePaths) {
            this.reviewableFiles.add(filePath);
        }
    }
    /** Load one file's threads only on the exact modified/right URI. */
    loadThreadsForFile(targetUri, filePath, plan = this.activePlan) {
        if (plan) {
            if (this.activePlan && this.activePlan !== plan) {
                return;
            }
            const expected = (0, gitService_1.getDiffDocumentUri)(plan.right, filePath, 'modified', plan.reviewId, plan.worktreeRoot);
            if (targetUri.toString() !== expected.toString()) {
                return;
            }
            this.activePlan = plan;
        }
        const comments = plan
            ? this.storageService.loadCommentsForReview(plan.reviewId)
            : this.storageService.loadComments();
        if (!comments) {
            return;
        }
        for (const thread of comments.threads) {
            if (!plan
                || !(0, types_1.isThreadCurrentForPlan)(thread, plan, filePath)) {
                continue;
            }
            const key = targetUri.scheme === 'file'
                ? thread.id
                : threadKey(thread.id, targetUri);
            this.createVscodeThread(plan.reviewId, targetUri, thread, key);
        }
    }
    /**
     * Replace all loaded threads using the exact target document in a prepared
     * plan. No branch equality or checked-out-branch inference is performed.
     */
    loadAllThreads(plan) {
        this.clearAllThreads();
        this.activePlan = plan;
        if (!plan) {
            return;
        }
        const comments = this.storageService.loadCommentsForReview(plan.reviewId);
        if (!comments || comments.threads.length === 0) {
            return;
        }
        for (const thread of comments.threads) {
            const target = thread.target;
            const targetUri = threadTargetUri(target, plan);
            this.createVscodeThread(plan.reviewId, targetUri, thread, threadKey(thread.id, targetUri));
        }
    }
    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri, filePath) {
        return this.requireCurrentCommentTarget(uri, filePath).reviewId;
    }
    createThread(uri, range, text, filePath, existingThread, expectedReviewId) {
        const plan = this.requireCurrentCommentTarget(uri, filePath);
        if (expectedReviewId && plan.reviewId !== expectedReviewId) {
            throw new Error('The active review changed before the comment was submitted');
        }
        const target = targetFromPlan(plan, filePath);
        const savedThread = this.storageService.addThread(plan.reviewId, target, filePath, range.start.line, range.end.line, text, os.userInfo().username);
        const key = uri.scheme === 'file' ? savedThread.id : threadKey(savedThread.id, uri);
        if (existingThread) {
            this.populateThread(existingThread, plan.reviewId, savedThread, key);
        }
        else {
            this.createVscodeThread(plan.reviewId, uri, savedThread, key);
        }
    }
    requireCurrentCommentTarget(uri, filePath) {
        const plan = this.activePlan;
        if (!plan) {
            throw new Error('No prepared review is active');
        }
        if (uri.scheme === 'git-local-review') {
            const expected = (0, gitService_1.getDiffDocumentUri)(plan.right, filePath, 'modified', plan.reviewId, plan.worktreeRoot);
            if (uri.toString() !== expected.toString()) {
                throw new Error('Comments can only be added to the prepared diff target');
            }
        }
        else {
            throw new Error('Comments can only be added to the prepared diff target');
        }
        return plan;
    }
    populateThread(thread, reviewId, savedThread, key) {
        this.removeOtherUris(savedThread.id, key);
        thread.comments = this.toVscodeComments(reviewId, savedThread);
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.applyThreadState(thread, savedThread);
        thread.__threadData = {
            reviewId,
            threadId: savedThread.id,
            filePath: savedThread.filePath,
            targetUri: thread.uri.toString(),
        };
        this.threads.set(key, thread);
    }
    createVscodeThread(reviewId, uri, savedThread, key = savedThread.id) {
        const existing = this.threads.get(key);
        if (existing) {
            existing.comments = this.toVscodeComments(reviewId, savedThread);
            this.applyThreadState(existing, savedThread);
            existing.__threadData = {
                reviewId,
                threadId: savedThread.id,
                filePath: savedThread.filePath,
                targetUri: uri.toString(),
            };
            return existing;
        }
        this.removeOtherUris(savedThread.id, key);
        const range = new vscode.Range(savedThread.startLine, 0, savedThread.endLine, 0);
        const thread = this.controller.createCommentThread(uri, range, []);
        thread.comments = this.toVscodeComments(reviewId, savedThread);
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.applyThreadState(thread, savedThread);
        thread.__threadData = {
            reviewId,
            threadId: savedThread.id,
            filePath: savedThread.filePath,
            targetUri: uri.toString(),
        };
        this.threads.set(key, thread);
        return thread;
    }
    removeOtherUris(threadId, retainedKey) {
        for (const [key, thread] of [...this.threads.entries()]) {
            if (key !== retainedKey && thread.__threadData?.threadId === threadId) {
                thread.dispose();
                this.threads.delete(key);
            }
        }
    }
    applyThreadState(thread, savedThread) {
        const resolved = savedThread.state === 'resolved';
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }
    toVscodeComments(reviewId, thread) {
        return thread.comments.map(comment => this.toVscodeComment(reviewId, thread.id, comment));
    }
    toVscodeComment(reviewId, threadId, comment) {
        const rendered = {
            body: new vscode.MarkdownString(comment.body),
            author: { name: comment.author },
            mode: vscode.CommentMode.Preview,
            contextValue: 'canEdit',
            timestamp: new Date(comment.timestamp),
            label: undefined,
        };
        this.commentIdentities.set(rendered, {
            reviewId,
            threadId,
            commentId: comment.id,
        });
        return rendered;
    }
    resolveThread(thread) {
        const managed = thread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.resolveThread(managed.__threadData.reviewId, managed.__threadData.threadId)) {
            thread.state = vscode.CommentThreadState.Resolved;
            thread.label = 'Resolved';
            thread.contextValue = 'resolved';
        }
    }
    unresolveThread(thread) {
        const managed = thread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.unresolveThread(managed.__threadData.reviewId, managed.__threadData.threadId)) {
            thread.state = vscode.CommentThreadState.Unresolved;
            thread.label = undefined;
            thread.contextValue = 'unresolved';
        }
    }
    addReply(thread, text) {
        const managed = thread;
        if (!managed.__threadData) {
            return;
        }
        const comment = this.storageService.addReplyToThread(managed.__threadData.reviewId, managed.__threadData.threadId, text, os.userInfo().username);
        if (comment) {
            thread.comments = [
                ...thread.comments,
                this.toVscodeComment(managed.__threadData.reviewId, managed.__threadData.threadId, comment),
            ];
        }
    }
    saveEditedComment(thread, comment, newBody) {
        const managed = thread;
        const threadData = managed.__threadData;
        const identity = this.commentIdentities.get(comment);
        if (!threadData
            || !identity
            || identity.reviewId !== threadData.reviewId
            || identity.threadId !== threadData.threadId) {
            return;
        }
        if (!this.storageService.editComment(identity.reviewId, identity.threadId, identity.commentId, newBody)) {
            return;
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            thread.comments = this.toVscodeComments(identity.reviewId, refreshed);
        }
    }
    deleteComment(thread, comment) {
        const managed = thread;
        const threadData = managed.__threadData;
        const identity = this.commentIdentities.get(comment);
        if (!threadData
            || !identity
            || identity.reviewId !== threadData.reviewId
            || identity.threadId !== threadData.threadId) {
            return;
        }
        const storedThread = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (!storedThread
            || !storedThread.comments.some(candidate => candidate.id === identity.commentId)) {
            return;
        }
        const removingLast = storedThread.comments.length === 1;
        if (!this.storageService.deleteComment(identity.reviewId, identity.threadId, identity.commentId)) {
            return;
        }
        if (removingLast) {
            this.disposeThread(managed);
            return;
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        thread.comments = refreshed
            ? this.toVscodeComments(identity.reviewId, refreshed)
            : thread.comments.filter(candidate => candidate !== comment);
    }
    disposeThread(thread) {
        const threadId = thread.__threadData?.threadId;
        for (const [key, candidate] of [...this.threads.entries()]) {
            if (candidate === thread || (threadId && candidate.__threadData?.threadId === threadId)) {
                candidate.dispose();
                this.threads.delete(key);
            }
        }
    }
    findThreadForComment(comment) {
        const withParent = comment;
        const parent = withParent.parent ?? withParent.thread;
        if (parent) {
            const managedParent = parent;
            if (managedParent.__threadData || [...this.threads.values()].includes(managedParent)) {
                return parent;
            }
        }
        const identity = this.commentIdentities.get(comment);
        if (identity) {
            for (const thread of this.threads.values()) {
                if (thread.__threadData?.reviewId === identity.reviewId
                    && thread.__threadData.threadId === identity.threadId) {
                    return thread;
                }
            }
        }
        for (const thread of this.threads.values()) {
            if (thread.comments.includes(comment)) {
                return thread;
            }
        }
        for (const thread of this.threads.values()) {
            if (thread.comments.some(candidate => commentBody(candidate) === commentBody(comment)
                && candidate.author.name === comment.author.name)) {
                return thread;
            }
        }
        return undefined;
    }
    clearAllThreads() {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }
    dispose() {
        this.clearAllThreads();
        this.controller.dispose();
    }
}
exports.ReviewCommentController = ReviewCommentController;
function threadKey(threadId, uri) {
    return `${threadId}::${uri.toString()}`;
}
function uriFilePath(uri) {
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}
function commentBody(comment) {
    return typeof comment.body === 'string' ? comment.body : comment.body.value;
}
function targetFromPlan(plan, filePath) {
    return plan.kind === 'branch'
        ? { kind: 'git', ref: plan.targetCommit, filePath }
        : {
            kind: 'worktree',
            reviewId: plan.reviewId,
            headCommit: plan.headCommit,
            planId: plan.planId,
            filePath,
        };
}
function threadTargetUri(target, plan) {
    const currentWorktreeTarget = target.kind === 'worktree'
        && plan.kind === 'worktree'
        && target.reviewId === plan.reviewId
        && target.headCommit === plan.headCommit;
    const document = target.kind === 'git'
        ? { kind: 'git', ref: target.ref }
        : {
            kind: 'worktree',
            reviewId: plan.reviewId,
            headCommit: target.headCommit,
            // The URI nonce changes on refresh to invalidate VS Code's cache,
            // while same-HEAD comments remain attached to the current document.
            planId: currentWorktreeTarget ? plan.planId : target.planId,
            // The persisted schema intentionally remains unchanged. During this
            // activation, thread documents use the prepared checkout identity.
            worktreeRoot: plan.worktreeRoot,
        };
    return (0, gitService_1.getDiffDocumentUri)(document, target.filePath, 'modified', plan.reviewId, plan.worktreeRoot);
}
//# sourceMappingURL=commentController.js.map