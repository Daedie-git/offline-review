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
const types_1 = require("../types");
const reviewAnchorResolver_1 = require("../comments/reviewAnchorResolver");
class LocalReviewTool {
    constructor(gitService, localPrManager, storageService, anchorResolver) {
        this.gitService = gitService;
        this.localPrManager = localPrManager;
        this.storageService = storageService;
        this.anchorResolver = anchorResolver;
    }
    async prepareInvocation(options, _token) {
        const confirmationMessages = {
            title: 'Get Offline Review Comments',
            message: new vscode.MarkdownString(`Retrieve offline review comments${options.input.filePath ? ` for **${options.input.filePath}**` : ''}${options.input.state ? ` (${options.input.state} only)` : ''}?`),
        };
        return { invocationMessage: 'Checking offline review comments...', confirmationMessages };
    }
    async invoke(options, _token) {
        const { filePath, state } = options.input;
        const review = await this.resolveReview();
        if (!review) {
            return textResult('No offline review exists for the current git branch. '
                + 'Tell the user: "No offline review found. Open the **Offline Review** sidebar, '
                + 'pick Uncommitted or Active branch, then add comments in a diff view." '
                + 'Do NOT search the filesystem or run commands; review data is available through this tool.');
        }
        // UUID-specific reads avoid activating a different review as a side effect.
        const comments = this.storageService.loadCommentsForReview(review);
        const label = (0, types_1.formatReviewLabel)(review);
        if (!comments || comments.threads.length === 0) {
            return textResult(`Review found: ${label}. However, there are no comments yet. `
                + 'Tell the user to open a file from Changed Files and use the diff gutter to add a comment.');
        }
        if (filePath && (0, reviewAnchorResolver_1.normalizeReviewFilePath)(filePath) !== filePath) {
            return textResult(JSON.stringify({
                error: 'filePath must be an exact normalized repository-relative path',
            }, null, 2));
        }
        let threads = comments.threads;
        if (filePath) {
            threads = threads.filter(thread => thread.filePath === filePath);
        }
        if (state) {
            threads = threads.filter(thread => thread.state === state);
        }
        const comparison = (0, types_1.getReviewSourceTarget)(review);
        const applied = this.anchorResolver?.getAppliedState();
        const projectionById = new Map(applied?.plan.reviewId === review.id
            ? applied.projections.map(projection => [projection.thread.id, projection])
            : []);
        const result = {
            review: {
                id: review.id,
                mode: review.mode,
                label,
                baseBranch: comparison.sourceBranch,
                compareBranch: comparison.targetBranch,
            },
            totalThreads: comments.threads.length,
            unresolvedCount: comments.threads.filter(thread => thread.state === 'unresolved').length,
            resolvedCount: comments.threads.filter(thread => thread.state === 'resolved').length,
            threads: threads.map(thread => {
                const projection = projectionById.get(thread.id);
                const effective = projection && (0, reviewAnchorResolver_1.isEffectiveReviewProjection)(projection);
                const side = projection?.side
                    ?? (thread.target.kind === 'git' ? thread.target.side ?? 'modified' : 'modified');
                return {
                    id: thread.id,
                    filePath: thread.filePath,
                    authoredStartLine: thread.startLine,
                    authoredEndLine: thread.endLine,
                    effectiveStartLine: effective ? projection.effectiveStartLine : undefined,
                    effectiveEndLine: effective ? projection.effectiveEndLine : undefined,
                    side,
                    sourceAnchor: thread.sourceAnchor,
                    anchorStatus: projection?.anchorStatus ?? 'unavailable',
                    matches: projection?.matches ?? [],
                    currentPlanPlacement: effective ? {
                        status: 'effective',
                        uri: projection.currentPlanUri,
                        startLine: projection.effectiveStartLine,
                        endLine: projection.effectiveEndLine,
                    } : {
                        status: projection?.anchorStatus ?? 'unavailable',
                        uri: projection?.currentPlanUri,
                    },
                    historicalGitPlacement: !effective && projection?.historicalGitUri ? {
                        uri: projection.historicalGitUri,
                        startLine: thread.startLine,
                        endLine: thread.endLine,
                    } : undefined,
                    state: thread.state,
                    comments: thread.comments.map(comment => ({
                        author: comment.author,
                        body: comment.body,
                        timestamp: comment.timestamp,
                    })),
                };
            }),
        };
        return textResult(JSON.stringify(result, null, 2));
    }
    async resolveReview() {
        // Active UUID is authoritative because branch and uncommitted reviews can
        // intentionally share a branch name while remaining separate buckets.
        const active = this.localPrManager.getActiveReview();
        if (active) {
            return active;
        }
        const currentBranch = await this.gitService.getCurrentBranch();
        return currentBranch
            ? this.localPrManager.findReviewByBranch(currentBranch, this.localPrManager.getActiveMode())
            : undefined;
    }
}
exports.LocalReviewTool = LocalReviewTool;
function textResult(text) {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
//# sourceMappingURL=localReviewTool.js.map