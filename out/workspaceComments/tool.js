"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceCommentsTool = void 0;
const vscode = __importStar(require("vscode"));
class WorkspaceCommentsTool {
    constructor(storage, pathResolver) {
        this.storage = storage;
        this.pathResolver = pathResolver;
    }
    async prepareInvocation(options, _token) {
        return {
            invocationMessage: 'Checking workspace code comments...',
            confirmationMessages: {
                title: 'Get Workspace Code Comments',
                message: new vscode.MarkdownString(`Retrieve workspace code comments${options.input.filePath ? ` for **${options.input.filePath}**` : ''}${options.input.state ? ` (${options.input.state} only)` : ''}?`),
            },
        };
    }
    async invoke(options, _token) {
        const { filePath, state } = options.input;
        if (filePath && this.pathResolver.normalizeStoredPath(filePath) !== filePath) {
            return textResult(JSON.stringify({
                error: 'filePath must be an exact normalized path inside the original workspace',
            }, null, 2));
        }
        const reports = this.storage.getReports();
        const filtered = reports.filter(thread => (!filePath || thread.filePath === filePath)
            && (!state || thread.state === state));
        const result = {
            workspace: {
                root: this.pathResolver.workspaceRoot,
                storage: '.vscode/local-reviews/workspace-comments.json',
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
exports.WorkspaceCommentsTool = WorkspaceCommentsTool;
function textResult(text) {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
//# sourceMappingURL=tool.js.map