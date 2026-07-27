import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
import { StorageService } from '../storage/storageService';
import { ReviewAnchorResolver } from '../comments/reviewAnchorResolver';
interface ToolInput {
    filePath?: string;
    state?: 'resolved' | 'unresolved';
}
export declare class LocalReviewTool implements vscode.LanguageModelTool<ToolInput> {
    private readonly gitService;
    private readonly localPrManager;
    private readonly storageService;
    private readonly anchorResolver?;
    constructor(gitService: GitService, localPrManager: LocalPrManager, storageService: StorageService, anchorResolver?: ReviewAnchorResolver | undefined);
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
