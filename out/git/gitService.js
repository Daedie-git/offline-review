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
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("child_process"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class GitService {
    constructor(context) {
        this.context = context;
        this._onDidChangeBranch = new vscode.EventEmitter();
        this.onDidChangeBranch = this._onDidChangeBranch.event;
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
        // If repos are already available, use them
        if (api.repositories.length > 0) {
            this.repo = api.repositories[0];
            this._trackBranchChanges();
            return true;
        }
        // Wait for git extension to discover repositories (up to 10 seconds)
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                disposable.dispose();
                resolve(false);
            }, 10000);
            const disposable = api.onDidOpenRepository((repo) => {
                clearTimeout(timeout);
                disposable.dispose();
                this.repo = repo;
                this._trackBranchChanges();
                resolve(true);
            });
        });
    }
    _trackBranchChanges() {
        if (!this.repo) {
            return;
        }
        this._lastBranch = this.repo.state.HEAD?.name;
        this._lastCommit = this.repo.state.HEAD?.commit;
        this.repo.state.onDidChange(() => {
            const current = this.repo?.state.HEAD?.name;
            const currentCommit = this.repo?.state.HEAD?.commit;
            if (current && current !== this._lastBranch) {
                this._lastBranch = current;
                this._lastCommit = currentCommit;
                this._onDidChangeBranch.fire(current);
            }
            else if (currentCommit && currentCommit !== this._lastCommit) {
                this._lastCommit = currentCommit;
                this._onDidChangeHead.fire();
            }
        });
    }
    async getBranches(includeRemote = false) {
        if (!this.repo) {
            return [];
        }
        const localBranches = await this.repo.getBranches({ remote: false });
        const localNames = localBranches
            .map(b => b.name)
            .filter((name) => !!name);
        if (!includeRemote) {
            return localNames;
        }
        // Also include remote tracking branches (origin/*)
        try {
            const remoteBranches = await this.repo.getBranches({ remote: true });
            const remoteNames = remoteBranches
                .map(b => b.name)
                .filter((name) => !!name);
            const localSet = new Set(localNames);
            const uniqueRemote = remoteNames.filter(n => !localSet.has(n));
            return [...localNames, ...uniqueRemote];
        }
        catch {
            return localNames;
        }
    }
    async getCurrentBranch() {
        return this.repo?.state.HEAD?.name;
    }
    /**
     * Detect the repository's primary branch from Git metadata rather than
     * guessing branch names. A valid saved preference is handled by callers.
     */
    async getPrimaryBranch(branches, excludeBranch) {
        const available = branches || await this.getBranches(true);
        const remotes = this.repo?.state.remotes
            ?.map(remote => remote.name)
            .filter((name) => !!name) ?? [];
        const isEligible = (branch) => {
            if (!branch || !available.includes(branch)) {
                return false;
            }
            if (!excludeBranch) {
                return true;
            }
            const mirrorsExcludedBranch = remotes.some(remote => branch === `${remote}/${excludeBranch}`);
            return branch !== excludeBranch && !mirrorsExcludedBranch;
        };
        const selectRemoteHead = (remote, remoteHead) => {
            const localHead = remoteHead.startsWith(`${remote}/`)
                ? remoteHead.slice(remote.length + 1)
                : remoteHead;
            if (isEligible(localHead)) {
                return localHead;
            }
            return isEligible(remoteHead) ? remoteHead : undefined;
        };
        // `origin` is conventionally the repository's primary remote. If it is
        // absent, use the first configured remote instead of guessing a branch.
        const primaryRemote = remotes.includes('origin') ? 'origin' : remotes[0];
        if (primaryRemote) {
            try {
                const cachedHead = (await this.execGit(`symbolic-ref --quiet --short refs/remotes/${primaryRemote}/HEAD`)).trim();
                const selected = selectRemoteHead(primaryRemote, cachedHead);
                if (selected) {
                    return selected;
                }
            }
            catch {
                // The cached symbolic ref is optional; query the remote below.
            }
            try {
                const output = await this.execGitFile(['ls-remote', '--symref', primaryRemote, 'HEAD'], 3000);
                const match = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(output);
                if (match) {
                    const selected = selectRemoteHead(primaryRemote, `${primaryRemote}/${match[1]}`);
                    if (selected) {
                        return selected;
                    }
                }
            }
            catch {
                // Stay usable offline. An explicit selection may still exist.
            }
        }
        // Without remote default-branch metadata, selecting the sole other
        // local branch is unambiguous. Multiple choices require user input.
        const localBranches = await this.getBranches(false);
        const alternatives = localBranches.filter(isEligible);
        return alternatives.length === 1 ? alternatives[0] : undefined;
    }
    async getCommitHash(branch) {
        return this.execGit(`rev-parse ${branch}`);
    }
    async isCurrentBranch(branch) {
        const current = await this.getCurrentBranch();
        return current === branch;
    }
    async getChangedFiles(source, target) {
        // Same branch = review uncommitted WIP (staged + unstaged) vs HEAD.
        // Compare == current branch = include working-tree edits vs base.
        // Otherwise = commit range base...compare.
        const isWorkingTree = await this.isCurrentBranch(target);
        let diffCmd;
        if (source === target) {
            // Always HEAD vs working tree of the current checkout (mode switch, not branch identity).
            diffCmd = 'diff --name-status HEAD';
        }
        else if (isWorkingTree) {
            diffCmd = `diff --name-status ${source}`;
        }
        else {
            diffCmd = `diff --name-status ${source}...${target}`;
        }
        const output = await this.execGit(diffCmd);
        const files = [];
        if (output.trim()) {
            for (const line of output.trim().split('\n')) {
                const parts = line.split('\t');
                const statusChar = parts[0].charAt(0);
                const oldFilePath = parts.length > 2 ? parts[1] : undefined;
                const actualPath = parts.length > 2 ? parts[2] : parts[1];
                let status;
                switch (statusChar) {
                    case 'A':
                        status = 'added';
                        break;
                    case 'D':
                        status = 'deleted';
                        break;
                    case 'R':
                        status = 'renamed';
                        break;
                    default:
                        status = 'modified';
                        break;
                }
                files.push({
                    status,
                    filePath: actualPath,
                    oldFilePath: status === 'renamed' ? oldFilePath : undefined,
                });
            }
        }
        // Same-branch WIP review: also surface untracked files (git diff omits them).
        if (source === target) {
            const untracked = await this.execGit('ls-files --others --exclude-standard');
            const seen = new Set(files.map(f => f.filePath));
            for (const filePath of untracked.trim().split('\n')) {
                if (!filePath || seen.has(filePath)) {
                    continue;
                }
                files.push({ status: 'added', filePath });
            }
        }
        return files;
    }
    getFileUri(ref, filePath, side) {
        const q = new URLSearchParams({ ref });
        if (side) {
            q.set('side', side);
        }
        return vscode.Uri.parse(`git-local-review://authority/${filePath}?${q.toString()}`);
    }
    /** Virtual ref for on-disk working tree (avoids file:// so other comment providers don't compete). */
    static get WORKTREE_REF() {
        return 'WORKTREE';
    }
    getWorkingTreeFileUri(filePath) {
        return this.getFileUri(GitService.WORKTREE_REF, filePath, 'modified');
    }
    async getFileContent(ref, filePath) {
        if (ref === GitService.WORKTREE_REF) {
            try {
                const abs = path.resolve(this.workspaceRoot, filePath);
                const root = path.resolve(this.workspaceRoot);
                if (abs !== root && !abs.startsWith(root + path.sep)) {
                    return '';
                }
                return fs.readFileSync(abs, 'utf-8');
            }
            catch {
                return '';
            }
        }
        try {
            return await this.execGit(`show ${ref}:${filePath}`);
        }
        catch {
            return '';
        }
    }
    async getCommitsBetween(source, target) {
        const SEP = '---SEP---';
        const format = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI${SEP}%ar`;
        try {
            const output = await this.execGit(`log --format="${format}" ${source}..${target}`);
            if (!output.trim()) {
                return [];
            }
            return output.trim().split('\n').map(line => {
                const [hash, shortHash, message, author, date, relativeDate] = line.split(SEP);
                return { hash, shortHash, message, author, date, relativeDate };
            });
        }
        catch {
            return [];
        }
    }
    execGitFile(args, timeout = 3000) {
        return new Promise((resolve, reject) => {
            cp.execFile('git', args, {
                cwd: this.workspaceRoot,
                maxBuffer: 10 * 1024 * 1024,
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
    execGit(args) {
        return new Promise((resolve, reject) => {
            cp.exec(`git ${args}`, { cwd: this.workspaceRoot, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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
//# sourceMappingURL=gitService.js.map