"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getReviewSourceTarget = getReviewSourceTarget;
exports.formatReviewLabel = formatReviewLabel;
exports.isThreadCurrentForPlan = isThreadCurrentForPlan;
function getReviewSourceTarget(review) {
    if (review.mode === 'branch') {
        return {
            sourceBranch: review.baseBranch,
            targetBranch: review.targetBranch,
            sourceCommit: review.sourceCommit,
            targetCommit: review.targetCommit,
        };
    }
    return {
        sourceBranch: review.branch,
        targetBranch: review.branch,
        sourceCommit: review.sourceCommit,
        targetCommit: review.targetCommit,
    };
}
/** The single user-facing label format for persisted reviews. */
function formatReviewLabel(review) {
    return review.mode === 'uncommitted'
        ? `uncommitted (${review.branch})`
        : `${review.targetBranch} vs ${review.baseBranch}`;
}
function isThreadCurrentForPlan(thread, plan, filePath = thread.filePath) {
    const target = thread.target;
    if (target.filePath !== filePath) {
        return false;
    }
    return plan.kind === 'branch'
        ? target.kind === 'git' && target.ref === plan.targetCommit
        : target.kind === 'worktree'
            && target.reviewId === plan.reviewId
            && target.headCommit === plan.headCommit;
}
//# sourceMappingURL=types.js.map