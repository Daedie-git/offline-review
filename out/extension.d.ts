import * as vscode from 'vscode';
import { WorkspaceCommentController } from './workspaceComments/controller';
export declare function activate(context: vscode.ExtensionContext): Promise<void>;
export declare function addOrReplyWorkspaceComment(controller: WorkspaceCommentController, reply: vscode.CommentReply): Promise<void>;
export declare function deactivate(): void;
