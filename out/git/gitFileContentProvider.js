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
exports.GitFileContentProvider = void 0;
const vscode = __importStar(require("vscode"));
const gitService_1 = require("../git/gitService");
/**
 * Provides Git-object and WORKTREE content via the review's virtual URI scheme.
 * WORKTREE URIs include the owning review UUID and prepared HEAD commit.
 */
class GitFileContentProvider {
    constructor(gitService) {
        this.gitService = gitService;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
    }
    async provideTextDocumentContent(uri) {
        const parsed = (0, gitService_1.parseDiffDocumentUri)(uri);
        if (!parsed) {
            return '';
        }
        const ref = parsed.document.kind === 'worktree'
            ? gitService_1.GitService.WORKTREE_REF
            : parsed.document.ref;
        return this.gitService.getFileContent(ref, parsed.filePath);
    }
    /** Invalidate every open WORKTREE identity for one real file. */
    refreshWorkingTreeFile(filePath) {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = (0, gitService_1.parseDiffDocumentUri)(document.uri);
            if (parsed?.document.kind === 'worktree' && parsed.filePath === filePath) {
                this._onDidChange.fire(document.uri);
            }
        }
    }
    /** Invalidate every open WORKTREE virtual document. */
    refreshAllWorkingTree() {
        for (const document of vscode.workspace.textDocuments) {
            const parsed = (0, gitService_1.parseDiffDocumentUri)(document.uri);
            if (parsed?.document.kind === 'worktree') {
                this._onDidChange.fire(document.uri);
            }
        }
    }
    dispose() {
        this._onDidChange.dispose();
    }
}
exports.GitFileContentProvider = GitFileContentProvider;
//# sourceMappingURL=gitFileContentProvider.js.map