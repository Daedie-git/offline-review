import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
/**
 * Provides file content from a specific git ref via a custom URI scheme.
 * URI format: git-local-review://authority/{filePath}?ref={branch}
 */
export declare class GitFileContentProvider implements vscode.TextDocumentContentProvider {
    private gitService;
    private _onDidChange;
    readonly onDidChange: vscode.Event<vscode.Uri>;
    constructor(gitService: GitService);
    provideTextDocumentContent(uri: vscode.Uri): Promise<string>;
    dispose(): void;
}
