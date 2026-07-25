import * as vscode from 'vscode';
import { FileChange, CommitInfo } from '../types';
export declare class GitService {
    private context;
    private repo;
    private workspaceRoot;
    private _onDidChangeBranch;
    readonly onDidChangeBranch: vscode.Event<string>;
    private _onDidChangeHead;
    readonly onDidChangeHead: vscode.Event<void>;
    private _lastBranch;
    private _lastCommit;
    constructor(context: vscode.ExtensionContext);
    initialize(): Promise<boolean>;
    private _trackBranchChanges;
    getBranches(includeRemote?: boolean): Promise<string[]>;
    getCurrentBranch(): Promise<string | undefined>;
    getCommitHash(branch: string): Promise<string>;
    isCurrentBranch(branch: string): Promise<boolean>;
    getChangedFiles(source: string, target: string): Promise<FileChange[]>;
    getFileUri(ref: string, filePath: string): vscode.Uri;
    getFileContent(ref: string, filePath: string): Promise<string>;
    getCommitsBetween(source: string, target: string): Promise<CommitInfo[]>;
    private execGit;
}
