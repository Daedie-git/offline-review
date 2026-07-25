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
class LocalPrManager {
    constructor(gitService, workspaceRoot) {
        this.gitService = gitService;
        this.registry = { version: 1, reviews: [] };
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
        this.reviewsDir = path.join(workspaceRoot, '.vscode', 'local-reviews');
        this.registryPath = path.join(this.reviewsDir, 'registry.json');
        this.loadRegistry();
    }
    loadRegistry() {
        try {
            if (fs.existsSync(this.registryPath)) {
                const data = fs.readFileSync(this.registryPath, 'utf-8');
                this.registry = JSON.parse(data);
            }
        }
        catch {
            this.registry = { version: 1, reviews: [] };
        }
    }
    saveRegistry() {
        if (!fs.existsSync(this.reviewsDir)) {
            fs.mkdirSync(this.reviewsDir, { recursive: true });
        }
        fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2), 'utf-8');
        this._onDidChange.fire();
    }
    async createReview(sourceBranch, targetBranch) {
        // Check if review already exists for this branch pair
        const existing = this.registry.reviews.find(r => r.sourceBranch === sourceBranch && r.targetBranch === targetBranch);
        if (existing) {
            this.setActiveReview(existing.id);
            return existing;
        }
        const sourceCommit = await this.gitService.getCommitHash(sourceBranch);
        const targetCommit = await this.gitService.getCommitHash(targetBranch);
        const review = {
            id: crypto.randomUUID(),
            sourceBranch,
            targetBranch,
            sourceCommit: sourceCommit.trim(),
            targetCommit: targetCommit.trim(),
            createdAt: new Date().toISOString(),
        };
        this.registry.reviews.push(review);
        this.registry.activeReviewId = review.id;
        this.saveRegistry();
        return review;
    }
    deleteReview(id) {
        const review = this.registry.reviews.find(r => r.id === id);
        if (!review) {
            return;
        }
        // Remove comments directory
        const commentsDir = this.getReviewDir(review);
        if (fs.existsSync(commentsDir)) {
            fs.rmSync(commentsDir, { recursive: true });
        }
        this.registry.reviews = this.registry.reviews.filter(r => r.id !== id);
        if (this.registry.activeReviewId === id) {
            this.registry.activeReviewId = undefined;
        }
        this.saveRegistry();
    }
    setActiveReview(id) {
        this.registry.activeReviewId = id;
        this.saveRegistry();
    }
    getActiveReview() {
        if (!this.registry.activeReviewId) {
            return undefined;
        }
        return this.registry.reviews.find(r => r.id === this.registry.activeReviewId);
    }
    listReviews() {
        return this.registry.reviews;
    }
    findReviewByBranch(branch) {
        return this.registry.reviews.find(r => r.targetBranch === branch || r.sourceBranch === branch);
    }
    getReviewDir(review) {
        const dirName = `${review.sourceBranch}_${review.targetBranch}`.replace(/\//g, '-');
        return path.join(this.reviewsDir, dirName);
    }
    getCommentsFilePath(review) {
        return path.join(this.getReviewDir(review), 'comments.json');
    }
    getReviewedFiles() {
        const review = this.getActiveReview();
        return review?.reviewedFiles || [];
    }
    setReviewedFiles(files) {
        const review = this.getActiveReview();
        if (review) {
            review.reviewedFiles = files;
            this.saveRegistry();
        }
    }
    dispose() {
        this._onDidChange.dispose();
    }
}
exports.LocalPrManager = LocalPrManager;
//# sourceMappingURL=localPrManager.js.map