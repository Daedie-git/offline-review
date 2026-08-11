import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
/** Map only a live worktree virtual document to its captured on-disk file. */
export declare function getLiveWorktreeUri(virtualUri: vscode.Uri): vscode.Uri | undefined;
/**
 * Forward language navigation from coordinate-equivalent modified documents to
 * the corresponding file in the checkout captured by the prepared DiffPlan.
 * Immutable Git snapshots are eligible only while their exact text still
 * matches that real document; stale snapshots and original sides fail closed.
 */
export declare function registerVirtualDocLanguageFeatures(context: vscode.ExtensionContext, gitService: GitService): void;
