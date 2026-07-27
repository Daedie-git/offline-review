import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceCommentState } from './types';
interface ToolInput {
    filePath?: string;
    state?: WorkspaceCommentState;
}
export declare class WorkspaceCommentsTool implements vscode.LanguageModelTool<ToolInput> {
    private readonly storage;
    private readonly pathResolver;
    constructor(storage: WorkspaceCommentStorage, pathResolver: WorkspacePathResolver);
    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ToolInput>, _token: vscode.CancellationToken): Promise<{
        invocationMessage: string;
        confirmationMessages: {
            title: string;
            message: vscode.MarkdownString;
        };
    }>;
    invoke(options: vscode.LanguageModelToolInvocationOptions<ToolInput>, _token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult>;
}
export {};
