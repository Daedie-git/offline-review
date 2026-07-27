import * as vscode from 'vscode';
import { GitService } from '../git/gitService';
/**
 * Forward language navigation from modified-side virtual documents to the
 * corresponding file in the checkout captured by the prepared DiffPlan.
 * Original/base snapshots are never forwarded because their line positions do
 * not describe the target file.
 */
export declare function registerVirtualDocLanguageFeatures(context: vscode.ExtensionContext, gitService: GitService): void;
