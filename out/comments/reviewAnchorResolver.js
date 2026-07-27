"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewAnchorResolver = void 0;
exports.isEffectiveReviewProjection = isEffectiveReviewProjection;
exports.normalizeReviewFilePath = normalizeReviewFilePath;
const gitService_1 = require("../git/gitService");
const lineSequenceResolver_1 = require("../lineSequenceResolver");
class ReviewAnchorResolver {
    constructor(gitService, storageService) {
        this.gitService = gitService;
        this.storageService = storageService;
    }
    async prepare(plan, files) {
        const comments = this.storageService.loadCommentsForReview(plan.reviewId);
        const candidates = new Map();
        for (const file of files) {
            const side = file.status === 'deleted' ? 'original' : 'modified';
            const document = side === 'original' ? plan.left : plan.right;
            candidates.set(candidateKey(file.filePath, side), {
                side,
                document,
                uri: (0, gitService_1.getDiffDocumentUri)(document, file.filePath, side, plan.reviewId, plan.worktreeRoot).toString(),
            });
        }
        const reads = new Map();
        const read = (document, filePath) => {
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
        const projections = await Promise.all((comments?.threads ?? []).map(thread => this.resolveThread(plan, thread, candidates, read)));
        return Object.freeze({
            plan,
            projections: Object.freeze(projections),
        });
    }
    applyPreparedState(state) {
        this.appliedState = state;
    }
    getAppliedState(plan) {
        if (!this.appliedState) {
            return undefined;
        }
        if (plan && !samePlan(this.appliedState.plan, plan)) {
            return undefined;
        }
        return this.appliedState;
    }
    addCurrentProjection(plan, projection) {
        const state = this.getAppliedState(plan);
        if (!state) {
            return;
        }
        this.appliedState = Object.freeze({
            plan: state.plan,
            projections: Object.freeze([
                ...state.projections.filter(candidate => candidate.thread.id !== projection.thread.id),
                projection,
            ]),
        });
    }
    updateThread(reviewId, threadId, update) {
        const state = this.appliedState;
        if (!state || state.plan.reviewId !== reviewId) {
            return;
        }
        let changed = false;
        const projections = [];
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
    clear() {
        this.appliedState = undefined;
    }
    async resolveThread(plan, thread, candidates, read) {
        const side = threadSide(thread);
        const historicalGitUri = thread.target.kind === 'git'
            ? (0, gitService_1.getDiffDocumentUri)({ kind: 'git', ref: thread.target.ref }, thread.target.filePath, side, plan.reviewId, plan.worktreeRoot).toString()
            : undefined;
        const base = {
            reviewId: plan.reviewId,
            thread,
            side,
            matches: [],
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
            const historical = await read({ kind: 'git', ref: target.ref }, target.filePath);
            if (historical.status === 'unavailable') {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
            sourceAnchor = anchorAtRange(historical.content, thread.startLine, thread.endLine);
            if (sourceAnchor === undefined) {
                return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
            }
        }
        const current = await read(candidate.document, thread.target.filePath);
        if (current.status === 'unavailable') {
            return { ...base, anchorStatus: 'unavailable', currentPlanUri: candidate.uri };
        }
        const resolution = (0, lineSequenceResolver_1.resolveExactLineSequence)(current.content, sourceAnchor, thread.startLine, thread.endLine);
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
exports.ReviewAnchorResolver = ReviewAnchorResolver;
function isEffectiveReviewProjection(projection) {
    return projection.anchorStatus === 'current'
        || projection.anchorStatus === 'reanchored'
        || projection.anchorStatus === 'legacyCurrent';
}
function normalizeReviewFilePath(filePath) {
    if (!filePath || filePath.includes('\0') || filePath.includes('\\')
        || filePath.startsWith('/') || filePath.endsWith('/')) {
        return undefined;
    }
    const parts = filePath.split('/');
    return parts.some(part => !part || part === '.' || part === '..')
        ? undefined
        : parts.join('/');
}
function candidateKey(filePath, side) {
    return `${side}\0${filePath}`;
}
function threadSide(thread) {
    return thread.target.kind === 'git' ? thread.target.side ?? 'modified' : 'modified';
}
function anchorAtRange(content, startLine, endLine) {
    const lines = (0, lineSequenceResolver_1.splitExactLines)(content);
    if (!rangeExistsInLines(lines, startLine, endLine)) {
        return undefined;
    }
    return lines.slice(startLine, endLine + 1).join('\n');
}
function rangeExists(content, startLine, endLine) {
    return rangeExistsInLines((0, lineSequenceResolver_1.splitExactLines)(content), startLine, endLine);
}
function rangeExistsInLines(lines, startLine, endLine) {
    return Number.isInteger(startLine)
        && Number.isInteger(endLine)
        && startLine >= 0
        && endLine >= startLine
        && endLine < lines.length;
}
function samePlan(left, right) {
    return left.reviewId === right.reviewId
        && left.kind === right.kind
        && left.worktreeRoot === right.worktreeRoot
        && (left.kind === 'branch' && right.kind === 'branch'
            ? left.mergeBaseCommit === right.mergeBaseCommit
                && left.targetCommit === right.targetCommit
            : left.kind === 'worktree' && right.kind === 'worktree'
                && left.headCommit === right.headCommit
                && left.planId === right.planId);
}
//# sourceMappingURL=reviewAnchorResolver.js.map