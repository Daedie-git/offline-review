import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
import { LocalPr, ReviewMode } from '../types';
interface BranchSelection {
    base: string;
    compare: string;
}
interface ReviewViewState {
    review?: LocalPr;
    currentBranch?: string;
    base?: string;
    mode?: ReviewMode;
}
export declare class BranchSelectorWebviewProvider implements vscode.WebviewViewProvider {
    private readonly extensionUri;
    private readonly gitService;
    private readonly localPrManager;
    static readonly viewType = "localPrReview.branchSelector";
    private view;
    private readonly _onDidSelectBranches;
    readonly onDidSelectBranches: vscode.Event<BranchSelection>;
    private baseBranch;
    private compareBranch;
    private mode;
    private currentBranch;
    private branches;
    private stateGeneration;
    constructor(extensionUri: vscode.Uri, gitService: GitService, localPrManager: LocalPrManager);
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    private pushFullState;
    private postBranches;
    private defaultBase;
    private updateWebview;
    getSourceBranch(): string;
    getTargetBranch(): string;
    getMode(): ReviewMode;
    setSourceBranch(branch: string): void;
    setTargetBranch(branch: string): void;
    setMode(mode: ReviewMode): void;
    setReviewState(state: ReviewViewState): void;
    refresh(): void;
    private applyReview;
    dispose(): void;
    private getHtml;
}
export {};
