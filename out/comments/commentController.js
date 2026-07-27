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
class ReviewCommentController {
    constructor(storageService) {
        this.storageService = storageService;
        this.threads = new Map();
        this.reviewableFiles = new Set();
        this.controller = vscode.comments.createCommentController('localPrReview', 'Offline Review');
        const self = this;
        this.controller.commentingRangeProvider = {
            provideCommentingRanges(document) {
                // In review diffs, only claim the modified (right) side. Base/left
                // line numbers cannot safely be persisted against the modified file.
                if (document.uri.scheme === 'git-local-review') {
                    const params = new URLSearchParams(document.uri.query);
                    if (params.get('side') !== 'modified') {
                        return [];
                    }
                }
                // Cursor may expose the working-copy side as file://, and users can
                // also open a changed file directly. Only claim files in this review
                // (or files with an existing thread) to avoid competing globally with
                // GitHub and other comment providers.
                else if (document.uri.scheme === 'file') {
                    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
                    if (!self.reviewableFiles.has(relativePath) && !self.hasThreadsForFile(relativePath)) {
                        return [];
                    }
                }
                else {
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
    /**
     * Set the list of file paths (workspace-relative) that are part of the active review.
     * This enables commenting on working-tree files shown in diffs.
     */
    setReviewableFiles(filePaths) {
        this.reviewableFiles.clear();
        for (const p of filePaths) {
            this.reviewableFiles.add(p);
        }
    }
    /**
     * Check if any loaded threads reference this file path.
     */
    hasThreadsForFile(relativePath) {
        for (const thread of this.threads.values()) {
            const data = thread.__threadData;
            if (data && data.filePath === relativePath) {
                return true;
            }
        }
        return false;
    }
    /**
     * Load comment threads from storage for a given file in the diff view.
     * Creates threads only on the provided URI (call with the modified/right side).
     */
    loadThreadsForFile(fileUri, filePath) {
        const comments = this.storageService.loadComments();
        if (!comments) {
            return;
        }
        const fileThreads = comments.threads.filter(t => t.filePath === filePath);
        for (const thread of fileThreads) {
            // One VS Code thread per saved thread on this URI — never also mirror to
            // the other diff side (that shows the same comment twice).
            const dKey = fileUri.scheme === 'file'
                ? thread.id
                : `${thread.id}::${fileUri.toString()}`;
            this.createVscodeThread(fileUri, thread, dKey);
        }
    }
    /**
     * Load all threads for the active review across all files
     */
    async loadAllThreads(gitService, sourceBranch, targetBranch) {
        this.clearAllThreads();
        if (gitService) {
            this.gitService = gitService;
        }
        const comments = this.storageService.loadComments();
        if (!comments || comments.threads.length === 0) {
            return;
        }
        const gs = this.gitService;
        if (!gs || !sourceBranch || !targetBranch) {
            // Fallback: try to derive branches from stored comments
            const src = sourceBranch || comments.sourceBranch;
            const tgt = targetBranch || comments.targetBranch;
            if (!src || !tgt) {
                return;
            }
            await this.loadAllThreadsForBranches(comments.threads, src, tgt, gs);
            return;
        }
        await this.loadAllThreadsForBranches(comments.threads, sourceBranch, targetBranch, gs);
    }
    async loadAllThreadsForBranches(threads, sourceBranch, targetBranch, gitService) {
        // Group threads by file
        const fileThreads = new Map();
        for (const thread of threads) {
            if (!fileThreads.has(thread.filePath)) {
                fileThreads.set(thread.filePath, []);
            }
            fileThreads.get(thread.filePath).push(thread);
        }
        // Prefer virtual review URIs (modified side) so Comments panel + reopen
        // share one thread per comment instead of file:// + left + right.
        const useWorkingTree = sourceBranch === targetBranch
            || (gitService && await gitService.isCurrentBranch(targetBranch));
        for (const [filePath, fileSpecificThreads] of fileThreads) {
            const fileUri = useWorkingTree && gitService
                ? gitService.getWorkingTreeFileUri(filePath)
                : gitService
                    ? gitService.getFileUri(targetBranch, filePath, 'modified')
                    : vscode.Uri.parse(`git-local-review://authority/${filePath}?ref=${encodeURIComponent(targetBranch)}&side=modified`);
            for (const thread of fileSpecificThreads) {
                const key = `${thread.id}::${fileUri.toString()}`;
                this.createVscodeThread(fileUri, thread, key);
            }
        }
    }
    createThread(uri, range, text, filePath, existingThread) {
        const author = os.userInfo().username;
        const savedThread = this.storageService.addThread(filePath, range.start.line, range.end.line, text, author);
        const key = uri.scheme === 'file'
            ? savedThread.id
            : `${savedThread.id}::${uri.toString()}`;
        // Single thread on the URI where the user commented — no mirrored copy.
        if (existingThread) {
            this.populateThread(existingThread, savedThread, key);
        }
        else {
            this.createVscodeThread(uri, savedThread, key);
        }
    }
    populateThread(thread, savedThread, key) {
        thread.comments = savedThread.comments.map(c => this.toVscodeComment(c));
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.state = savedThread.state === 'resolved'
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = savedThread.state === 'resolved' ? 'Resolved' : undefined;
        thread.contextValue = savedThread.state === 'resolved' ? 'resolved' : 'unresolved';
        thread.__threadData = {
            threadId: savedThread.id,
            filePath: savedThread.filePath,
        };
        this.threads.set(key, thread);
    }
    createVscodeThread(uri, savedThread, key) {
        const threadKey = key || savedThread.id;
        const existing = this.threads.get(threadKey);
        if (existing) {
            existing.comments = savedThread.comments.map(c => this.toVscodeComment(c));
            existing.state = savedThread.state === 'resolved'
                ? vscode.CommentThreadState.Resolved
                : vscode.CommentThreadState.Unresolved;
            existing.label = savedThread.state === 'resolved' ? 'Resolved' : undefined;
            existing.contextValue = savedThread.state === 'resolved' ? 'resolved' : 'unresolved';
            existing.__threadData = {
                threadId: savedThread.id,
                filePath: savedThread.filePath,
            };
            return existing;
        }
        // Drop any other URI mirrors of the same logical thread so reopen can't
        // stack left+right+file copies.
        for (const [k, t] of [...this.threads.entries()]) {
            const data = t.__threadData;
            if (data && data.threadId === savedThread.id && k !== threadKey) {
                t.dispose();
                this.threads.delete(k);
            }
        }
        const range = new vscode.Range(savedThread.startLine, 0, savedThread.endLine, 0);
        const thread = this.controller.createCommentThread(uri, range, []);
        thread.comments = savedThread.comments.map(c => this.toVscodeComment(c));
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.state = savedThread.state === 'resolved'
            ? vscode.CommentThreadState.Resolved
            : vscode.CommentThreadState.Unresolved;
        thread.label = savedThread.state === 'resolved' ? 'Resolved' : undefined;
        thread.contextValue = savedThread.state === 'resolved' ? 'resolved' : 'unresolved';
        // Store thread data for later retrieval  
        thread.__threadData = {
            threadId: savedThread.id,
            filePath: savedThread.filePath,
        };
        this.threads.set(threadKey, thread);
        return thread;
    }
    toVscodeComment(comment) {
        return {
            body: new vscode.MarkdownString(comment.body),
            author: { name: comment.author },
            mode: vscode.CommentMode.Preview,
            contextValue: 'canEdit',
            timestamp: new Date(comment.timestamp),
            label: undefined,
        };
    }
    resolveThread(thread) {
        const data = thread.__threadData;
        if (!data) {
            return;
        }
        this.storageService.resolveThread(data.threadId);
        thread.state = vscode.CommentThreadState.Resolved;
        thread.label = 'Resolved';
        thread.contextValue = 'resolved';
    }
    unresolveThread(thread) {
        const data = thread.__threadData;
        if (!data) {
            return;
        }
        this.storageService.unresolveThread(data.threadId);
        thread.state = vscode.CommentThreadState.Unresolved;
        thread.label = undefined;
        thread.contextValue = 'unresolved';
    }
    addReply(thread, text) {
        const data = thread.__threadData;
        if (!data) {
            return;
        }
        const author = os.userInfo().username;
        const comment = this.storageService.addReplyToThread(data.threadId, text, author);
        if (comment) {
            thread.comments = [...thread.comments, this.toVscodeComment(comment)];
        }
    }
    saveEditedComment(thread, comment, newBody) {
        const data = thread.__threadData;
        if (!data) {
            return;
        }
        const bodyText = typeof comment.body === 'string' ? comment.body : (comment.body?.value ?? '');
        const comments = this.storageService.loadComments();
        const storedThread = comments?.threads.find(t => t.id === data.threadId);
        if (!storedThread) {
            return;
        }
        const idx = thread.comments.indexOf(comment);
        let stored = idx >= 0 && idx < storedThread.comments.length
            ? storedThread.comments[idx]
            : storedThread.comments.find(c => c.body === bodyText && c.author === comment.author?.name);
        if (!stored && storedThread.comments.length === 1) {
            stored = storedThread.comments[0];
        }
        if (!stored) {
            return;
        }
        this.storageService.editComment(data.threadId, stored.id, newBody);
        const refreshed = this.storageService.loadComments()?.threads.find(t => t.id === data.threadId);
        if (refreshed) {
            thread.comments = refreshed.comments.map(c => this.toVscodeComment(c));
        }
    }
    deleteComment(thread, comment) {
        const data = thread.__threadData;
        if (!data) {
            return;
        }
        const comments = this.storageService.loadComments();
        if (!comments) {
            return;
        }
        const storedThread = comments.threads.find(t => t.id === data.threadId);
        if (!storedThread) {
            return;
        }
        const bodyText = (c) => typeof c.body === 'string' ? c.body : (c.body?.value ?? '');
        const uiIndex = thread.comments.indexOf(comment);
        let storedComment = undefined;
        // Prefer index when UI and storage still line up
        if (uiIndex >= 0 && uiIndex < storedThread.comments.length) {
            storedComment = storedThread.comments[uiIndex];
        }
        if (!storedComment) {
            const commentTimestamp = comment.timestamp?.getTime?.() ?? (comment.timestamp ? new Date(comment.timestamp).getTime() : undefined);
            storedComment = storedThread.comments.find(c => {
                if (commentTimestamp && new Date(c.timestamp).getTime() === commentTimestamp && c.author === comment.author?.name) {
                    return true;
                }
                return c.body === bodyText(comment) && c.author === comment.author?.name;
            });
        }
        if (!storedComment) {
            // Last resort: single-comment thread
            if (storedThread.comments.length === 1) {
                storedComment = storedThread.comments[0];
            }
            else {
                return;
            }
        }
        const removingLast = storedThread.comments.length <= 1;
        this.storageService.deleteComment(data.threadId, storedComment.id);
        if (removingLast) {
            this.disposeThread(thread);
        }
        else {
            const remaining = this.storageService.loadComments()?.threads.find(t => t.id === data.threadId);
            thread.comments = remaining
                ? remaining.comments.map(c => this.toVscodeComment(c))
                : thread.comments.filter(c => c !== comment);
        }
    }
    disposeThread(thread) {
        for (const [k, t] of [...this.threads.entries()]) {
            if (t === thread || t.__threadData?.threadId === thread.__threadData?.threadId) {
                t.dispose();
                this.threads.delete(k);
            }
        }
    }
    findThreadForComment(comment) {
        if (!comment) {
            return undefined;
        }
        // VS Code sometimes attaches the parent thread on the comment
        const parent = comment.parent || comment.thread;
        if (parent) {
            for (const thread of this.threads.values()) {
                if (thread === parent) {
                    return thread;
                }
            }
            if (parent.__threadData) {
                return parent;
            }
        }
        for (const thread of this.threads.values()) {
            if (thread.comments.includes(comment)) {
                return thread;
            }
        }
        const body = typeof comment.body === 'string' ? comment.body : comment.body?.value;
        const author = comment.author?.name;
        for (const thread of this.threads.values()) {
            if (thread.comments.some(c => {
                const b = typeof c.body === 'string' ? c.body : c.body?.value;
                return b === body && c.author?.name === author;
            })) {
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
//# sourceMappingURL=commentController.js.map
