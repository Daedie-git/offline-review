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
exports.BranchSelectorProvider = void 0;
const vscode = __importStar(require("vscode"));
const types_1 = require("../types");
class BranchSelectorProvider {
    constructor(gitService, localPrManager) {
        this.gitService = gitService;
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.sourceBranch = '';
        this.targetBranch = '';
        this.mode = localPrManager.getActiveMode();
        this.syncFromActiveReview();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        if (this.mode === 'uncommitted') {
            return [new BranchSelectorItem('Uncommitted', this.targetBranch || '(current checkout)', 'localPrReview.reviewUncommitted', 'HEAD vs working tree')];
        }
        const selfDescription = this.sourceBranch
            && this.sourceBranch === this.targetBranch
            ? 'intentional empty self-review'
            : undefined;
        return [
            new BranchSelectorItem('Base', this.sourceBranch || '(select base branch)', 'localPrReview.reviewActiveBranch'),
            new BranchSelectorItem('Active branch', this.targetBranch || '(current checkout)', 'localPrReview.reviewActiveBranch', selfDescription),
        ];
    }
    getSourceBranch() { return this.sourceBranch; }
    getTargetBranch() { return this.targetBranch; }
    getMode() { return this.mode; }
    setSourceBranch(branch) {
        this.sourceBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }
    setTargetBranch(branch) {
        this.targetBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }
    setMode(mode) {
        this.mode = mode;
        this._onDidChangeTreeData.fire(undefined);
    }
    refresh() {
        this.syncFromActiveReview();
        this._onDidChangeTreeData.fire(undefined);
    }
    syncFromActiveReview() {
        const active = this.localPrManager.getActiveReview();
        if (!active) {
            return;
        }
        const comparison = (0, types_1.getReviewSourceTarget)(active);
        this.mode = active.mode;
        this.sourceBranch = active.mode === 'branch'
            ? active.baseBranch
            : (this.localPrManager.getPreferredBaseBranch() ?? '');
        this.targetBranch = comparison.targetBranch;
    }
    dispose() {
        // Retain the service dependency in this lightweight tree implementation;
        // the webview provider is the primary selector UI.
        void this.gitService;
        this._onDidChangeTreeData.dispose();
    }
}
exports.BranchSelectorProvider = BranchSelectorProvider;
class BranchSelectorItem extends vscode.TreeItem {
    constructor(label, branchName, commandId, detail) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = detail ? `${branchName} · ${detail}` : branchName;
        this.tooltip = detail ?? `Click to review ${branchName}`;
        this.command = { command: commandId, title: label };
        this.iconPath = new vscode.ThemeIcon('git-branch');
    }
}
//# sourceMappingURL=branchSelectorProvider.js.map