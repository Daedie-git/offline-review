import * as vscode from 'vscode';
import { AuthorIdentity } from '../authorIdentity';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceComment, WorkspaceCommentThread, WorkspaceThreadReport } from './types';

interface ManagedThread extends vscode.CommentThread {
    __workspaceThreadId?: string;
}

interface CommentIdentity {
    readonly threadId: string;
    readonly commentId: string;
}

interface CommentWithParent extends vscode.Comment {
    parent?: vscode.CommentThread;
    thread?: vscode.CommentThread;
}

/** Stable ids mirrored onto the comment for hosts that re-wrap objects. */
interface IdentifiedComment extends vscode.Comment {
    __offlineThreadId?: string;
    __offlineCommentId?: string;
}

export class WorkspaceCommentController {
    private readonly controller: vscode.CommentController;
    private readonly commentingRangeProvider: vscode.CommentingRangeProvider;
    private readonly threads = new Map<string, ManagedThread>();
    private readonly commentIdentities = new WeakMap<vscode.Comment, CommentIdentity>();

    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver,
        private readonly authorIdentity: AuthorIdentity = new AuthorIdentity()
    ) {
        this.controller = vscode.comments.createCommentController(
            'localCodeComments',
            'Offline Review Code Comments'
        );
        this.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument): vscode.Range[] => {
                if (!this.pathResolver.resolveUri(document.uri)) {
                    return [];
                }
                const lastLine = Math.max(0, document.lineCount - 1);
                return [new vscode.Range(
                    0,
                    0,
                    lastLine,
                    document.lineAt(lastLine).range.end.character
                )];
            },
        };
        this.controller.commentingRangeProvider = this.commentingRangeProvider;
        this.controller.options = {
            prompt: 'Add workspace code comment',
            placeHolder: 'Comment on this workspace code',
        };
    }

    /**
     * Republishes the provider so hosts recompute commentable ranges for the
     * current editor. Cursor can otherwise retain an empty range cache after
     * activation or a same-version extension reload.
     */
    refreshCommentingRanges(): void {
        this.controller.commentingRangeProvider = this.commentingRangeProvider;
    }

    loadAllThreads(): void {
        const retained = new Set<string>();
        for (const saved of this.storage.getReports()) {
            const uri = this.pathResolver.uriForStoredPath(saved.filePath);
            if (!uri
                || (saved.anchorStatus !== 'current' && saved.anchorStatus !== 'reanchored')) {
                continue;
            }
            retained.add(saved.id);
            this.createOrUpdateThread(uri, saved);
        }
        for (const [id, thread] of [...this.threads.entries()]) {
            if (!retained.has(id)) {
                thread.dispose();
                this.threads.delete(id);
            }
        }
    }

    createThread(
        document: vscode.TextDocument,
        range: vscode.Range,
        body: string,
        existingThread?: vscode.CommentThread
    ): void {
        const resolved = this.pathResolver.resolveUri(document.uri);
        if (!resolved) {
            throw new Error('Code comments are limited to files in the original workspace');
        }
        const startLine = range.start.line;
        const endLine = range.end.line;
        if (startLine < 0 || endLine < startLine || endLine >= document.lineCount) {
            throw new Error('The selected code comment range is no longer valid');
        }
        const sourceAnchor = anchorFromDocument(document, startLine, endLine);
        const saved = this.storage.addThread(
            resolved.filePath,
            startLine,
            endLine,
            sourceAnchor,
            body,
            this.authorIdentity.get()
        );
        if (existingThread) {
            this.populateThread(existingThread as ManagedThread, saved);
        } else {
            this.createOrUpdateThread(resolved.uri, {
                ...saved,
                pathStatus: 'current',
                anchorStatus: 'current',
                rangeStatus: 'current',
                effectiveStartLine: startLine,
                effectiveEndLine: endLine,
                matches: [{ startLine, endLine }],
                stale: false,
            });
        }
    }

    addReply(thread: vscode.CommentThread, body: string): void {
        const threadId = this.requireThreadId(thread);
        const comment = this.storage.addReply(threadId, body, this.authorIdentity.get());
        thread.comments = [...thread.comments, this.toVscodeComment(threadId, comment)];
    }

    resolveThread(thread: vscode.CommentThread): void {
        this.setThreadState(thread, true);
    }

    unresolveThread(thread: vscode.CommentThread): void {
        this.setThreadState(thread, false);
    }

    saveEditedComment(thread: vscode.CommentThread, comment: vscode.Comment, body: string): void {
        const threadId = this.requireThreadId(thread);
        const identity = this.requireCommentIdentity(comment, threadId);
        this.storage.editComment(threadId, identity.commentId, body);
        this.refreshThreadComments(thread, threadId);
    }

    /** Reload thread comments from storage, discarding in-progress edit UI state. */
    discardCommentEdits(thread: vscode.CommentThread): void {
        this.refreshThreadComments(thread, this.requireThreadId(thread));
    }

    deleteComment(thread: vscode.CommentThread, comment: vscode.Comment): void {
        const managed = thread as ManagedThread;
        const threadId = this.requireThreadId(thread);
        const identity = this.requireCommentIdentity(comment, threadId);
        const removedThread = this.storage.deleteComment(threadId, identity.commentId);
        if (removedThread) {
            managed.dispose();
            this.threads.delete(threadId);
        } else {
            this.refreshThreadComments(thread, threadId);
        }
    }

    findThreadForComment(comment: vscode.Comment): vscode.CommentThread | undefined {
        const withParent = comment as CommentWithParent;
        if (withParent.parent || withParent.thread) {
            return withParent.parent ?? withParent.thread;
        }
        const fromMap = this.commentIdentities.get(comment);
        if (fromMap) {
            return this.threads.get(fromMap.threadId);
        }
        const tagged = comment as IdentifiedComment;
        if (tagged.__offlineThreadId) {
            return this.threads.get(tagged.__offlineThreadId);
        }
        for (const thread of this.threads.values()) {
            if (thread.comments.includes(comment)) {
                return thread;
            }
        }
        return undefined;
    }

    dispose(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
        this.controller.dispose();
    }

    private createOrUpdateThread(uri: vscode.Uri, saved: WorkspaceThreadReport): void {
        const startLine = saved.effectiveStartLine;
        const endLine = saved.effectiveEndLine;
        if (startLine === undefined || endLine === undefined) {
            return;
        }
        let existing = this.threads.get(saved.id);
        if (existing && existing.uri.fsPath !== uri.fsPath) {
            existing.dispose();
            this.threads.delete(saved.id);
            existing = undefined;
        }
        if (existing) {
            existing.comments = this.toVscodeComments(saved);
            existing.range = new vscode.Range(startLine, 0, endLine, 0);
            this.applyState(existing, saved);
            return;
        }
        const thread = this.controller.createCommentThread(
            uri,
            new vscode.Range(startLine, 0, endLine, 0),
            []
        ) as ManagedThread;
        this.populateThread(thread, saved);
    }

    private populateThread(thread: ManagedThread, saved: WorkspaceCommentThread): void {
        thread.comments = this.toVscodeComments(saved);
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.__workspaceThreadId = saved.id;
        this.applyState(thread, saved);
        this.threads.set(saved.id, thread);
    }

    private applyState(thread: vscode.CommentThread, saved: WorkspaceCommentThread): void {
        const resolved = saved.state === 'resolved';
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }

    private setThreadState(thread: vscode.CommentThread, resolved: boolean): void {
        const threadId = this.requireThreadId(thread);
        if (resolved) {
            this.storage.resolveThread(threadId);
        } else {
            this.storage.unresolveThread(threadId);
        }
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }

    private refreshThreadComments(thread: vscode.CommentThread, threadId: string): void {
        const saved = this.storage.load().threads.find(candidate => candidate.id === threadId);
        if (!saved) {
            throw new Error(`Workspace comment thread is stale or missing: ${threadId}`);
        }
        thread.comments = this.toVscodeComments(saved);
    }

    private requireThreadId(thread: vscode.CommentThread): string {
        const threadId = (thread as ManagedThread).__workspaceThreadId;
        if (!threadId) {
            throw new Error('Workspace comment thread is stale or unmanaged');
        }
        return threadId;
    }

    private requireCommentIdentity(comment: vscode.Comment, threadId: string): CommentIdentity {
        const identity = this.resolveCommentIdentity(comment, threadId);
        if (!identity) {
            throw new Error('Workspace comment is stale or unmanaged');
        }
        return identity;
    }

    private resolveCommentIdentity(
        comment: vscode.Comment,
        threadId: string
    ): CommentIdentity | undefined {
        const fromMap = this.commentIdentities.get(comment);
        if (fromMap && fromMap.threadId === threadId) {
            return fromMap;
        }
        const tagged = comment as IdentifiedComment;
        if (tagged.__offlineCommentId && tagged.__offlineThreadId === threadId) {
            return {
                threadId: tagged.__offlineThreadId,
                commentId: tagged.__offlineCommentId,
            };
        }
        return undefined;
    }

    private toVscodeComments(thread: WorkspaceCommentThread): vscode.Comment[] {
        return thread.comments.map(comment => this.toVscodeComment(thread.id, comment));
    }

    private toVscodeComment(threadId: string, comment: WorkspaceComment): vscode.Comment {
        const identity: CommentIdentity = { threadId, commentId: comment.id };
        const rendered: IdentifiedComment = {
            body: new vscode.MarkdownString(comment.body),
            author: { name: comment.author },
            mode: vscode.CommentMode.Preview,
            contextValue: 'canEdit',
            timestamp: new Date(comment.timestamp),
            __offlineThreadId: threadId,
            __offlineCommentId: comment.id,
        };
        this.commentIdentities.set(rendered, identity);
        return rendered;
    }
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
