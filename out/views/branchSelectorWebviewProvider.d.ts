import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
export declare class BranchSelectorWebviewProvider implements vscode.WebviewViewProvider {
    private readonly _extensionUri;
    private gitService;
    private localPrManager;
    static readonly viewType = "localPrReview.branchSelector";
    private _view?;
    private _onDidSelectBranches;
    readonly onDidSelectBranches: vscode.Event<{
        base: string;
        compare: string;
    }>;
    private baseBranch;
    private compareBranch;
    private branches;
    constructor(_extensionUri: vscode.Uri, gitService: GitService, localPrManager: LocalPrManager);
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    private _fireBranchChange;
    private _updateWebview;
    getSourceBranch(): string;
    getTargetBranch(): string;
    setSourceBranch(branch: string): void;
    setTargetBranch(branch: string): void;
    refresh(): void;
    dispose(): void;
    private _getHtml;
}
