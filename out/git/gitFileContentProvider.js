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
/**
 * Provides file content from a specific git ref via a custom URI scheme.
 * URI format: git-local-review://authority/{filePath}?ref={branch}
 */
class GitFileContentProvider {
    constructor(gitService) {
        this.gitService = gitService;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
    }
    async provideTextDocumentContent(uri) {
        const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
        const params = new URLSearchParams(uri.query);
        const ref = params.get('ref');
        if (!ref) {
            return '';
        }
        return this.gitService.getFileContent(ref, filePath);
    }
    dispose() {
        this._onDidChange.dispose();
    }
}
exports.GitFileContentProvider = GitFileContentProvider;
//# sourceMappingURL=gitFileContentProvider.js.map