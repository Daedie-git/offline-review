import * as vscode from 'vscode';
import * as os from 'os';
import { StorageService } from '../storage/storageService';
import {
    DiffPlan,
    isThreadCurrentForPlan,
    ReviewComment,
    ReviewThread,
    ReviewThreadTarget,
} from '../types';
import { getDiffDocumentUri } from '../git/gitService';

interface ThreadData {
    readonly reviewId: string;
    readonly threadId: string;
    readonly filePath: string;
    readonly targetUri: string;
}

interface ManagedCommentThread extends vscode.CommentThread {
    __threadData?: ThreadData;
}

interface CommentWithParent extends vscode.Comment {
    parent?: vscode.CommentThread;
    thread?: vscode.CommentThread;
}

interface CommentIdentity {
    readonly reviewId: string;
    readonly threadId: string;
    readonly commentId: string;
}

export class ReviewCommentController {
    private readonly controller: vscode.CommentController;
    private readonly threads = new Map<string, ManagedCommentThread>();
    private readonly commentIdentities = new WeakMap<vscode.Comment, CommentIdentity>();
    private readonly reviewableFiles = new Set<string>();
    private activePlan: DiffPlan | undefined;

    constructor(private readonly storageService: StorageService) {
        this.controller = vscode.comments.createCommentController(
            'localPrReview',
            'Offline Review'
        );

        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => {
                if (document.uri.scheme === 'git-local-review') {
                    const params = new URLSearchParams(document.uri.query);
                    if (params.get('side') !== 'modified') {
                        return [];
                    }
                    if (this.activePlan) {
                        const filePath = uriFilePath(document.uri);
                        const expected = getDiffDocumentUri(
                            this.activePlan.right,
                            filePath,
                            'modified',
                            this.activePlan.reviewId,
                            this.activePlan.worktreeRoot
                        );
                        if (document.uri.toString() !== expected.toString()) {
                            return [];
                        }
                    }
                } else {
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

    setReviewableFiles(filePaths: readonly string[]): void {
        this.reviewableFiles.clear();
        for (const filePath of filePaths) {
            this.reviewableFiles.add(filePath);
        }
    }

    /** Load one file's threads only on the exact modified/right URI. */
    loadThreadsForFile(targetUri: vscode.Uri, filePath: string, plan: DiffPlan | undefined = this.activePlan): void {
        if (plan) {
            if (this.activePlan && this.activePlan !== plan) {
                return;
            }
            const expected = getDiffDocumentUri(
                plan.right,
                filePath,
                'modified',
                plan.reviewId,
                plan.worktreeRoot
            );
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
                || !isThreadCurrentForPlan(thread, plan, filePath)) {
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
    loadAllThreads(plan?: DiffPlan): void {
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
            this.createVscodeThread(
                plan.reviewId,
                targetUri,
                thread,
                threadKey(thread.id, targetUri)
            );
        }
    }

    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri: vscode.Uri, filePath: string): string {
        return this.requireCurrentCommentTarget(uri, filePath).reviewId;
    }

    createThread(
        uri: vscode.Uri,
        range: vscode.Range,
        text: string,
        filePath: string,
        existingThread?: vscode.CommentThread,
        expectedReviewId?: string
    ): void {
        const plan = this.requireCurrentCommentTarget(uri, filePath);
        if (expectedReviewId && plan.reviewId !== expectedReviewId) {
            throw new Error('The active review changed before the comment was submitted');
        }
        const target = targetFromPlan(plan, filePath);
        const savedThread = this.storageService.addThread(
            plan.reviewId,
            target,
            filePath,
            range.start.line,
            range.end.line,
            text,
            os.userInfo().username
        );
        const key = uri.scheme === 'file' ? savedThread.id : threadKey(savedThread.id, uri);
        if (existingThread) {
            this.populateThread(
                existingThread as ManagedCommentThread,
                plan.reviewId,
                savedThread,
                key
            );
        } else {
            this.createVscodeThread(plan.reviewId, uri, savedThread, key);
        }
    }

    private requireCurrentCommentTarget(uri: vscode.Uri, filePath: string): DiffPlan {
        const plan = this.activePlan;
        if (!plan) {
            throw new Error('No prepared review is active');
        }
        if (uri.scheme === 'git-local-review') {
            const expected = getDiffDocumentUri(
                plan.right,
                filePath,
                'modified',
                plan.reviewId,
                plan.worktreeRoot
            );
            if (uri.toString() !== expected.toString()) {
                throw new Error('Comments can only be added to the prepared diff target');
            }
        } else {
            throw new Error('Comments can only be added to the prepared diff target');
        }
        return plan;
    }

    private populateThread(
        thread: ManagedCommentThread,
        reviewId: string,
        savedThread: ReviewThread,
        key: string
    ): void {
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

    private createVscodeThread(
        reviewId: string,
        uri: vscode.Uri,
        savedThread: ReviewThread,
        key: string = savedThread.id
    ): ManagedCommentThread {
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
        const thread = this.controller.createCommentThread(uri, range, []) as ManagedCommentThread;
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

    private removeOtherUris(threadId: string, retainedKey: string): void {
        for (const [key, thread] of [...this.threads.entries()]) {
            if (key !== retainedKey && thread.__threadData?.threadId === threadId) {
                thread.dispose();
                this.threads.delete(key);
            }
        }
    }

    private applyThreadState(thread: vscode.CommentThread, savedThread: ReviewThread): void {
        const resolved = savedThread.state === 'resolved';
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }

    private toVscodeComments(reviewId: string, thread: ReviewThread): vscode.Comment[] {
        return thread.comments.map(comment =>
            this.toVscodeComment(reviewId, thread.id, comment)
        );
    }

    private toVscodeComment(
        reviewId: string,
        threadId: string,
        comment: ReviewComment
    ): vscode.Comment {
        const rendered: vscode.Comment = {
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

    resolveThread(thread: vscode.CommentThread): void {
        const managed = thread as ManagedCommentThread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.resolveThread(
            managed.__threadData.reviewId,
            managed.__threadData.threadId
        )) {
            thread.state = vscode.CommentThreadState.Resolved;
            thread.label = 'Resolved';
            thread.contextValue = 'resolved';
        }
    }

    unresolveThread(thread: vscode.CommentThread): void {
        const managed = thread as ManagedCommentThread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.unresolveThread(
            managed.__threadData.reviewId,
            managed.__threadData.threadId
        )) {
            thread.state = vscode.CommentThreadState.Unresolved;
            thread.label = undefined;
            thread.contextValue = 'unresolved';
        }
    }

    addReply(thread: vscode.CommentThread, text: string): void {
        const managed = thread as ManagedCommentThread;
        if (!managed.__threadData) {
            return;
        }
        const comment = this.storageService.addReplyToThread(
            managed.__threadData.reviewId,
            managed.__threadData.threadId,
            text,
            os.userInfo().username
        );
        if (comment) {
            thread.comments = [
                ...thread.comments,
                this.toVscodeComment(
                    managed.__threadData.reviewId,
                    managed.__threadData.threadId,
                    comment
                ),
            ];
        }
    }

    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, newBody: string): void {
        const managed = thread as ManagedCommentThread;
        const threadData = managed.__threadData;
        const identity = this.commentIdentities.get(comment);
        if (!threadData
            || !identity
            || identity.reviewId !== threadData.reviewId
            || identity.threadId !== threadData.threadId) {
            return;
        }

        if (!this.storageService.editComment(
            identity.reviewId,
            identity.threadId,
            identity.commentId,
            newBody
        )) {
            return;
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            thread.comments = this.toVscodeComments(identity.reviewId, refreshed);
        }
    }

    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void {
        const managed = thread as ManagedCommentThread;
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
        if (!this.storageService.deleteComment(
            identity.reviewId,
            identity.threadId,
            identity.commentId
        )) {
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

    private disposeThread(thread: ManagedCommentThread): void {
        const threadId = thread.__threadData?.threadId;
        for (const [key, candidate] of [...this.threads.entries()]) {
            if (candidate === thread || (threadId && candidate.__threadData?.threadId === threadId)) {
                candidate.dispose();
                this.threads.delete(key);
            }
        }
    }

    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined {
        const withParent = comment as CommentWithParent;
        const parent = withParent.parent ?? withParent.thread;
        if (parent) {
            const managedParent = parent as ManagedCommentThread;
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
            if (thread.comments.some(candidate =>
                commentBody(candidate) === commentBody(comment)
                && candidate.author.name === comment.author.name
            )) {
                return thread;
            }
        }
        return undefined;
    }

    private clearAllThreads(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
    }

    dispose(): void {
        this.clearAllThreads();
        this.controller.dispose();
    }
}

function threadKey(threadId: string, uri: vscode.Uri): string {
    return `${threadId}::${uri.toString()}`;
}

function uriFilePath(uri: vscode.Uri): string {
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}

function commentBody(comment: vscode.Comment): string {
    return typeof comment.body === 'string' ? comment.body : comment.body.value;
}

function targetFromPlan(plan: DiffPlan, filePath: string): ReviewThreadTarget {
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

function threadTargetUri(target: ReviewThreadTarget, plan: DiffPlan): vscode.Uri {
    const currentWorktreeTarget = target.kind === 'worktree'
        && plan.kind === 'worktree'
        && target.reviewId === plan.reviewId
        && target.headCommit === plan.headCommit;
    const document = target.kind === 'git'
        ? { kind: 'git' as const, ref: target.ref }
        : {
            kind: 'worktree' as const,
            reviewId: plan.reviewId,
            headCommit: target.headCommit,
            // The URI nonce changes on refresh to invalidate VS Code's cache,
            // while same-HEAD comments remain attached to the current document.
            planId: currentWorktreeTarget ? plan.planId : target.planId,
            // The persisted schema intentionally remains unchanged. During this
            // activation, thread documents use the prepared checkout identity.
            worktreeRoot: plan.worktreeRoot,
        };
    return getDiffDocumentUri(
        document,
        target.filePath,
        'modified',
        plan.reviewId,
        plan.worktreeRoot
    );
}
