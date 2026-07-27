import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
import { GitService } from '../git/gitService';
export declare class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly storageService;
    private readonly gitService;
    private _onDidChangeFileDecorations;
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    constructor(storageService: StorageService, gitService: GitService);
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
    private getUnresolvedCount;
    refresh(): void;
    dispose(): void;
}
