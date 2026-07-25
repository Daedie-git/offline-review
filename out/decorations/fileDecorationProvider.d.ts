import * as vscode from 'vscode';
import { StorageService } from '../storage/storageService';
export declare class ReviewFileDecorationProvider implements vscode.FileDecorationProvider {
    private storageService;
    private _onDidChangeFileDecorations;
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    constructor(storageService: StorageService);
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
    private getUnresolvedCount;
    refresh(): void;
    dispose(): void;
}
