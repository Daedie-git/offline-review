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
exports.LocalPrManager = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const types_1 = require("../types");
const EMPTY_REGISTRY = () => ({
    version: 2,
    reviews: [],
    activeMode: 'branch',
});
class LocalPrManager {
    constructor(gitService, workspaceRoot) {
        this.gitService = gitService;
        this.registry = EMPTY_REGISTRY();
        this.pendingReviewCreations = new Map();
        /** Destructive operations invalidate older in-flight review creations. */
        this.creationEpoch = 0;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
        this.storageDir = path.join(workspaceRoot, '.vscode', 'local-reviews');
        this.reviewsDir = path.join(this.storageDir, 'reviews');
        this.registryPath = path.join(this.storageDir, 'registry.json');
        this.loadRegistry();
    }
    loadRegistry() {
        if (!fs.existsSync(this.registryPath)) {
            return;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
            if (!isCurrentRegistry(parsed)) {
                throw new Error('Unsupported Offline Review registry format');
            }
            this.registry = parsed;
        }
        catch {
            // Unsupported or malformed registries are ignored. This release
            // accepts only the canonical v2 format.
            this.registry = EMPTY_REGISTRY();
        }
    }
    saveRegistry(emitChange = true) {
        fs.mkdirSync(this.storageDir, { recursive: true });
        const tempPath = path.join(this.storageDir, `.registry.${process.pid}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        try {
            descriptor = fs.openSync(tempPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, JSON.stringify(this.registry, null, 2), 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(tempPath, this.registryPath);
        }
        catch (error) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                }
                catch {
                    // Preserve the original write failure.
                }
            }
            try {
                fs.unlinkSync(tempPath);
            }
            catch {
                // The temporary file may not have been created.
            }
            throw error;
        }
        if (emitChange) {
            this._onDidChange.fire();
        }
    }
    async createBranchReview(baseBranch, targetBranch, activate = true) {
        const review = await this.createReviewInternal(baseBranch, targetBranch, 'branch', activate);
        if (review.mode !== 'branch') {
            throw new Error('Internal review mode mismatch');
        }
        return review;
    }
    async createUncommittedReview(branch, activate = true) {
        const review = await this.createReviewInternal(branch, branch, 'uncommitted', activate);
        if (review.mode !== 'uncommitted') {
            throw new Error('Internal review mode mismatch');
        }
        return review;
    }
    async createReview(sourceBranch, targetBranch, mode) {
        return this.createReviewInternal(sourceBranch, targetBranch, mode, true);
    }
    async createReviewInternal(sourceBranch, targetBranch, mode, activate) {
        if (!sourceBranch || !targetBranch) {
            throw new Error('Review branches must not be empty');
        }
        if (mode === 'uncommitted' && sourceBranch !== targetBranch) {
            throw new Error('An uncommitted review must use one branch');
        }
        const existing = this.findReviewByIdentity(sourceBranch, targetBranch, mode);
        if (existing) {
            if (activate) {
                this.activateReview(existing);
            }
            return existing;
        }
        const identity = JSON.stringify([mode, sourceBranch, targetBranch]);
        let creation = this.pendingReviewCreations.get(identity);
        if (!creation) {
            creation = this.resolveAndStoreReview(sourceBranch, targetBranch, mode, this.creationEpoch);
            this.pendingReviewCreations.set(identity, creation);
        }
        let review;
        try {
            review = await creation;
        }
        finally {
            if (this.pendingReviewCreations.get(identity) === creation) {
                this.pendingReviewCreations.delete(identity);
            }
        }
        if (activate) {
            this.activateReview(review);
        }
        return review;
    }
    async resolveAndStoreReview(sourceBranch, targetBranch, mode, creationEpoch) {
        let review;
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
        }
        else {
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
        const existing = this.findReviewByIdentity(sourceBranch, targetBranch, mode);
        if (existing) {
            return existing;
        }
        this.registry.reviews.push(review);
        this.saveRegistry();
        return review;
    }
    findReviewByIdentity(sourceBranch, targetBranch, mode) {
        return this.registry.reviews.find(review => mode === 'branch'
            ? review.mode === 'branch'
                && review.baseBranch === sourceBranch
                && review.targetBranch === targetBranch
            : review.mode === 'uncommitted' && review.branch === targetBranch);
    }
    getPreferredBaseBranch() {
        return this.registry.preferredBaseBranch;
    }
    setPreferredBaseBranch(branch) {
        if (!branch || this.registry.preferredBaseBranch === branch) {
            return;
        }
        this.registry.preferredBaseBranch = branch;
        this.saveRegistry();
    }
    getActiveMode() {
        return this.registry.activeMode;
    }
    setActiveMode(mode) {
        if (this.registry.activeMode === mode) {
            return;
        }
        this.registry.activeMode = mode;
        this.saveRegistry();
    }
    getReviewMode(review) {
        return review.mode;
    }
    isUncommittedReview(review) {
        return review?.mode === 'uncommitted';
    }
    getReviewSourceTarget(review) {
        return (0, types_1.getReviewSourceTarget)(review);
    }
    updateBranchReviewFallbackCommits(reviewId, sourceCommit, targetCommit) {
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
        this.saveRegistry();
        return true;
    }
    invalidatePendingCreations() {
        this.creationEpoch++;
        this.pendingReviewCreations.clear();
    }
    deleteReview(id) {
        const review = this.getReviewById(id);
        if (!review) {
            return;
        }
        const deletingActive = this.registry.activeReviewId === id;
        if (deletingActive) {
            this.invalidatePendingCreations();
        }
        fs.rmSync(this.getReviewDir(review), { recursive: true, force: true });
        this.registry.reviews = this.registry.reviews.filter(candidate => candidate.id !== id);
        if (deletingActive) {
            this.registry.activeReviewId = undefined;
        }
        this.saveRegistry();
    }
    clearActiveReview() {
        const active = this.getActiveReview();
        if (!active) {
            return false;
        }
        this.deleteReview(active.id);
        return true;
    }
    clearAllReviews() {
        this.invalidatePendingCreations();
        for (const review of this.registry.reviews) {
            fs.rmSync(this.getReviewDir(review), { recursive: true, force: true });
        }
        this.registry.reviews = [];
        this.registry.activeReviewId = undefined;
        this.saveRegistry();
    }
    setActiveReview(id) {
        const review = this.getReviewById(id);
        if (!review) {
            return;
        }
        const changed = this.registry.activeReviewId !== id
            || this.registry.activeMode !== review.mode
            || (review.mode === 'branch'
                && this.registry.preferredBaseBranch !== review.baseBranch);
        if (changed) {
            this.activateReview(review);
        }
    }
    activateReview(review) {
        this.registry.activeReviewId = review.id;
        this.registry.activeMode = review.mode;
        if (review.mode === 'branch') {
            this.registry.preferredBaseBranch = review.baseBranch;
        }
        this.saveRegistry();
    }
    getActiveReview() {
        return this.registry.activeReviewId
            ? this.getReviewById(this.registry.activeReviewId)
            : undefined;
    }
    /** Clear only the active pointer; saved reviews and comments remain intact. */
    deactivateReview() {
        if (this.registry.activeReviewId === undefined) {
            return false;
        }
        this.registry.activeReviewId = undefined;
        this.saveRegistry();
        return true;
    }
    listReviews() {
        return [...this.registry.reviews];
    }
    getReviewById(id) {
        return this.registry.reviews.find(review => review.id === id);
    }
    findReviewByBranch(branch, mode) {
        return this.registry.reviews.find(review => {
            if (mode && review.mode !== mode) {
                return false;
            }
            return review.mode === 'uncommitted'
                ? review.branch === branch
                : review.baseBranch === branch || review.targetBranch === branch;
        });
    }
    getReviewDir(review) {
        if (!isUuid(review.id)) {
            throw new Error(`Invalid review id: ${review.id}`);
        }
        return path.join(this.reviewsDir, review.id.toLowerCase());
    }
    getCommentsFilePath(review) {
        return path.join(this.getReviewDir(review), 'comments.json');
    }
    getReviewedFiles() {
        return [...(this.getActiveReview()?.reviewedFiles ?? [])];
    }
    setReviewedFiles(files) {
        const review = this.getActiveReview();
        if (review) {
            review.reviewedFiles = [...files];
            this.saveRegistry();
        }
    }
    dispose() {
        this._onDidChange.dispose();
    }
}
exports.LocalPrManager = LocalPrManager;
function isCurrentRegistry(value) {
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
function isCurrentReview(value) {
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
//# sourceMappingURL=localPrManager.js.map