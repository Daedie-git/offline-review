import * as crypto from 'crypto';
import * as fs from 'fs';

const RETRY_MS = 25;
const TIMEOUT_MS = 1000;
const STALE_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

interface LockRecord {
    readonly pid: number;
    readonly createdAt: number;
    readonly token: string;
}

interface AcquiredLock {
    readonly descriptor: number;
    readonly token: string;
}

interface LockEntryIdentity {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
}

export function withFileLock<T>(
    lockPath: string,
    action: () => T,
    verifyDirectory: () => void = () => {}
): T {
    const acquired = acquire(lockPath, verifyDirectory);
    try {
        verifyDirectory();
        const result = action();
        verifyDirectory();
        return result;
    } finally {
        try {
            fs.closeSync(acquired.descriptor);
        } catch {
            // Best effort only after the protected action has completed.
        }
        releaseOwnedLock(lockPath, acquired.token);
    }
}

function acquire(lockPath: string, verifyDirectory: () => void): AcquiredLock {
    const started = Date.now();
    while (true) {
        const token = crypto.randomUUID();
        let descriptor: number | undefined;
        try {
            verifyDirectory();
            descriptor = fs.openSync(lockPath, 'wx', 0o600);
            verifyDirectory();
            const record: LockRecord = { pid: process.pid, createdAt: Date.now(), token };
            fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
            fs.fsyncSync(descriptor);
            verifyDirectory();
            return { descriptor, token };
        } catch (error: unknown) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                } catch {
                    // Preserve the acquisition error.
                }
                removeOwnedLockAfterFailedAcquire(lockPath, token);
            }
            if (!isAlreadyExists(error)) {
                throw new Error(`Workspace comments lock could not be acquired: ${errorMessage(error)}`);
            }
            verifyDirectory();
            tryReclaimDeadStaleLock(lockPath);
            verifyDirectory();
            if (Date.now() - started >= TIMEOUT_MS) {
                throw new Error('Workspace comments are busy in another process; reload and try again');
            }
            Atomics.wait(sleeper, 0, 0, RETRY_MS);
        }
    }
}

function tryReclaimDeadStaleLock(lockPath: string): void {
    const identity = inspectLockEntry(lockPath);
    if (!identity) {
        return;
    }
    const record = readLockRecord(lockPath);
    const reclaimable = record
        ? Date.now() - record.createdAt >= STALE_MS && isDemonstrablyDead(record.pid)
        : Date.now() - identity.mtimeMs >= STALE_MS;
    if (!reclaimable) {
        return;
    }

    const quarantinePath = uniqueQuarantinePath(lockPath);
    try {
        fs.renameSync(lockPath, quarantinePath);
    } catch (error: unknown) {
        if (isMissing(error)) {
            return;
        }
        throw error;
    }

    const quarantinedIdentity = inspectLockEntry(quarantinePath);
    const quarantinedRecord = record ? readLockRecord(quarantinePath) : undefined;
    if (quarantinedIdentity
        && sameLockEntry(identity, quarantinedIdentity)
        && (!record || quarantinedRecord?.token === record.token)) {
        unlinkBestEffort(quarantinePath);
        return;
    }
    restoreQuarantineWithoutOverwrite(quarantinePath, lockPath);
}

function releaseOwnedLock(lockPath: string, token: string): void {
    const record = readLockRecord(lockPath);
    if (record?.token !== token) {
        return;
    }

    const quarantinePath = uniqueQuarantinePath(lockPath);
    try {
        fs.renameSync(lockPath, quarantinePath);
    } catch {
        return;
    }
    const quarantined = readLockRecord(quarantinePath);
    if (quarantined?.token === token) {
        unlinkBestEffort(quarantinePath);
        return;
    }
    restoreQuarantineWithoutOverwrite(quarantinePath, lockPath);
}

function removeOwnedLockAfterFailedAcquire(lockPath: string, token: string): void {
    releaseOwnedLock(lockPath, token);
}

function restoreQuarantineWithoutOverwrite(quarantinePath: string, lockPath: string): void {
    try {
        fs.linkSync(quarantinePath, lockPath);
        fs.unlinkSync(quarantinePath);
    } catch {
        // Preserve the quarantined record if another owner already has the lock.
    }
}

function readLockRecord(lockPath: string): LockRecord | undefined {
    let value: unknown;
    try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return undefined;
        }
        value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).length !== 3
        || !Object.prototype.hasOwnProperty.call(candidate, 'pid')
        || !Object.prototype.hasOwnProperty.call(candidate, 'createdAt')
        || !Object.prototype.hasOwnProperty.call(candidate, 'token')
        || typeof candidate.pid !== 'number'
        || !Number.isSafeInteger(candidate.pid)
        || candidate.pid <= 0
        || typeof candidate.createdAt !== 'number'
        || !Number.isFinite(candidate.createdAt)
        || candidate.createdAt < 0
        || typeof candidate.token !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.token)) {
        return undefined;
    }
    return candidate as unknown as LockRecord;
}

function isDemonstrablyDead(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error: unknown) {
        return error instanceof Error && 'code' in error
            && (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

function inspectLockEntry(lockPath: string): LockEntryIdentity | undefined {
    try {
        const stat = fs.lstatSync(lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Unsafe workspace comments lock: ${lockPath}`);
        }
        return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error: unknown) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
}

function sameLockEntry(before: LockEntryIdentity, after: LockEntryIdentity): boolean {
    if (before.dev !== 0 && before.ino !== 0 && after.dev !== 0 && after.ino !== 0) {
        return before.dev === after.dev && before.ino === after.ino;
    }
    return before.size === after.size && before.mtimeMs === after.mtimeMs;
}

function uniqueQuarantinePath(lockPath: string): string {
    return `${lockPath}.${process.pid}.${crypto.randomUUID()}.quarantine`;
}

function unlinkBestEffort(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Best effort cleanup; an orphaned quarantine never acts as the lock.
    }
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
