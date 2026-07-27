import { StorageService } from '../storage/storageService';
export interface ReviewInputSnapshot {
    readonly reviewId: string;
    readonly commentsRevision: number;
    readonly worktreeRoot?: string;
    readonly worktreeRevision?: number;
}
export type StablePreparationResult<T> = {
    readonly status: 'prepared';
    readonly value: T;
    readonly snapshot: ReviewInputSnapshot;
    readonly attempts: number;
} | {
    readonly status: 'superseded';
    readonly attempts: number;
} | {
    readonly status: 'retry';
    readonly attempts: number;
};
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
export declare class ReviewTransitionCoordinator {
    private readonly storageService;
    private generation;
    private readonly worktreeRevisions;
    constructor(storageService: StorageService);
    beginTransition(): number;
    get currentGeneration(): number;
    isCurrent(generation: number): boolean;
    markWorktreeChanged(worktreeRoot: string): void;
    captureInputs(reviewId: string, worktreeRoot?: string): ReviewInputSnapshot;
    inputsAreCurrent(snapshot: ReviewInputSnapshot): boolean;
    prepareStable<T>(options: StablePreparationOptions<T>): Promise<StablePreparationResult<T>>;
}
export {};
