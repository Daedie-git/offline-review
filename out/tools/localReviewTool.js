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
exports.LocalReviewTool = void 0;
const vscode = __importStar(require("vscode"));
class LocalReviewTool {
    constructor(gitService, localPrManager, storageService) {
        this.gitService = gitService;
        this.localPrManager = localPrManager;
        this.storageService = storageService;
    }
    async prepareInvocation(options, _token) {
        const confirmationMessages = {
            title: 'Get Local Review Comments',
            message: new vscode.MarkdownString(`Retrieve local review comments${options.input.filePath ? ` for **${options.input.filePath}**` : ''}${options.input.state ? ` (${options.input.state} only)` : ''}?`),
        };
        return { invocationMessage: 'Checking local review comments...', confirmationMessages };
    }
    async invoke(options, _token) {
        const { filePath, state } = options.input;
        // Auto-detect review from current git branch
        const review = await this.resolveReview();
        if (!review) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart('No local review exists for the current git branch. '
                    + 'Tell the user: "No local review found. Open the **Local PR Review** sidebar (activity bar icon), '
                    + 'select a base and compare branch, then click Create Review. '
                    + 'After that, you can add comments in diff views and ask me to check them." '
                    + 'Do NOT search the filesystem or run any commands — local review data is only accessible through this tool.'),
            ]);
        }
        // Temporarily set as active to read comments
        const previousActive = this.localPrManager.getActiveReview();
        this.localPrManager.setActiveReview(review.id);
        const comments = this.storageService.loadComments();
        // Restore previous active if different
        if (previousActive && previousActive.id !== review.id) {
            this.localPrManager.setActiveReview(previousActive.id);
        }
        if (!comments || comments.threads.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Review found: ${review.targetBranch} -> ${review.sourceBranch}. `
                    + 'However, there are no comments yet. '
                    + 'Tell the user: "Your review has no comments yet. Open a file from the Changed Files list '
                    + 'in the Local PR Review sidebar, then click the + icon in the diff gutter to add a comment." '
                    + 'Do NOT search the filesystem or run any commands.'),
            ]);
        }
        let threads = comments.threads;
        // Filter by file path if specified
        if (filePath) {
            threads = threads.filter(t => t.filePath.includes(filePath));
        }
        // Filter by state if specified
        if (state) {
            threads = threads.filter(t => t.state === state);
        }
        const result = {
            review: {
                baseBranch: review.sourceBranch,
                compareBranch: review.targetBranch,
            },
            totalThreads: comments.threads.length,
            unresolvedCount: comments.threads.filter(t => t.state === 'unresolved').length,
            resolvedCount: comments.threads.filter(t => t.state === 'resolved').length,
            threads: threads.map(t => ({
                id: t.id,
                filePath: t.filePath,
                startLine: t.startLine,
                endLine: t.endLine,
                state: t.state,
                comments: t.comments.map(c => ({
                    author: c.author,
                    body: c.body,
                    timestamp: c.timestamp,
                })),
            })),
        };
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }
    async resolveReview() {
        // Try auto-detect from current git branch
        const currentBranch = await this.gitService.getCurrentBranch();
        if (currentBranch) {
            const review = this.localPrManager.findReviewByBranch(currentBranch);
            if (review) {
                return review;
            }
        }
        // Fall back to active review
        return this.localPrManager.getActiveReview();
    }
}
exports.LocalReviewTool = LocalReviewTool;
//# sourceMappingURL=localReviewTool.js.map