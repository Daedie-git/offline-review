import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { GitService } from '../git/gitService';
import { ReviewAnchorResolver } from '../comments/reviewAnchorResolver';
export declare class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly gitService;
    private readonly anchorResolver?;
    private _onDidChangeFileDecorations;
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    constructor(_storageService: StorageService, gitService: GitService, anchorResolver?: ReviewAnchorResolver | undefined);
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
    private getUnresolvedCount;
    refresh(): void;
    dispose(): void;
}
