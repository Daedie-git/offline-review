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
exports.CommentFileItem = exports.LocalCommentsProvider = void 0;
const vscode = __importStar(require("vscode"));
class LocalCommentsProvider {
    constructor(storageService) {
        this.storageService = storageService;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        return this.storageService.getAllCommentFiles().map(file => new CommentFileItem(file));
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
exports.LocalCommentsProvider = LocalCommentsProvider;
class CommentFileItem extends vscode.TreeItem {
    constructor(discovery) {
        super(discovery.label, vscode.TreeItemCollapsibleState.None);
        this.reviewId = discovery.reviewId;
        this.mode = discovery.mode;
        this.filePath = discovery.filePath;
        const modeLabel = discovery.mode === 'uncommitted' ? 'uncommitted' : 'branch';
        this.description = discovery.isActive ? `active · ${modeLabel}` : modeLabel;
        this.tooltip = discovery.isActive
            ? `${discovery.filePath} (active ${modeLabel} review)`
            : `${discovery.filePath} (${modeLabel} review)`;
        this.iconPath = new vscode.ThemeIcon(discovery.isActive ? 'comment-discussion' : 'comment', discovery.isActive ? undefined : new vscode.ThemeColor('descriptionForeground'));
        this.contextValue = 'commentFile';
        this.command = {
            command: 'vscode.open',
            title: 'Open Comments File',
            arguments: [vscode.Uri.file(discovery.filePath)],
        };
    }
}
exports.CommentFileItem = CommentFileItem;
//# sourceMappingURL=localCommentsProvider.js.map