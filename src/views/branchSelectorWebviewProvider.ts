import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
import { LocalPrManager } from '../services/localPrManager';
import { GitWorktreeInfo, LocalPr, ReviewMode } from '../types';

interface BranchSelection {
    base: string;
    compare: string;
}

interface ReviewViewState {
    review?: LocalPr;
    currentBranch?: string;
    base?: string;
    compare?: string;
    mode?: ReviewMode;
}

export class BranchSelectorWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'localPrReview.branchSelector';

    private view: vscode.WebviewView | undefined;
    private readonly _onDidSelectBranches = new vscode.EventEmitter<BranchSelection>();
    readonly onDidSelectBranches = this._onDidSelectBranches.event;

    private baseBranch: string;
    private compareBranch = '';
    private mode: ReviewMode;
    private currentBranch = '';
    private branches: string[] = [];
    private worktrees: GitWorktreeInfo[] = [];
    private stateGeneration = 0;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitService: GitService,
        private readonly localPrManager: LocalPrManager
    ) {
        this.baseBranch = localPrManager.getPreferredBaseBranch() ?? '';
        this.mode = localPrManager.getActiveMode();
        this.applyReview(localPrManager.getActiveReview());
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
            if (!isWebviewMessage(message)) {
                return;
            }
            switch (message.type) {
                case 'requestState':
                    await this.pushFullState();
                    break;
                case 'selectWorktree':
                    if (typeof message.root === 'string' && message.root) {
                        try {
                            await this.gitService.selectWorktree(message.root);
                        } catch (error: unknown) {
                            vscode.window.showErrorMessage(
                                `Could not select Git worktree: ${errorMessage(error)}`
                            );
                        }
                        await this.pushFullState();
                    }
                    break;
                case 'selectBase':
                    if (typeof message.branch === 'string' && message.branch) {
                        this.stateGeneration++;
                        this.baseBranch = message.branch;
                        this.localPrManager.setPreferredBaseBranch(message.branch);
                        this._onDidSelectBranches.fire({
                            base: this.baseBranch,
                            compare: this.compareBranch,
                        });
                        this.updateWebview();
                    }
                    break;
                case 'reviewUncommitted':
                    await vscode.commands.executeCommand('localPrReview.reviewUncommitted');
                    break;
                case 'reviewActiveBranch':
                    await vscode.commands.executeCommand('localPrReview.reviewActiveBranch');
                    break;
                case 'refreshBranches':
                    await this.postBranches();
                    break;
                case 'refreshWorktrees':
                    await this.postWorktrees();
                    break;
            }
        });
        void this.extensionUri;
    }

    private async pushFullState(): Promise<void> {
        const generation = ++this.stateGeneration;
        const [branches, currentBranch, worktrees] = await Promise.all([
            this.gitService.getBranches(true),
            this.gitService.getCurrentBranch(),
            this.gitService.listWorktrees(),
        ]);
        if (generation !== this.stateGeneration) {
            return;
        }
        this.branches = branches;
        this.worktrees = worktrees;
        this.currentBranch = currentBranch ?? '';
        if (!this.baseBranch || !this.branches.includes(this.baseBranch)) {
            const base = await this.defaultBase(this.branches, this.currentBranch) ?? '';
            if (generation !== this.stateGeneration) {
                return;
            }
            this.baseBranch = base;
            if (base) {
                this.localPrManager.setPreferredBaseBranch(base);
            }
        }
        await Promise.all([
            this.view?.webview.postMessage({ type: 'branches', branches: this.branches }),
            this.postWorktrees(false),
        ]);
        if (generation === this.stateGeneration) {
            this.updateWebview();
        }
    }

    private async postBranches(): Promise<void> {
        this.branches = await this.gitService.getBranches(true);
        await this.view?.webview.postMessage({ type: 'branches', branches: this.branches });
    }

    private async postWorktrees(refresh: boolean = true): Promise<void> {
        if (refresh) {
            const generation = ++this.stateGeneration;
            const worktrees = await this.gitService.listWorktrees();
            if (generation !== this.stateGeneration) {
                return;
            }
            this.worktrees = worktrees;
        }
        let selectedRoot = this.gitService.getSelectedWorktreeRoot();
        if (!this.worktrees.some(worktree => worktree.root === selectedRoot)) {
            const local = this.worktrees.find(worktree => worktree.isLocal);
            if (local) {
                vscode.window.showErrorMessage(
                    `The selected Git worktree is no longer linked: ${selectedRoot}. Returning to Local.`
                );
                await this.gitService.selectWorktree(local.root);
                selectedRoot = this.gitService.getSelectedWorktreeRoot();
            }
        }
        await this.view?.webview.postMessage({
            type: 'worktrees',
            worktrees: this.worktrees,
            selectedRoot,
        });
    }

    private async defaultBase(branches: string[], current: string): Promise<string | undefined> {
        const preferred = this.localPrManager.getPreferredBaseBranch();
        if (preferred && branches.includes(preferred)) {
            return preferred;
        }
        const primary = await this.gitService.getPrimaryBranch(branches, undefined, {
            allowUnavailable: false,
            localFallback: false,
        });
        if (primary) {
            return primary;
        }
        return this.gitService.getSoleLocalBranch(current);
    }

    private updateWebview(): void {
        void this.view?.webview.postMessage({
            type: 'setState',
            base: this.baseBranch,
            compare: this.compareBranch,
            mode: this.mode,
            currentBranch: this.currentBranch,
            selectedWorktreeRoot: this.gitService.getSelectedWorktreeRoot(),
        });
    }

    getSourceBranch(): string { return this.baseBranch; }
    getTargetBranch(): string { return this.compareBranch; }
    getMode(): ReviewMode { return this.mode; }

    setSourceBranch(branch: string): void {
        this.stateGeneration++;
        this.baseBranch = branch;
        this.updateWebview();
    }

    setTargetBranch(branch: string): void {
        this.stateGeneration++;
        this.compareBranch = branch;
        this.updateWebview();
    }

    setMode(mode: ReviewMode): void {
        this.stateGeneration++;
        this.mode = mode;
        this.updateWebview();
    }

    setReviewState(state: ReviewViewState): void {
        this.stateGeneration++;
        if (state.review) {
            this.applyReview(state.review);
        }
        if (state.base !== undefined) {
            this.baseBranch = state.base;
        }
        if (state.compare !== undefined) {
            this.compareBranch = state.compare;
        }
        if (state.mode) {
            this.mode = state.mode;
        }
        if (state.currentBranch !== undefined) {
            this.currentBranch = state.currentBranch;
        }
        this.updateWebview();
    }

    refresh(): void {
        this.applyReview(this.localPrManager.getActiveReview());
        void this.pushFullState();
    }

    private applyReview(review: LocalPr | undefined): void {
        if (!review) {
            return;
        }
        this.mode = review.mode;
        if (review.mode === 'branch') {
            this.baseBranch = review.baseBranch;
            this.compareBranch = review.targetBranch;
        } else {
            this.baseBranch = this.localPrManager.getPreferredBaseBranch() ?? this.baseBranch;
            this.compareBranch = review.branch;
        }
    }

    dispose(): void {
        this._onDidSelectBranches.dispose();
    }

    private getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
    .mode-label, .field-label { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; }
    .mode-label { margin-bottom: 6px; }
    .worktree-field { margin-bottom: 12px; }
    .worktree-select { width: 100%; margin-top: 4px; padding: 5px 7px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); font: inherit; }
    .mode-btns { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
    .mode-btn { width: 100%; padding: 8px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 12px; text-align: left; }
    .mode-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .mode-btn .sub { display: block; margin-top: 2px; font-size: 11px; opacity: .8; }
    .field { margin-bottom: 8px; position: relative; }
    .field-label { margin-bottom: 4px; }
    .branch-input-wrapper { position: relative; }
    .branch-input { width: 100%; padding: 6px 28px 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; font: inherit; }
    .branch-input:focus { border-color: var(--vscode-focusBorder); }
    .dropdown-arrow { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--vscode-descriptionForeground); pointer-events: none; font-size: 10px; }
    .dropdown { display: none; position: absolute; left: 0; right: 0; top: 100%; z-index: 10; max-height: 180px; overflow-y: auto; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border)); margin-top: 2px; }
    .dropdown.visible { display: block; }
    .dropdown-item { padding: 5px 8px; cursor: pointer; font-size: 12px; }
    .dropdown-item:hover, .dropdown-item.active { background: var(--vscode-list-hoverBackground); }
    .dropdown-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .remote-tag { margin-left: 6px; font-size: 10px; opacity: .7; }
    .status { margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .status strong { color: var(--vscode-foreground); font-weight: 600; }
    .base-field.disabled { opacity: .45; pointer-events: none; }
    .no-results { padding: 6px 8px; color: var(--vscode-descriptionForeground); font-style: italic; font-size: 12px; }
</style>
</head>
<body>
    <div class="worktree-field">
        <div class="field-label">Git worktree</div>
        <select class="worktree-select" id="worktreeSelect" aria-label="Git worktree"></select>
    </div>
    <div class="mode-label">Review mode</div>
    <div class="mode-btns">
        <button class="mode-btn" id="btnUncommitted" type="button">Uncommitted<span class="sub">HEAD vs working tree</span></button>
        <button class="mode-btn" id="btnActive" type="button">Active branch<span class="sub" id="activeSub">vs base</span></button>
    </div>
    <div class="field base-field" id="baseField">
        <div class="field-label">base branch</div>
        <div class="branch-input-wrapper">
            <input class="branch-input" id="baseInput" type="text" placeholder="Select base branch..." autocomplete="off" spellcheck="false" />
            <span class="dropdown-arrow">&#9662;</span><div class="dropdown" id="baseDropdown"></div>
        </div>
    </div>
    <div class="status" id="status"></div>
<script>
    const vscode = acquireVsCodeApi();
    let allBranches = [], allWorktrees = [], selectedWorktreeRoot = '', activeIndex = -1, currentValue = '', mode = 'branch', currentBranch = '', compareBranch = '';
    const worktreeSelect = document.getElementById('worktreeSelect');
    const baseInput = document.getElementById('baseInput');
    const baseDropdown = document.getElementById('baseDropdown');
    const baseField = document.getElementById('baseField');
    const status = document.getElementById('status');
    const btnUncommitted = document.getElementById('btnUncommitted');
    const btnActive = document.getElementById('btnActive');
    const activeSub = document.getElementById('activeSub');
    vscode.postMessage({ type: 'requestState' });
    worktreeSelect.onfocus = () => vscode.postMessage({ type: 'refreshWorktrees' });
    worktreeSelect.onchange = () => {
        const root = worktreeSelect.value;
        if (root && root !== selectedWorktreeRoot) vscode.postMessage({ type: 'selectWorktree', root });
    };
    btnUncommitted.onclick = () => vscode.postMessage({ type: 'reviewUncommitted' });
    btnActive.onclick = () => vscode.postMessage({ type: 'reviewActiveBranch' });
    const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const filtered = query => { const q = query.toLowerCase(); return allBranches.filter(branch => !q || branch.toLowerCase().includes(q)).slice(0, 50); };
    function render() {
        const items = filtered(baseInput.value);
        baseDropdown.innerHTML = items.length ? items.map((branch, index) => '<div class="dropdown-item' + (branch === currentValue ? ' selected' : '') + '" data-index="' + index + '" data-branch="' + escapeHtml(branch) + '">' + escapeHtml(branch) + (branch.includes('/') ? '<span class="remote-tag">remote</span>' : '') + '</div>').join('') : '<div class="no-results">No matching branches</div>';
        baseDropdown.classList.add('visible');
    }
    function hide() { baseDropdown.classList.remove('visible'); activeIndex = -1; }
    function select(branch) { currentValue = branch; baseInput.value = branch; hide(); baseInput.blur(); vscode.postMessage({ type: 'selectBase', branch }); updateStatus(); }
    baseInput.onfocus = () => { activeIndex = -1; vscode.postMessage({ type: 'refreshBranches' }); render(); };
    baseInput.oninput = render;
    baseInput.onblur = () => setTimeout(hide, 150);
    baseInput.onkeydown = event => {
        const items = [...baseDropdown.querySelectorAll('.dropdown-item[data-branch]')];
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activeIndex = Math.max(0, Math.min(items.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1))); items.forEach((item, index) => item.classList.toggle('active', index === activeIndex)); }
        else if (event.key === 'Enter' && items[activeIndex]) { event.preventDefault(); select(items[activeIndex].dataset.branch); }
        else if (event.key === 'Escape') { baseInput.value = currentValue; hide(); baseInput.blur(); }
    };
    baseDropdown.onmousedown = event => event.preventDefault();
    baseDropdown.onclick = event => { const item = event.target.closest('.dropdown-item[data-branch]'); if (item) select(item.dataset.branch); };
    function renderWorktrees() {
        worktreeSelect.replaceChildren(...allWorktrees.map(worktree => {
            const option = document.createElement('option');
            option.value = worktree.root;
            const state = worktree.detached
                ? 'detached @ ' + String(worktree.headCommit || '').slice(0, 8)
                : (worktree.branch || 'unknown branch');
            option.textContent = (worktree.isLocal ? 'Local — ' : '') + state + ' — ' + worktree.root;
            return option;
        }));
        worktreeSelect.value = selectedWorktreeRoot;
        worktreeSelect.disabled = allWorktrees.length === 0;
    }
    function updateStatus() {
        btnUncommitted.classList.toggle('active', mode === 'uncommitted');
        btnActive.classList.toggle('active', mode === 'branch');
        baseField.classList.toggle('disabled', mode === 'uncommitted');
        activeSub.textContent = baseInput.value ? 'vs ' + baseInput.value : 'vs base';
        if (mode === 'uncommitted') status.innerHTML = 'Active: <strong>uncommitted</strong> on <strong>' + escapeHtml(compareBranch || currentBranch || '?') + '</strong>. Comments stay with this review.';
        else if ((compareBranch || currentBranch) && baseInput.value === (compareBranch || currentBranch)) status.innerHTML = '<strong>Primary branch self-review</strong>: intentionally empty. Use Uncommitted for working-tree changes.';
        else status.innerHTML = 'Active: <strong>' + escapeHtml(compareBranch || currentBranch || '?') + '</strong> vs <strong>' + escapeHtml(baseInput.value || '?') + '</strong>. Saved branch reviews work from any checkout.';
    }
    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'branches') { allBranches = msg.branches || []; if (baseDropdown.classList.contains('visible')) render(); }
        if (msg.type === 'worktrees') { allWorktrees = msg.worktrees || []; selectedWorktreeRoot = msg.selectedRoot || ''; renderWorktrees(); }
        if (msg.type === 'setState') { if (msg.base !== undefined) { currentValue = msg.base || ''; baseInput.value = currentValue; } if (msg.mode) mode = msg.mode; if (msg.currentBranch !== undefined) currentBranch = msg.currentBranch; if (msg.compare !== undefined) compareBranch = msg.compare || ''; if (msg.selectedWorktreeRoot !== undefined) { selectedWorktreeRoot = msg.selectedWorktreeRoot || ''; renderWorktrees(); } updateStatus(); }
    });
</script>
</body>
</html>`;
    }
}

interface WebviewMessage {
    type: 'requestState' | 'selectWorktree' | 'selectBase' | 'reviewUncommitted'
        | 'reviewActiveBranch' | 'refreshBranches' | 'refreshWorktrees';
    branch?: unknown;
    root?: unknown;
}

function isWebviewMessage(value: unknown): value is WebviewMessage {
    return typeof value === 'object' && value !== null && 'type' in value
        && typeof (value as { type?: unknown }).type === 'string';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
