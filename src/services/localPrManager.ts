import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    BranchReview,
    getReviewSourceTarget,
    LocalPr,
    LocalPrRegistry,
    ReviewMode,
    ReviewSourceTarget,
    UncommittedReview,
} from '../types';
import { GitService } from '../git/gitService';
import { withFileLock } from '../workspaceComments/fileLock';

const EMPTY_REGISTRY = (): LocalPrRegistry => ({
    version: 2,
    reviews: [],
    activeMode: 'branch',
});

export class LocalPrManager {
    private registry: LocalPrRegistry = EMPTY_REGISTRY();
    /** The persisted active pointer is a startup default, not another window's authority. */
    private activeReviewId: string | undefined;
    private readonly storageDir: string;
    private readonly reviewsDir: string;
    private readonly registryPath: string;
    private readonly pendingReviewCreations = new Map<string, Promise<LocalPr>>();
    /** Destructive operations invalidate older in-flight review creations. */
    private creationEpoch = 0;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly gitService: GitService,
        workspaceRoot: string
    ) {
        this.storageDir = path.join(workspaceRoot, '.vscode', 'offline-reviews');
        this.reviewsDir = path.join(this.storageDir, 'reviews');
        this.registryPath = path.join(this.storageDir, 'registry.json');
        this.loadRegistry();
        this.activeReviewId = this.registry.activeReviewId;
    }

    private loadRegistry(strict = false): void {
        if (!fs.existsSync(this.registryPath)) {
            this.registry = EMPTY_REGISTRY();
            return;
        }

        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
            if (!isCurrentRegistry(parsed)) {
                throw new Error('Unsupported Offline Review registry format');
            }
            this.registry = parsed;
        } catch {
            if (strict) {
                throw new Error('Review registry is malformed or unreadable; refusing to overwrite it');
            }
            // Unsupported or malformed registries are ignored. This release
            // accepts only the canonical v2 format.
            this.registry = EMPTY_REGISTRY();
        }
    }

    private mutateRegistry<T>(mutation: () => T): T {
        fs.mkdirSync(this.storageDir, { recursive: true });
        let changed = false;
        const previousActive = this.activeReviewId;
        const result = withFileLock(path.join(this.storageDir, '.registry.lock'), () => {
            const previous = this.registry;
            try {
                this.loadRegistry(true);
                const before = JSON.stringify(this.registry);
                const value = mutation();
                changed = before !== JSON.stringify(this.registry);
                if (changed) {
                    this.saveRegistry();
                }
                return value;
            } catch (error) {
                this.registry = previous;
                this.activeReviewId = previousActive;
                throw error;
            }
        });
        if (changed || previousActive !== this.activeReviewId) {
            this._onDidChange.fire();
        }
        return result;
    }

    private saveRegistry(): void {
        fs.mkdirSync(this.storageDir, { recursive: true });
        const tempPath = path.join(
            this.storageDir,
            `.registry.${process.pid}.${crypto.randomUUID()}.tmp`
        );
        let descriptor: number | undefined;

        try {
            descriptor = fs.openSync(tempPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, JSON.stringify(this.registry, null, 2), 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(tempPath, this.registryPath);
        } catch (error) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                } catch {
                    // Preserve the original write failure.
                }
            }
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // The temporary file may not have been created.
            }
            throw error;
        }
    }

    async createBranchReview(
        baseBranch: string,
        targetBranch: string,
        activate: boolean = true
    ): Promise<BranchReview> {
        const review = await this.createReviewInternal(baseBranch, targetBranch, 'branch', activate);
        if (review.mode !== 'branch') {
            throw new Error('Internal review mode mismatch');
        }
        return review;
    }

    async createUncommittedReview(
        branch: string,
        activate: boolean = true
    ): Promise<UncommittedReview> {
        const review = await this.createReviewInternal(branch, branch, 'uncommitted', activate);
        if (review.mode !== 'uncommitted') {
            throw new Error('Internal review mode mismatch');
        }
        return review;
    }

    async createReview(
        sourceBranch: string,
        targetBranch: string,
        mode: 'branch'
    ): Promise<BranchReview>;
    async createReview(
        sourceBranch: string,
        targetBranch: string,
        mode: 'uncommitted'
    ): Promise<UncommittedReview>;
    async createReview(
        sourceBranch: string,
        targetBranch: string,
        mode: ReviewMode
    ): Promise<LocalPr> {
        return this.createReviewInternal(sourceBranch, targetBranch, mode, true);
    }

    private async createReviewInternal(
        sourceBranch: string,
        targetBranch: string,
        mode: ReviewMode,
        activate: boolean
    ): Promise<LocalPr> {
        if (!sourceBranch || !targetBranch) {
            throw new Error('Review branches must not be empty');
        }
        if (mode === 'uncommitted' && sourceBranch !== targetBranch) {
            throw new Error('An uncommitted review must use one branch');
        }

        this.loadRegistry(true);
        const existing = this.findReviewByIdentity(sourceBranch, targetBranch, mode);
        if (existing) {
            if (activate) {
                this.setActiveReview(existing.id);
            }
            return existing;
        }

        const identity = JSON.stringify([mode, sourceBranch, targetBranch]);
        let creation = this.pendingReviewCreations.get(identity);
        if (!creation) {
            creation = this.resolveAndStoreReview(
                sourceBranch,
                targetBranch,
                mode,
                this.creationEpoch
            );
            this.pendingReviewCreations.set(identity, creation);
        }

        let review: LocalPr;
        try {
            review = await creation;
        } finally {
            if (this.pendingReviewCreations.get(identity) === creation) {
                this.pendingReviewCreations.delete(identity);
            }
        }

        if (activate) {
            this.setActiveReview(review.id);
        }
        return review;
    }

    private async resolveAndStoreReview(
        sourceBranch: string,
        targetBranch: string,
        mode: ReviewMode,
        creationEpoch: number
    ): Promise<LocalPr> {
        let review: LocalPr;
        if (mode === 'branch') {
            const [sourceCommit, targetCommit] = await Promise.all([
                this.gitService.getCommitHash(sourceBranch),
                this.gitService.getCommitHash(targetBranch),
            ]);
            review = {
                id: crypto.randomUUID(),
                mode: 'branch',
                baseBranch: sourceBranch,
                targetBranch,
                sourceCommit: sourceCommit.trim(),
                targetCommit: targetCommit.trim(),
                createdAt: new Date().toISOString(),
            };
        } else {
            const snapshotCommit = (await this.gitService.getCommitHash(targetBranch)).trim();
            review = {
                id: crypto.randomUUID(),
                mode: 'uncommitted',
                branch: targetBranch,
                sourceCommit: snapshotCommit,
                targetCommit: snapshotCommit,
                createdAt: new Date().toISOString(),
            };
        }

        if (creationEpoch !== this.creationEpoch) {
            throw new Error('Review creation was superseded by a clear operation');
        }

        return this.mutateRegistry(() => {
            const existing = this.findReviewByIdentity(sourceBranch, targetBranch, mode);
            if (existing) {
                return existing;
            }
            this.registry.reviews.push(review);
            return review;
        });
    }

    private findReviewByIdentity(
        sourceBranch: string,
        targetBranch: string,
        mode: ReviewMode
    ): LocalPr | undefined {
        return this.registry.reviews.find(review => mode === 'branch'
            ? review.mode === 'branch'
                && review.baseBranch === sourceBranch
                && review.targetBranch === targetBranch
            : review.mode === 'uncommitted' && review.branch === targetBranch
        );
    }

    getPreferredBaseBranch(): string | undefined {
        return this.registry.preferredBaseBranch;
    }

    setPreferredBaseBranch(branch: string): void {
        if (!branch) {
            return;
        }
        this.mutateRegistry(() => { this.registry.preferredBaseBranch = branch; });
    }

    getActiveMode(): ReviewMode {
        return this.getActiveReview()?.mode ?? this.registry.activeMode;
    }

    setActiveMode(mode: ReviewMode): void {
        this.mutateRegistry(() => { this.registry.activeMode = mode; });
    }

    getReviewMode(review: LocalPr): ReviewMode {
        return review.mode;
    }

    isUncommittedReview(review?: LocalPr): review is UncommittedReview {
        return review?.mode === 'uncommitted';
    }

    getReviewSourceTarget(review: LocalPr): ReviewSourceTarget {
        return getReviewSourceTarget(review);
    }

    updateBranchReviewFallbackCommits(
        reviewId: string,
        sourceCommit: string,
        targetCommit: string
    ): boolean {
        return this.mutateRegistry(() => {
            const review = this.getReviewById(reviewId);
            if (review?.mode !== 'branch') {
                return false;
            }
            const normalizedSource = sourceCommit.trim();
            const normalizedTarget = targetCommit.trim();
            if (review.sourceCommit === normalizedSource && review.targetCommit === normalizedTarget) {
                return false;
            }
            review.sourceCommit = normalizedSource;
            review.targetCommit = normalizedTarget;
            return true;
        });
    }

    private invalidatePendingCreations(): void {
        this.creationEpoch++;
        this.pendingReviewCreations.clear();
    }

    deleteReview(id: string): void {
        if (this.activeReviewId === id) {
            this.invalidatePendingCreations();
        }
        this.mutateRegistry(() => {
            if (this.activeReviewId === id) {
                this.activeReviewId = undefined;
            }
            const review = this.getReviewById(id);
            if (!review) {
                return;
            }
            fs.rmSync(this.getReviewDir(review), { recursive: true, force: true });
            this.registry.reviews = this.registry.reviews.filter(candidate => candidate.id !== id);
            if (this.registry.activeReviewId === id) {
                this.registry.activeReviewId = undefined;
            }
        });
    }

    clearActiveReview(): boolean {
        const active = this.getActiveReview();
        if (!active) {
            return false;
        }
        this.deleteReview(active.id);
        return true;
    }

    clearAllReviews(): void {
        this.invalidatePendingCreations();
        this.mutateRegistry(() => {
            for (const review of this.registry.reviews) {
                fs.rmSync(this.getReviewDir(review), { recursive: true, force: true });
            }
            this.registry.reviews = [];
            this.registry.activeReviewId = undefined;
            this.activeReviewId = undefined;
        });
    }

    setActiveReview(id: string): boolean {
        return this.mutateRegistry(() => {
            const review = this.getReviewById(id);
            if (!review) {
                return false;
            }
            this.registry.activeReviewId = review.id;
            this.activeReviewId = review.id;
            this.registry.activeMode = review.mode;
            if (review.mode === 'branch') {
                this.registry.preferredBaseBranch = review.baseBranch;
            }
            return true;
        });
    }

    getActiveReview(): LocalPr | undefined {
        return this.activeReviewId
            ? this.getReviewById(this.activeReviewId)
            : undefined;
    }

    /** Clear only the active pointer; saved reviews and comments remain intact. */
    deactivateReview(): boolean {
        const id = this.activeReviewId;
        this.mutateRegistry(() => {
            this.activeReviewId = undefined;
            if (id === undefined || this.registry.activeReviewId !== id) {
                return false;
            }
            this.registry.activeReviewId = undefined;
            return true;
        });
        return id !== undefined;
    }

    listReviews(): LocalPr[] {
        return [...this.registry.reviews];
    }

    getReviewById(id: string): LocalPr | undefined {
        return this.registry.reviews.find(review => review.id === id);
    }

    findReviewByBranch(branch: string, mode?: ReviewMode): LocalPr | undefined {
        return this.registry.reviews.find(review => {
            if (mode && review.mode !== mode) {
                return false;
            }
            return review.mode === 'uncommitted'
                ? review.branch === branch
                : review.baseBranch === branch || review.targetBranch === branch;
        });
    }

    getReviewDir(review: LocalPr): string {
        if (!isUuid(review.id)) {
            throw new Error(`Invalid review id: ${review.id}`);
        }
        return path.join(this.reviewsDir, review.id.toLowerCase());
    }

    getCommentsFilePath(review: LocalPr): string {
        return path.join(this.getReviewDir(review), 'comments.json');
    }

    getReviewedFiles(): string[] {
        return [...(this.getActiveReview()?.reviewedFiles ?? [])];
    }

    setReviewedFiles(files: string[]): void {
        // Capture the UI's owner before reloading another window's active pointer.
        const id = this.activeReviewId;
        this.mutateRegistry(() => {
            const review = id ? this.getReviewById(id) : undefined;
            if (review) {
                review.reviewedFiles = [...files];
            }
        });
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

function isCurrentRegistry(value: unknown): value is LocalPrRegistry {
    if (!isRecord(value)
        || value.version !== 2
        || !Array.isArray(value.reviews)
        || !value.reviews.every(isCurrentReview)
        || (value.activeMode !== 'branch' && value.activeMode !== 'uncommitted')
        || (value.activeReviewId !== undefined && typeof value.activeReviewId !== 'string')
        || (value.preferredBaseBranch !== undefined
            && typeof value.preferredBaseBranch !== 'string')) {
        return false;
    }

    const ids = new Set(value.reviews.map(review => review.id));
    return ids.size === value.reviews.length
        && (value.activeReviewId === undefined || ids.has(value.activeReviewId));
}

function isCurrentReview(value: unknown): value is LocalPr {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || !isUuid(value.id)
        || typeof value.sourceCommit !== 'string'
        || typeof value.targetCommit !== 'string'
        || typeof value.createdAt !== 'string'
        || (value.reviewedFiles !== undefined
            && (!Array.isArray(value.reviewedFiles)
                || !value.reviewedFiles.every(file => typeof file === 'string')))) {
        return false;
    }

    return value.mode === 'branch'
        ? isNonEmptyString(value.baseBranch) && isNonEmptyString(value.targetBranch)
        : value.mode === 'uncommitted' && isNonEmptyString(value.branch);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
