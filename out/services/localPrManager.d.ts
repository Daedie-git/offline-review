import * as vscode from 'vscode';
import { LocalPr } from '../types';
import { GitService } from '../git/gitService';
export declare class LocalPrManager {
    private gitService;
    private registry;
    private registryPath;
    private reviewsDir;
    private _onDidChange;
    readonly onDidChange: vscode.Event<void>;
    constructor(gitService: GitService, workspaceRoot: string);
    private loadRegistry;
    private saveRegistry;
    createReview(sourceBranch: string, targetBranch: string): Promise<LocalPr>;
    deleteReview(id: string): void;
    setActiveReview(id: string): void;
    getActiveReview(): LocalPr | undefined;
    listReviews(): LocalPr[];
    findReviewByBranch(branch: string): LocalPr | undefined;
    getReviewDir(review: LocalPr): string;
    getCommentsFilePath(review: LocalPr): string;
    getReviewedFiles(): string[];
    setReviewedFiles(files: string[]): void;
    dispose(): void;
}
