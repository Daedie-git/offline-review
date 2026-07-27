import { StorageService } from '../storage/storageService';

export interface ReviewInputSnapshot {
    readonly reviewId: string;
    readonly commentsRevision: number;
    readonly worktreeRoot?: string;
    readonly worktreeRevision?: number;
}

export type StablePreparationResult<T> =
    | {
        readonly status: 'prepared';
        readonly value: T;
        readonly snapshot: ReviewInputSnapshot;
        readonly attempts: number;
    }
    | { readonly status: 'superseded'; readonly attempts: number }
    | { readonly status: 'retry'; readonly attempts: number };

interface StablePreparationOptions<T> {
    readonly generation: number;
    readonly reviewId: string;
    readonly worktreeRoot?: string;
    readonly prepare: () => Promise<T>;
    readonly maxAttempts?: number;
}

/**
 * Latest-request-wins coordinator for asynchronously prepared review state.
 * It also guards the comment bucket and current worktree inputs read by a plan.
 */
export class ReviewTransitionCoordinator {
    private generation = 0;
    private readonly worktreeRevisions = new Map<string, number>();

    constructor(private readonly storageService: StorageService) {}

    beginTransition(): number {
        return ++this.generation;
    }

    get currentGeneration(): number {
        return this.generation;
    }

    isCurrent(generation: number): boolean {
        return generation === this.generation;
    }

    markWorktreeChanged(worktreeRoot: string): void {
        this.worktreeRevisions.set(
            worktreeRoot,
            (this.worktreeRevisions.get(worktreeRoot) ?? 0) + 1
        );
    }

    captureInputs(reviewId: string, worktreeRoot?: string): ReviewInputSnapshot {
        return {
            reviewId,
            commentsRevision: this.storageService.getReviewRevision(reviewId),
            worktreeRoot,
            worktreeRevision: worktreeRoot === undefined
                ? undefined
                : this.worktreeRevisions.get(worktreeRoot) ?? 0,
        };
    }

    inputsAreCurrent(snapshot: ReviewInputSnapshot): boolean {
        return snapshot.commentsRevision
                === this.storageService.getReviewRevision(snapshot.reviewId)
            && (snapshot.worktreeRoot === undefined
                || snapshot.worktreeRevision
                    === (this.worktreeRevisions.get(snapshot.worktreeRoot) ?? 0));
    }

    async prepareStable<T>(
        options: StablePreparationOptions<T>
    ): Promise<StablePreparationResult<T>> {
        const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
        for (let attempts = 1; attempts <= maxAttempts; attempts++) {
            if (!this.isCurrent(options.generation)) {
                return { status: 'superseded', attempts: attempts - 1 };
            }
            const snapshot = this.captureInputs(
                options.reviewId,
                options.worktreeRoot
            );
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
