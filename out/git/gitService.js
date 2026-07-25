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
    async getCommitHash(branch) {
        return this.execGit(`rev-parse ${branch}`);
    }
    async isCurrentBranch(branch) {
        const current = await this.getCurrentBranch();
        return current === branch;
    }
    async getChangedFiles(source, target) {
        // If target is the current branch, compare against working tree (includes uncommitted changes)
        const isWorkingTree = await this.isCurrentBranch(target);
        const diffCmd = isWorkingTree
            ? `diff --name-status ${source}`
            : `diff --name-status ${source}...${target}`;
        const output = await this.execGit(diffCmd);
        if (!output.trim()) {
            return [];
        }
        return output.trim().split('\n').map(line => {
            const parts = line.split('\t');
            const statusChar = parts[0].charAt(0);
            const filePath = parts[1];
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
            return {
                status,
                filePath: actualPath,
                oldFilePath: status === 'renamed' ? oldFilePath : undefined,
            };
        });
    }
    getFileUri(ref, filePath) {
        // Use git show to create a URI for the file at a specific ref
        return vscode.Uri.parse(`git-local-review://authority/${filePath}?ref=${encodeURIComponent(ref)}`);
    }
    async getFileContent(ref, filePath) {
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