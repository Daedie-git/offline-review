import * as vscode from 'vscode';
import { WorkspacePathResolver } from './pathResolver';
import { WorkspaceCommentStorage } from './storage';
import { WorkspaceCommentState } from './types';

interface ToolInput {
    filePath?: string;
    state?: WorkspaceCommentState;
}

export class WorkspaceCommentsTool implements vscode.LanguageModelTool<ToolInput> {
    constructor(
        private readonly storage: WorkspaceCommentStorage,
        private readonly pathResolver: WorkspacePathResolver
    ) {}

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ToolInput>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: 'Checking workspace code comments...',
            confirmationMessages: {
                title: 'Get Workspace Code Comments',
                message: new vscode.MarkdownString(
                    `Retrieve workspace code comments${
                        options.input.filePath ? ` for **${options.input.filePath}**` : ''
                    }${options.input.state ? ` (${options.input.state} only)` : ''}?`
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ToolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, state } = options.input;
        if (filePath && this.pathResolver.normalizeStoredPath(filePath) !== filePath) {
            return textResult(JSON.stringify({
                error: 'filePath must be an exact normalized path inside the original workspace',
            }, null, 2));
        }
        const reports = this.storage.getReports();
        const filtered = reports.filter(thread =>
            (!filePath || thread.filePath === filePath)
            && (!state || thread.state === state)
        );
        const result = {
            workspace: {
                root: this.pathResolver.workspaceRoot,
                storage: '.vscode/offline-reviews/workspace-comments.json',
            },
            totalThreads: reports.length,
            unresolvedCount: reports.filter(thread => thread.state === 'unresolved').length,
            resolvedCount: reports.filter(thread => thread.state === 'resolved').length,
            matchedThreads: filtered.length,
            threads: filtered.map(thread => ({
                id: thread.id,
                filePath: thread.filePath,
                authoredStartLine: thread.startLine,
                authoredEndLine: thread.endLine,
                effectiveStartLine: thread.effectiveStartLine,
                effectiveEndLine: thread.effectiveEndLine,
                state: thread.state,
                sourceAnchor: thread.sourceAnchor,
                createdAt: thread.createdAt,
                pathStatus: thread.pathStatus,
                anchorStatus: thread.anchorStatus,
                rangeStatus: thread.rangeStatus,
                matches: thread.matches,
                missing: thread.pathStatus === 'missing',
                stale: thread.stale,
                ambiguous: thread.anchorStatus === 'ambiguous',
                reanchored: thread.anchorStatus === 'reanchored',
                comments: thread.comments.map(comment => ({
                    id: comment.id,
                    author: comment.author,
                    body: comment.body,
                    timestamp: comment.timestamp,
                })),
            })),
        };
        return textResult(JSON.stringify(result, null, 2));
    }
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
