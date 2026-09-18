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
const authorIdentity_1 = require("../authorIdentity");
const gitService_1 = require("../git/gitService");
const reviewAnchorResolver_1 = require("./reviewAnchorResolver");
class ReviewCommentController {
    constructor(storageService, anchorResolver, authorIdentity = new authorIdentity_1.AuthorIdentity()) {
        this.storageService = storageService;
        this.anchorResolver = anchorResolver;
        this.authorIdentity = authorIdentity;
        this.threads = new Map();
        this.commentIdentities = new WeakMap();
        this.reviewableFiles = new Set();
        this.originalSideFiles = new Set();
        this.controller = vscode.comments.createCommentController('localPrReview', 'Offline Review');
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                const plan = this.activePlan;
                if (document.uri.scheme !== 'git-local-review' || !plan) {
                    // New threads are authored only on plan-identified virtual
                    // targets. A file:// URI cannot retain pending ownership
                    // across a review switch, so accepting it could write into
                    // the newly active review by accident.
                    return [];
                }
                const filePath = uriFilePath(document.uri);
                if (!this.reviewableFiles.has(filePath)
                    || document.uri.toString() !== this.currentTargetUri(plan, filePath).toString()) {
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
    setReviewableFiles(filePaths, originalSideFilePaths = []) {
        this.reviewableFiles.clear();
        this.originalSideFiles.clear();
        for (const filePath of filePaths) {
            this.reviewableFiles.add(filePath);
        }
        for (const filePath of originalSideFilePaths) {
            if (this.reviewableFiles.has(filePath)) {
                this.originalSideFiles.add(filePath);
            }
        }
    }
    async pickFileComment(uri) {
        const candidates = [...this.threads.entries()]
            .filter(([, thread]) => thread.uri.toString() === uri.toString() && thread.range)
            .sort(([, left], [, right]) => left.range.start.line - right.range.start.line)
            .map(([key, thread]) => {
            const body = thread.comments[0]?.body;
            return {
                label: (typeof body === 'string' ? body : body?.value ?? '')
                    .replace(/\s+/g, ' ').trim() || 'Comment',
                description: `Line ${thread.range.start.line + 1} - ${thread.state === vscode.CommentThreadState.Resolved ? 'resolved' : 'unresolved'}`,
                key,
                thread,
            };
        });
        if (candidates.length === 0) {
            vscode.window.showInformationMessage('No review comments anchored in this file.');
            return undefined;
        }
        const selected = await vscode.window.showQuickPick(candidates, {
            placeHolder: 'Jump to a comment in this file',
            matchOnDescription: true,
        });
        // A refresh or review deletion can replace the threads while the picker is open.
        return selected && this.threads.get(selected.key) === selected.thread
            ? selected.thread
            : undefined;
    }
    currentTargetUri(plan, filePath) {
        const original = this.originalSideFiles.has(filePath);
        return (0, gitService_1.getDiffDocumentUri)(original ? plan.left : plan.right, filePath, original ? 'original' : 'modified', plan.reviewId, plan.worktreeRoot);
    }
    /** Load one file's threads only on its exact reviewable diff side. */
    loadThreadsForFile(targetUri, filePath, plan = this.activePlan) {
        if (plan) {
            if (this.activePlan !== plan) {
                return;
            }
            const expected = this.currentTargetUri(plan, filePath);
            if (targetUri.toString() !== expected.toString()) {
                return;
            }
            this.activePlan = plan;
        }
        if (!plan) {
            return;
        }
        const state = this.anchorResolver?.getAppliedState(plan);
        if (!state) {
            return;
        }
        for (const projection of state.projections) {
            if (!(0, reviewAnchorResolver_1.isEffectiveReviewProjection)(projection)
                || projection.thread.filePath !== filePath
                || projection.currentPlanUri !== targetUri.toString()) {
                continue;
            }
            const key = threadKey(projection.thread.id, targetUri);
            this.createVscodeThread(plan.reviewId, targetUri, projection, key);
        }
    }
    /**
     * Replace all loaded threads using the exact target document in a prepared
     * plan. No branch equality or checked-out-branch inference is performed.
     */
    loadAllThreads(plan, preparedState) {
        this.clearAllThreads();
        this.activePlan = plan;
        if (!plan) {
            return;
        }
        const state = preparedState ?? this.anchorResolver?.getAppliedState(plan);
        if (!state
            || state.plan.reviewId !== plan.reviewId
            || (this.anchorResolver
                && this.anchorResolver.getAppliedState(plan) !== state)) {
            return;
        }
        for (const projection of state.projections) {
            if (!(0, reviewAnchorResolver_1.isEffectiveReviewProjection)(projection)
                || projection.effectiveStartLine === undefined
                || projection.effectiveEndLine === undefined
                || !projection.currentPlanUri) {
                continue;
            }
            const targetUri = vscode.Uri.parse(projection.currentPlanUri);
            this.createVscodeThread(plan.reviewId, targetUri, projection, threadKey(projection.thread.id, targetUri));
        }
    }
    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri, filePath) {
        return this.requireCurrentCommentTarget(uri, filePath).reviewId;
    }
    async createThread(uri, range, text, filePath, existingThread, expectedReviewId, capturedDocument) {
        const plan = this.requireCurrentCommentTarget(uri, filePath);
        if (expectedReviewId && plan.reviewId !== expectedReviewId) {
            throw new Error('The active review changed before the comment was submitted');
        }
        const side = this.originalSideFiles.has(filePath) ? 'original' : 'modified';
        const target = targetFromPlan(plan, filePath, side);
        const document = capturedDocument
            ?? findOpenDocument(uri)
            ?? await vscode.workspace.openTextDocument(uri);
        const currentPlan = this.requireCurrentCommentTarget(uri, filePath);
        if (currentPlan !== plan
            || (expectedReviewId && currentPlan.reviewId !== expectedReviewId)
            || document.uri.toString() !== uri.toString()) {
            throw new Error('The active review changed before the comment was submitted');
        }
        if (range.start.line < 0 || range.end.line < range.start.line
            || range.end.line >= document.lineCount) {
            throw new Error('The selected review comment range is no longer valid');
        }
        const sourceAnchor = anchorFromDocument(document, range.start.line, range.end.line);
        const savedThread = this.storageService.addThread(plan.reviewId, target, filePath, range.start.line, range.end.line, text, this.authorIdentity.get(), sourceAnchor);
        const projection = projectionForNewThread(plan, savedThread, uri, side);
        this.anchorResolver?.addCurrentProjection(plan, projection);
        const key = threadKey(savedThread.id, uri);
        if (existingThread) {
            this.populateThread(existingThread, plan.reviewId, savedThread, key);
            existingThread.range = new vscode.Range(range.start.line, 0, range.end.line, 0);
        }
        else {
            this.createVscodeThread(plan.reviewId, uri, projection, key);
        }
    }
    requireCurrentCommentTarget(uri, filePath) {
        const plan = this.activePlan;
        if (!plan) {
            throw new Error('No prepared review is active');
        }
        if (uri.scheme === 'git-local-review') {
            const expected = this.currentTargetUri(plan, filePath);
            if (!this.reviewableFiles.has(filePath)
                || uri.toString() !== expected.toString()) {
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
    createVscodeThread(reviewId, uri, projection, key = projection.thread.id) {
        const savedThread = projection.thread;
        const startLine = projection.effectiveStartLine;
        const endLine = projection.effectiveEndLine;
        if (startLine === undefined || endLine === undefined) {
            throw new Error('Cannot render a review comment without an effective range');
        }
        const existing = this.threads.get(key);
        if (existing) {
            existing.comments = this.toVscodeComments(reviewId, savedThread);
            existing.range = new vscode.Range(startLine, 0, endLine, 0);
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
        const range = new vscode.Range(startLine, 0, endLine, 0);
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
        const identity = {
            reviewId,
            threadId,
            commentId: comment.id,
        };
        const rendered = {
            body: new vscode.MarkdownString(comment.body),
            author: { name: comment.author },
            mode: vscode.CommentMode.Preview,
            contextValue: 'canEdit',
            timestamp: new Date(comment.timestamp),
            label: undefined,
            __offlineReviewId: reviewId,
            __offlineThreadId: threadId,
            __offlineCommentId: comment.id,
        };
        this.commentIdentities.set(rendered, identity);
        return rendered;
    }
    resolveCommentIdentity(comment, threadData) {
        const fromMap = this.commentIdentities.get(comment);
        if (fromMap
            && (!threadData
                || (fromMap.reviewId === threadData.reviewId
                    && fromMap.threadId === threadData.threadId))) {
            return fromMap;
        }
        const tagged = comment;
        if (tagged.__offlineCommentId
            && tagged.__offlineThreadId
            && tagged.__offlineReviewId
            && (!threadData
                || (tagged.__offlineReviewId === threadData.reviewId
                    && tagged.__offlineThreadId === threadData.threadId))) {
            return {
                reviewId: tagged.__offlineReviewId,
                threadId: tagged.__offlineThreadId,
                commentId: tagged.__offlineCommentId,
            };
        }
        return undefined;
    }
    resolveThread(thread) {
        const managed = thread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.resolveThread(managed.__threadData.reviewId, managed.__threadData.threadId)) {
            this.anchorResolver?.updateThread(managed.__threadData.reviewId, managed.__threadData.threadId, saved => ({ ...saved, state: 'resolved' }));
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
            this.anchorResolver?.updateThread(managed.__threadData.reviewId, managed.__threadData.threadId, saved => ({ ...saved, state: 'unresolved' }));
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
        const comment = this.storageService.addReplyToThread(managed.__threadData.reviewId, managed.__threadData.threadId, text, this.authorIdentity.get());
        if (comment) {
            this.anchorResolver?.updateThread(managed.__threadData.reviewId, managed.__threadData.threadId, saved => ({ ...saved, comments: [...saved.comments, comment] }));
            thread.comments = [
                ...thread.comments,
                this.toVscodeComment(managed.__threadData.reviewId, managed.__threadData.threadId, comment),
            ];
        }
    }
    saveEditedComment(thread, comment, newBody) {
        const managed = thread;
        const threadData = managed.__threadData;
        const identity = this.resolveCommentIdentity(comment, threadData);
        if (!threadData || !identity) {
            throw new Error('Could not match the edited comment to stored review data');
        }
        if (!this.storageService.editComment(identity.reviewId, identity.threadId, identity.commentId, newBody)) {
            throw new Error('Could not save the edited comment');
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            this.anchorResolver?.updateThread(identity.reviewId, identity.threadId, () => refreshed);
            thread.comments = this.toVscodeComments(identity.reviewId, refreshed);
        }
    }
    /** Reload thread comments from storage, discarding in-progress edit UI state. */
    discardCommentEdits(thread) {
        const managed = thread;
        const threadData = managed.__threadData;
        if (!threadData) {
            return;
        }
        const refreshed = this.storageService
            .loadCommentsForReview(threadData.reviewId)?.threads
            .find(candidate => candidate.id === threadData.threadId);
        if (refreshed) {
            thread.comments = this.toVscodeComments(threadData.reviewId, refreshed);
        }
    }
    deleteComment(thread, comment) {
        const managed = thread;
        const threadData = managed.__threadData;
        const identity = this.resolveCommentIdentity(comment, threadData);
        if (!threadData || !identity) {
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
            this.anchorResolver?.updateThread(identity.reviewId, identity.threadId, () => undefined);
            this.disposeThread(managed);
            return;
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            this.anchorResolver?.updateThread(identity.reviewId, identity.threadId, () => refreshed);
        }
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
        const identity = this.resolveCommentIdentity(comment, undefined);
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
function findOpenDocument(uri) {
    const target = uri.toString();
    return vscode.workspace.textDocuments.find(document => document.uri.toString() === target);
}
function uriFilePath(uri) {
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}
function commentBody(comment) {
    return typeof comment.body === 'string' ? comment.body : comment.body.value;
}
function targetFromPlan(plan, filePath, side) {
    if (side === 'original') {
        return {
            kind: 'git',
            ref: plan.kind === 'branch' ? plan.mergeBaseCommit : plan.headCommit,
            side,
            filePath,
        };
    }
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
function projectionForNewThread(plan, thread, uri, side) {
    return {
        reviewId: plan.reviewId,
        thread,
        side,
        anchorStatus: 'current',
        effectiveStartLine: thread.startLine,
        effectiveEndLine: thread.endLine,
        matches: [{ startLine: thread.startLine, endLine: thread.endLine }],
        currentPlanUri: uri.toString(),
    };
}
function anchorFromDocument(document, startLine, endLine) {
    const lines = [];
    for (let line = startLine; line <= endLine; line++) {
        lines.push(document.lineAt(line).text);
    }
    return lines.join('\n');
}
//# sourceMappingURL=commentController.js.map