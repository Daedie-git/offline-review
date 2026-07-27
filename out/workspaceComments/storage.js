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
exports.WorkspaceCommentStorage = void 0;
exports.isWorkspaceCommentsFile = isWorkspaceCommentsFile;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util_1 = require("util");
const lineSequenceResolver_1 = require("../lineSequenceResolver");
const fileLock_1 = require("./fileLock");
const safeFilesystem_1 = require("./safeFilesystem");
const ABSENT_FINGERPRINT = 'absent';
const DEFAULT_OWN_WRITE_WINDOW_MS = 300;
class WorkspaceCommentStorage {
    constructor(_workspaceRoot, pathResolver, now = () => Date.now(), ownWriteWindowMs = DEFAULT_OWN_WRITE_WINDOW_MS) {
        this.pathResolver = pathResolver;
        this.now = now;
        this.ownWriteWindowMs = ownWriteWindowMs;
        this.suppressWatcherUntil = 0;
        this.ignoreWatchDepth = 0;
        this.ownWrites = new Map();
        this.directorySyncCapabilities = new Set();
        this.hardLinkCapabilities = new Set();
        const directory = path.join(pathResolver.canonicalRoot, '.vscode', 'offline-reviews');
        this.filePath = path.join(directory, 'workspace-comments.json');
        this.lockPath = path.join(directory, '.workspace-comments.lock');
    }
    load() {
        return this.loadSnapshot(false).comments;
    }
    getReports() {
        const contentByPath = new Map();
        return this.load().threads.map(thread => {
            const pathStatus = this.pathResolver.inspectStoredPath(thread.filePath);
            if (pathStatus !== 'current') {
                return {
                    ...thread,
                    pathStatus,
                    anchorStatus: 'unavailable',
                    rangeStatus: 'unavailable',
                    matches: [],
                    stale: false,
                };
            }
            let content = contentByPath.get(thread.filePath);
            if (!contentByPath.has(thread.filePath)) {
                const uri = this.pathResolver.uriForStoredPath(thread.filePath);
                try {
                    content = uri ? fs.readFileSync(uri.fsPath, 'utf8') : undefined;
                }
                catch {
                    content = undefined;
                }
                contentByPath.set(thread.filePath, content);
            }
            if (content === undefined) {
                return {
                    ...thread,
                    pathStatus,
                    anchorStatus: 'unavailable',
                    rangeStatus: 'unavailable',
                    matches: [],
                    stale: false,
                };
            }
            const resolution = (0, lineSequenceResolver_1.resolveExactLineSequence)(content, thread.sourceAnchor, thread.startLine, thread.endLine);
            const rangeStatus = resolution.status === 'notFound'
                ? 'stale'
                : resolution.status;
            return {
                ...thread,
                pathStatus,
                anchorStatus: resolution.status,
                rangeStatus,
                effectiveStartLine: resolution.effectiveStartLine,
                effectiveEndLine: resolution.effectiveEndLine,
                matches: resolution.matches,
                stale: rangeStatus === 'stale',
            };
        });
    }
    addThread(filePath, startLine, endLine, sourceAnchor, body, author) {
        if (!this.pathResolver.normalizeStoredPath(filePath)) {
            throw new Error('Workspace comment path is unsafe');
        }
        validateRange(startLine, endLine);
        return this.mutate(comments => {
            const timestamp = new Date().toISOString();
            const thread = {
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
    addReply(threadId, body, author) {
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
    editComment(threadId, commentId, body) {
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
    deleteComment(threadId, commentId) {
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
    resolveThread(threadId) {
        this.setThreadState(threadId, 'resolved');
    }
    unresolveThread(threadId) {
        this.setThreadState(threadId, 'unresolved');
    }
    clear() {
        this.mutate(comments => {
            comments.threads = [];
        });
    }
    classifyWatch(fsPath) {
        const now = this.now();
        const ownWrite = fsPath ? this.ownWrites.get(fsPath) : undefined;
        if (fsPath && ownWrite) {
            if (now >= ownWrite.expiresAt) {
                this.ownWrites.delete(fsPath);
            }
            else {
                try {
                    if (ownWrite.expectedHash === undefined) {
                        if (!fs.existsSync(fsPath)) {
                            return 'exactOwnWrite';
                        }
                    }
                    else if (fs.existsSync(fsPath)
                        && hash(fs.readFileSync(fsPath)) === ownWrite.expectedHash) {
                        return 'exactOwnWrite';
                    }
                }
                catch {
                    // An unreadable or changing path is never an exact own write.
                }
            }
        }
        if (this.ignoreWatchDepth > 0 || now < this.suppressWatcherUntil) {
            return 'suppressed';
        }
        return 'external';
    }
    shouldIgnoreWatch(fsPath) {
        return this.classifyWatch(fsPath) !== 'external';
    }
    msUntilWatchAllowed() {
        return Math.max(0, this.suppressWatcherUntil - this.now());
    }
    setThreadState(threadId, state) {
        this.mutate(comments => {
            requireThread(comments, threadId).state = state;
        });
    }
    mutate(mutation) {
        const directory = this.ensureSafeStorageDirectory();
        try {
            this.preflightDirectorySync(directory);
            return (0, fileLock_1.withFileLock)(this.entryPath(directory, path.basename(this.lockPath)), () => {
                this.verifyStorageDirectory(directory);
                const snapshot = this.loadSnapshot(true, directory);
                const result = mutation(snapshot.comments);
                this.save(snapshot.comments, snapshot.fingerprint, directory);
                return result;
            }, () => this.verifyStorageDirectory(directory));
        }
        finally {
            fs.closeSync(directory.descriptor);
        }
    }
    loadSnapshot(lockHeld, heldDirectory) {
        if (!heldDirectory && this.hasSafelyAbsentStorageDirectory()) {
            return {
                comments: { version: 1, threads: [] },
                fingerprint: ABSENT_FINGERPRINT,
            };
        }
        const directory = heldDirectory ?? this.ensureSafeStorageDirectory();
        try {
            this.revalidateStorage(directory);
            const storePath = this.entryPath(directory, path.basename(this.filePath));
            const recoveryEntries = this.recoveryEntries(directory);
            if (recoveryEntries.backups.length > 0 || recoveryEntries.temporaries.length > 0) {
                if (!lockHeld) {
                    syncDirectoryStrict(directory);
                    return (0, fileLock_1.withFileLock)(this.entryPath(directory, path.basename(this.lockPath)), () => this.loadSnapshot(true, directory), () => this.verifyStorageDirectory(directory));
                }
                this.recoverInterruptedSave(recoveryEntries, directory);
            }
            if (!pathEntryExists(storePath)) {
                return { comments: { version: 1, threads: [] }, fingerprint: ABSENT_FINGERPRINT };
            }
            (0, safeFilesystem_1.assertOrdinaryPath)(storePath, 'file');
            const { contents, parsed } = this.readAndValidate(storePath);
            return { comments: parsed, fingerprint: hash(contents) };
        }
        finally {
            if (!heldDirectory) {
                fs.closeSync(directory.descriptor);
            }
        }
    }
    recoveryEntries(directory) {
        const prefix = `.${path.basename(this.filePath)}.`;
        this.verifyStorageDirectory(directory);
        const names = fs.readdirSync(directory.operationPath);
        this.verifyStorageDirectory(directory);
        const matching = (suffix) => names
            .filter(name => name.startsWith(prefix)
            && name.length > prefix.length + suffix.length
            && name.endsWith(suffix))
            .map(name => this.entryPath(directory, name));
        return { backups: matching('.backup'), temporaries: matching('.tmp') };
    }
    recoverInterruptedSave(entries, directory) {
        this.revalidateStorage(directory);
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const validateBackups = () => {
            // Backups are committed recovery state: malformed backups are never deleted.
            for (const backupPath of entries.backups) {
                (0, safeFilesystem_1.assertOrdinaryPath)(backupPath, 'file');
                this.readAndValidate(backupPath);
            }
        };
        const validTemporaries = [];
        const invalidTemporaries = [];
        for (const temporaryPath of entries.temporaries) {
            try {
                (0, safeFilesystem_1.assertOrdinaryPath)(temporaryPath, 'file');
                this.readAndValidate(temporaryPath);
                validTemporaries.push(temporaryPath);
            }
            catch {
                // A cooperating writer cannot be live while this lock is held. An invalid
                // matching temporary is therefore incomplete scratch, not recovery state.
                invalidTemporaries.push(temporaryPath);
            }
        }
        const retire = (filePaths) => {
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
            }
            catch (error) {
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
        }
        catch (error) {
            throw new Error(`Workspace comments temporary could not be recovered without overwrite: ${errorMessage(error)}`);
        }
        retire([...validTemporaries, ...invalidTemporaries]);
        syncDirectoryStrict(directory);
    }
    readAndValidate(filePath) {
        let contents;
        let parsed;
        try {
            contents = fs.readFileSync(filePath);
            parsed = JSON.parse(new util_1.TextDecoder('utf-8', { fatal: true }).decode(contents));
        }
        catch (error) {
            throw new Error(`Workspace comments could not be read: ${errorMessage(error)}`);
        }
        if (!isWorkspaceCommentsFile(parsed, this.pathResolver)) {
            throw new Error('Workspace comments file is malformed or uses an unsupported schema');
        }
        return { contents, parsed };
    }
    save(comments, expectedFingerprint, directory) {
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
        const temporaryPath = this.entryPath(directory, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        let descriptor;
        let backupPath;
        let temporaryCreated = false;
        let temporaryDurable = false;
        let recoveryEntriesRetired = false;
        this.preflightHardLinks(directory);
        try {
            descriptor = this.guardedOperation(directory, () => fs.openSync(temporaryPath, 'wx', 0o600));
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
            }
            else {
                backupPath = this.displaceAndVerify(expectedFingerprint, directory);
                // Milestone 1: the canonical displacement and backup name are durable.
                syncDirectoryStrict(directory);
            }
            try {
                this.guardedOperation(directory, () => fs.linkSync(temporaryPath, storePath));
            }
            catch (error) {
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
        }
        finally {
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
    deleteExpected(expectedFingerprint, directory) {
        this.revalidateStorage(directory);
        if (expectedFingerprint === ABSENT_FINGERPRINT) {
            this.assertExpectedFingerprint(expectedFingerprint, directory);
            return;
        }
        this.preflightHardLinks(directory);
        const backupPath = this.displaceAndVerify(expectedFingerprint, directory);
        syncDirectoryStrict(directory);
        this.guardedUnlink(backupPath, directory);
        syncDirectoryStrict(directory);
    }
    displaceAndVerify(expectedFingerprint, directory) {
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        const backupPath = this.entryPath(directory, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.backup`);
        try {
            this.guardedOperation(directory, () => fs.renameSync(storePath, backupPath));
        }
        catch (error) {
            if (isMissing(error)) {
                throw changedOutsideLockError();
            }
            throw error;
        }
        try {
            (0, safeFilesystem_1.assertOrdinaryPath)(backupPath, 'file');
            if (hash(fs.readFileSync(backupPath)) !== expectedFingerprint) {
                throw changedOutsideLockError();
            }
            this.verifyStorageDirectory(directory);
            return backupPath;
        }
        catch (error) {
            // Never retire a displaced entry on failure; recovery can validate it and
            // restore it without overwrite under the cooperating lock.
            throw error;
        }
    }
    assertExpectedFingerprint(expected, directory) {
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
    hasSafelyAbsentStorageDirectory() {
        let current = this.pathResolver.canonicalRoot;
        for (const component of ['.vscode', 'offline-reviews']) {
            const next = path.join(current, component);
            if (!pathEntryExists(next)) {
                return true;
            }
            const entry = fs.lstatSync(next);
            if (entry.isSymbolicLink() || !entry.isDirectory()) {
                throw new Error(`Unsafe workspace comments directory: ${next}`);
            }
            if (!(0, safeFilesystem_1.sameCanonicalPath)((0, safeFilesystem_1.canonicalPath)(next), next)) {
                throw new Error(`Unsafe workspace comments directory alias: ${next}`);
            }
            current = next;
        }
        return false;
    }
    ensureSafeStorageDirectory() {
        let current = this.pathResolver.canonicalRoot;
        for (const component of ['.vscode', 'offline-reviews']) {
            const parent = this.openVerifiedDirectory(current);
            const next = path.join(current, component);
            const boundNext = this.entryPath(parent, component);
            try {
                let createdOrRaced = false;
                if (!pathEntryExists(boundNext)) {
                    // Prove parent-directory durability support before publishing a child name.
                    syncDirectoryStrict(parent);
                    try {
                        this.guardedOperation(parent, () => fs.mkdirSync(boundNext, { mode: 0o700 }));
                    }
                    catch (error) {
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
                (0, safeFilesystem_1.assertOrdinaryPath)(next, 'directory');
                if (!(0, safeFilesystem_1.sameCanonicalPath)((0, safeFilesystem_1.canonicalPath)(next), next)) {
                    throw new Error(`Unsafe workspace comments directory alias: ${next}`);
                }
                this.verifyStorageDirectory(parent);
                if (createdOrRaced) {
                    // The child name must be durable before it becomes the next parent.
                    syncDirectoryStrict(parent);
                }
            }
            finally {
                fs.closeSync(parent.descriptor);
            }
            current = next;
        }
        return this.openVerifiedDirectory(current);
    }
    openVerifiedDirectory(directoryPath) {
        const before = fs.lstatSync(directoryPath);
        if (before.isSymbolicLink() || !before.isDirectory()) {
            throw new Error(`Unsafe workspace comments directory: ${directoryPath}`);
        }
        if (!(0, safeFilesystem_1.sameCanonicalPath)((0, safeFilesystem_1.canonicalPath)(directoryPath), directoryPath)) {
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
            const directory = {
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
        }
        catch (error) {
            fs.closeSync(descriptor);
            throw error;
        }
    }
    revalidateStorage(directory) {
        this.verifyStorageDirectory(directory);
        const storePath = this.entryPath(directory, path.basename(this.filePath));
        if (pathEntryExists(storePath)) {
            (0, safeFilesystem_1.assertOrdinaryPath)(storePath, 'file');
        }
        this.verifyStorageDirectory(directory);
    }
    verifyStorageDirectory(directory) {
        let pathname;
        let opened;
        try {
            pathname = fs.lstatSync(directory.path);
            opened = fs.fstatSync(directory.descriptor);
        }
        catch (error) {
            throw new Error(`Workspace comments storage changed unexpectedly: ${errorMessage(error)}`);
        }
        if (pathname.isSymbolicLink() || !pathname.isDirectory()
            || !opened.isDirectory()
            || !sameDirectoryIdentity(pathname, opened)
            || !matchesCapturedDirectory(opened, directory)
            || !(0, safeFilesystem_1.sameCanonicalPath)((0, safeFilesystem_1.canonicalPath)(directory.path), directory.path)) {
            throw new Error('Workspace comments storage changed unexpectedly');
        }
    }
    storageDirectoryStillCurrent(directory) {
        try {
            this.verifyStorageDirectory(directory);
            return true;
        }
        catch {
            return false;
        }
    }
    entryPath(directory, name) {
        return path.join(directory.operationPath, name);
    }
    guardedOperation(directory, operation) {
        this.verifyStorageDirectory(directory);
        const result = operation();
        this.verifyStorageDirectory(directory);
        return result;
    }
    guardedUnlink(filePath, directory) {
        this.guardedOperation(directory, () => fs.unlinkSync(filePath));
    }
    preflightDirectorySync(directory) {
        const identity = directoryIdentity(directory);
        if (this.directorySyncCapabilities.has(identity)) {
            return;
        }
        syncDirectoryStrict(directory);
        this.directorySyncCapabilities.add(identity);
    }
    preflightHardLinks(directory) {
        const identity = directoryIdentity(directory);
        if (this.hardLinkCapabilities.has(identity)) {
            return;
        }
        preflightHardLinks(directory, () => this.verifyStorageDirectory(directory));
        this.hardLinkCapabilities.add(identity);
    }
    markOwnWrite(serialized) {
        this._lastWrittenHash = hash(Buffer.from(serialized));
        const deadline = this.now() + this.ownWriteWindowMs;
        this.ownWrites.set(this.filePath, {
            expectedHash: serialized === '' ? undefined : this._lastWrittenHash,
            expiresAt: deadline,
        });
        this.suppressWatcherUntil = Math.max(this.suppressWatcherUntil, deadline);
        this.ignoreWatchDepth++;
        setTimeout(() => {
            this.ignoreWatchDepth = Math.max(0, this.ignoreWatchDepth - 1);
        }, 0);
    }
}
exports.WorkspaceCommentStorage = WorkspaceCommentStorage;
function isWorkspaceCommentsFile(value, pathResolver) {
    if (!hasExactKeys(value, ['version', 'threads'])
        || value.version !== 1
        || !Array.isArray(value.threads)) {
        return false;
    }
    const ids = new Set();
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
function requireThread(comments, threadId) {
    const thread = comments.threads.find(candidate => candidate.id === threadId);
    if (!thread) {
        throw new Error(`Workspace comment thread is stale or missing: ${threadId}`);
    }
    return thread;
}
function isValidRange(startLine, endLine) {
    return typeof startLine === 'number'
        && typeof endLine === 'number'
        && Number.isFinite(startLine)
        && Number.isFinite(endLine)
        && Number.isInteger(startLine)
        && Number.isInteger(endLine)
        && startLine >= 0
        && endLine >= startLine;
}
function validateRange(startLine, endLine) {
    if (!isValidRange(startLine, endLine)) {
        throw new Error('Workspace comment range must contain ordered non-negative whole lines');
    }
}
function isTimestamp(value) {
    return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}
function isUniqueUuid(value, ids) {
    if (typeof value !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        || ids.has(value)) {
        return false;
    }
    ids.add(value);
    return true;
}
function hasExactKeys(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}
function hash(contents) {
    return crypto.createHash('sha256').update(contents).digest('hex');
}
function sameDirectoryIdentity(before, after) {
    if (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0) {
        return before.dev === after.dev && before.ino === after.ino;
    }
    return before.ctimeMs === after.ctimeMs && before.birthtimeMs === after.birthtimeMs;
}
function matchesCapturedDirectory(stat, directory) {
    if (stat.dev !== 0 && stat.ino !== 0 && directory.dev !== 0 && directory.ino !== 0) {
        return stat.dev === directory.dev && stat.ino === directory.ino;
    }
    return stat.ctimeMs === directory.ctimeMs && stat.birthtimeMs === directory.birthtimeMs;
}
function directoryIdentity(directory) {
    return directory.dev !== 0 && directory.ino !== 0
        ? `${directory.dev}:${directory.ino}`
        : `${directory.ctimeMs}:${directory.birthtimeMs}`;
}
function directoryPathHasIdentity(directoryPath, expected) {
    try {
        const candidate = fs.statSync(directoryPath);
        return candidate.isDirectory() && sameDirectoryIdentity(candidate, expected);
    }
    catch {
        return false;
    }
}
function syncDirectoryStrict(directory) {
    directoryPathHasIdentityOrThrow(directory.operationPath, directory);
    try {
        fs.fsyncSync(directory.descriptor);
    }
    catch (error) {
        throw new Error(`Workspace comments directory could not be synced: ${errorMessage(error)}`);
    }
    directoryPathHasIdentityOrThrow(directory.operationPath, directory);
}
function directoryPathHasIdentityOrThrow(operationPath, directory) {
    let stat;
    try {
        stat = fs.statSync(operationPath);
    }
    catch (error) {
        throw new Error(`Workspace comments descriptor-bound path became unavailable: ${errorMessage(error)}`);
    }
    if (!stat.isDirectory() || !matchesCapturedDirectory(stat, directory)) {
        throw new Error('Workspace comments descriptor-bound path changed unexpectedly');
    }
}
function pathEntryExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error
            && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
function preflightHardLinks(directory, verifyDirectory) {
    const probePath = path.join(directory.operationPath, `.workspace-comments.${process.pid}.${crypto.randomUUID()}.link-probe`);
    const linkedPath = `${probePath}.linked`;
    let descriptor;
    try {
        verifyDirectory();
        descriptor = fs.openSync(probePath, 'wx', 0o600);
        verifyDirectory();
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(probePath, linkedPath);
        verifyDirectory();
    }
    catch (error) {
        throw new Error(`Workspace comments storage does not support safe hard-link publication: ${errorMessage(error)}`);
    }
    finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            }
            catch {
                // Preserve the preflight error.
            }
        }
        unlinkIfExistsBestEffort(linkedPath);
        unlinkIfExistsBestEffort(probePath);
        syncDirectoryStrict(directory);
    }
}
function unlinkIfExistsBestEffort(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch (error) {
        if (!isMissing(error)) {
            // Cleanup failure must not overwrite or remove another writer's destination.
        }
    }
}
function changedOutsideLockError() {
    return new Error('Workspace comments changed outside the cooperating lock; reload before retrying');
}
function isAlreadyExists(error) {
    return error instanceof Error && 'code' in error
        && error.code === 'EEXIST';
}
function isMissing(error) {
    return error instanceof Error && 'code' in error
        && error.code === 'ENOENT';
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=storage.js.map