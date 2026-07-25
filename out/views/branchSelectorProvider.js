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
class BranchSelectorProvider {
    constructor(gitService, localPrManager) {
        this.gitService = gitService;
        this.localPrManager = localPrManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.sourceBranch = 'origin/devel';
        this.targetBranch = '';
        // Sync with active review
        const active = this.localPrManager.getActiveReview();
        if (active) {
            this.sourceBranch = active.sourceBranch;
            this.targetBranch = active.targetBranch;
        }
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        return [
            new BranchSelectorItem('Base', this.sourceBranch || '(select base branch)', 'localPrReview.selectSource'),
            new BranchSelectorItem('Compare', this.targetBranch || '(select compare branch)', 'localPrReview.selectDestination'),
        ];
    }
    getSourceBranch() {
        return this.sourceBranch;
    }
    getTargetBranch() {
        return this.targetBranch;
    }
    setSourceBranch(branch) {
        this.sourceBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }
    setTargetBranch(branch) {
        this.targetBranch = branch;
        this._onDidChangeTreeData.fire(undefined);
    }
    refresh() {
        const active = this.localPrManager.getActiveReview();
        if (active) {
            this.sourceBranch = active.sourceBranch;
            this.targetBranch = active.targetBranch;
        }
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
}
exports.BranchSelectorProvider = BranchSelectorProvider;
class BranchSelectorItem extends vscode.TreeItem {
    constructor(label, branchName, commandId) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.label = label;
        this.branchName = branchName;
        this.description = branchName;
        this.tooltip = `Click to change ${label.toLowerCase()} branch`;
        this.command = {
            command: commandId,
            title: `Select ${label} Branch`,
        };
        this.iconPath = new vscode.ThemeIcon('git-branch');
    }
}
//# sourceMappingURL=branchSelectorProvider.js.map