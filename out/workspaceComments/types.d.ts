export type WorkspaceCommentState = 'resolved' | 'unresolved';
export interface WorkspaceComment {
    id: string;
    body: string;
    author: string;
    timestamp: string;
}
export interface WorkspaceCommentThread {
    id: string;
    filePath: string;
    startLine: number;
    endLine: number;
    state: WorkspaceCommentState;
    sourceAnchor: string;
    createdAt: string;
    comments: WorkspaceComment[];
}
export interface WorkspaceCommentsFile {
    version: 1;
    threads: WorkspaceCommentThread[];
}
export type WorkspacePathStatus = 'current' | 'missing' | 'unsafe';
export type WorkspaceRangeStatus = 'current' | 'stale' | 'outOfRange' | 'unavailable';
export interface WorkspaceThreadReport extends WorkspaceCommentThread {
    pathStatus: WorkspacePathStatus;
    rangeStatus: WorkspaceRangeStatus;
    stale: boolean;
}
