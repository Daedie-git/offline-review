import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
import { StorageService } from '../storage/storageService';
interface ToolInput {
    filePath?: string;
    state?: 'resolved' | 'unresolved';
}
export declare class LocalReviewTool implements vscode.LanguageModelTool<ToolInput> {
    private gitService;
    private localPrManager;
    private storageService;
    constructor(gitService: GitService, localPrManager: LocalPrManager, storageService: StorageService);
    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ToolInput>, _token: vscode.CancellationToken): Promise<{
        invocationMessage: string;
        confirmationMessages: {
            title: string;
            message: vscode.MarkdownString;
        };
    }>;
    invoke(options: vscode.LanguageModelToolInvocationOptions<ToolInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult>;
    private resolveReview;
}
export {};
