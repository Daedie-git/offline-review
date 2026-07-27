import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
/** Map only a live worktree virtual document to its captured on-disk file. */
export declare function getLiveWorktreeUri(virtualUri: vscode.Uri): vscode.Uri | undefined;
/**
 * Forward language navigation only from live WORKTREE documents to the
 * corresponding file captured by the prepared DiffPlan. Immutable Git snapshots
 * are not forwarded because their contents and line positions may differ from
 * every checked-out file.
 */
export declare function registerVirtualDocLanguageFeatures(context: vscode.ExtensionContext, gitService: GitService): void;
