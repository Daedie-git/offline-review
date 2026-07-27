"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewTransitionCoordinator = void 0;
/**
 * Latest-request-wins coordinator for asynchronously prepared review state.
 * It also guards the comment bucket and current worktree inputs read by a plan.
 */
class ReviewTransitionCoordinator {
    constructor(storageService) {
        this.storageService = storageService;
        this.generation = 0;
        this.worktreeRevisions = new Map();
    }
    beginTransition() {
        return ++this.generation;
    }
    get currentGeneration() {
        return this.generation;
    }
    isCurrent(generation) {
        return generation === this.generation;
    }
    markWorktreeChanged(worktreeRoot) {
        this.worktreeRevisions.set(worktreeRoot, (this.worktreeRevisions.get(worktreeRoot) ?? 0) + 1);
    }
    captureInputs(reviewId, worktreeRoot) {
        return {
            reviewId,
            commentsRevision: this.storageService.getReviewRevision(reviewId),
            worktreeRoot,
            worktreeRevision: worktreeRoot === undefined
                ? undefined
                : this.worktreeRevisions.get(worktreeRoot) ?? 0,
        };
    }
    inputsAreCurrent(snapshot) {
        return snapshot.commentsRevision
            === this.storageService.getReviewRevision(snapshot.reviewId)
            && (snapshot.worktreeRoot === undefined
                || snapshot.worktreeRevision
                    === (this.worktreeRevisions.get(snapshot.worktreeRoot) ?? 0));
    }
    async prepareStable(options) {
        const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
        for (let attempts = 1; attempts <= maxAttempts; attempts++) {
            if (!this.isCurrent(options.generation)) {
                return { status: 'superseded', attempts: attempts - 1 };
            }
            const snapshot = this.captureInputs(options.reviewId, options.worktreeRoot);
            const value = await options.prepare();
            if (!this.isCurrent(options.generation)) {
                return { status: 'superseded', attempts };
            }
            if (this.inputsAreCurrent(snapshot)) {
                return {
                    status: 'prepared',
                    value,
                    snapshot,
                    attempts,
                };
            }
        }
        return { status: 'retry', attempts: maxAttempts };
    }
}
exports.ReviewTransitionCoordinator = ReviewTransitionCoordinator;
//# sourceMappingURL=reviewTransitionCoordinator.js.map