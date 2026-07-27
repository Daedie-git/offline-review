import * as os from 'os';
import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceComment, WorkspaceCommentThread } from './types';

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

export class WorkspaceCommentController {
    private readonly controller: vscode.CommentController;
    private readonly threads = new Map<string, ManagedThread>();
    private readonly commentIdentities = new WeakMap<vscode.Comment, CommentIdentity>();

    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver
    ) {
        this.controller = vscode.comments.createCommentController(
            'localCodeComments',
            'Offline Review Code Comments'
        );
        this.controller.commentingRangeProvider = {
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
        this.controller.options = {
            prompt: 'Add workspace code comment',
            placeHolder: 'Comment on this workspace code',
        };
    }

    loadAllThreads(): void {
        const retained = new Set<string>();
        for (const saved of this.storage.getReports()) {
            const uri = this.pathResolver.uriForStoredPath(saved.filePath);
            if (!uri || saved.rangeStatus === 'outOfRange') {
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
            os.userInfo().username
        );
        if (existingThread) {
            this.populateThread(existingThread as ManagedThread, saved);
        } else {
            this.createOrUpdateThread(resolved.uri, saved);
        }
    }

    addReply(thread: vscode.CommentThread, body: string): void {
        const threadId = this.requireThreadId(thread);
        const comment = this.storage.addReply(threadId, body, os.userInfo().username);
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
        const identity = this.commentIdentities.get(comment);
        return identity ? this.threads.get(identity.threadId) : undefined;
    }

    dispose(): void {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
        this.controller.dispose();
    }

    private createOrUpdateThread(uri: vscode.Uri, saved: WorkspaceCommentThread): void {
        let existing = this.threads.get(saved.id);
        if (existing && existing.uri.fsPath !== uri.fsPath) {
            existing.dispose();
            this.threads.delete(saved.id);
            existing = undefined;
        }
        if (existing) {
            existing.comments = this.toVscodeComments(saved);
            existing.range = new vscode.Range(saved.startLine, 0, saved.endLine, 0);
            this.applyState(existing, saved);
            return;
        }
        const thread = this.controller.createCommentThread(
            uri,
            new vscode.Range(saved.startLine, 0, saved.endLine, 0),
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
        const identity = this.commentIdentities.get(comment);
        if (!identity || identity.threadId !== threadId) {
            throw new Error('Workspace comment is stale or unmanaged');
        }
        return identity;
    }

    private toVscodeComments(thread: WorkspaceCommentThread): vscode.Comment[] {
        return thread.comments.map(comment => this.toVscodeComment(thread.id, comment));
    }

    private toVscodeComment(threadId: string, comment: WorkspaceComment): vscode.Comment {
        const rendered: vscode.Comment = {
            body: new vscode.MarkdownString(comment.body),
            author: { name: comment.author },
            mode: vscode.CommentMode.Preview,
            contextValue: 'canEdit',
            timestamp: new Date(comment.timestamp),
        };
        this.commentIdentities.set(rendered, { threadId, commentId: comment.id });
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
