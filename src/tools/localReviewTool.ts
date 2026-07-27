import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
import { StorageService } from '../storage/storageService';
import { formatReviewLabel, getReviewSourceTarget, LocalPr } from '../types';
import {
    isEffectiveReviewProjection,
    normalizeReviewFilePath,
    ReviewAnchorResolver,
} from '../comments/reviewAnchorResolver';

interface ToolInput {
    filePath?: string;
    state?: 'resolved' | 'unresolved';
}

export class LocalReviewTool implements vscode.LanguageModelTool<ToolInput> {
    constructor(
        private readonly gitService: GitService,
        private readonly localPrManager: LocalPrManager,
        private readonly storageService: StorageService,
        private readonly anchorResolver?: ReviewAnchorResolver
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ToolInput>,
        _token: vscode.CancellationToken
    ) {
        const confirmationMessages = {
            title: 'Get Offline Review Comments',
            message: new vscode.MarkdownString(
                `Retrieve offline review comments${
                    options.input.filePath ? ` for **${options.input.filePath}**` : ''
                }${options.input.state ? ` (${options.input.state} only)` : ''}?`
            ),
        };
        return { invocationMessage: 'Checking offline review comments...', confirmationMessages };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, state } = options.input;
        const review = await this.resolveReview();
        if (!review) {
            return textResult(
                'No offline review exists for the current git branch. '
                + 'Tell the user: "No offline review found. Open the **Offline Review** sidebar, '
                + 'pick Uncommitted or Active branch, then add comments in a diff view." '
                + 'Do NOT search the filesystem or run commands; review data is available through this tool.'
            );
        }

        // UUID-specific reads avoid activating a different review as a side effect.
        const comments = this.storageService.loadCommentsForReview(review);
        const label = formatReviewLabel(review);
        if (!comments || comments.threads.length === 0) {
            return textResult(
                `Review found: ${label}. However, there are no comments yet. `
                + 'Tell the user to open a file from Changed Files and use the diff gutter to add a comment.'
            );
        }

        if (filePath && normalizeReviewFilePath(filePath) !== filePath) {
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

        const comparison = getReviewSourceTarget(review);
        const applied = this.anchorResolver?.getAppliedState();
        const projectionById = new Map(
            applied?.plan.reviewId === review.id
                ? applied.projections.map(projection => [projection.thread.id, projection])
                : []
        );
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
                const effective = projection && isEffectiveReviewProjection(projection);
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

    private async resolveReview(): Promise<LocalPr | undefined> {
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

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
