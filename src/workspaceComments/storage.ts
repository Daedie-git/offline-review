import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { withFileLock } from './fileLock';
import { WorkspacePathResolver } from './pathResolver';
import { assertOrdinaryPath, canonicalPath, sameCanonicalPath } from './safeFilesystem';
import {
    WorkspaceComment,
    WorkspaceCommentsFile,
    WorkspaceCommentState,
    WorkspaceCommentThread,
    WorkspaceThreadReport,
} from './types';

interface LoadedSnapshot {
    readonly comments: WorkspaceCommentsFile;
    readonly fingerprint: string;
}

interface RecoveryEntries {
    readonly backups: readonly string[];
    readonly temporaries: readonly string[];
}

interface StorageDirectory {
    readonly path: string;
    readonly descriptor: number;
    readonly operationPath: string;
    readonly dev: number;
    readonly ino: number;
    readonly ctimeMs: number;
    readonly birthtimeMs: number;
}

const ABSENT_FINGERPRINT = 'absent';

export class WorkspaceCommentStorage {
    readonly filePath: string;
    readonly lockPath: string;
    public _lastWrittenHash: string | undefined;
    private suppressWatcherUntil = 0;
    private ignoreWatchDepth = 0;

    constructor(
        _workspaceRoot: string,
        private readonly pathResolver: WorkspacePathResolver
    ) {
        const directory = path.join(pathResolver.canonicalRoot, '.vscode', 'local-reviews');
        this.filePath = path.join(directory, 'workspace-comments.json');
        this.lockPath = path.join(directory, '.workspace-comments.lock');
    }

    load(): WorkspaceCommentsFile {
        return this.loadSnapshot(false).comments;
    }

    getReports(): WorkspaceThreadReport[] {
        return this.load().threads.map(thread => {
            const pathStatus = this.pathResolver.inspectStoredPath(thread.filePath);
            const anchor = pathStatus === 'current' ? this.readAnchor(thread) : undefined;
            const rangeStatus = pathStatus !== 'current'
                ? 'unavailable'
                : anchor === undefined ? 'outOfRange'
                    : anchor === thread.sourceAnchor ? 'current' : 'stale';
            return {
                ...thread,
                pathStatus,
                rangeStatus,
                stale: rangeStatus === 'stale',
            };
        });
    }

    addThread(
        filePath: string,
        startLine: number,
        endLine: number,
        sourceAnchor: string,
        body: string,
        author: string
    ): WorkspaceCommentThread {
        if (!this.pathResolver.normalizeStoredPath(filePath)) {
            throw new Error('Workspace comment path is unsafe');
        }
        validateRange(startLine, endLine);
        return this.mutate(comments => {
            const timestamp = new Date().toISOString();
            const thread: WorkspaceCommentThread = {
                id: crypto.randomUUID(),
                filePath,
                startLine,
                endLine,
                state: 'unresolved',
                sourceAnchor,
                createdAt: timestamp,
                comments: [{
                    id: crypto.randomUUID(),
                    body,
                    author,
                    timestamp,
                }],
            };
            comments.threads.push(thread);
            return thread;
        });
    }

    addReply(threadId: string, body: string, author: string): WorkspaceComment {
        return this.mutate(comments => {
            const thread = requireThread(comments, threadId);
            const comment = {
                id: crypto.randomUUID(),
                body,
                author,
                timestamp: new Date().toISOString(),
            };
            thread.comments.push(comment);
            return comment;
        });
    }

    editComment(threadId: string, commentId: string, body: string): void {
        this.mutate(comments => {
            const thread = requireThread(comments, threadId);
            const comment = thread.comments.find(candidate => candidate.id === commentId);
            if (!comment) {
                throw new Error(`Workspace comment is stale or missing: ${commentId}`);
            }
            comment.body = body;
            comment.timestamp = new Date().toISOString();
        });
    }

    /** Delete one comment and report whether its now-empty thread was removed. */
    deleteComment(threadId: string, commentId: string): boolean {
        return this.mutate(comments => {
            const thread = requireThread(comments, threadId);
            if (!thread.comments.some(comment => comment.id === commentId)) {
                throw new Error(`Workspace comment is stale or missing: ${commentId}`);
            }
            thread.comments = thread.comments.filter(comment => comment.id !== commentId);
            const removedThread = thread.comments.length === 0;
            if (removedThread) {
                comments.threads = comments.threads.filter(candidate => candidate.id !== threadId);
            }
            return removedThread;
        });
    }

    resolveThread(threadId: string): void {
        this.setThreadState(threadId, 'resolved');
    }

    unresolveThread(threadId: string): void {
        this.setThreadState(threadId, 'unresolved');
    }

    clear(): void {
        this.mutate(comments => {
            comments.threads = [];
        });
    }

    shouldIgnoreWatch(fsPath?: string): boolean {
        if (this.ignoreWatchDepth > 0) {
            return true;
        }
        if (fsPath && this._lastWrittenHash && fs.existsSync(fsPath)) {
            try {
                if (hash(fs.readFileSync(fsPath)) === this._lastWrittenHash) {
                    return true;
                }
            } catch {
                // Fall through to the short suppression window.
            }
        }
        return Date.now() < this.suppressWatcherUntil;
    }

    msUntilWatchAllowed(): number {
        return Math.max(0, this.suppressWatcherUntil - Date.now());
    }

    private setThreadState(threadId: string, state: WorkspaceCommentState): void {
        this.mutate(comments => {
            requireThread(comments, threadId).state = state;
        });
    }

    private mutate<T>(mutation: (comments: WorkspaceCommentsFile) => T): T {
        const directory = this.ensureSafeStorageDirectory();
        try {
            syncDirectoryStrict(directory);
            return withFileLock(this.entryPath(directory, path.basename(this.lockPath)), () => {
                this.verifyStorageDirectory(directory);
                const snapshot = this.loadSnapshot(true, directory);
                const result = mutation(snapshot.comments);
                this.save(snapshot.comments, snapshot.fingerprint, directory);
                return result;
            }, () => this.verifyStorageDirectory(directory));
        } finally {
            fs.closeSync(directory.descriptor);
        }
    }

    private loadSnapshot(lockHeld: boolean, heldDirectory?: StorageDirectory): LoadedSnapshot {
        const directory = heldDirectory ?? this.ensureSafeStorageDirectory();
        try {
            this.revalidateStorage(directory);
            const storePath = this.entryPath(directory, path.basename(this.filePath));
            const recoveryEntries = this.recoveryEntries(directory);
            if (recoveryEntries.backups.length > 0 || recoveryEntries.temporaries.length > 0) {
                if (!lockHeld) {
                    syncDirectoryStrict(directory);
                    return withFileLock(this.entryPath(directory, path.basename(this.lockPath)),
                        () => this.loadSnapshot(true, directory),
                        () => this.verifyStorageDirectory(directory));
                }
                this.recoverInterruptedSave(recoveryEntries, directory);
            }
            if (!pathEntryExists(storePath)) {
                return { comments: { version: 1, threads: [] }, fingerprint: ABSENT_FINGERPRINT };
            }
            assertOrdinaryPath(storePath, 'file');
            const { contents, parsed } = this.readAndValidate(storePath);
            return { comments: parsed, fingerprint: hash(contents) };
        } finally {
            if (!heldDirectory) {
                fs.closeSync(directory.descriptor);
            }
        }
    }

    private recoveryEntries(directory: StorageDirectory): RecoveryEntries {
        const prefix = `.${path.basename(this.filePath)}.`;
        this.verifyStorageDirectory(directory);
        const names = fs.readdirSync(directory.operationPath);
        this.verifyStorageDirectory(directory);
        const matching = (suffix: string): string[] => names
            .filter(name => name.startsWith(prefix)
                && name.length > prefix.length + suffix.length
                && name.endsWith(suffix))
            .map(name => this.entryPath(directory, name));
        return { backups: matching('.backup'), temporaries: matching('.tmp') };
    }

    private recoverInterruptedSave(
        entries: RecoveryEntries,
        directory: StorageDirectory
    ): void {
        this.revalidateStorage(directory);
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const validateBackups = (): void => {
            // Backups are committed recovery state: malformed backups are never deleted.
            for (const backupPath of entries.backups) {
                assertOrdinaryPath(backupPath, 'file');
                this.readAndValidate(backupPath);
            }
        };
        const validTemporaries: string[] = [];
        const invalidTemporaries: string[] = [];
        for (const temporaryPath of entries.temporaries) {
            try {
                assertOrdinaryPath(temporaryPath, 'file');
                this.readAndValidate(temporaryPath);
                validTemporaries.push(temporaryPath);
            } catch {
                // A cooperating writer cannot be live while this lock is held. An invalid
                // matching temporary is therefore incomplete scratch, not recovery state.
                invalidTemporaries.push(temporaryPath);
            }
        }
        const retire = (filePaths: readonly string[]): void => {
            for (const filePath of filePaths) {
                this.guardedUnlink(filePath, directory);
            }
        };
        if (pathEntryExists(storePath)) {
            // A visible valid canonical is newest. Malformed scratch temporaries cannot
            // wedge it, but every backup must validate before any recovery state is retired.
            this.readAndValidate(storePath);
            validateBackups();
            syncDirectoryStrict(directory);
            retire([...entries.backups, ...validTemporaries, ...invalidTemporaries]);
            syncDirectoryStrict(directory);
            return;
        }
        if (entries.backups.length > 0) {
            // Without a canonical, one valid durable backup takes precedence over all temps.
            if (entries.backups.length !== 1) {
                throw new Error('Workspace comments recovery is ambiguous; recovery entries were preserved');
            }
            validateBackups();
            const backupPath = entries.backups[0];
            try {
                this.guardedOperation(directory, () => fs.linkSync(backupPath, storePath));
                syncDirectoryStrict(directory);
            } catch (error: unknown) {
                throw new Error(`Workspace comments backup could not be restored without overwrite: ${errorMessage(error)}`);
            }
            retire([...entries.backups, ...validTemporaries, ...invalidTemporaries]);
            syncDirectoryStrict(directory);
            return;
        }
        if (validTemporaries.length === 0) {
            // Only unrecoverable process-death scratch remains. Retire it under lock.
            syncDirectoryStrict(directory);
            retire(invalidTemporaries);
            syncDirectoryStrict(directory);
            return;
        }
        if (validTemporaries.length !== 1) {
            // Invalid scratch is safe to retire, but multiple valid publications are ambiguous.
            if (invalidTemporaries.length > 0) {
                syncDirectoryStrict(directory);
                retire(invalidTemporaries);
                syncDirectoryStrict(directory);
            }
            throw new Error('Workspace comments recovery is ambiguous; valid temporaries were preserved');
        }
        // A unique valid durably named temporary is the recoverable first publication.
        const temporaryPath = validTemporaries[0];
        try {
            this.guardedOperation(directory, () => fs.linkSync(temporaryPath, storePath));
            syncDirectoryStrict(directory);
        } catch (error: unknown) {
            throw new Error(`Workspace comments temporary could not be recovered without overwrite: ${errorMessage(error)}`);
        }
        retire([...validTemporaries, ...invalidTemporaries]);
        syncDirectoryStrict(directory);
    }

    private readAndValidate(filePath: string): { contents: Buffer; parsed: WorkspaceCommentsFile } {
        let contents: Buffer;
        let parsed: unknown;
        try {
            contents = fs.readFileSync(filePath);
            parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
        } catch (error: unknown) {
            throw new Error(`Workspace comments could not be read: ${errorMessage(error)}`);
        }
        if (!isWorkspaceCommentsFile(parsed, this.pathResolver)) {
            throw new Error('Workspace comments file is malformed or uses an unsupported schema');
        }
        return { contents, parsed };
    }

    private save(
        comments: WorkspaceCommentsFile,
        expectedFingerprint: string,
        directory: StorageDirectory
    ): void {
        if (!isWorkspaceCommentsFile(comments, this.pathResolver)) {
            throw new Error('Refusing to write malformed workspace comments');
        }
        if (comments.threads.length === 0) {
            this.deleteExpected(expectedFingerprint, directory);
            this.markOwnWrite('');
            return;
        }

        const serialized = `${JSON.stringify(comments, null, 2)}\n`;
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const temporaryPath = this.entryPath(
            directory,
            `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
        );
        let descriptor: number | undefined;
        let backupPath: string | undefined;
        let temporaryCreated = false;
        let temporaryDurable = false;
        let recoveryEntriesRetired = false;
        preflightHardLinks(directory, () => this.verifyStorageDirectory(directory));
        try {
            descriptor = this.guardedOperation(directory,
                () => fs.openSync(temporaryPath, 'wx', 0o600));
            temporaryCreated = true;
            fs.writeFileSync(descriptor, serialized, 'utf8');
            fs.fsyncSync(descriptor);
            this.verifyStorageDirectory(directory);
            fs.closeSync(descriptor);
            descriptor = undefined;
            // The temporary name is a strict durable recovery point, including for
            // first publication when no canonical or backup exists yet.
            syncDirectoryStrict(directory);
            temporaryDurable = true;
            this.revalidateStorage(directory);

            if (expectedFingerprint === ABSENT_FINGERPRINT) {
                this.assertExpectedFingerprint(expectedFingerprint, directory);
            } else {
                backupPath = this.displaceAndVerify(expectedFingerprint, directory);
                // Milestone 1: the canonical displacement and backup name are durable.
                syncDirectoryStrict(directory);
            }

            try {
                this.guardedOperation(directory, () => fs.linkSync(temporaryPath, storePath));
            } catch (error: unknown) {
                if (isAlreadyExists(error)) {
                    throw changedOutsideLockError();
                }
                throw error;
            }
            // Milestone 2: the newer canonical is durable before any recovery entry is retired.
            syncDirectoryStrict(directory);
            if (backupPath) {
                this.guardedUnlink(backupPath, directory);
            }
            this.guardedUnlink(temporaryPath, directory);
            // Milestone 3: retirement of backup and temporary names is durable.
            syncDirectoryStrict(directory);
            recoveryEntriesRetired = true;
            this.markOwnWrite(serialized);
        } finally {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
            }
            if (temporaryCreated && !temporaryDurable
                && !recoveryEntriesRetired && this.storageDirectoryStillCurrent(directory)) {
                unlinkIfExistsBestEffort(temporaryPath);
            }
            // Durable temporaries and backups are intentionally preserved on every later
            // failure. Recovery applies explicit canonical > backup > temporary precedence.
        }
    }

    private deleteExpected(expectedFingerprint: string, directory: StorageDirectory): void {
        this.revalidateStorage(directory);
        if (expectedFingerprint === ABSENT_FINGERPRINT) {
            this.assertExpectedFingerprint(expectedFingerprint, directory);
            return;
        }
        preflightHardLinks(directory, () => this.verifyStorageDirectory(directory));
        const backupPath = this.displaceAndVerify(expectedFingerprint, directory);
        syncDirectoryStrict(directory);
        this.guardedUnlink(backupPath, directory);
        syncDirectoryStrict(directory);
    }

    private displaceAndVerify(expectedFingerprint: string, directory: StorageDirectory): string {
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const backupPath = this.entryPath(
            directory,
            `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.backup`
        );
        try {
            this.guardedOperation(directory, () => fs.renameSync(storePath, backupPath));
        } catch (error: unknown) {
            if (isMissing(error)) {
                throw changedOutsideLockError();
            }
            throw error;
        }
        try {
            assertOrdinaryPath(backupPath, 'file');
            if (hash(fs.readFileSync(backupPath)) !== expectedFingerprint) {
                throw changedOutsideLockError();
            }
            this.verifyStorageDirectory(directory);
            return backupPath;
        } catch (error: unknown) {
            // Never retire a displaced entry on failure; recovery can validate it and
            // restore it without overwrite under the cooperating lock.
            throw error;
        }
    }

    private assertExpectedFingerprint(expected: string, directory: StorageDirectory): void {
        this.revalidateStorage(directory);
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const actual = pathEntryExists(storePath)
            ? hash(fs.readFileSync(storePath))
            : ABSENT_FINGERPRINT;
        this.verifyStorageDirectory(directory);
        if (actual !== expected) {
            throw changedOutsideLockError();
        }
    }

    private ensureSafeStorageDirectory(): StorageDirectory {
        let current = this.pathResolver.canonicalRoot;
        for (const component of ['.vscode', 'local-reviews']) {
            const parent = this.openVerifiedDirectory(current);
            const next = path.join(current, component);
            const boundNext = this.entryPath(parent, component);
            try {
                let createdOrRaced = false;
                if (!pathEntryExists(boundNext)) {
                    // Prove parent-directory durability support before publishing a child name.
                    syncDirectoryStrict(parent);
                    try {
                        this.guardedOperation(parent,
                            () => fs.mkdirSync(boundNext, { mode: 0o700 }));
                    } catch (error: unknown) {
                        if (!isAlreadyExists(error)) {
                            throw error;
                        }
                    }
                    createdOrRaced = true;
                }
                const entry = fs.lstatSync(boundNext);
                if (entry.isSymbolicLink() || !entry.isDirectory()) {
                    throw new Error(`Unsafe workspace comments directory: ${next}`);
                }
                this.verifyStorageDirectory(parent);
                assertOrdinaryPath(next, 'directory');
                if (!sameCanonicalPath(canonicalPath(next), next)) {
                    throw new Error(`Unsafe workspace comments directory alias: ${next}`);
                }
                this.verifyStorageDirectory(parent);
                if (createdOrRaced) {
                    // The child name must be durable before it becomes the next parent.
                    syncDirectoryStrict(parent);
                }
            } finally {
                fs.closeSync(parent.descriptor);
            }
            current = next;
        }
        return this.openVerifiedDirectory(current);
    }

    private openVerifiedDirectory(directoryPath: string): StorageDirectory {
        const before = fs.lstatSync(directoryPath);
        if (before.isSymbolicLink() || !before.isDirectory()) {
            throw new Error(`Unsafe workspace comments directory: ${directoryPath}`);
        }
        if (!sameCanonicalPath(canonicalPath(directoryPath), directoryPath)) {
            throw new Error(`Unsafe workspace comments directory alias: ${directoryPath}`);
        }
        const descriptor = fs.openSync(directoryPath, 'r');
        try {
            const opened = fs.fstatSync(descriptor);
            if (!sameDirectoryIdentity(before, opened)) {
                throw new Error('Workspace comments storage changed while it was being opened');
            }
            const procPath = `/proc/self/fd/${descriptor}`;
            if (!directoryPathHasIdentity(procPath, opened)) {
                throw new Error('Workspace comments storage requires a verified descriptor-bound path');
            }
            const directory: StorageDirectory = {
                path: directoryPath,
                descriptor,
                operationPath: procPath,
                dev: opened.dev,
                ino: opened.ino,
                ctimeMs: opened.ctimeMs,
                birthtimeMs: opened.birthtimeMs,
            };
            this.verifyStorageDirectory(directory);
            return directory;
        } catch (error: unknown) {
            fs.closeSync(descriptor);
            throw error;
        }
    }

    private revalidateStorage(directory: StorageDirectory): void {
        this.verifyStorageDirectory(directory);
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        if (pathEntryExists(storePath)) {
            assertOrdinaryPath(storePath, 'file');
        }
        this.verifyStorageDirectory(directory);
    }

    private verifyStorageDirectory(directory: StorageDirectory): void {
        let pathname: fs.Stats;
        let opened: fs.Stats;
        try {
            pathname = fs.lstatSync(directory.path);
            opened = fs.fstatSync(directory.descriptor);
        } catch (error: unknown) {
            throw new Error(`Workspace comments storage changed unexpectedly: ${errorMessage(error)}`);
        }
        if (pathname.isSymbolicLink() || !pathname.isDirectory()
            || !opened.isDirectory()
            || !sameDirectoryIdentity(pathname, opened)
            || !matchesCapturedDirectory(opened, directory)
            || !sameCanonicalPath(canonicalPath(directory.path), directory.path)) {
            throw new Error('Workspace comments storage changed unexpectedly');
        }
    }

    private storageDirectoryStillCurrent(directory: StorageDirectory): boolean {
        try {
            this.verifyStorageDirectory(directory);
            return true;
        } catch {
            return false;
        }
    }

    private entryPath(directory: StorageDirectory, name: string): string {
        return path.join(directory.operationPath, name);
    }

    private guardedOperation<T>(directory: StorageDirectory, operation: () => T): T {
        this.verifyStorageDirectory(directory);
        const result = operation();
        this.verifyStorageDirectory(directory);
        return result;
    }

    private guardedUnlink(filePath: string, directory: StorageDirectory): void {
        this.guardedOperation(directory, () => fs.unlinkSync(filePath));
    }

    private markOwnWrite(serialized: string): void {
        this._lastWrittenHash = hash(Buffer.from(serialized));
        this.suppressWatcherUntil = Date.now() + 300;
        this.ignoreWatchDepth++;
        setTimeout(() => {
            this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
        }, 0);
    }

    private readAnchor(thread: WorkspaceCommentThread): string | undefined {
        const uri = this.pathResolver.uriForStoredPath(thread.filePath);
        if (!uri) {
            return undefined;
        }
        try {
            const lines = fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/);
            if (thread.startLine >= lines.length || thread.endLine >= lines.length) {
                return undefined;
            }
            return lines.slice(thread.startLine, thread.endLine + 1).join('\n');
        } catch {
            return undefined;
        }
    }
}

export function isWorkspaceCommentsFile(
    value: unknown,
    pathResolver: WorkspacePathResolver
): value is WorkspaceCommentsFile {
    if (!hasExactKeys(value, ['version', 'threads'])
        || value.version !== 1
        || !Array.isArray(value.threads)) {
        return false;
    }
    const ids = new Set<string>();
    for (const thread of value.threads) {
        if (!hasExactKeys(thread, [
            'id', 'filePath', 'startLine', 'endLine', 'state', 'sourceAnchor', 'createdAt', 'comments',
        ])
            || !isUniqueUuid(thread.id, ids)
            || typeof thread.filePath !== 'string'
            || !pathResolver.normalizeStoredPath(thread.filePath)
            || !isValidRange(thread.startLine, thread.endLine)
            || (thread.state !== 'resolved' && thread.state !== 'unresolved')
            || typeof thread.sourceAnchor !== 'string'
            || !isTimestamp(thread.createdAt)
            || !Array.isArray(thread.comments)
            || thread.comments.length === 0) {
            return false;
        }
        for (const comment of thread.comments) {
            if (!hasExactKeys(comment, ['id', 'body', 'author', 'timestamp'])
                || !isUniqueUuid(comment.id, ids)
                || typeof comment.body !== 'string'
                || typeof comment.author !== 'string'
                || !isTimestamp(comment.timestamp)) {
                return false;
            }
        }
    }
    return true;
}

function requireThread(comments: WorkspaceCommentsFile, threadId: string): WorkspaceCommentThread {
    const thread = comments.threads.find(candidate => candidate.id === threadId);
    if (!thread) {
        throw new Error(`Workspace comment thread is stale or missing: ${threadId}`);
    }
    return thread;
}

function isValidRange(startLine: unknown, endLine: unknown): boolean {
    return typeof startLine === 'number'
        && typeof endLine === 'number'
        && Number.isFinite(startLine)
        && Number.isFinite(endLine)
        && Number.isInteger(startLine)
        && Number.isInteger(endLine)
        && startLine >= 0
        && endLine >= startLine;
}

function validateRange(startLine: number, endLine: number): void {
    if (!isValidRange(startLine, endLine)) {
        throw new Error('Workspace comment range must contain ordered non-negative whole lines');
    }
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isUniqueUuid(value: unknown, ids: Set<string>): value is string {
    if (typeof value !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        || ids.has(value)) {
        return false;
    }
    ids.add(value);
    return true;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function hash(contents: Buffer): string {
    return crypto.createHash('sha256').update(contents).digest('hex');
}

function sameDirectoryIdentity(before: fs.Stats, after: fs.Stats): boolean {
    if (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0) {
        return before.dev === after.dev && before.ino === after.ino;
    }
    return before.ctimeMs === after.ctimeMs && before.birthtimeMs === after.birthtimeMs;
}

function matchesCapturedDirectory(stat: fs.Stats, directory: StorageDirectory): boolean {
    if (stat.dev !== 0 && stat.ino !== 0 && directory.dev !== 0 && directory.ino !== 0) {
        return stat.dev === directory.dev && stat.ino === directory.ino;
    }
    return stat.ctimeMs === directory.ctimeMs && stat.birthtimeMs === directory.birthtimeMs;
}

function directoryPathHasIdentity(directoryPath: string, expected: fs.Stats): boolean {
    try {
        const candidate = fs.statSync(directoryPath);
        return candidate.isDirectory() && sameDirectoryIdentity(candidate, expected);
    } catch {
        return false;
    }
}

function syncDirectoryStrict(directory: StorageDirectory): void {
    directoryPathHasIdentityOrThrow(directory.operationPath, directory);
    try {
        fs.fsyncSync(directory.descriptor);
    } catch (error: unknown) {
        throw new Error(`Workspace comments directory could not be synced: ${errorMessage(error)}`);
    }
    directoryPathHasIdentityOrThrow(directory.operationPath, directory);
}

function directoryPathHasIdentityOrThrow(
    operationPath: string,
    directory: StorageDirectory
): void {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(operationPath);
    } catch (error: unknown) {
        throw new Error(`Workspace comments descriptor-bound path became unavailable: ${errorMessage(error)}`);
    }
    if (!stat.isDirectory() || !matchesCapturedDirectory(stat, directory)) {
        throw new Error('Workspace comments descriptor-bound path changed unexpectedly');
    }
}

function pathEntryExists(filePath: string): boolean {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error
            && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function preflightHardLinks(
    directory: StorageDirectory,
    verifyDirectory: () => void
): void {
    const probePath = path.join(
        directory.operationPath,
        `.workspace-comments.${process.pid}.${crypto.randomUUID()}.link-probe`
    );
    const linkedPath = `${probePath}.linked`;
    let descriptor: number | undefined;
    try {
        verifyDirectory();
        descriptor = fs.openSync(probePath, 'wx', 0o600);
        verifyDirectory();
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(probePath, linkedPath);
        verifyDirectory();
    } catch (error: unknown) {
        throw new Error(`Workspace comments storage does not support safe hard-link publication: ${errorMessage(error)}`);
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Preserve the preflight error.
            }
        }
        unlinkIfExistsBestEffort(linkedPath);
        unlinkIfExistsBestEffort(probePath);
        syncDirectoryStrict(directory);
    }
}

function unlinkIfExistsBestEffort(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch (error: unknown) {
        if (!isMissing(error)) {
            // Cleanup failure must not overwrite or remove another writer's destination.
        }
    }
}

function changedOutsideLockError(): Error {
    return new Error('Workspace comments changed outside the cooperating lock; reload before retrying');
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
