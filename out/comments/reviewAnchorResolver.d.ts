import { GitService } from '../git/gitService';
import { StorageService } from '../storage/storageService';
import { DiffPlan, FileChange, PreparedReviewCommentState, ReviewThread, ReviewThreadProjection } from '../types';
export declare class ReviewAnchorResolver {
    private readonly gitService;
    private readonly storageService;
    private appliedState;
    constructor(gitService: GitService, storageService: StorageService);
    prepare(plan: DiffPlan, files: readonly FileChange[]): Promise<PreparedReviewCommentState>;
    applyPreparedState(state: PreparedReviewCommentState): void;
    getAppliedState(plan?: DiffPlan): PreparedReviewCommentState | undefined;
    addCurrentProjection(plan: DiffPlan, projection: ReviewThreadProjection): void;
    updateThread(reviewId: string, threadId: string, update: (thread: ReviewThread) => ReviewThread | undefined): void;
    clear(): void;
    private resolveThread;
}
export declare function isEffectiveReviewProjection(projection: ReviewThreadProjection): boolean;
export declare function normalizeReviewFilePath(filePath: string): string | undefined;
