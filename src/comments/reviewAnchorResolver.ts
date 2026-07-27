import { getDiffDocumentUri, GitFileContentResult, GitService } from '../git/gitService';
import { resolveExactLineSequence, splitExactLines } from '../lineSequenceResolver';
import { StorageService } from '../storage/storageService';
import {
    DiffDocument,
    DiffPlan,
    FileChange,
    PreparedReviewCommentState,
    ReviewThread,
    ReviewThreadProjection,
} from '../types';

interface Candidate {
    readonly side: 'original' | 'modified';
    readonly document: DiffDocument;
    readonly uri: string;
}

export class ReviewAnchorResolver {
    private appliedState: PreparedReviewCommentState | undefined;

    constructor(
        private readonly gitService: GitService,
        private readonly storageService: StorageService
    ) {}

    async prepare(
        plan: DiffPlan,
        files: readonly FileChange[]
    ): Promise<PreparedReviewCommentState> {
        const comments = this.storageService.loadCommentsForReview(plan.reviewId);
        const candidates = new Map<string, Candidate>();
        for (const file of files) {
            const side = file.status === 'deleted' ? 'original' : 'modified';
            const document = side === 'original' ? plan.left : plan.right;
            candidates.set(candidateKey(file.filePath, side), {
                side,
                document,
                uri: getDiffDocumentUri(
                    document,
                    file.filePath,
                    side,
                    plan.reviewId,
                    plan.worktreeRoot
                ).toString(),
            });
        }

        const reads = new Map<string, Promise<GitFileContentResult>>();
        const read = (document: DiffDocument, filePath: string): Promise<GitFileContentResult> => {
            const key = document.kind === 'git'
                ? `git:${document.ref}:${filePath}`
                : `worktree:${document.reviewId}:${document.headCommit}:${document.planId}:${document.worktreeRoot}:${filePath}`;
            let pending = reads.get(key);
            if (!pending) {
                pending = this.gitService.getFileContentResult(document, filePath);
                reads.set(key, pending);
            }
            return pending;
        };

        const projections = await Promise.all((comments?.threads ?? []).map(thread =>
            this.resolveThread(plan, thread, candidates, read)
        ));
        return Object.freeze({
            plan,
            projections: Object.freeze(projections),
        });
    }

    applyPreparedState(state: PreparedReviewCommentState): void {
        this.appliedState = state;
    }

    getAppliedState(plan?: DiffPlan): PreparedReviewCommentState | undefined {
        if (!this.appliedState) {
            return undefined;
        }
        if (plan && !samePlan(this.appliedState.plan, plan)) {
            return undefined;
        }
        return this.appliedState;
    }

    addCurrentProjection(plan: DiffPlan, projection: ReviewThreadProjection): void {
        const state = this.getAppliedState(plan);
        if (!state) {
            return;
        }
        this.appliedState = Object.freeze({
            plan: state.plan,
            projections: Object.freeze([
                ...state.projections.filter(candidate =>
                    candidate.thread.id !== projection.thread.id
                ),
                projection,
            ]),
        });
    }

    updateThread(
        reviewId: string,
        threadId: string,
        update: (thread: ReviewThread) => ReviewThread | undefined
    ): void {
        const state = this.appliedState;
        if (!state || state.plan.reviewId !== reviewId) {
            return;
        }
        let changed = false;
        const projections: ReviewThreadProjection[] = [];
        for (const projection of state.projections) {
            if (projection.thread.id !== threadId) {
                projections.push(projection);
                continue;
            }
            changed = true;
            const thread = update(projection.thread);
            if (thread) {
                projections.push(Object.freeze({ ...projection, thread }));
            }
        }
        if (changed) {
            this.appliedState = Object.freeze({
                plan: state.plan,
                projections: Object.freeze(projections),
            });
        }
    }

    clear(): void {
        this.appliedState = undefined;
    }

    private async resolveThread(
        plan: DiffPlan,
        thread: ReviewThread,
        candidates: ReadonlyMap<string, Candidate>,
        read: (document: DiffDocument, filePath: string) => Promise<GitFileContentResult>
    ): Promise<ReviewThreadProjection> {
        const side = threadSide(thread);
        const historicalGitUri = thread.target.kind === 'git'
            ? getDiffDocumentUri(
                { kind: 'git', ref: thread.target.ref },
                thread.target.filePath,
                side,
                plan.reviewId,
                plan.worktreeRoot
            ).toString()
            : undefined;
        const base = {
            reviewId: plan.reviewId,
            thread,
            side,
            matches: [] as const,
            historicalGitUri,
        };
        if (thread.filePath !== thread.target.filePath
            || (thread.target.kind === 'worktree' && thread.target.reviewId !== plan.reviewId)) {
            return { ...base, anchorStatus: 'unavailable' };
        }
        const candidate = candidates.get(candidateKey(thread.target.filePath, side));
        if (!candidate) {
            return { ...base, anchorStatus: 'unavailable' };
        }

        if (thread.sourceAnchor === undefined && thread.target.kind === 'worktree') {
            if (plan.kind !== 'worktree' || thread.target.headCommit !== plan.headCommit) {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
            const current = await read(candidate.document, thread.target.filePath);
            if (current.status === 'unavailable'
                || !rangeExists(current.content, thread.startLine, thread.endLine)) {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
            return {
                ...base,
                anchorStatus: 'legacyCurrent',
                effectiveStartLine: thread.startLine,
                effectiveEndLine: thread.endLine,
                currentPlanUri: candidate.uri,
            };
        }

        let sourceAnchor = thread.sourceAnchor;
        if (sourceAnchor === undefined) {
            const target = thread.target;
            if (target.kind !== 'git') {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
            const historical = await read(
                { kind: 'git', ref: target.ref },
                target.filePath
            );
            if (historical.status === 'unavailable') {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
            sourceAnchor = anchorAtRange(
                historical.content,
                thread.startLine,
                thread.endLine
            );
            if (sourceAnchor === undefined) {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
        }

        const current = await read(candidate.document, thread.target.filePath);
        if (current.status === 'unavailable') {
            return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
        }
        const resolution = resolveExactLineSequence(
            current.content,
            sourceAnchor,
            thread.startLine,
            thread.endLine
        );
        return {
            ...base,
            anchorStatus: resolution.status,
            effectiveStartLine: resolution.effectiveStartLine,
            effectiveEndLine: resolution.effectiveEndLine,
            matches: resolution.matches,
            currentPlanUri: candidate.uri,
        };
    }
}

export function isEffectiveReviewProjection(
    projection: ReviewThreadProjection
): boolean {
    return projection.anchorStatus === 'current'
        || projection.anchorStatus === 'reanchored'
        || projection.anchorStatus === 'legacyCurrent';
}

export function normalizeReviewFilePath(filePath: string): string | undefined {
    if (!filePath || filePath.includes('\0') || filePath.includes('\\')
        || filePath.startsWith('/') || filePath.endsWith('/')) {
        return undefined;
    }
    const parts = filePath.split('/');
    return parts.some(part => !part || part === '.' || part === '..')
        ? undefined
        : parts.join('/');
}

function candidateKey(filePath: string, side: 'original' | 'modified'): string {
    return `${side}\0${filePath}`;
}

function threadSide(thread: ReviewThread): 'original' | 'modified' {
    return thread.target.kind === 'git' ? thread.target.side ?? 'modified' : 'modified';
}

function anchorAtRange(
    content: string,
    startLine: number,
    endLine: number
): string | undefined {
    const lines = splitExactLines(content);
    if (!rangeExistsInLines(lines, startLine, endLine)) {
        return undefined;
    }
    return lines.slice(startLine, endLine + 1).join('\n');
}

function rangeExists(content: string, startLine: number, endLine: number): boolean {
    return rangeExistsInLines(splitExactLines(content), startLine, endLine);
}

function rangeExistsInLines(
    lines: readonly string[],
    startLine: number,
    endLine: number
): boolean {
    return Number.isInteger(startLine)
        && Number.isInteger(endLine)
        && startLine >= 0
        && endLine >= startLine
        && endLine < lines.length;
}

function samePlan(left: DiffPlan, right: DiffPlan): boolean {
    return left.reviewId === right.reviewId
        && left.kind === right.kind
        && left.worktreeRoot === right.worktreeRoot
        && (left.kind === 'branch' && right.kind === 'branch'
            ? left.mergeBaseCommit === right.mergeBaseCommit
                && left.targetCommit === right.targetCommit
            : left.kind === 'worktree' && right.kind === 'worktree'
                && left.headCommit === right.headCommit
                && left.planId === right.planId
            );
}
