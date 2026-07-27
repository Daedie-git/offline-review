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
exports.BranchSelectorWebviewProvider = void 0;
const vscode = __importStar(require("vscode"));
class BranchSelectorWebviewProvider {
    constructor(_extensionUri, gitService, localPrManager) {
        this._extensionUri = _extensionUri;
        this.gitService = gitService;
        this.localPrManager = localPrManager;
        this._onDidSelectBranches = new vscode.EventEmitter();
        this.onDidSelectBranches = this._onDidSelectBranches.event;
        this.baseBranch = localPrManager.getPreferredBaseBranch() || '';
        this.compareBranch = '';
        this.mode = localPrManager.getActiveMode() || 'branch';
        this.currentBranch = '';
        this.branches = [];
        const active = this.localPrManager.getActiveReview();
        if (active) {
            this.baseBranch = active.sourceBranch === active.targetBranch
                ? (localPrManager.getPreferredBaseBranch() || this.baseBranch)
                : active.sourceBranch;
            this.compareBranch = active.targetBranch;
            this.mode = active.sourceBranch === active.targetBranch ? 'uncommitted' : 'branch';
        }
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'requestState': {
                    await this._pushFullState();
                    break;
                }
                case 'selectBase': {
                    this.baseBranch = message.branch;
                    this.localPrManager.setPreferredBaseBranch(message.branch);
                    this._updateWebview();
                    break;
                }
                case 'reviewUncommitted': {
                    vscode.commands.executeCommand('localPrReview.reviewUncommitted');
                    break;
                }
                case 'reviewActiveBranch': {
                    vscode.commands.executeCommand('localPrReview.reviewActiveBranch');
                    break;
                }
                case 'clearActiveReview': {
                    vscode.commands.executeCommand('localPrReview.clearActiveReview');
                    break;
                }
                case 'clearAllReviews': {
                    vscode.commands.executeCommand('localPrReview.clearAllReviews');
                    break;
                }
                case 'refreshBranches': {
                    this.branches = await this.gitService.getBranches(true);
                    webviewView.webview.postMessage({
                        type: 'branches',
                        branches: this.branches,
                    });
                    break;
                }
            }
        });
    }
    async _pushFullState() {
        this.branches = await this.gitService.getBranches(true);
        this.currentBranch = (await this.gitService.getCurrentBranch()) || '';
        if (!this.baseBranch || this.baseBranch === this.currentBranch || !this.branches.includes(this.baseBranch)) {
            this.baseBranch = await this._defaultBase(this.branches, this.currentBranch) || '';
            if (this.baseBranch) {
                this.localPrManager.setPreferredBaseBranch(this.baseBranch);
            }
        }
        this._view?.webview.postMessage({
            type: 'branches',
            branches: this.branches,
        });
        this._updateWebview();
    }
    async _defaultBase(branches, current) {
        const preferred = this.localPrManager.getPreferredBaseBranch();
        if (preferred && preferred !== current && branches.includes(preferred)) {
            return preferred;
        }
        return this.gitService.getPrimaryBranch(branches, current);
    }
    _fireBranchChange() {
        // Kept for API compatibility; mode buttons drive refresh now.
        if (this.baseBranch && this.compareBranch) {
            this._onDidSelectBranches.fire({ base: this.baseBranch, compare: this.compareBranch });
        }
        this._updateWebview();
    }
    _updateWebview() {
        this._view?.webview.postMessage({
            type: 'setState',
            base: this.baseBranch,
            compare: this.compareBranch,
            mode: this.mode,
            currentBranch: this.currentBranch,
        });
    }
    getSourceBranch() { return this.baseBranch; }
    getTargetBranch() { return this.compareBranch; }
    getMode() { return this.mode; }
    setMode(mode) {
        this.mode = mode;
        this.localPrManager.setActiveMode(mode);
        this._updateWebview();
    }
    setSourceBranch(branch) {
        this.baseBranch = branch;
        this._updateWebview();
    }
    setTargetBranch(branch) {
        this.compareBranch = branch;
        this._updateWebview();
    }
    setReviewState({ base, compare, mode, currentBranch }) {
        if (base) {
            this.baseBranch = base;
        }
        if (compare) {
            this.compareBranch = compare;
        }
        if (mode) {
            this.mode = mode;
            this.localPrManager.setActiveMode(mode);
        }
        if (currentBranch !== undefined) {
            this.currentBranch = currentBranch;
        }
        this._updateWebview();
    }
    refresh() {
        const active = this.localPrManager.getActiveReview();
        if (active) {
            const uncommitted = active.sourceBranch === active.targetBranch;
            this.mode = uncommitted ? 'uncommitted' : 'branch';
            this.localPrManager.setActiveMode(this.mode);
            if (!uncommitted) {
                this.baseBranch = active.sourceBranch;
                this.localPrManager.setPreferredBaseBranch(active.sourceBranch);
            }
            this.compareBranch = active.targetBranch;
        }
        void this._pushFullState();
    }
    dispose() {
        this._onDidSelectBranches.dispose();
    }
    _getHtml() {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 8px;
    }
    .mode-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .mode-btns {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
    }
    .mode-btn {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
        font-size: 12px;
        text-align: left;
    }
    .mode-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }
    .mode-btn.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .mode-btn .sub {
        display: block;
        margin-top: 2px;
        font-size: 11px;
        opacity: 0.8;
        font-weight: normal;
    }
    .field { margin-bottom: 8px; position: relative; }
    .field-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .branch-input-wrapper { position: relative; }
    .branch-input {
        width: 100%;
        padding: 6px 28px 6px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        outline: none;
        font-family: inherit;
        font-size: inherit;
    }
    .branch-input:focus {
        border-color: var(--vscode-focusBorder);
    }
    .dropdown-arrow {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--vscode-descriptionForeground);
        pointer-events: none;
        font-size: 10px;
    }
    .dropdown {
        display: none;
        position: absolute;
        left: 0; right: 0; top: 100%;
        z-index: 10;
        max-height: 180px;
        overflow-y: auto;
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border));
        border-radius: 2px;
        margin-top: 2px;
    }
    .dropdown.visible { display: block; }
    .dropdown-item {
        padding: 5px 8px;
        cursor: pointer;
        font-size: 12px;
    }
    .dropdown-item:hover, .dropdown-item.active {
        background: var(--vscode-list-hoverBackground);
    }
    .dropdown-item.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
    }
    .dropdown-item .remote-tag {
        margin-left: 6px;
        font-size: 10px;
        opacity: 0.7;
    }
    .status {
        margin-top: 10px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.4;
    }
    .status strong {
        color: var(--vscode-foreground);
        font-weight: 600;
    }
    .clear-row {
        display: flex;
        gap: 6px;
        margin-top: 12px;
    }
    .clear-btn {
        flex: 1;
        padding: 5px 6px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        font-size: 11px;
    }
    .clear-btn:hover {
        background: var(--vscode-toolbar-hoverBackground);
        color: var(--vscode-errorForeground, #f14c4c);
    }
    .base-field.disabled { opacity: 0.45; pointer-events: none; }
    .no-results {
        padding: 6px 8px;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        font-size: 12px;
    }
</style>
</head>
<body>
    <div class="mode-label">Review mode</div>
    <div class="mode-btns">
        <button class="mode-btn" id="btnUncommitted" type="button">
            Uncommitted
            <span class="sub">HEAD vs working tree</span>
        </button>
        <button class="mode-btn" id="btnActive" type="button">
            Active branch
            <span class="sub" id="activeSub">vs base</span>
        </button>
    </div>

    <div class="field base-field" id="baseField">
        <div class="field-label">base branch</div>
        <div class="branch-input-wrapper">
            <input class="branch-input" id="baseInput" type="text" placeholder="Select base branch..." autocomplete="off" spellcheck="false" />
            <span class="dropdown-arrow">&#9662;</span>
            <div class="dropdown" id="baseDropdown"></div>
        </div>
    </div>

    <div class="status" id="status"></div>
    <div class="clear-row">
        <button class="clear-btn" id="clearActiveBtn" type="button">Clear active</button>
        <button class="clear-btn" id="clearAllBtn" type="button">Clear all</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allBranches = [];
        let activeDropdown = null;
        let activeIndex = -1;
        let currentValue = '';
        let mode = 'branch';
        let currentBranch = '';

        const baseInput = document.getElementById('baseInput');
        const baseDropdown = document.getElementById('baseDropdown');
        const baseField = document.getElementById('baseField');
        const status = document.getElementById('status');
        const btnUncommitted = document.getElementById('btnUncommitted');
        const btnActive = document.getElementById('btnActive');
        const activeSub = document.getElementById('activeSub');

        vscode.postMessage({ type: 'requestState' });

        btnUncommitted.addEventListener('click', () => {
            vscode.postMessage({ type: 'reviewUncommitted' });
        });
        btnActive.addEventListener('click', () => {
            vscode.postMessage({ type: 'reviewActiveBranch' });
        });
        document.getElementById('clearActiveBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'clearActiveReview' });
        });
        document.getElementById('clearAllBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'clearAllReviews' });
        });

        function filterBranches(query) {
            if (!query) return allBranches.slice(0, 50);
            const lower = query.toLowerCase();
            return allBranches.filter(b => b.toLowerCase().includes(lower)).slice(0, 50);
        }

        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function renderDropdown(items, selectedValue) {
            if (items.length === 0) {
                baseDropdown.innerHTML = '<div class="no-results">No matching branches</div>';
            } else {
                baseDropdown.innerHTML = items.map((b, i) => {
                    const isRemote = b.startsWith('origin/') || b.includes('remotes/');
                    const cls = b === selectedValue ? 'dropdown-item selected' : 'dropdown-item';
                    const tag = isRemote ? '<span class="remote-tag">remote</span>' : '';
                    return '<div class="' + cls + '" data-branch="' + escapeHtml(b) + '" data-index="' + i + '">' + escapeHtml(b) + tag + '</div>';
                }).join('');
            }
            baseDropdown.classList.add('visible');
        }

        function hideDropdown() {
            baseDropdown.classList.remove('visible');
            activeDropdown = null;
            activeIndex = -1;
        }

        function selectBranch(branch) {
            currentValue = branch;
            baseInput.value = branch;
            hideDropdown();
            baseInput.blur();
            vscode.postMessage({ type: 'selectBase', branch: branch });
            updateStatus();
        }

        baseInput.addEventListener('focus', () => {
            activeDropdown = baseDropdown;
            activeIndex = -1;
            vscode.postMessage({ type: 'refreshBranches' });
            renderDropdown(filterBranches(baseInput.value), currentValue);
        });
        baseInput.addEventListener('input', () => {
            activeIndex = -1;
            renderDropdown(filterBranches(baseInput.value), currentValue);
        });
        baseInput.addEventListener('keydown', (e) => {
            const items = baseDropdown.querySelectorAll('.dropdown-item[data-branch]');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeIndex = Math.min(activeIndex + 1, items.length - 1);
                items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
                items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (activeIndex >= 0 && items[activeIndex]) {
                    selectBranch(items[activeIndex].dataset.branch);
                }
            } else if (e.key === 'Escape') {
                baseInput.value = currentValue;
                hideDropdown();
                baseInput.blur();
            }
        });
        baseDropdown.addEventListener('mousedown', (e) => e.preventDefault());
        baseDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.dropdown-item[data-branch]');
            if (item) selectBranch(item.dataset.branch);
        });
        baseInput.addEventListener('blur', () => setTimeout(hideDropdown, 150));

        function updateStatus() {
            btnUncommitted.classList.toggle('active', mode === 'uncommitted');
            btnActive.classList.toggle('active', mode === 'branch');
            baseField.classList.toggle('disabled', mode === 'uncommitted');
            activeSub.textContent = baseInput.value
                ? ('vs ' + baseInput.value)
                : 'vs base';
            if (mode === 'uncommitted') {
                status.innerHTML = 'Active: <strong>uncommitted</strong> on <strong>' +
                    escapeHtml(currentBranch || '?') + '</strong>. Comments go here.';
            } else {
                status.innerHTML = 'Active: <strong>' + escapeHtml(currentBranch || '?') +
                    '</strong> vs <strong>' + escapeHtml(baseInput.value || '?') +
                    '</strong>. Comments go here.';
            }
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.type) {
                case 'branches':
                    allBranches = msg.branches || [];
                    if (activeDropdown === baseDropdown) {
                        renderDropdown(filterBranches(baseInput.value), currentValue);
                    }
                    break;
                case 'setState':
                    if (msg.base) {
                        currentValue = msg.base;
                        baseInput.value = msg.base;
                    }
                    if (msg.mode) mode = msg.mode;
                    if (msg.currentBranch !== undefined) currentBranch = msg.currentBranch;
                    updateStatus();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
exports.BranchSelectorWebviewProvider = BranchSelectorWebviewProvider;
BranchSelectorWebviewProvider.viewType = 'localPrReview.branchSelector';
//# sourceMappingURL=branchSelectorWebviewProvider.js.map
