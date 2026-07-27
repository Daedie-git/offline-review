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
exports.GitService = void 0;
exports.getDiffDocumentUri = getDiffDocumentUri;
exports.parseDiffDocumentUri = parseDiffDocumentUri;
exports.getFileDiffUris = getFileDiffUris;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const MAX_GIT_OUTPUT = 10 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT = 30000;
const GIT_URI_SCHEME = 'git-local-review';
/** Build a virtual-document URI from an already resolved document decision. */
function getDiffDocumentUri(document, filePath, side, reviewId) {
    const query = new URLSearchParams({
        ref: document.kind === 'worktree' ? GitService.WORKTREE_REF : document.ref,
    });
    if (side) {
        query.set('side', side);
    }
    const ownerId = document.kind === 'worktree' ? document.reviewId : reviewId;
    if (ownerId) {
        query.set('reviewId', ownerId);
    }
    if (document.kind === 'worktree') {
        query.set('head', document.headCommit);
        query.set('planId', document.planId);
    }
    return vscode.Uri.from({
        scheme: GIT_URI_SCHEME,
        authority: 'authority',
        path: `/${filePath}`,
        query: query.toString(),
    });
}
/** Parse and validate one URI before it can reach Git or the working tree. */
function parseDiffDocumentUri(uri) {
    if (uri.scheme !== GIT_URI_SCHEME || uri.authority !== 'authority') {
        return undefined;
    }
    const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    if (!filePath) {
        return undefined;
    }
    const query = new URLSearchParams(uri.query);
    const ref = query.get('ref');
    const sideValue = query.get('side');
    if (sideValue !== null && sideValue !== 'original' && sideValue !== 'modified') {
        return undefined;
    }
    const side = sideValue ?? undefined;
    const reviewId = query.get('reviewId') ?? undefined;
    if (ref === GitService.WORKTREE_REF) {
        const headCommit = query.get('head');
        const planId = query.get('planId');
        if (side !== 'modified' || !reviewId || !isUuid(reviewId)
            || !headCommit || !isFullObjectId(headCommit)
            || !planId || !isUuid(planId)) {
            return undefined;
        }
        return {
            filePath,
            side,
            reviewId,
            document: { kind: 'worktree', reviewId, headCommit, planId },
        };
    }
    if (!ref || !isFullObjectId(ref) || (reviewId && !isUuid(reviewId))) {
        return undefined;
    }
    return {
        filePath,
        side,
        reviewId,
        document: { kind: 'git', ref },
    };
}
function getFileDiffUris(plan, change) {
    const leftPath = change.status === 'renamed' && change.oldFilePath
        ? change.oldFilePath
        : change.filePath;
    return Object.freeze({
        left: getDiffDocumentUri(plan.left, leftPath, 'original', plan.reviewId),
        right: getDiffDocumentUri(plan.right, change.filePath, 'modified', plan.reviewId),
    });
}
class GitService {
    constructor(context) {
        this.context = context;
        /** Compatibility event for named-branch checkouts. */
        this._onDidChangeBranch = new vscode.EventEmitter();
        this.onDidChangeBranch = this._onDidChangeBranch.event;
        this._onDidChangeCheckout = new vscode.EventEmitter();
        this.onDidChangeCheckout = this._onDidChangeCheckout.event;
        this._onDidChangeHead = new vscode.EventEmitter();
        this.onDidChangeHead = this._onDidChangeHead.event;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    }
    async initialize() {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            vscode.window.showErrorMessage('Git extension not found');
            return false;
        }
        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }
        const api = gitExtension.exports.getAPI(1);
        if (api.repositories.length > 0) {
            this.repo = api.repositories[0];
            this.trackBranchChanges();
            return true;
        }
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                disposable.dispose();
                resolve(false);
            }, 10000);
            const disposable = api.onDidOpenRepository((repo) => {
                clearTimeout(timeout);
                disposable.dispose();
                this.repo = repo;
                this.trackBranchChanges();
                resolve(true);
            });
        });
    }
    trackBranchChanges() {
        if (!this.repo) {
            return;
        }
        this._lastBranch = this.repo.state.HEAD?.name;
        this._lastCommit = this.repo.state.HEAD?.commit;
        const disposable = this.repo.state.onDidChange(() => {
            const currentBranch = this.repo?.state.HEAD?.name;
            const currentCommit = this.repo?.state.HEAD?.commit;
            if (currentBranch !== this._lastBranch) {
                const previousBranch = this._lastBranch;
                this._lastBranch = currentBranch;
                this._lastCommit = currentCommit;
                this._onDidChangeCheckout.fire({ previousBranch, branch: currentBranch });
                if (currentBranch !== undefined) {
                    this._onDidChangeBranch.fire(currentBranch);
                }
            }
            else if (currentCommit !== this._lastCommit) {
                this._lastCommit = currentCommit;
                this._onDidChangeHead.fire();
            }
        });
        this.context.subscriptions.push(disposable);
    }
    async getBranches(includeRemote = false) {
        if (!this.repo) {
            return [];
        }
        const localBranches = await this.repo.getBranches({ remote: false });
        const localNames = localBranches
            .map(branch => branch.name)
            .filter((name) => Boolean(name));
        if (!includeRemote) {
            return localNames;
        }
        try {
            const remoteBranches = await this.repo.getBranches({ remote: true });
            const remoteNames = remoteBranches
                .map(branch => branch.name)
                .filter((name) => Boolean(name));
            const localSet = new Set(localNames);
            return [...localNames, ...remoteNames.filter(name => !localSet.has(name))];
        }
        catch {
            return localNames;
        }
    }
    async getCurrentBranch() {
        return this.repo?.state.HEAD?.name;
    }
    /** Detect the primary branch from remote metadata without guessing names. */
    async getPrimaryBranch(branches, excludeBranch, options = {}) {
        const available = branches ?? await this.getBranches(true);
        const { allowUnavailable = false, localFallback = true } = options;
        let remotes = [];
        try {
            remotes = splitLines(await this.execGit(['remote']));
        }
        catch {
            // A repository without remotes can still use the sole-local fallback.
        }
        const isEligible = (branch) => {
            if (!branch || !available.includes(branch)) {
                return false;
            }
            if (!excludeBranch) {
                return true;
            }
            const mirrorsExcluded = remotes.some(remote => branch === `${remote}/${excludeBranch}`);
            return branch !== excludeBranch && !mirrorsExcluded;
        };
        const selectRemoteHead = (remote, remoteHead) => {
            const localHead = remoteHead.startsWith(`${remote}/`)
                ? remoteHead.slice(remote.length + 1)
                : remoteHead;
            if (isEligible(localHead)) {
                return localHead;
            }
            if (isEligible(remoteHead)) {
                return remoteHead;
            }
            return allowUnavailable && localHead !== excludeBranch ? localHead : undefined;
        };
        const primaryRemote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (primaryRemote) {
            try {
                const cachedHead = (await this.execGit([
                    'symbolic-ref',
                    '--quiet',
                    '--short',
                    `refs/remotes/${primaryRemote}/HEAD`,
                ])).trim();
                const selected = selectRemoteHead(primaryRemote, cachedHead);
                if (selected) {
                    return selected;
                }
            }
            catch {
                // The cached symbolic ref is optional.
            }
            try {
                const output = await this.execGit(['ls-remote', '--symref', primaryRemote, 'HEAD'], 3000);
                const match = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(output);
                if (match) {
                    const selected = selectRemoteHead(primaryRemote, `${primaryRemote}/${match[1]}`);
                    if (selected) {
                        return selected;
                    }
                }
            }
            catch {
                // Stay usable offline.
            }
        }
        return localFallback ? this.getSoleLocalBranch(excludeBranch) : undefined;
    }
    async getSoleLocalBranch(excludeBranch) {
        const localBranches = await this.getBranches(false);
        const alternatives = excludeBranch
            ? localBranches.filter(branch => branch !== excludeBranch)
            : localBranches;
        return alternatives.length === 1 ? alternatives[0] : undefined;
    }
    async getCommitHash(ref) {
        return this.resolveCommit(ref);
    }
    async isCurrentBranch(branch) {
        return (await this.getCurrentBranch()) === branch;
    }
    async checkoutBranch(branch) {
        if (!branch) {
            throw new Error('Cannot switch to an empty branch name');
        }
        await this.execGit(['checkout', branch]);
    }
    /** Resolve a persisted review into one explicit, immutable diff strategy. */
    async prepareDiffPlan(review) {
        if (review.mode === 'branch') {
            // Resolve branch names on every refresh so newly-created commits are
            // included, then freeze this refresh to immutable object IDs. Saved
            // commits remain a fallback for reviews whose branches were deleted.
            const [baseCommit, targetCommit] = await Promise.all([
                this.resolveCommitWithFallback(review.baseBranch, review.sourceCommit),
                this.resolveCommitWithFallback(review.targetBranch, review.targetCommit),
            ]);
            const mergeBaseCommit = (await this.execGit([
                'merge-base',
                baseCommit,
                targetCommit,
            ])).trim();
            if (!isFullObjectId(mergeBaseCommit)) {
                throw new Error('Git did not return an immutable merge-base commit');
            }
            const left = Object.freeze({ kind: 'git', ref: mergeBaseCommit });
            const right = Object.freeze({ kind: 'git', ref: targetCommit });
            return Object.freeze({
                kind: 'branch',
                reviewId: review.id,
                baseBranch: review.baseBranch,
                targetBranch: review.targetBranch,
                baseCommit,
                mergeBaseCommit,
                targetCommit,
                left,
                right,
            });
        }
        const currentBranch = await this.getCurrentBranch();
        if (!currentBranch) {
            throw new Error('Cannot review uncommitted changes from detached HEAD');
        }
        if (currentBranch !== review.branch) {
            throw new Error(`Uncommitted review is saved for branch "${review.branch}", but "${currentBranch}" is checked out`);
        }
        const headCommit = await this.resolveCommit('HEAD');
        const planId = crypto.randomUUID();
        const left = Object.freeze({ kind: 'git', ref: headCommit });
        const right = Object.freeze({
            kind: 'worktree',
            reviewId: review.id,
            headCommit,
            planId,
        });
        return Object.freeze({
            kind: 'worktree',
            reviewId: review.id,
            branch: review.branch,
            headCommit,
            planId,
            left,
            right,
        });
    }
    async getChangedFiles(plan) {
        this.assertValidPlan(plan);
        const output = plan.kind === 'branch'
            ? await this.execGit([
                'diff',
                '--no-ext-diff',
                '--name-status',
                '-z',
                '--find-renames',
                plan.mergeBaseCommit,
                plan.targetCommit,
                '--',
            ])
            : await this.execGit([
                'diff',
                '--no-ext-diff',
                '--name-status',
                '-z',
                '--find-renames',
                plan.headCommit,
                '--',
            ]);
        const files = parseNameStatus(output);
        if (plan.kind === 'worktree') {
            const untrackedOutput = await this.execGit([
                'ls-files',
                '--others',
                '--exclude-standard',
                '-z',
                '--',
            ]);
            const seen = new Set(files.map(file => file.filePath));
            for (const filePath of splitNul(untrackedOutput)) {
                if (!seen.has(filePath)) {
                    files.push({ status: 'added', filePath });
                    seen.add(filePath);
                }
            }
        }
        return files;
    }
    getFileUri(ref, filePath, side) {
        assertFullObjectId(ref, 'document ref');
        return getDiffDocumentUri({ kind: 'git', ref }, filePath, side);
    }
    getWorkingTreeFileUri(plan, filePath) {
        this.assertValidPlan(plan);
        return getDiffDocumentUri(plan.right, filePath, 'modified', plan.reviewId);
    }
    getFileDiffUris(plan, change) {
        return getFileDiffUris(plan, change);
    }
    async getFileContent(ref, filePath) {
        if (ref === GitService.WORKTREE_REF) {
            return this.getWorkingTreeFileContent(filePath);
        }
        if (!isFullObjectId(ref)) {
            return '';
        }
        try {
            return await this.execGit(['cat-file', 'blob', `${ref}:${filePath}`]);
        }
        catch {
            return '';
        }
    }
    async getCommitsForDiff(plan) {
        if (plan.kind === 'worktree') {
            return [];
        }
        return this.getCommitsBetween(plan.mergeBaseCommit, plan.targetCommit);
    }
    /** Both arguments must be immutable commit hashes. */
    async getCommitsBetween(sourceCommit, targetCommit) {
        assertFullObjectId(sourceCommit, 'source commit');
        assertFullObjectId(targetCommit, 'target commit');
        const fieldSeparator = '\u001f';
        const recordSeparator = '\u001e';
        const format = [
            '%H',
            '%h',
            '%s',
            '%an',
            '%aI',
            '%ar',
        ].join(fieldSeparator) + recordSeparator;
        try {
            const output = await this.execGit([
                'log',
                `--format=${format}`,
                `${sourceCommit}..${targetCommit}`,
                '--',
            ]);
            return output
                .split(recordSeparator)
                .map(record => record.replace(/^\n+|\n+$/g, ''))
                .filter(Boolean)
                .map(record => {
                const [hash, shortHash, message, author, date, relativeDate] = record.split(fieldSeparator);
                return { hash, shortHash, message, author, date, relativeDate };
            });
        }
        catch {
            return [];
        }
    }
    async resolveCommitWithFallback(ref, fallbackCommit) {
        try {
            return await this.resolveCommit(ref);
        }
        catch (error) {
            if (!fallbackCommit) {
                throw error;
            }
            return this.resolveCommit(fallbackCommit);
        }
    }
    async resolveCommit(ref) {
        if (!ref) {
            throw new Error('Cannot resolve an empty Git ref');
        }
        const resolved = (await this.execGit([
            'rev-parse',
            '--verify',
            '--end-of-options',
            `${ref}^{commit}`,
        ])).trim();
        if (!isFullObjectId(resolved)) {
            throw new Error(`Git ref "${ref}" did not resolve to a full commit hash`);
        }
        return resolved;
    }
    async getWorkingTreeFileContent(filePath) {
        try {
            const root = path.resolve(this.workspaceRoot);
            const absolutePath = path.resolve(root, filePath);
            if (!filePath || (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`))) {
                return '';
            }
            const stat = await fs.promises.lstat(absolutePath);
            if (stat.isSymbolicLink()) {
                return await fs.promises.readlink(absolutePath, 'utf8');
            }
            if (!stat.isFile()) {
                return '';
            }
            return await fs.promises.readFile(absolutePath, 'utf8');
        }
        catch {
            return '';
        }
    }
    assertValidPlan(plan) {
        if (plan.kind === 'branch') {
            assertFullObjectId(plan.baseCommit, 'base commit');
            assertFullObjectId(plan.mergeBaseCommit, 'merge-base commit');
            assertFullObjectId(plan.targetCommit, 'target commit');
            if (plan.left.ref !== plan.mergeBaseCommit || plan.right.ref !== plan.targetCommit) {
                throw new Error('Branch DiffPlan document refs do not match its immutable commits');
            }
            return;
        }
        assertFullObjectId(plan.headCommit, 'HEAD commit');
        if (plan.left.ref !== plan.headCommit
            || plan.right.kind !== 'worktree'
            || plan.right.reviewId !== plan.reviewId
            || plan.right.headCommit !== plan.headCommit
            || plan.right.planId !== plan.planId
            || !isUuid(plan.planId)) {
            throw new Error('Worktree DiffPlan document refs do not match its strategy');
        }
    }
    execGit(args, timeout = DEFAULT_GIT_TIMEOUT) {
        if (!this.workspaceRoot) {
            return Promise.reject(new Error('No workspace folder is open'));
        }
        return new Promise((resolve, reject) => {
            cp.execFile('git', [...args], {
                cwd: this.workspaceRoot,
                encoding: 'utf8',
                maxBuffer: MAX_GIT_OUTPUT,
                timeout,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                }
                else {
                    resolve(stdout);
                }
            });
        });
    }
}
exports.GitService = GitService;
GitService.WORKTREE_REF = 'WORKTREE';
function parseNameStatus(output) {
    const tokens = splitNul(output);
    const files = [];
    for (let index = 0; index < tokens.length;) {
        const statusToken = tokens[index++];
        const statusChar = statusToken.charAt(0);
        if (statusChar === 'R' || statusChar === 'C') {
            const oldFilePath = tokens[index++];
            const filePath = tokens[index++];
            if (oldFilePath === undefined || filePath === undefined) {
                break;
            }
            files.push(statusChar === 'R'
                ? { status: 'renamed', filePath, oldFilePath }
                : { status: 'added', filePath });
            continue;
        }
        const filePath = tokens[index++];
        if (filePath === undefined) {
            break;
        }
        files.push({ status: toFileChangeStatus(statusChar), filePath });
    }
    return files;
}
function toFileChangeStatus(statusChar) {
    switch (statusChar) {
        case 'A': return 'added';
        case 'D': return 'deleted';
        default: return 'modified';
    }
}
function splitNul(output) {
    const tokens = output.split('\0');
    if (tokens[tokens.length - 1] === '') {
        tokens.pop();
    }
    return tokens;
}
function splitLines(output) {
    return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function isFullObjectId(value) {
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function assertFullObjectId(value, label) {
    if (!isFullObjectId(value)) {
        throw new Error(`DiffPlan ${label} is not an immutable full Git object id`);
    }
}
//# sourceMappingURL=gitService.js.map