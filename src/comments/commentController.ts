import * as vscode from 'vscode';
import { AuthorIdentity } from '../authorIdentity';
import { StorageService } from '../storage/storageService';
import {
    DiffPlan,
    PreparedReviewCommentState,
    ReviewComment,
    ReviewThread,
    ReviewThreadProjection,
    ReviewThreadTarget,
} from '../types';
import { getDiffDocumentUri } from '../git/gitService';
import { isEffectiveReviewProjection, ReviewAnchorResolver } from './reviewAnchorResolver';

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

/** Stable ids mirrored onto the comment for hosts that re-wrap objects. */
interface IdentifiedComment extends vscode.Comment {
    __offlineReviewId?: string;
    __offlineThreadId?: string;
    __offlineCommentId?: string;
}

export class ReviewCommentController {
    private readonly controller: vscode.CommentController;
    private readonly threads = new Map<string, ManagedCommentThread>();
    private readonly commentIdentities = new WeakMap<vscode.Comment, CommentIdentity>();
    private readonly reviewableFiles = new Set<string>();
    private readonly originalSideFiles = new Set<string>();
    private activePlan: DiffPlan | undefined;

    constructor(
        private readonly storageService: StorageService,
        private readonly anchorResolver?: ReviewAnchorResolver,
        private readonly authorIdentity: AuthorIdentity = new AuthorIdentity()
    ) {
        this.controller = vscode.comments.createCommentController(
            'localPrReview',
            'Offline Review'
        );

        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => {
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

    setReviewableFiles(
        filePaths: readonly string[],
        originalSideFilePaths: readonly string[] = []
    ): void {
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

    async pickFileComment(uri: vscode.Uri): Promise<vscode.CommentThread | undefined> {
        const candidates = [...this.threads.entries()]
            .filter(([, thread]) => thread.uri.toString() === uri.toString() && thread.range)
            .sort(([, left], [, right]) => left.range!.start.line - right.range!.start.line)
            .map(([key, thread]) => {
                const body = thread.comments[0]?.body;
                return {
                    label: (typeof body === 'string' ? body : body?.value ?? '')
                        .replace(/\s+/g, ' ').trim() || 'Comment',
                    description: `Line ${thread.range!.start.line + 1} - ${
                        thread.state === vscode.CommentThreadState.Resolved ? 'resolved' : 'unresolved'
                    }`,
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

    private currentTargetUri(plan: DiffPlan, filePath: string): vscode.Uri {
        const original = this.originalSideFiles.has(filePath);
        return getDiffDocumentUri(
            original ? plan.left : plan.right,
            filePath,
            original ? 'original' : 'modified',
            plan.reviewId,
            plan.worktreeRoot
        );
    }

    /** Load one file's threads only on its exact reviewable diff side. */
    loadThreadsForFile(targetUri: vscode.Uri, filePath: string, plan: DiffPlan | undefined = this.activePlan): void {
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
            if (!isEffectiveReviewProjection(projection)
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
    loadAllThreads(
        plan?: DiffPlan,
        preparedState?: PreparedReviewCommentState
    ): void {
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
            if (!isEffectiveReviewProjection(projection)
                || projection.effectiveStartLine === undefined
                || projection.effectiveEndLine === undefined
                || !projection.currentPlanUri) {
                continue;
            }
            const targetUri = vscode.Uri.parse(projection.currentPlanUri);
            this.createVscodeThread(
                plan.reviewId,
                targetUri,
                projection,
                threadKey(projection.thread.id, targetUri)
            );
        }
    }

    /** Capture ownership before opening any delayed new-comment UI. */
    captureNewThreadReviewId(uri: vscode.Uri, filePath: string): string {
        return this.requireCurrentCommentTarget(uri, filePath).reviewId;
    }

    async createThread(
        uri: vscode.Uri,
        range: vscode.Range,
        text: string,
        filePath: string,
        existingThread?: vscode.CommentThread,
        expectedReviewId?: string,
        capturedDocument?: vscode.TextDocument
    ): Promise<void> {
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
        const savedThread = this.storageService.addThread(
            plan.reviewId,
            target,
            filePath,
            range.start.line,
            range.end.line,
            text,
            this.authorIdentity.get(),
            sourceAnchor
        );
        const projection = projectionForNewThread(plan, savedThread, uri, side);
        this.anchorResolver?.addCurrentProjection(plan, projection);
        const key = threadKey(savedThread.id, uri);
        if (existingThread) {
            this.populateThread(
                existingThread as ManagedCommentThread,
                plan.reviewId,
                savedThread,
                key
            );
            existingThread.range = new vscode.Range(
                range.start.line,
                0,
                range.end.line,
                0
            );
        } else {
            this.createVscodeThread(plan.reviewId, uri, projection, key);
        }
    }

    private requireCurrentCommentTarget(uri: vscode.Uri, filePath: string): DiffPlan {
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
        projection: ReviewThreadProjection,
        key: string = projection.thread.id
    ): ManagedCommentThread {
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
        const identity: CommentIdentity = {
            reviewId,
            threadId,
            commentId: comment.id,
        };
        const rendered: IdentifiedComment = {
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

    private resolveCommentIdentity(
        comment: vscode.Comment,
        threadData: ThreadData | undefined
    ): CommentIdentity | undefined {
        const fromMap = this.commentIdentities.get(comment);
        if (fromMap
            && (!threadData
                || (fromMap.reviewId === threadData.reviewId
                    && fromMap.threadId === threadData.threadId))) {
            return fromMap;
        }
        const tagged = comment as IdentifiedComment;
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

    resolveThread(thread: vscode.CommentThread): void {
        const managed = thread as ManagedCommentThread;
        if (!managed.__threadData) {
            return;
        }
        if (this.storageService.resolveThread(
            managed.__threadData.reviewId,
            managed.__threadData.threadId
        )) {
            this.anchorResolver?.updateThread(
                managed.__threadData.reviewId,
                managed.__threadData.threadId,
                saved => ({ ...saved, state: 'resolved' })
            );
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
            this.anchorResolver?.updateThread(
                managed.__threadData.reviewId,
                managed.__threadData.threadId,
                saved => ({ ...saved, state: 'unresolved' })
            );
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
            this.authorIdentity.get()
        );
        if (comment) {
            this.anchorResolver?.updateThread(
                managed.__threadData.reviewId,
                managed.__threadData.threadId,
                saved => ({ ...saved, comments: [...saved.comments, comment] })
            );
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
        const identity = this.resolveCommentIdentity(comment, threadData);
        if (!threadData || !identity) {
            throw new Error('Could not match the edited comment to stored review data');
        }

        if (!this.storageService.editComment(
            identity.reviewId,
            identity.threadId,
            identity.commentId,
            newBody
        )) {
            throw new Error('Could not save the edited comment');
        }
        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            this.anchorResolver?.updateThread(
                identity.reviewId,
                identity.threadId,
                () => refreshed
            );
            thread.comments = this.toVscodeComments(identity.reviewId, refreshed);
        }
    }

    /** Reload thread comments from storage, discarding in-progress edit UI state. */
    discardCommentEdits(thread: vscode.CommentThread): void {
        const managed = thread as ManagedCommentThread;
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

    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void {
        const managed = thread as ManagedCommentThread;
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
        if (!this.storageService.deleteComment(
            identity.reviewId,
            identity.threadId,
            identity.commentId
        )) {
            return;
        }
        if (removingLast) {
            this.anchorResolver?.updateThread(
                identity.reviewId,
                identity.threadId,
                () => undefined
            );
            this.disposeThread(managed);
            return;
        }

        const refreshed = this.storageService
            .loadCommentsForReview(identity.reviewId)?.threads
            .find(candidate => candidate.id === identity.threadId);
        if (refreshed) {
            this.anchorResolver?.updateThread(
                identity.reviewId,
                identity.threadId,
                () => refreshed
            );
        }
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

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const target = uri.toString();
    return vscode.workspace.textDocuments.find(document =>
        document.uri.toString() === target
    );
}

function uriFilePath(uri: vscode.Uri): string {
    return uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
}

function commentBody(comment: vscode.Comment): string {
    return typeof comment.body === 'string' ? comment.body : comment.body.value;
}

function targetFromPlan(
    plan: DiffPlan,
    filePath: string,
    side: 'original' | 'modified'
): ReviewThreadTarget {
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

function projectionForNewThread(
    plan: DiffPlan,
    thread: ReviewThread,
    uri: vscode.Uri,
    side: 'original' | 'modified'
): ReviewThreadProjection {
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

function anchorFromDocument(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number
): string {
    const lines: string[] = [];
    for (let line = startLine; line <= endLine; line++) {
        lines.push(document.lineAt(line).text);
    }
    return lines.join('\n');
}
