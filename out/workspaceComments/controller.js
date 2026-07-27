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
exports.WorkspaceCommentController = void 0;
const vscode = __importStar(require("vscode"));
const authorIdentity_1 = require("../authorIdentity");
class WorkspaceCommentController {
    constructor(storage, pathResolver, authorIdentity = new authorIdentity_1.AuthorIdentity()) {
        this.storage = storage;
        this.pathResolver = pathResolver;
        this.authorIdentity = authorIdentity;
        this.threads = new Map();
        this.commentIdentities = new WeakMap();
        this.controller = vscode.comments.createCommentController('localCodeComments', 'Offline Review Code Comments');
        this.commentingRangeProvider = {
            provideCommentingRanges: (document) => {
                if (!this.pathResolver.resolveUri(document.uri)) {
                    return [];
                }
                const lastLine = Math.max(0, document.lineCount - 1);
                return [new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).range.end.character)];
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
    refreshCommentingRanges() {
        this.controller.commentingRangeProvider = this.commentingRangeProvider;
    }
    loadAllThreads() {
        const retained = new Set();
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
    createThread(document, range, body, existingThread) {
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
        const saved = this.storage.addThread(resolved.filePath, startLine, endLine, sourceAnchor, body, this.authorIdentity.get());
        if (existingThread) {
            this.populateThread(existingThread, saved);
        }
        else {
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
    addReply(thread, body) {
        const threadId = this.requireThreadId(thread);
        const comment = this.storage.addReply(threadId, body, this.authorIdentity.get());
        thread.comments = [...thread.comments, this.toVscodeComment(threadId, comment)];
    }
    resolveThread(thread) {
        this.setThreadState(thread, true);
    }
    unresolveThread(thread) {
        this.setThreadState(thread, false);
    }
    saveEditedComment(thread, comment, body) {
        const threadId = this.requireThreadId(thread);
        const identity = this.requireCommentIdentity(comment, threadId);
        this.storage.editComment(threadId, identity.commentId, body);
        this.refreshThreadComments(thread, threadId);
    }
    deleteComment(thread, comment) {
        const managed = thread;
        const threadId = this.requireThreadId(thread);
        const identity = this.requireCommentIdentity(comment, threadId);
        const removedThread = this.storage.deleteComment(threadId, identity.commentId);
        if (removedThread) {
            managed.dispose();
            this.threads.delete(threadId);
        }
        else {
            this.refreshThreadComments(thread, threadId);
        }
    }
    findThreadForComment(comment) {
        const withParent = comment;
        if (withParent.parent || withParent.thread) {
            return withParent.parent ?? withParent.thread;
        }
        const identity = this.commentIdentities.get(comment);
        return identity ? this.threads.get(identity.threadId) : undefined;
    }
    dispose() {
        for (const thread of this.threads.values()) {
            thread.dispose();
        }
        this.threads.clear();
        this.controller.dispose();
    }
    createOrUpdateThread(uri, saved) {
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
        const thread = this.controller.createCommentThread(uri, new vscode.Range(startLine, 0, endLine, 0), []);
        this.populateThread(thread, saved);
    }
    populateThread(thread, saved) {
        thread.comments = this.toVscodeComments(saved);
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.__workspaceThreadId = saved.id;
        this.applyState(thread, saved);
        this.threads.set(saved.id, thread);
    }
    applyState(thread, saved) {
        const resolved = saved.state === 'resolved';
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }
    setThreadState(thread, resolved) {
        const threadId = this.requireThreadId(thread);
        if (resolved) {
            this.storage.resolveThread(threadId);
        }
        else {
            this.storage.unresolveThread(threadId);
        }
        thread.state = resolved
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = resolved ? 'Resolved' : undefined;
        thread.contextValue = resolved ? 'resolved' : 'unresolved';
    }
    refreshThreadComments(thread, threadId) {
        const saved = this.storage.load().threads.find(candidate => candidate.id === threadId);
        if (!saved) {
            throw new Error(`Workspace comment thread is stale or missing: ${threadId}`);
        }
        thread.comments = this.toVscodeComments(saved);
    }
    requireThreadId(thread) {
        const threadId = thread.__workspaceThreadId;
        if (!threadId) {
            throw new Error('Workspace comment thread is stale or unmanaged');
        }
        return threadId;
    }
    requireCommentIdentity(comment, threadId) {
        const identity = this.commentIdentities.get(comment);
        if (!identity || identity.threadId !== threadId) {
            throw new Error('Workspace comment is stale or unmanaged');
        }
        return identity;
    }
    toVscodeComments(thread) {
        return thread.comments.map(comment => this.toVscodeComment(thread.id, comment));
    }
    toVscodeComment(threadId, comment) {
        const rendered = {
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
exports.WorkspaceCommentController = WorkspaceCommentController;
function anchorFromDocument(document, startLine, endLine) {
    const lines = [];
    for (let line = startLine; line <= endLine; line++) {
        lines.push(document.lineAt(line).text);
    }
    return lines.join('\n');
}
//# sourceMappingURL=controller.js.map